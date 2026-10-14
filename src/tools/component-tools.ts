/**
 * Component tools — the five small operations behind authoring a component
 * version: describe a component as the loader sees it, lay out the first
 * version of a brand-new component, lay out the next version of an existing
 * one under the host-managed root, run a version's contract, and announce
 * the outcome. See `docs/COMPONENTS.md` §Authoring a version and
 * §Authoring a new component.
 *
 * The filesystem work is `src/components/authoring.ts`; these tools add
 * the configuration (which roots, which agent) and turn results into text.
 * Every failure is a result string, never a throw.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { getConfig } from "../config/index.js";
import {
  CONTENT_KINDS,
  MIDDLEWARE_TOOL_NAMES,
  SEED_COMPONENTS_DIRNAME,
  SEED_CONTENT_VERSION,
  VERSIONS_DIR,
  capDiff,
  contentComponentName,
  contentDigest,
  describeComponent,
  diffContentSources,
  discoverComponents,
  getActiveToolPool,
  isContentKind,
  isVersionBump,
  listComponentVersions,
  listSeedContent,
  parseContentComponentName,
  parseLineageRef,
  planComponentVersion,
  planNewComponent,
  readComponentVersion,
  readSeedBaseline,
  readVersionOrSeed,
  resolveComponentRoots,
  resolveContent,
  runComponentContract,
  seedContentPath,
  seedContentSource,
  type ContentDiff,
  type ContentKind,
  type ContractResult,
  type LoadedFile,
  type RunContractOptions,
  type VersionBump,
} from "../components/index.js";
import { createComponentHost } from "../components/host.js";
import { lineageTitle, type LineageDiffInput } from "../components/lineage.js";
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
/** Most distinct thread × component entries kept for the double-announce guard. */
const ANNOUNCE_GUARD_LIMIT = 256;

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

function coerceCreateKind(value: unknown): "tools" | "skill" | null {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (lowered === "" || lowered === "tools" || lowered === "tool") {
    return "tools";
  }
  return lowered === "skill" ? "skill" : null;
}

/** What the built-in contract of a skill or prompt checks, in one line. */
export const CONTENT_CONTRACT_SUMMARY =
  "built in: text only, balanced code fences, size budgets, a skill's SKILL.md frontmatter, " +
  "a prompt's trust rules, and no sentence repeated across the prompts";

