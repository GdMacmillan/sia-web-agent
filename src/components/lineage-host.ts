/**
 * The one read the agent makes of the host's `GET /status`: the component
 * store it reports (for the lineage reconciler) and the drift of the
 * agent's own source tree against what the host staged (for the situation
 * context). See `docs/HOST_CONTRACT.md` §3.5.
 *
 * `null` means the host reported no component store at all — an older
 * daemon, or a request that failed — and the caller must not decide
 * anything from it. An empty array means the host reported a store with
 * no components in it.
 */

import type { HostComponentView } from "./lineage.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Rebuild one component entry field by field; anything malformed is dropped. */
export function parseHostComponent(raw: unknown): HostComponentView | null {
  const record = asRecord(raw);
  const name = record ? asString(record.name) : undefined;
  if (!record || !name) {
    return null;
  }
  const candidateRecord = asRecord(record.candidate);
  const candidateVersion = candidateRecord ? asString(candidateRecord.version) : undefined;
  const outcomeRecord = asRecord(record.lastOutcome);
  const outcomeVersion = outcomeRecord ? asString(outcomeRecord.version) : undefined;
  const outcomeResult = outcomeRecord ? asString(outcomeRecord.result) : undefined;
  const rejected = parseRejected(record.rejected);
  const versions = Array.isArray(record.versions)
    ? record.versions.filter((v): v is string => typeof v === "string")
    : [];

  return {
    name,
    ...(asString(record.active) ? { active: asString(record.active) } : {}),
    ...(asString(record.previous) ? { previous: asString(record.previous) } : {}),
    ...(candidateRecord && candidateVersion
      ? {
          candidate: {
            version: candidateVersion,
            ...(asString(candidateRecord.threadId)
              ? { threadId: asString(candidateRecord.threadId) }
              : {}),
            ...(asString(candidateRecord.announcedAt)
              ? { announcedAt: asString(candidateRecord.announcedAt) }
              : {}),
          },
        }
      : {}),
    ...(outcomeRecord && outcomeVersion && outcomeResult
      ? {
          lastOutcome: {
            version: outcomeVersion,
            result: outcomeResult,
            ...(asString(outcomeRecord.at) ? { at: asString(outcomeRecord.at) } : {}),
            ...(asString(outcomeRecord.error) ? { error: asString(outcomeRecord.error) } : {}),
            ...(asString(outcomeRecord.decisionReason)
              ? { decisionReason: asString(outcomeRecord.decisionReason) }
              : {}),
          },
        }
      : {}),
    ...(rejected ? { rejected } : {}),
    versions,
  };
}

/** Rebuild the declined-versions map; entries that are not objects are dropped. */
function parseRejected(raw: unknown): HostComponentView["rejected"] | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const out: NonNullable<HostComponentView["rejected"]> = {};
  for (const [version, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (!version || !entry) {
      continue;
    }
    out[version] = {
      ...(asString(entry.at) ? { at: asString(entry.at) } : {}),
      ...(asString(entry.decisionReason) ? { decisionReason: asString(entry.decisionReason) } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drift of the agent's own source tree against the tree the host staged.
 * `baseline` is the host's word for whether the comparison could be made
 * at all; only `"ok"` means the path lists are meaningful.
 */
export interface HostAgentSourceView {
  version?: string;
  checkedAt?: string;
  baseline: string;
  modified: string[];
  added: string[];
  removed: string[];
  truncated: number;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}

/** Rebuild the drift report field by field; `null` when it has no baseline word. */
export function parseHostAgentSource(raw: unknown): HostAgentSourceView | null {
  const record = asRecord(raw);
  const baseline = record ? asString(record.baseline) : undefined;
  if (!record || !baseline) {
    return null;
  }
  const truncated =
    typeof record.truncated === "number" && Number.isInteger(record.truncated) && record.truncated > 0
      ? record.truncated
      : 0;
  return {
    ...(asString(record.version) ? { version: asString(record.version) } : {}),
    ...(asString(record.checkedAt) ? { checkedAt: asString(record.checkedAt) } : {}),
    baseline,
    modified: stringList(record.modified),
    added: stringList(record.added),
    removed: stringList(record.removed),
    truncated,
  };
}

/** Reduce a `/status` body to the component store, or `null` when it has none. */
export function parseHostStatus(body: unknown): HostComponentView[] | null {
  return parseHostStatusView(body).components;
}

/** Everything the agent reads from one `/status` body. Each half is `null` when absent. */
export interface HostStatusView {
  components: HostComponentView[] | null;
  agentSource: HostAgentSourceView | null;
}

/** Reduce a `/status` body to both halves the agent reads. */
export function parseHostStatusView(body: unknown): HostStatusView {
  const root = asRecord(body);
  const node = root ? asRecord(root.node) : undefined;
  const store = node ? asRecord(node.components) : undefined;
  const components =
    store && Array.isArray(store.components)
      ? store.components
          .map((entry) => parseHostComponent(entry))
          .filter((entry): entry is HostComponentView => entry !== null)
      : null;
  return {
    components,
    agentSource: node ? parseHostAgentSource(node.agentSource) : null,
  };
}

/**
 * Read the host's component store. Never throws: a transport error, a
 * non-2xx answer, a body that is not JSON, or a body without a component
 * store all read as `null`. `daemonToken`, when a non-empty string, is
 * sent as a bearer token; absent or empty, the request carries no
 * `authorization` header at all.
 */
export async function readHostComponents(
  fetchImpl: FetchLike,
  daemonUrl: string,
  daemonToken?: string,
  timeoutMs = 5_000,
): Promise<HostComponentView[] | null> {
  return (await readHostStatus(fetchImpl, daemonUrl, daemonToken, timeoutMs)).components;
}

const NOTHING_REPORTED: HostStatusView = { components: null, agentSource: null };

/**
 * Read the host's `/status` once and return both halves. Same failure
 * rules as {@link readHostComponents}: never throws, and anything that
 * goes wrong reads as nothing reported.
 */
export async function readHostStatus(
  fetchImpl: FetchLike,
  daemonUrl: string,
  daemonToken?: string,
  timeoutMs = 5_000,
): Promise<HostStatusView> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A stuck read must never be what keeps the process alive.
  timer.unref?.();
  try {
    const res = await fetchImpl(`${daemonUrl.replace(/\/+$/, "")}/status`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return NOTHING_REPORTED;
    }
    return parseHostStatusView(await res.json());
  } catch {
    return NOTHING_REPORTED;
  } finally {
    clearTimeout(timer);
  }
}
