/**
 * Component tools — the four small operations behind authoring a new
 * component version: describe a component as the loader sees it, lay out
 * the next version under the host-managed root, run a version's contract,
 * and announce the outcome. See `docs/COMPONENTS.md` §Authoring a version.
 *
 * The filesystem work is `src/components/authoring.ts`; these tools add
 * the configuration (which roots, which agent) and turn results into text.
 * Every failure is a result string, never a throw.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { getConfig } from "../config/index.js";
import {
  SEED_COMPONENTS_DIRNAME,
  describeComponent,
  isVersionBump,
  planComponentVersion,
  readComponentVersion,
  resolveComponentRoots,
  runComponentContract,
  type ContractResult,
  type LoadedFile,
  type RunContractOptions,
  type VersionBump,
} from "../components/index.js";
import { lineageTitle } from "../components/lineage.js";
import { getLineageReconciler, type LineageReconciler } from "../components/lineage-reconcile.js";
import {
  ensureParentEntity,
  findLineageEntity,
  markLineageAnnounced,
  settleLineageEntity,
  storeLineageEntity,
} from "../components/lineage-store.js";
import { allowPathRoot, getProjectRoot } from "../utils/path-utils.js";
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import { getMemoryAdapter } from "./memory-adapter.js";
import { resolveOwnServerUrl } from "./self-task-tool.js";

/** Longest any single call to the host may take. */
export const DEFAULT_ANNOUNCE_TIMEOUT_MS = 10_000;
/**
 * Env switch for the room message. Off unless set to a truthy value: an
 * announcement in a shared room reaches every participant, so it stays
 * opt-in. The host event is always sent.
 */
