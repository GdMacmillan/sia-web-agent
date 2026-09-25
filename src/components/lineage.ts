/**
 * Component lineage in graph memory — the pure half.
 *
 * Every component version the agent prepares gets one `component_version`
 * entity in the workspace's graph memory, titled `<name>@<version>` and
 * linked to its parent with a `SUPERSEDES` edge. The entity is written by
 * the component tools (not by the model), starts as a `candidate`, and is
 * settled once the host reports the verdict. Every agent in the workspace
 * can read it, which is what makes one agent's history usable by another.
 *
 * This module knows nothing about I/O: it builds entity bodies, maps the
 * host's result words, and decides what a pending version should do given
 * what the host currently reports. See `docs/COMPONENTS.md` §6.
 */

import type { ComponentManifest } from "./manifest.js";
import type { EntityStoreInput } from "../vendor/svc-rpc/graph-memory/entity-shape.js";
import {
  COMPONENT_VERSION_ENTITY_TYPE,
  SUPERSEDES_RELATIONSHIP,
} from "../vendor/svc-rpc/graph-memory/tool-handlers.js";

export const LINEAGE_ENTITY_TYPE = COMPONENT_VERSION_ENTITY_TYPE;
export const SUPERSEDES = SUPERSEDES_RELATIONSHIP;

/**
 * Where a version stands. `candidate` until the host decides; the other
 * five are terminal. `failed` is the author giving up before a candidate
 * ever reached the host, or the host failing to apply one. `abandoned` is
 * never sent by the host — it is this side's own conclusion that a
 * candidate's story simply ended without a verdict from anyone: it was
 * never announced (the self-task that was building it ended, or a
 * restart caught it mid-flight), or a later candidate for the same
 * component took its place in the host's slot before it was decided.
 * Unlike `rejected` and `reverted`, `abandoned` carries no judgment on
 * the change itself — it is fine to retry or resume the work.
 */
export const OUTCOMES = [
  "candidate",
  "converged",
  "reverted",
  "failed",
  "rejected",
  "abandoned",
] as const;
export type LineageOutcome = (typeof OUTCOMES)[number];

export type SettledOutcome = Exclude<LineageOutcome, "candidate">;

