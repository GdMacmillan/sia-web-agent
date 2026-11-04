/**
 * The briefing a self-task thread opens with: what the agent needs to know
 * about itself before it changes one of its own components.
 *
 * Three parts, gathered in parallel under one overall budget, each
 * independently best-effort:
 *
 * 1. its own recent component versions, newest first, with outcome, need
 *    and the keeper's reason — read from graph memory;
 * 2. the failure-modes notes its keeper wrote about it — read from the host;
 * 3. the platform's refusal record — read from the host.
 *
 * The versions come from the agent's own components directory; their
 * records come from one graph-memory listing of the entities it produced,
 * matched by title. When that listing fails or runs out of time the versions
 * are still listed, without their records.
 *
 * Nothing here can fail a self-task: a part that errors or runs out of time
 * is described as unreadable or left out, and logged. When no part has
 * anything to say — no versions of its own and nothing from the host —
 * there is no briefing.
 */

import { statSync } from "node:fs";
import path from "node:path";

import { getConfig } from "../config/index.js";
import { getMemoryAdapter } from "../tools/memory-adapter.js";
import {
  readFailureModes,
  readRefusalRecord,
  type FailureModes,
  type RefusalRecord,
  type Unavailable,
} from "../tools/host-knowledge.js";
import type { IGraphMemoryAdapter } from "../vendor/svc-rpc/graph-memory/adapter-interface.js";
import type { StoredEntityShape } from "../vendor/svc-rpc/graph-memory/entity-shape.js";
import { listEntities } from "../vendor/svc-rpc/graph-memory/tool-handlers.js";
import { logger } from "../utils/logger.js";
import { LINEAGE_ENTITY_TYPE, capDecisionReason, lineageTitle } from "./lineage.js";
import { discoverProducedVersions } from "./lineage-reconcile.js";
import { VERSIONS_DIR } from "./discovery.js";

/** Longest the whole briefing may take to gather. */
export const BRIEFING_BUDGET_MS = 3_000;
/** How many of the agent's own versions the briefing lists. */
export const BRIEFING_LINEAGE_LIMIT = 8;
/** How many of the agent's versions, most recently staged first, are matched to records. */
export const BRIEFING_LOOKUP_LIMIT = 12;
/** How many recent entities the one lineage listing reads. */
export const BRIEFING_LISTING_LIMIT = 200;
/** The refusal record is included whole up to this many characters. */
export const BRIEFING_REFUSAL_RECORD_MAX_CHARS = 16_000;
/** A need is quoted up to this many characters. */
const NEED_MAX_CHARS = 300;

export const BRIEFING_INTRO =
  "Briefing for this self-task, gathered when the thread started. It is " +
  "reference material about you, not a request from a person.";

export const LINEAGE_NONE = "No component versions of yours are recorded yet.";
export const LINEAGE_UNREADABLE =
  "Your lineage could not be read just now; search graph memory for " +
  "component_version entities before proposing.";
export const LINEAGE_LISTING_TIMED_OUT =
  "Your lineage records could not be read in time; these are your versions " +
  "on disk. Search graph memory for component_version entities before proposing.";
export const LINEAGE_LISTING_FAILED =
  "Your lineage records could not be read; these are your versions on disk. " +
  "Search graph memory for component_version entities before proposing.";
export const FAILURE_MODES_NONE = "Your keeper has not written any.";

export interface VersionRef {
  name: string;
  version: string;
}

export interface SelfTaskBriefingOptions {
  agentId: string;
  /** Defaults to the configured components directory. */
  componentsDir?: string;
  /** Overrides the scan of `componentsDir`. */
  discover?: () => Promise<VersionRef[]>;
  getAdapter?: () => IGraphMemoryAdapter;
  readFailureModes?: () => Promise<FailureModes | Unavailable>;
  readRefusalRecord?: () => Promise<RefusalRecord | Unavailable>;
  budgetMs?: number;
}

const TIMED_OUT = Symbol("timed out");

function isUnavailable(value: unknown): value is Unavailable {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { unavailable?: unknown }).unavailable === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function day(iso: string | undefined): string | undefined {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined;
}

