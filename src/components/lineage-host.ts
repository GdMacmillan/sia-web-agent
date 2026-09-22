/**
 * The one read the lineage reconciler makes of the host: `GET /status`,
 * reduced to the component store it reports. See `docs/HOST_CONTRACT.md`
 * §3.5.
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
          },
        }
      : {}),
    versions,
  };
}

/** Reduce a `/status` body to the component store, or `null` when it has none. */
export function parseHostStatus(body: unknown): HostComponentView[] | null {
  const root = asRecord(body);
  const node = root ? asRecord(root.node) : undefined;
  const components = node ? asRecord(node.components) : undefined;
  if (!components || !Array.isArray(components.components)) {
    return null;
  }
  return components.components
    .map((entry) => parseHostComponent(entry))
    .filter((entry): entry is HostComponentView => entry !== null);
}

/**
 * Read the host's component store. Never throws: a transport error, a
 * non-2xx answer, a body that is not JSON, or a body without a component
 * store all read as `null`.
 */
export async function readHostComponents(
  fetchImpl: FetchLike,
  daemonUrl: string,
  timeoutMs = 5_000,
): Promise<HostComponentView[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${daemonUrl.replace(/\/+$/, "")}/status`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    return parseHostStatus(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