/** `+a −r`, with the file count when more than one file changed. */
function diffStatsLabel(diff: Pick<ContentDiff, "added" | "removed" | "files">): string {
  return `+${diff.added} −${diff.removed}${diff.files > 1 ? ` in ${diff.files} files` : ""}`;
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

/** Create the five component tools. Every option is injectable for tests. */
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
   * The upstreams a component may call through `deps.host`, read live from
   * the host. `undefined` — no line at all — when the host cannot say.
   */
  const upstreamsLine = async (): Promise<string | undefined> => {
    const upstreams = await createComponentHost({
      url: opts.daemonUrl,
      token: opts.daemonToken,
      env,
      fetchImpl: opts.fetchImpl,
      listTimeoutMs: Math.min(timeoutMs, 5_000),
    }).upstreams();
    if (upstreams === undefined) {
      return undefined;
    }
    const names = upstreams.map((u) => u.name).join(", ") || "none";
    return `  host upstreams: ${names} (a component calls one by name with deps.host.fetch(name, path); the host holds the credential)`;
  };

  /**
   * Record a prepared version in graph memory: the parent (when there is
   * one) gets an entity if it has none, the version is stored as a
   * candidate superseding it, and the reconciler watches for the verdict.
   * A first version has no parent: it is stored as the root of its lineage,
   * with no edge. Returns the line the tool result carries; never throws.
   */
  const recordLineage = async (input: {
    name: string;
    /** Absent for the first version of a new component. */
    previousVersion?: string;
    nextVersion: string;
    need: string;
    threadId?: string;
  }): Promise<string> => {
    const { name, previousVersion, nextVersion } = input;
    try {
      const adapter = memory();
      const child = readComponentVersion({ name, version: nextVersion, roots: roots() });

      if (previousVersion === undefined) {
        const stored = await storeLineageEntity(
          adapter,
          {
            name,
            version: nextVersion,
            depth: child.ok ? child.component.manifest.depth : 0,
            need: input.need,
            producedBy: agentId(),
            threadId: input.threadId,
            outcome: "candidate",
          },
          { agentId: agentId() },
        );
        reconciler().track(stored.id, name, nextVersion);
        return `lineage: recorded (id ${stored.id}; root of its lineage)`;
      }

      const parent = readVersionOrSeed({
        name,
        version: previousVersion,
        roots: roots(),
        contentSeedRoot: projectRoot(),
      });
      if (!parent.ok) {
        return `lineage: not recorded — parent ${lineageTitle(name, previousVersion)} unreadable (${parent.reason})`;
      }
      const depth = child.ok ? child.component.manifest.depth : parent.manifest.depth;
      const parentEntity = await ensureParentEntity(adapter, parent.manifest, {
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
   * Bring the version's entity up to date with an announcement: a failure
   * settles it right away; a candidate is *not* stamped here — the caller
   * decides when the announcement actually reached anyone (see
   * `markCandidateAnnounced`) — so this returns the entity id instead of a
   * report line for that case. Returns the line the tool result carries
   * (empty for a candidate, filled in later); never throws.
   */
  const recordAnnouncement = async (input: {
    name: string;
    version: string;
    outcome: "candidate" | "failed";
    summary: string;
  }): Promise<{ line: string; candidateEntityId?: string }> => {
    const title = lineageTitle(input.name, input.version);
    try {
      const adapter = memory();
      const entity = await findLineageEntity(adapter, title);
      if (!entity) {
        return { line: `lineage: no entity for ${title}; nothing updated` };
      }
      if (input.outcome === "failed") {
        reconciler().untrack(input.name, input.version);
        const result = await settleLineageEntity(
          adapter,
          entity.id,
          { outcome: "failed", reason: input.summary },
          nowIso,
        );
        return {
          line:
            result === "settled"
              ? `lineage: settled as failed (id ${entity.id})`
              : `lineage: already settled (id ${entity.id})`,
        };
      }
      return { line: "", candidateEntityId: entity.id };
    } catch (error: unknown) {
      return { line: `lineage: not updated — ${errorMessage(error)}` };
    }
  };

  /**
   * Stamp a candidate's entity as announced and tell the reconciler, once
   * the caller knows the announcement is actually going out (or that no
   * host is configured to confirm it — see `announceTool`). Idempotent via
   * `markLineageAnnounced`'s own settled-entity guard; never throws.
   */
  const markCandidateAnnounced = async (
    name: string,
    version: string,
    entityId: string,
    diff?: LineageDiffInput,
  ): Promise<string> => {
    try {
      const adapter = memory();
      const result = await markLineageAnnounced(adapter, entityId, nowIso(), diff);
      if (result === "already_settled") {
        return `lineage: already settled (id ${entityId})`;
      }
      reconciler().markAnnounced(name, version);
      return `lineage: announced (id ${entityId})`;
    } catch (error: unknown) {
      return `lineage: not updated — ${errorMessage(error)}`;
    }
  };

  /**
   * A skill or prompt version's diff against its parent (a host version or
   * the in-place seed), or null when `name` is not one, the version cannot
   * be read, or it has no parent.
   */
  const contentDiffFor = (
    name: string,
    version: string,
  ): { parent: string; diff: ContentDiff } | null => {
    if (parseContentComponentName(name) === null) {
      return null;
    }
    const child = readVersionOrSeed({ name, version, roots: roots(), contentSeedRoot: projectRoot() });
    if (!child.ok || child.content === undefined) {
      return null;
    }
    const parentRef = child.manifest.lineage.parent;
    const parsed = parentRef ? parseLineageRef(parentRef) : null;
    if (parentRef === undefined || parsed === null || parsed.name !== name) {
      return null;
    }
    const parent = readVersionOrSeed({
      name,
      version: parsed.version,
      roots: roots(),
      contentSeedRoot: projectRoot(),
    });
    return {
      parent: parentRef,
      diff: diffContentSources(parent.ok ? (parent.content ?? null) : null, child.content),
    };
  };

  /** The first root carrying `<name>/`, and the versions staged there. */
  const stagedContent = (name: string): { root: string; versions: string[] } | null => {
    for (const root of roots()) {
      const dir = path.join(root, name);
      if (existsSync(path.join(dir, VERSIONS_DIR))) {
        return { root, versions: listComponentVersions(dir) };
      }
    }
    return null;
  };

  /** `describe_component` for a skill or prompt. Null when there is nothing by that name. */
  const describeContent = (kind: ContentKind, base: string): string | null => {
    const name = contentComponentName(kind, base);
    const served = resolveContent(kind, base, { roots: roots(), seedRoot: projectRoot() });
    const seed = seedContentSource(kind, base, projectRoot());
    const staged = stagedContent(name);
    if (served === null && staged === null) {
      return null;
    }
    const versions = [
      ...(seed !== null ? [`${SEED_CONTENT_VERSION} (seed)`] : []),
      ...(staged?.versions ?? []).filter((v) => seed === null || v !== SEED_CONTENT_VERSION),
    ];
    const lines = [
      `Component "${name}" (the ${base} ${kind})`,
      served === null
        ? "  served now: nothing (no activated version and no copy in the source tree)"
        : served.origin === "seed"
          ? `  current version: ${served.version} (seed, served from ${served.file})`
          : `  current version: ${served.version} (host version, served from ${served.file})`,
      `  versions present: ${versions.join(", ") || "none"}`,
      ...(seed !== null
        ? [
            `  seed: ${seedContentPath(kind, base, projectRoot())} (read in place as ${SEED_CONTENT_VERSION}; ` +
              "change it by preparing a version, never by editing it)",
          ]
        : []),
      ...(staged !== null ? [`  host versions: ${path.join(staged.root, name)}`] : []),
      `  contract: ${CONTENT_CONTRACT_SUMMARY}`,
    ];
    if (served?.origin === "version" && seed !== null) {
      const baseline = readSeedBaseline(served.dir);
      if (baseline !== null && baseline !== contentDigest(seed)) {
        lines.push(
          `  seed changed since this version's lineage was prepared from it: ${served.version} does not ` +
            "include what the source tree now ships, and a version prepared from it will not either. " +
            "Tell your keeper if that matters.",
        );
      }
    }
    const host = hostRoot();
    lines.push(
      host === undefined
        ? "  note: no host-managed component root is configured (SIA_COMPONENTS_DIR); a new version cannot be written until one is."
        : `  host-managed root: ${host} (new versions are written there)`,
    );
    return lines.join("\n");
  };

  /** `describe_component` with no name: every code component, skills and prompts summarised. */
  const describeAll = (): string => {
    const discovered = discoverComponents(roots());
    const code = discovered.found.filter((c) => !isContentKind(c.manifest.kind));
    // Content components a root carries that are not seeds (a created skill).
    const hostContent = [
      ...discovered.found.map((c) => c.manifest.name),
      ...discovered.skipped.map((c) => c.name),
    ];
    const lines = [
      `Components: ${code.map((c) => `${c.manifest.name}@${c.manifest.version}`).join(", ") || "none"}`,
    ];
    for (const kind of CONTENT_KINDS) {
      const bases = new Set(listSeedContent(kind, projectRoot()));
      for (const entry of hostContent) {
        const parsed = parseContentComponentName(entry);
        if (parsed?.kind === kind) {
          bases.add(parsed.base);
        }
      }
      const withHost = [...bases].filter((b) => stagedContent(contentComponentName(kind, b)) !== null).length;
      const names =
        kind === "prompt" ? `: ${[...bases].sort().map((b) => contentComponentName(kind, b)).join(", ")}` : "";
      lines.push(`${kind}s: ${bases.size} (${withHost} with host versions), named ${kind}-<name>${names}`);
    }
    lines.push('describe_component({ name }) describes one, e.g. "skill-planning" or "prompt-manager".');
    return lines.join("\n");
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
      "(intent, kind, lineage) and the entry/contract paths. Your skills " +
      "(skill-<name>) and prompts (prompt-<role>) are components too. " +
      "Without a name, lists them all. Read-only. Use it before iterating a component.",
    schema: z.object({
      name: z
        .string()
        .optional()
        .describe('The component name, e.g. "execute-code", "skill-planning", "prompt-manager" (default: list all).'),
    }),
    func: async ({ name }: { name?: string }): Promise<string> => {
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (trimmed === "") {
        return describeAll();
      }
      const content = parseContentComponentName(trimmed);
      if (content !== null) {
        return (
          describeContent(content.kind, content.base) ??
          `Cannot describe component: unknown ${content.kind} "${content.base}"`
        );
      }
      const result = describeComponent({ name: trimmed, roots: roots() });
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
      const upstreams = await upstreamsLine();
      if (upstreams !== undefined) {
        lines.push(upstreams);
      }
      return lines.join("\n");
    },
  });

  const createTool = new DynamicStructuredTool({
    name: "create_component",
    description:
      "Create a new component (a tool you do not have yet) as version " +
      "0.1.0: a manifest, an entry contributing one stub tool that echoes " +
      "its input, and a contract that already passes. It is not live until " +
      "a person accepts it and you restart. Refuses a name that has a live " +
      "version (use prepare_component_version) or a tool name you already " +
      "have. A removed component whose versions are still staged may be " +
      "created again, as a new lineage root above them. With kind \"skill\" " +
      "it creates a new skill (skill-<name>, a stub SKILL.md) instead. Returns " +
      "the paths to edit next.",
    schema: z.object({
      name: z
        .string()
        .describe('The component name: lower-case, digits and hyphens, e.g. "parse-time-expression".'),
      intent: z
        .string()
        .describe("One paragraph, for a person: what the component is for."),
      need: z
        .string()
        .describe("The need it answers, in the words of whoever raised it."),
      tool_name: z
        .string()
        .optional()
        .describe(
          'The tool the entry contributes (default: the name with "-" replaced by "_", e.g. "parse_time_expression").',
        ),
      description: z
        .string()
        .optional()
        .describe("The tool's description for the model, or the skill's description (default: the intent)."),
      kind: z
        .string()
        .optional()
        .describe('"tools" (default) or "skill" (name it skill-<name>).'),
    }),
    func: async (
      {
        name,
        intent,
        need,
        tool_name,
        description,
        kind,
      }: {
        name: string;
        intent: string;
        need: string;
        tool_name?: string;
        description?: string;
        kind?: string;
      },
      _runManager?: unknown,
      config?: RunnableConfig,
    ): Promise<string> => {
      // Names the model already knows — the middleware's tools and the
      // pool assembled for this agent, components included — would collide
      // at the model boundary; the component's own future tool must not.
      const createKind = coerceCreateKind(kind);
      if (createKind === null) {
        return `Cannot create a component: kind must be "tools" or "skill" (got ${JSON.stringify(kind)}).`;
      }
      const reservedToolNames = new Set<string>([
        ...MIDDLEWARE_TOOL_NAMES,
        ...getActiveToolPool().map((t) => t.name),
      ]);
      const result = planNewComponent({
        name: typeof name === "string" ? name.trim() : name,
        roots: roots(),
        authoringRoot: hostRoot(),
        seedRoot: seedRoot(),
        intent,
        need,
        producedBy: agentId(),
        toolName: tool_name,
        description,
        reservedToolNames,
        kind: createKind,
        contentSeedRoot: projectRoot(),
      });
      if (!result.ok) {
        return `Cannot create a component: ${result.reason}`;
      }
      const p = result.plan;
      allowPathRoot(p.root);
      allowPathRoot(realpathOr(p.root));
      const lineage = await recordLineage({
        name: p.name,
        nextVersion: p.version,
        need: need.trim(),
        threadId: threadIdFrom(config),
      });
      if (p.kind === "skill") {
        return [
          `Created ${p.name}@${p.version} under ${p.root} (a new skill: no parent, nothing served yet).`,
          `  version directory: ${p.versionDir}`,
          `  manifest: ${p.manifestPath} (kind skill, intent, lineage.need; no lineage.parent)`,
          `  skill: ${p.entryPath} (a stub: frontmatter name and description, then the body)`,
          `  contract: ${CONTENT_CONTRACT_SUMMARY}`,
          `  ${lineage}`,
          `It is served only after the host activates ${p.version} and you restart; do not create \`current\`.`,
          `Next: write ${p.entryPath}, then run_component_contract({ name: "${p.name}", version: "${p.version}" }).`,
        ].join("\n");
      }
      const upstreams = await upstreamsLine();
      return [
        `Created ${p.name}@${p.version} under ${p.root} (a new component: no parent, nothing live yet).`,
        `  tool: ${p.toolName} (a stub that echoes its input; the contract invokes it)`,
        `  version directory: ${p.versionDir}`,
        `  manifest: ${p.manifestPath} (kind tools, intent, lineage.need; no lineage.parent)`,
        `  entry: ${p.entryPath}`,
        `  contract: ${p.contractPath}`,
        `  ${lineage}`,
        ...(p.previousVersions.length > 0
          ? [
              `  earlier versions staged: ${p.previousVersions.join(", ")} — the host removed the component; ${p.version} starts a fresh lineage (no parent)`,
            ]
          : []),
        ...(upstreams !== undefined ? [upstreams] : []),
        `\`current\` does not exist yet and you must not create it — the component runs only after the host activates ${p.version}, after which the agent restarts.`,
        `Next: run_component_contract({ name: "${p.name}", version: "${p.version}" }) to see the stub pass, then edit ${p.entryPath} so ${p.toolName} answers the need and make ${path.basename(p.contractPath)} prove it.`,
      ].join("\n");
    },
  });

  const prepareTool = new DynamicStructuredTool({
    name: "prepare_component_version",
    description:
      "Lay out the next version of a component under the host-managed " +
      "component root: copies the component there if needed, creates " +
      ".versions/<next>/ from the current version, and writes its manifest " +
      "(version, lineage.parent, lineage.need). Never touches `current`. " +
      "For a skill or prompt the current version may be the copy in the " +
      "source tree; it is copied, never edited. Returns the paths to edit next.",
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
        contentSeedRoot: projectRoot(),
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
      if (isContentKind(p.kind)) {
        const from =
          p.parentOrigin === "seed"
            ? `${p.name}@${p.previousVersion} (the copy shipped with the source tree)`
            : `${p.name}@${p.previousVersion}`;
        return [
          `Prepared ${p.name}@${p.nextVersion} from ${from} under ${p.root}.`,
          `  version directory: ${p.versionDir}`,
          `  manifest: ${p.manifestPath} (version, lineage.parent and lineage.need are set)`,
          `  ${p.kind}: ${p.entryPath}${p.kind === "skill" ? " (its supporting files sit beside it)" : ""}`,
          `  contract: ${CONTENT_CONTRACT_SUMMARY}`,
          `  ${lineage}`,
          `Edit this version only, never the source tree's copy. It governs only after your keeper accepts it and you restart; your keeper sees its diff against ${p.name}@${p.previousVersion}.`,
          `Next: edit ${p.entryPath}, then run_component_contract({ name: "${p.name}", version: "${p.nextVersion}" }).`,
        ].join("\n");
      }
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
      const isContent = parseContentComponentName(name) !== null;
      const result = await runComponentContract(name, {
        ...(opts.contract ?? {}),
        ...(target !== undefined ? { version: target } : {}),
        ...(isContent ? { contentRoots: roots(), contentSeedRoot: projectRoot() } : {}),
      });
      const label = `${name}@${result.version ?? target ?? "current"}`;
      const headline = result.ok
        ? isContent
          ? `contract passed for ${label} in ${result.durationMs} ms (built-in content contract)`
          : `contract passed for ${label} in ${result.durationMs} ms (SDK ${result.sdkVersion})`
        : `contract FAILED for ${label}: ${result.error ?? "unknown error"}`;
      const detail = recordContractRun(contractRuns, threadIdFrom(config) ?? "", label, result);
      const diffed = isContent && result.version ? contentDiffFor(name, result.version) : null;
      if (diffed !== null) {
        detail.push(
          diffed.diff.text === ""
            ? `diff against ${diffed.parent}: none yet (the version still matches its parent)`
            : `diff against ${diffed.parent}: ${diffStatsLabel(diffed.diff)} (your keeper sees it when you announce)`,
        );
      }
      return [headline, ...detail].join("\n");
    },
  });

  // Per-thread, per-component record of the version last announced as a
  // candidate, so a second `announce_component_version` for the same
  // component from the same thread — while that candidate is still
  // pending — is refused rather than silently repeated. A `failed` outcome
  // clears the entry (the story for this thread/component is over); a
  // settlement that arrives out of band (a keeper's verdict, a revert)
  // does not, so a self-task thread that genuinely starts a fresh
  // candidate after that stays blocked until the process restarts — a
  // known, accepted limitation of a process-local guard.
  const pendingAnnouncements = new Map<string, string>();

  const announceGuardKey = (threadId: string, name: string): string => `${threadId}\u0000${name}`;

  const announceTool = new DynamicStructuredTool({
    name: "announce_component_version",
    description:
      "Announce a component version once its contract has run. Reports the " +
      "candidate to the host and, when room announcements are on, posts one " +
      "announcement linking this thread to the room the need was raised in " +
      "(a need raised outside a room is posted nowhere; pass `channel` to " +
      "choose a room). Call it once, from the self-task thread that built " +
      "the version; a second pending candidate from the same thread, or a " +
      "call from a thread that is not a self-task, is refused.",
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
      // A skill or prompt candidate carries its diff against its parent, so
      // the keeper reads what changed in how the agent reasons before it
      // governs. Code components carry none.
      const diffed = kind === "candidate" && manifest.ok ? contentDiffFor(name, version) : null;
      const sentDiff = diffed !== null && diffed.diff.text !== "" ? capDiff(diffed.diff.text) : null;

      const id = agentId();
      const threadId = threadIdFrom(config);
      const fetchImpl = opts.fetchImpl ?? fetch;

      // The thread's own metadata says which room the work came from, and
      // — for a candidate — whether this is the self-task thread that is
      // supposed to be doing the announcing. A lookup failure (no thread
      // id, a 404, a network error) is not a refusal: both checks below
      // simply proceed as they always have when the metadata is unknown.
      let inheritedChannel: string | undefined;
      let threadMetadata: Record<string, unknown> | undefined;
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
            threadMetadata = thread?.metadata;
            const value = threadMetadata?.channel;
            if (typeof value === "string" && value) {
              inheritedChannel = value;
            }
          }
        } catch (_error) {
          // No room known, no self-task check possible: proceed as before.
        }
      }

      if (threadMetadata !== undefined && threadMetadata.self_task !== true) {
        return (
          "Cannot announce: this is not the self-task thread that built the candidate. " +
          "announce_component_version is called from the self-task thread that produced " +
          "the version (see the iterate-component skill), so a version is announced by " +
          "the work that made it, not by whatever thread happens to call the tool."
        );
      }

      let guardKey: string | undefined;
      if (kind === "candidate" && threadId !== undefined) {
        guardKey = announceGuardKey(threadId, name);
        const priorVersion = pendingAnnouncements.get(guardKey);
        if (priorVersion !== undefined && priorVersion !== version) {
          return (
            `Cannot announce: ${lineageTitle(name, priorVersion)} from this thread is still ` +
            "pending a verdict; announce once per candidate."
          );
        }
      }

      const report: string[] = [];
      const recorded = await recordAnnouncement({ name, version, outcome: kind, summary: trimmedSummary });
      if (recorded.line) {
        report.push(recorded.line);
      }
      if (kind === "failed" && threadId !== undefined) {
        // The story for this thread/component is over: free the guard so a
        // later self-task thread for the same component is not blocked by
        // a candidate that never converged.
        pendingAnnouncements.delete(announceGuardKey(threadId, name));
      }

      const finishCandidate = async (): Promise<void> => {
        if (kind !== "candidate" || recorded.candidateEntityId === undefined) {
          return;
        }
        report.push(
          await markCandidateAnnounced(
            name,
            version,
            recorded.candidateEntityId,
            diffed !== null
              ? {
                  parent: diffed.parent,
                  text: diffed.diff.text,
                  added: diffed.diff.added,
                  removed: diffed.diff.removed,
                }
              : undefined,
          ),
        );
        if (threadId !== undefined) {
          const k = guardKey ?? announceGuardKey(threadId, name);
          pendingAnnouncements.set(k, version);
          while (pendingAnnouncements.size > ANNOUNCE_GUARD_LIMIT) {
            const oldest = pendingAnnouncements.keys().next().value;
            if (oldest === undefined) break;
            pendingAnnouncements.delete(oldest);
          }
        }
      };

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
        // No host to confirm receipt with: stamp now, exactly as before.
        await finishCandidate();
        report.push("host chat endpoint not configured; the summary stays in this thread:");
        return `${report.join("\n")}\n${text}`;
      }
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daemonToken}`,
      };

      if (diffed !== null) {
        report.push(
          diffed.diff.text === ""
            ? `diff: none — ${lineageTitle(name, version)} matches ${diffed.parent}.`
            : `diff: ${diffStatsLabel(diffed.diff)} against ${diffed.parent}${sentDiff?.truncated ? " (cut to fit what the host carries)" : ""}.`,
        );
      }

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
              ...(sentDiff !== null ? { diff: sentDiff.text } : {}),
              timestamp: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) {
            report.push(`candidate event: accepted by the host (${res.status}).`);
            await finishCandidate();
          } else if (res.status === 404) {
            report.push(
              "candidate event: the host does not accept component-version events yet (404); the version is described on disk and the message below still goes out.",
            );
            // An older host that has never heard of this endpoint cannot
            // hold a candidate slot either, so there is nothing for this
            // version to be displaced from — stamping now is as good as
            // it gets on this host.
            await finishCandidate();
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

  return [describeTool, createTool, prepareTool, runTool, announceTool];
}