export function isLineageOutcome(value: unknown): value is LineageOutcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/** The exact title every lookup depends on. */
export function lineageTitle(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Inverse of {@link lineageTitle}; `null` for anything that is not `name@version`. */
export function parseLineageRef(ref: string): { name: string; version: string } | null {
  const at = ref.indexOf("@");
  if (at <= 0 || at === ref.length - 1) {
    return null;
  }
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

export interface LineageEntityInput {
  name: string;
  version: string;
  depth: number;
  need?: string;
  /** `name@version` of the version this one was derived from. */
  parent?: string;
  producedBy: string;
  threadId?: string;
  outcome: LineageOutcome;
  reason?: string;
}

/** Underscore spelling, the name a tool built from the component tends to carry. */
function underscored(name: string): string {
  return name.replace(/-/g, "_");
}

function outcomeLine(outcome: LineageOutcome, reason?: string): string {
  const base =
    outcome === "candidate"
      ? "Outcome: candidate — waiting for the host's verdict."
      : `Outcome: ${outcome}.`;
  return reason ? `${base} Reason: ${reason}` : base;
}

/**
 * Build the `store_entity` input for one version. The prose carries
 * everything a stranger needs (both spellings of the component, the need
 * verbatim, the thread); `metadata` is the structured copy. Nothing
 * node-private goes in.
 */
export function buildLineageEntity(input: LineageEntityInput): EntityStoreInput {
  const { name, version } = input;
  const alt = underscored(name);
  const title = lineageTitle(name, version);

  const lines = [
    `${title} is version ${version} of the ${name} component` +
      (alt !== name ? ` (its tool is ${alt}).` : "."),
    input.parent
      ? `It supersedes ${input.parent}.`
      : "It has no parent; it is the root of its lineage.",
    input.need ? `Need: ${input.need}` : undefined,
    input.threadId ? `Produced in thread ${input.threadId} by ${input.producedBy}.` : `Produced by ${input.producedBy}.`,
    `Depth: ${input.depth}.`,
    outcomeLine(input.outcome, input.reason),
  ].filter((line): line is string => typeof line === "string");

  const tags = [
    LINEAGE_ENTITY_TYPE,
    `component:${name}`,
    name,
    ...(alt !== name ? [alt] : []),
    `version:${version}`,
    `outcome:${input.outcome}`,
    `produced-by:${input.producedBy}`,
  ];

  const provenance: Record<string, string> = { produced_by: input.producedBy };
  if (input.parent) {
    provenance.parent = input.parent;
  }

  const metadata: Record<string, unknown> = {
    component: name,
    version,
    ...(input.need !== undefined ? { need: input.need } : {}),
    ...(input.threadId !== undefined ? { thread_id: input.threadId } : {}),
    depth: input.depth,
    provenance,
    outcome: input.outcome,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };

  return {
    entity_type: LINEAGE_ENTITY_TYPE,
    title,
    content: lines.join("\n"),
    context: `${LINEAGE_ENTITY_TYPE} ${name}`,
    tags,
    priority: "medium",
    status: input.outcome === "candidate" ? "active" : "completed",
    abstraction_level: "raw",
    metadata,
  };
}

/**
 * The entity for a version that is already current on the host but has
 * no entity yet (a seed, or a version prepared before lineage was
 * recorded). It is `converged` by definition — the host is running it.
 */
export function buildParentEntity(manifest: ComponentManifest): EntityStoreInput {
  return buildLineageEntity({
    name: manifest.name,
    version: manifest.version,
    depth: manifest.depth,
    need: manifest.lineage.need,
    parent: manifest.lineage.parent,
    producedBy: manifest.lineage.producedBy,
    outcome: "converged",
  });
}

/** The host's result words for an applied candidate, mapped onto ours. */
export function outcomeFromHostResult(result: string | undefined): SettledOutcome | null {
  switch (result) {
    case "activated":
      return "converged";
    case "reverted":
      return "reverted";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** One component as the host reports it (`GET /status` → `node.components.components[]`). */
export interface HostComponentView {
  name: string;
  active?: string;
  previous?: string;
  candidate?: { version: string; threadId?: string; announcedAt?: string };
  lastOutcome?: { version: string; result: string; at?: string; error?: string };
  versions: string[];
}

export interface PendingVersion {
  name: string;
  version: string;
}

/**
 * A pending version paired with whether its candidate event ever reached
 * the host. This is the only fact that lets {@link decideReconcile} tell
 * a version that vanished because nobody has seen it yet (still being
 * written by a live self-task, possibly in another thread) from one that
 * vanished because the host actually held it and then let it go.
 */
export interface TrackedPendingVersion extends PendingVersion {
  announced: boolean;
}

export interface Verdict {
  outcome: SettledOutcome;
  reason?: string;
  at?: string;
}

export type ReconcileDecision =
  | ({ action: "settle" } & Verdict)
  | { action: "wait" }
  | { action: "unknown" };

/**
 * What to do about one pending version given the host's current view.
 *
 * - `hostView === null`: the host reports no component store at all (an
 *   older daemon, or a request that failed) — decide nothing.
 * - the host's last outcome names this version → settle with that verdict.
 * - it is the candidate, or the active version without a verdict yet
 *   (a swap in flight) → wait.
 * - it was never announced → it may still be under construction (a
 *   self-task in another thread can be mid-`prepare`/`run`/edit when a
 *   turn elsewhere runs this check — `recordLineage` tracks a version the
 *   moment it is written, long before it is announced). A turn never
 *   settles this. Only a boot pass may, since a restart ends any
 *   self-task that was still running: `abandoned`, "never announced".
 * - it was announced, but a *different* candidate now occupies the
 *   host's slot for this component → nobody rejected this one; a newer
 *   one simply replaced it before a verdict arrived: `abandoned`,
 *   "replaced by `<version>`".
 * - otherwise it is genuinely gone with nothing having taken its place.
 *   A keeper's reject leaves no outcome behind, so that means rejected —
 *   at once on a turn, and at boot only once the poll has waited long
 *   enough for a swap in flight to be recorded.
 */
export function decideReconcile(
  pending: TrackedPendingVersion,
  hostView: HostComponentView[] | null,
  phase: "boot" | "turn",
  capReached: boolean,
): ReconcileDecision {
  if (hostView === null) {
    return { action: "unknown" };
  }
  const component = hostView.find((c) => c.name === pending.name);
  const last = component?.lastOutcome;
  if (last && last.version === pending.version) {
    const outcome = outcomeFromHostResult(last.result);
    if (!outcome) {
      return { action: "wait" };
    }
    return {
      action: "settle",
      outcome,
      ...(last.error ? { reason: last.error } : {}),
      ...(last.at ? { at: last.at } : {}),
    };
  }
  if (component?.candidate?.version === pending.version || component?.active === pending.version) {
    return { action: "wait" };
  }
  if (!pending.announced) {
    return phase === "boot"
      ? { action: "settle", outcome: "abandoned", reason: "never announced" }
      : { action: "wait" };
  }
  if (component?.candidate && component.candidate.version !== pending.version) {
    return {
      action: "settle",
      outcome: "abandoned",
      reason: `replaced by ${component.candidate.version}`,
    };
  }
  if (phase === "boot" && !capReached) {
    return { action: "wait" };
  }
  return { action: "settle", outcome: "rejected" };
}

export interface SettlePayload {
  tags: string[];
  status: "completed";
  metadata: { outcome: SettledOutcome; reason?: string; settled_at: string };
  contentLine: string;
}

/** The update that settles an entity: tag flip, completion, verdict line. */
export function settlePayload(
  currentTags: string[],
  verdict: Verdict,
  now: () => string = () => new Date().toISOString(),
): SettlePayload {
  const tags = [
    ...currentTags.filter((tag) => !tag.startsWith("outcome:")),
    `outcome:${verdict.outcome}`,
  ];
  return {
    tags,
    status: "completed",
    metadata: {
      outcome: verdict.outcome,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      settled_at: verdict.at ?? now(),
    },
    contentLine: outcomeLine(verdict.outcome, verdict.reason),
  };
}