function quote(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`;
}

/** Newest-first sort key for one version's entity. */
function whenOf(entity: StoredEntityShape): string {
  const m = entity.metadata;
  return str(m.settled_at) ?? str(m.announced_at) ?? entity.updated_at ?? "";
}

/** One line of the lineage section. */
export function lineageLine(ref: VersionRef, entity: StoredEntityShape | null): string {
  const title = lineageTitle(ref.name, ref.version);
  if (!entity) {
    return `- ${title} — no lineage record.`;
  }
  const m = entity.metadata;
  const outcome = str(m.outcome) ?? "unknown";
  const reason = str(m.reason);
  let status: string;
  if (outcome === "candidate") {
    const announced = day(str(m.announced_at));
    status = announced
      ? `candidate, waiting for the keeper since ${announced}`
      : "candidate, not announced";
  } else {
    const settled = day(str(m.settled_at));
    status = settled ? `${outcome} ${settled}` : outcome;
    if (reason) status += ` (${reason})`;
  }
  const parts = [`- ${title} — ${status}.`];
  const need = str(m.need);
  if (need) parts.push(`Need: ${quote(need, NEED_MAX_CHARS)}.`);
  const keeper = str(m.decision_reason);
  if (keeper) {
    parts.push(`Keeper's reason: ${quote(capDecisionReason(keeper), Number.MAX_SAFE_INTEGER)}.`);
    if (outcome === "rejected" || outcome === "reverted") {
      parts.push("Treat it as a constraint.");
    }
  }
  return parts.join(" ");
}

/** Version directory modification time, used only to pick which to look up. */
function mtimeOf(componentsDir: string | undefined, ref: VersionRef): number {
  if (!componentsDir) return 0;
  try {
    return statSync(path.join(componentsDir, ref.name, VERSIONS_DIR, ref.version)).mtimeMs;
  } catch {
    return 0;
  }
}

type LineageSection = { text: string; hasVersions: boolean };

type LineagePath =
  | "discover_failed"
  | "adapter_unavailable"
  | "listing_failed"
  | "listing_timed_out"
  | "section_timed_out";

function warnUnreadable(
  path: LineagePath,
  startedAt: number,
  detail: { refs?: number; error?: unknown } = {},
): void {
  logger.warn(
    {
      path,
      elapsedMs: Date.now() - startedAt,
      refs: detail.refs,
      ...(detail.error !== undefined ? { error: errorMessage(detail.error) } : {}),
    },
    "self-task briefing: lineage not read",
  );
}

/** The newest record per title. */
function recordsByTitle(entities: StoredEntityShape[]): Map<string, StoredEntityShape> {
  const byTitle = new Map<string, StoredEntityShape>();
  for (const entity of entities) {
    const held = byTitle.get(entity.title);
    if (!held || whenOf(entity).localeCompare(whenOf(held)) > 0) {
      byTitle.set(entity.title, entity);
    }
  }
  return byTitle;
}