export const ANNOUNCE_TO_CHAT_ENV = "SIA_ANNOUNCE_TO_CHAT";

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export interface ComponentToolsOptions {
  /** The source tree root (default: the resolved project root). */
  projectRoot?: string;
  /**
   * The host-managed component root. When the key is present it replaces
   * the configured `SIA_COMPONENTS_DIR` (explicitly `undefined` = none).
   */
  componentsDir?: string | undefined;
  agentId?: string;
  agentName?: string;
  /** Overrides `SIA_DAEMON_URL` / `SIA_DAEMON_TOKEN`. */
  daemonUrl?: string;
  daemonToken?: string;
  /** Overrides `SIA_ANNOUNCE_TO_CHAT` (default: off). */
  announceToChat?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Overrides the resolved own-server URL (used to read the current thread). */
  serverUrl?: string;
  argv?: readonly string[];
  timeoutMs?: number;
  /** Runner options handed through to `runComponentContract`. */
  contract?: Pick<RunContractOptions, "importModule" | "config" | "timeoutMs">;
  /** Graph memory, where lineage is recorded (default: the shared adapter). */
  adapter?: () => IGraphMemoryAdapter;
  /** Watches prepared versions for their verdict (default: the shared reconciler). */
  reconciler?: LineageReconciler;
  /** Clock for the timestamps lineage records. */
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadIdFrom(config?: RunnableConfig): string | undefined {
  const threadId = config?.configurable?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

/** Most distinct thread × name@version entries kept for run history. */
const CONTRACT_RUN_HISTORY_LIMIT = 256;

interface ContractRunRecord {
  runs: number;
  loaded?: ContractResult["loaded"];
}

function describeLoadedFile(
  current: LoadedFile,
  previous: LoadedFile | undefined,
  hadPrevious: boolean,
): string {
  const base = `${current.file} sha256 ${current.sha256}`;
  if (!hadPrevious) {
    return base;
  }
  if (previous === undefined) {
    return `${base} (not loaded on the previous run)`;
  }
  return previous.sha256 === current.sha256
    ? `${base} (unchanged since the previous run)`
    : `${base} (changed since the previous run, was ${previous.sha256})`;
}

/**
 * Record one contract run and describe it relative to the previous run of
 * the same version in the same thread.
 */
function recordContractRun(
  history: Map<string, ContractRunRecord>,
  threadId: string,
  label: string,
  result: ContractResult,
): string[] {
  const key = `${threadId}\u0000${label}`;
  const previous = history.get(key);
  const runs = (previous?.runs ?? 0) + 1;

  history.delete(key);
  history.set(key, { runs, ...(result.loaded !== undefined ? { loaded: result.loaded } : {}) });
  while (history.size > CONTRACT_RUN_HISTORY_LIMIT) {
    const oldest = history.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    history.delete(oldest);
  }

  const lines: string[] = [];
  if (result.loaded !== undefined) {
    const hadPrevious = previous !== undefined;
    lines.push(
      `loaded: ${describeLoadedFile(result.loaded.entry, previous?.loaded?.entry, hadPrevious)}; ` +
        describeLoadedFile(result.loaded.contract, previous?.loaded?.contract, hadPrevious),
    );
  }
  lines.push(
    runs === 1
      ? `first run of ${label}'s contract in this thread`
      : `run ${runs} of ${label}'s contract in this thread`,
  );
  return lines;
}

function coerceBump(value: unknown): VersionBump | null {
  if (value === undefined || value === null || value === "") {
    return "patch";
  }
  const lowered = String(value).trim().toLowerCase();
  return isVersionBump(lowered) ? lowered : null;
}

function coerceOutcome(value: unknown): "candidate" | "failed" {
  return String(value ?? "").trim().toLowerCase() === "failed" ? "failed" : "candidate";
}

function realpathOr(dir: string): string {
  try {
    return realpathSync(dir);
  } catch (_error) {
    return path.resolve(dir);
  }
}

/** Message kind that marks a room message as a component announcement. */
export const ANNOUNCEMENT_KIND = "announcement";
/**
 * Longest need or summary carried in the structured announcement, which is
 * kept small; the full text still goes out in the message body.
 */
const ANNOUNCEMENT_FIELD_MAX = 600;

function clip(value: string): string {
  return value.length > ANNOUNCEMENT_FIELD_MAX
    ? `${value.slice(0, ANNOUNCEMENT_FIELD_MAX - 1)}…`
    : value;
}

/**
 * Build the announcement text posted to the room. It stands on its own for
 * clients that render only text; clients that know the announcement kind
 * render the structured fields instead.
 */
export function buildAnnouncementText(input: {
  name: string;
  version: string;
  summary: string;
  outcome: "candidate" | "failed";
  agentId: string;
  threadId?: string;
  parentVersion?: string;
  need?: string;
}): string {
  let text =
    input.outcome === "failed"
      ? `**${input.name}@${input.version}** — could not produce a passing version. ${input.summary}`
      : `**${input.name}@${input.version}** — ${input.summary}`;
  const details: string[] = [];
  if (input.need?.trim()) details.push(`Need: ${input.need.trim()}`);
  if (input.parentVersion?.trim()) details.push(`from ${input.parentVersion.trim()}`);
  if (details.length > 0) {
    text += `\n${details.join(" · ")}`;
  }
  if (!input.threadId) {
    return text;
  }
  const link = `/chat?agentId=${encodeURIComponent(input.agentId)}&threadId=${encodeURIComponent(input.threadId)}`;
  return `${text}\n\n[Open the thread](${link})`;
}

/** Create the four component tools. Every option is injectable for tests. */
export function createComponentTools(
  opts: ComponentToolsOptions = {},
): DynamicStructuredTool[] {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS;

  const projectRoot = (): string => opts.projectRoot ?? getProjectRoot();
  const hostRoot = (): string | undefined =>
    Object.hasOwn(opts, "componentsDir")
      ? opts.componentsDir
      : getConfig().runtime.componentsDir;
  const seedRoot = (): string => path.join(projectRoot(), SEED_COMPONENTS_DIRNAME);
  const roots = (): string[] =>
    resolveComponentRoots({ projectRoot: projectRoot(), componentsDir: hostRoot() });
  const agentId = (): string => opts.agentId ?? getConfig().runtime.agentId;
  const agentName = (): string => opts.agentName ?? getConfig().runtime.agentName;
  const memory = (): IGraphMemoryAdapter => (opts.adapter ?? getMemoryAdapter)();
  const reconciler = (): LineageReconciler => opts.reconciler ?? getLineageReconciler();
  const nowIso = (): string => (opts.now ?? (() => new Date()))().toISOString();

  /**
   * Record a prepared version in graph memory: the parent gets an entity
   * if it has none, the child is stored as a candidate superseding it,
   * and the reconciler watches for the verdict. Returns the line the
   * tool result carries; never throws.
   */
  const recordLineage = async (input: {
    name: string;
    previousVersion: string;
    nextVersion: string;
    need: string;
    threadId?: string;
  }): Promise<string> => {
    const { name, previousVersion, nextVersion } = input;
    try {
      const adapter = memory();
      const parent = readComponentVersion({ name, version: previousVersion, roots: roots() });
      if (!parent.ok) {
        return `lineage: not recorded — parent ${lineageTitle(name, previousVersion)} unreadable (${parent.reason})`;
      }
      const child = readComponentVersion({ name, version: nextVersion, roots: roots() });
      const depth = child.ok ? child.component.manifest.depth : parent.component.manifest.depth;
      const parentEntity = await ensureParentEntity(adapter, parent.component.manifest, {
        agentId: agentId(),
      });
      const stored = await storeLineageEntity(
        adapter,
        {
          name,
          version: nextVersion,
          depth,
          need: input.need,
          parent: lineageTitle(name, previousVersion),
          producedBy: agentId(),
          threadId: input.threadId,
          outcome: "candidate",
        },
        { agentId: agentId(), parentId: parentEntity.id },
      );
      reconciler().track(stored.id, name, nextVersion);
      const notes = [
        `supersedes ${lineageTitle(name, previousVersion)}`,
        ...(parentEntity.created ? ["parent entity created"] : []),
        ...(stored.edgeError ? [`parent link failed: ${stored.edgeError}`] : []),
      ];
      return `lineage: recorded (id ${stored.id}; ${notes.join("; ")})`;
    } catch (error: unknown) {
      return `lineage: not recorded — ${errorMessage(error)}`;
    }
  };

  /**
   * Bring the version's entity up to date with an announcement: a
   * candidate is marked announced, a failure settles it. Returns the line
   * the tool result carries; never throws.
   */
  const recordAnnouncement = async (input: {
    name: string;
    version: string;
    outcome: "candidate" | "failed";
    summary: string;
  }): Promise<string> => {
    const title = lineageTitle(input.name, input.version);
    try {
      const adapter = memory();
      const entity = await findLineageEntity(adapter, title);
      if (!entity) {
        return `lineage: no entity for ${title}; nothing updated`;
      }
      if (input.outcome === "failed") {
        reconciler().untrack(input.name, input.version);
        const result = await settleLineageEntity(
          adapter,
          entity.id,
          { outcome: "failed", reason: input.summary },
          nowIso,
        );
        return result === "settled"
          ? `lineage: settled as failed (id ${entity.id})`
          : `lineage: already settled (id ${entity.id})`;
      }
      await markLineageAnnounced(adapter, entity.id, nowIso());
      return `lineage: announced (id ${entity.id})`;
    } catch (error: unknown) {
      return `lineage: not updated — ${errorMessage(error)}`;
    }
  };

  const rootLabel = (root: string): string => {
    const host = hostRoot();
    if (host !== undefined && realpathOr(root) === realpathOr(host)) {
      return "host-managed root";
    }
    if (realpathOr(root) === realpathOr(seedRoot())) {
      return "seed root shipped with the source tree (read-only for authoring)";
    }
    return "root";
  };

  const describeTool = new DynamicStructuredTool({
    name: "describe_component",
    description:
      "Describe one of your components as the loader sees it: which root " +
      "wins, the current version, the versions present, the manifest " +
      "(intent, kind, lineage) and the entry/contract paths. Read-only. " +
      "Use it before iterating a component.",
    schema: z.object({
      name: z.string().describe('The component name (directory name, e.g. "execute-code").'),
    }),
    func: async ({ name }: { name: string }): Promise<string> => {
      const result = describeComponent({ name, roots: roots() });
      if (!result.ok) {
        return `Cannot describe component: ${result.reason}`;
      }
      const d = result.description;
      const host = hostRoot();
      const lines = [
        `Component "${d.name}"`,
        `  current version: ${d.currentVersion} (kind ${d.manifest.kind}${d.manifest.replaces ? `, replaces ${d.manifest.replaces}` : ""})`,
        `  intent: ${d.manifest.intent}`,
        `  winning root: ${d.root} (${rootLabel(d.root)}; the first root in precedence order that carries the component wins)`,
        `  shadowed roots: ${d.shadowedRoots.length > 0 ? d.shadowedRoots.join(", ") : "none"}`,
        `  versions present: ${d.versions.join(", ") || "none"}`,
        `  version directory: ${d.versionDir}`,
        `  entry: ${d.entryPath}`,
        `  contract: ${d.contractPath}`,
        `  manifest: ${JSON.stringify(d.manifest)}`,
      ];
      if (host === undefined) {
        lines.push(
          "  note: no host-managed component root is configured (SIA_COMPONENTS_DIR); a new version cannot be written until one is.",
        );
      } else {
        lines.push(`  host-managed root: ${host} (new versions are written there, never here: ${seedRoot()})`);
      }
      return lines.join("\n");
    },
  });

  const prepareTool = new DynamicStructuredTool({
    name: "prepare_component_version",
    description:
      "Lay out the next version of a component under the host-managed " +
      "component root: copies the component there if needed, creates " +
      ".versions/<next>/ from the current version, and writes its manifest " +
      "(version, lineage.parent, lineage.need). Never touches `current`. " +
      "Returns the paths to edit next.",
    schema: z.object({
      name: z.string().describe("The component name."),
      need: z
        .string()
        .describe("The need this version answers, in the words of whoever raised it."),
      bump: z
        .string()
        .optional()
        .describe('How far to move the version: "patch" (default), "minor" or "major".'),
    }),
    func: async (
      {
        name,
        need,
        bump,
      }: {
        name: string;
        need: string;
        bump?: string;
      },
      _runManager?: unknown,
      config?: RunnableConfig,
    ): Promise<string> => {
      const coercedBump = coerceBump(bump);
      if (coercedBump === null) {
        return `Cannot prepare a version: bump must be "patch", "minor" or "major" (got ${JSON.stringify(bump)}).`;
      }
      const result = planComponentVersion({
        name,
        roots: roots(),
        authoringRoot: hostRoot(),
        seedRoot: seedRoot(),
        bump: coercedBump,
        need,
        producedBy: agentId(),
      });
      if (!result.ok) {
        return `Cannot prepare a version: ${result.reason}`;
      }
      const p = result.plan;
      // The filesystem tools are bounded to known roots; a host root that
      // appeared after assembly must be admitted (both spellings) so the
      // new version can be edited.
      allowPathRoot(p.root);
      allowPathRoot(realpathOr(p.root));
      const lineage = await recordLineage({
        name: p.name,
        previousVersion: p.previousVersion,
        nextVersion: p.nextVersion,
        need,
        threadId: threadIdFrom(config),
      });
      return [
        `Prepared ${p.name}@${p.nextVersion} from ${p.name}@${p.previousVersion} under ${p.root}${p.copied ? " (the component was copied there first)" : ""}.`,
        `  version directory: ${p.versionDir}`,
        `  manifest: ${p.manifestPath} (version, lineage.parent and lineage.need are set)`,
        `  entry: ${p.entryPath}`,
        `  contract: ${p.contractPath}`,
        `  ${lineage}`,
        `\`current\` still names ${p.previousVersion}; do not change it — activating a version is the host's step, after which the agent restarts.`,
        `Next: edit ${p.entryPath} (and add a contract case for the need), then run_component_contract({ name: "${p.name}", version: "${p.nextVersion}" }).`,
      ].join("\n");
    },
  });

  // Per-thread record of contract runs, keyed by thread and name@version,
  // so a result can say how often that version has run and whether the
  // files it loaded differ from the previous run's.
  const contractRuns = new Map<string, ContractRunRecord>();

  const runTool = new DynamicStructuredTool({
    name: "run_component_contract",
    description:
      "Run a component's contract in this process against a specific " +
      "version (or the current one) and report pass/fail with the error " +
      "text, the content hashes of the entry and contract files it loaded, " +
      "and how many times that version's contract has run in this thread. " +
      "A pass proves the version behaves; it does not activate it.",
    schema: z.object({
      name: z.string().describe("The component name."),
      version: z
        .string()
        .optional()
        .describe("The version to check (default: the current version)."),
    }),
    func: async (
      { name, version }: { name: string; version?: string },
      _runManager?: unknown,
      config?: RunnableConfig,
    ): Promise<string> => {
      const target = version?.trim() || undefined;
      const result = await runComponentContract(name, {
        ...(opts.contract ?? {}),
        ...(target !== undefined ? { version: target } : {}),
      });
      const label = `${name}@${result.version ?? target ?? "current"}`;
      const headline = result.ok
        ? `contract passed for ${label} in ${result.durationMs} ms (SDK ${result.sdkVersion})`
        : `contract FAILED for ${label}: ${result.error ?? "unknown error"}`;
      const detail = recordContractRun(contractRuns, threadIdFrom(config) ?? "", label, result);
      return [headline, ...detail].join("\n");
    },
  });

  const announceTool = new DynamicStructuredTool({
    name: "announce_component_version",
    description:
      "Announce the outcome of a component iteration: tells the host about " +
      "a candidate version and, when room announcements are enabled, posts " +
      "one announcement with a link to this thread to the room the need was " +
      "raised in. A need raised outside a room (a direct conversation) is " +
      "posted nowhere in the room; its owner sees it where they asked. " +
      "Pass `channel` to post to a room of your choosing instead. Call it " +
      "once, after the contract ran. outcome is \"candidate\" (default) or " +
      "\"failed\".",
    schema: z.object({
      name: z.string().describe("The component name."),
      version: z.string().describe("The version this thread produced."),
      summary: z
        .string()
        .describe("What changed and why, in one or two sentences, for a person."),
      outcome: z
        .string()
        .optional()
        .describe('"candidate" when the contract passed (default), "failed" when it could not.'),
      channel: z
        .string()
        .optional()
        .describe("Room to post to (default: the room the need was raised in; none when it was not raised in a room)."),
    }),
    func: async (
      {
        name,
        version,
        summary,
        outcome,
        channel,
      }: {
        name: string;
        version: string;
        summary: string;
        outcome?: string;
        channel?: string;
      },
      _runManager?: unknown,
      config?: RunnableConfig,
    ): Promise<string> => {
      const kind = coerceOutcome(outcome);
      const trimmedSummary = (summary ?? "").trim();
      if (!trimmedSummary) {
        return "Cannot announce: the summary is empty.";
      }

      const manifest = readComponentVersion({ name, version, roots: roots() });
      if (!manifest.ok && kind === "candidate") {
        return `Cannot announce a candidate: ${manifest.reason}`;
      }
      const parentVersion = manifest.ok ? manifest.component.manifest.lineage.parent : undefined;
      const need = manifest.ok ? manifest.component.manifest.lineage.need : undefined;

      const id = agentId();
      const threadId = threadIdFrom(config);
      const fetchImpl = opts.fetchImpl ?? fetch;
      const report: string[] = [
        await recordAnnouncement({ name, version, outcome: kind, summary: trimmedSummary }),
      ];

      // The thread's own metadata says which room the work came from.
      let inheritedChannel: string | undefined;
      if (threadId !== undefined) {
        const serverUrl = (
          opts.serverUrl ?? resolveOwnServerUrl({ env, argv: opts.argv })
        ).replace(/\/+$/, "");
        try {
          const res = await fetchImpl(`${serverUrl}/threads/${encodeURIComponent(threadId)}`, {
            method: "GET",
            headers: { "X-SIA-Agent-Id": id },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) {
            const thread = (await res.json()) as { metadata?: Record<string, unknown> };
            const value = thread?.metadata?.channel;
            if (typeof value === "string" && value) {
              inheritedChannel = value;
            }
          }
        } catch (_error) {
          // No room known: the room message is skipped below.
        }
      }
      const room = channel?.trim() || inheritedChannel;
      const text = buildAnnouncementText({
        name,
        version,
        summary: trimmedSummary,
        outcome: kind,
        agentId: id,
        threadId,
        parentVersion,
        need,
      });

      const daemonUrl = (opts.daemonUrl ?? env.SIA_DAEMON_URL ?? "").trim().replace(/\/+$/, "");
      const daemonToken = (opts.daemonToken ?? env.SIA_DAEMON_TOKEN ?? "").trim();
      if (!daemonUrl || !daemonToken) {
        report.push("host chat endpoint not configured; the summary stays in this thread:");
        return `${report.join("\n")}\n${text}`;
      }
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      };

      if (kind === "candidate") {
        try {
          const res = await fetchImpl(`${daemonUrl}/chat/component-version`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              agentId: id,
              name,
              version,
              parentVersion,
              need,
              summary: trimmedSummary,
              threadId,
              timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) {
            report.push(`candidate event: accepted by the host (${res.status}).`);
          } else if (res.status === 404) {
            report.push(
              "candidate event: the host does not accept component-version events yet (404); the version is described on disk and the message below still goes out.",
            );
          } else {
            report.push(`candidate event: rejected by the host (${res.status}).`);
          }
        } catch (error: unknown) {
          report.push(`candidate event: failed (${errorMessage(error)}).`);
        }
      } else {
        report.push("candidate event: skipped (outcome is failed).");
      }

      const chatEnabled = opts.announceToChat ?? isTruthy(env[ANNOUNCE_TO_CHAT_ENV]);
      if (!chatEnabled) {
        report.push(
          `room message: off (${ANNOUNCE_TO_CHAT_ENV} is not set); the summary stays in this thread.`,
        );
        return `${report.join("\n")}\n\n${text}`;
      }
      if (!room) {
        report.push(
          "room message: not posted; the need was not raised in a room, so the summary stays in this thread.",
        );
        return `${report.join("\n")}\n\n${text}`;
      }

      try {
        const res = await fetchImpl(`${daemonUrl}/chat/publish`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agentId: id,
            channel: room,
            sender: agentName(),
            isAgent: true,
            ...(threadId !== undefined ? { threadId } : {}),
            text,
            kind: ANNOUNCEMENT_KIND,
            announcement: {
              component: name,
              version,
              outcome: kind,
              ...(parentVersion ? { parentVersion } : {}),
              ...(need ? { need: clip(need) } : {}),
              summary: clip(trimmedSummary),
              ...(threadId !== undefined ? { threadId } : {}),
            },
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          report.push(`message posted to "${room}" (${res.status}).`);
        } else {
          report.push(`message to "${room}" rejected by the host (${res.status}); the summary stays in this thread.`);
        }
      } catch (error: unknown) {
        report.push(`message to "${room}" failed (${errorMessage(error)}); the summary stays in this thread.`);
      }

      return `${report.join("\n")}\n\n${text}`;
    },
  });

  return [describeTool, prepareTool, runTool, announceTool];
}