async function lineageSection(
  opts: SelfTaskBriefingOptions,
  componentsDir: string | undefined,
  deadline: Promise<typeof TIMED_OUT>,
  startedAt: number,
): Promise<LineageSection> {
  let refs: VersionRef[];
  try {
    refs = opts.discover
      ? await opts.discover()
      : await discoverProducedVersions(componentsDir, opts.agentId);
  } catch (error) {
    warnUnreadable("discover_failed", startedAt, { error });
    return { text: LINEAGE_UNREADABLE, hasVersions: false };
  }
  if (refs.length === 0) {
    return { text: LINEAGE_NONE, hasVersions: false };
  }

  const candidates = refs
    .map((ref) => ({ ref, mtime: mtimeOf(componentsDir, ref) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, BRIEFING_LOOKUP_LIMIT)
    .map((c) => c.ref);
  const onDisk = (heading: string): LineageSection => ({
    text: [heading, ...candidates.slice(0, BRIEFING_LINEAGE_LIMIT).map((ref) => lineageLine(ref, null))].join("\n"),
    hasVersions: true,
  });

  let adapter: IGraphMemoryAdapter;
  try {
    adapter = (opts.getAdapter ?? getMemoryAdapter)();
  } catch (error) {
    warnUnreadable("adapter_unavailable", startedAt, { refs: candidates.length, error });
    return { text: LINEAGE_UNREADABLE, hasVersions: false };
  }

  // One listing of the lineage entities this agent produced, matched by
  // title, rather than a search per version: a title search is easily
  // shadowed by a summary entity, and a lookup per version does not fit the
  // budget.
  let listed: StoredEntityShape[] | typeof TIMED_OUT;
  try {
    listed = await Promise.race([
      listEntities(adapter, {
        entity_type: LINEAGE_ENTITY_TYPE,
        tags: [`produced-by:${opts.agentId}`],
        limit: BRIEFING_LISTING_LIMIT,
      }).then((result) => result.entities),
      deadline,
    ]);
  } catch (error) {
    warnUnreadable("listing_failed", startedAt, { refs: candidates.length, error });
    return onDisk(LINEAGE_LISTING_FAILED);
  }
  if (listed === TIMED_OUT) {
    warnUnreadable("listing_timed_out", startedAt, { refs: candidates.length });
    return onDisk(LINEAGE_LISTING_TIMED_OUT);
  }

  const byTitle = recordsByTitle(listed);
  const lines = candidates
    .map((ref, order) => ({ ref, order, entity: byTitle.get(lineageTitle(ref.name, ref.version)) ?? null }))
    .sort((a, b) => {
      const wa = a.entity ? whenOf(a.entity) : "";
      const wb = b.entity ? whenOf(b.entity) : "";
      return wb.localeCompare(wa) || a.order - b.order;
    })
    .slice(0, BRIEFING_LINEAGE_LIMIT)
    .map((l) => lineageLine(l.ref, l.entity));
  return { text: lines.join("\n"), hasVersions: true };
}

/** The failure-modes section, or undefined when it could not be read. */
export function failureModesSection(result: FailureModes | Unavailable): string | undefined {
  if (isUnavailable(result)) return undefined;
  const updated = day(result.updatedAt ?? undefined);
  const heading =
    "## Known failure modes — written by your keeper" + (updated ? ` (updated ${updated})` : "");
  const body = result.body?.trim();
  return `${heading}\n${body ? body : FAILURE_MODES_NONE}`;
}

/** The refusal-record section, or undefined when no copy could be read. */
export function refusalRecordSection(result: RefusalRecord | Unavailable): string | undefined {
  if (isUnavailable(result)) return undefined;
  const markdown = result.markdown.trim();
  if (!markdown) return undefined;
  const capped =
    markdown.length > BRIEFING_REFUSAL_RECORD_MAX_CHARS
      ? `${markdown.slice(0, BRIEFING_REFUSAL_RECORD_MAX_CHARS)}\n\n[The record continues; it was cut here for length.]`
      : markdown;
  const heading =
    "## Refusal record — the platform's account of every refusal and outcome " +
    `(version ${result.version}${result.cached ? ", the last copy read" : ""})`;
  return `${heading}\n${capped}`;
}

/** Resolve `promise`, or `fallback` once the shared deadline passes. */
function within<T, F>(promise: Promise<T>, deadline: Promise<typeof TIMED_OUT>, fallback: F): Promise<T | F> {
  return Promise.race([promise, deadline]).then(
    (value) => (value === TIMED_OUT ? fallback : (value as T)),
    () => fallback,
  );
}

/**
 * Gather the briefing. Resolves within the budget and never rejects;
 * `undefined` when there are no versions of the agent's own to list and
 * nothing could be read from the host.
 */
export async function buildSelfTaskBriefing(opts: SelfTaskBriefingOptions): Promise<string | undefined> {
  let componentsDir = opts.componentsDir;
  if (componentsDir === undefined && !opts.discover) {
    try {
      componentsDir = getConfig().runtime.componentsDir;
    } catch {
      componentsDir = undefined;
    }
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), opts.budgetMs ?? BRIEFING_BUDGET_MS);
    timer.unref?.();
  });

  // The lineage section races its own listing against the deadline and
  // falls back to the versions on disk. Its backstop, which only catches a
  // version scan that never finishes, fires one macrotask later so that
  // fallback always settles first.
  const backstop = deadline.then(
    () => new Promise<typeof TIMED_OUT>((resolve) => setImmediate(() => resolve(TIMED_OUT))),
  );

  const unreadable = { text: LINEAGE_UNREADABLE, hasVersions: false };
  const missing: Unavailable = { unavailable: "not read in time" };
  try {
    const [lineage, failureModes, refusalRecord] = await Promise.all([
      within(lineageSection(opts, componentsDir, deadline, startedAt), backstop, TIMED_OUT).then((section) => {
        if (section !== TIMED_OUT) return section;
        warnUnreadable("section_timed_out", startedAt);
        return unreadable;
      }),
      within((opts.readFailureModes ?? (() => readFailureModes()))(), deadline, missing),
      within((opts.readRefusalRecord ?? (() => readRefusalRecord()))(), deadline, missing),
    ]);

    const failureText = failureModesSection(failureModes);
    const refusalText = refusalRecordSection(refusalRecord);
    if (!lineage.hasVersions && failureText === undefined && refusalText === undefined) {
      return undefined;
    }
    return [
      BRIEFING_INTRO,
      `## Your recent component versions (newest first)\n${lineage.text}`,
      failureText,
      refusalText,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}
