/**
 * Two read-only knowledge calls the agent makes through its host:
 *
 * - the **refusal record** — the platform's account of every refusal code
 *   and outcome a keeper decision can meet, who says it and what to do;
 * - the **failure-modes catalogue** — what the agent's keeper wrote down
 *   about how this agent tends to fail.
 *
 * Both go over the host's service-call endpoint with the agent's own host
 * token (`docs/HOST_CONTRACT.md` §3.8). Neither is a write, and the agent
 * never says whose catalogue it wants: it sends an empty request and the
 * host fills in the caller from the token, so an agent can only ever read
 * its own.
 *
 * Every function here resolves — a failure is `{ unavailable }`, never a
 * throw — because callers use these to enrich work, never to gate it.
 */

import { getConfig } from "../config/index.js";
import {
  DB_SCHEMA_HASH,
  DB_SERVICE,
  DB_SERVICE_VERSION,
  FAILURE_MODES_VERB,
  FAILURE_MODES_VERB_HASH,
  REFUSAL_RECORD_VERB,
  REFUSAL_RECORD_VERB_HASH,
} from "../vendor/svc-rpc/db/knowledge-hashes.js";
import { resolveHostEndpoint } from "../utils/host-fetch.js";
import { callHostRpc } from "../utils/host-rpc.js";

/** Longest one knowledge call may take. */
export const KNOWLEDGE_DEADLINE_MS = 2_500;

export interface Unavailable {
  unavailable: string;
}

export interface RefusalRecord {
  version: number;
  markdown: string;
  /** Set when the host could not be read and this is the last copy seen. */
  cached?: true;
}

export interface FailureModes {
  /** What the keeper wrote, verbatim; `null` when nothing has been written. */
  body: string | null;
  updatedAt: string | null;
}

export interface HostKnowledgeOptions {
  /** Overrides `SIA_DAEMON_URL` / `SIA_DAEMON_TOKEN`. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the configured workspace id. */
  workspaceId?: string;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
}

let cachedRecord: { version: number; markdown: string } | undefined;

/** Test hook: forget the cached refusal record. */
export function _resetHostKnowledgeCacheForTests(): void {
  cachedRecord = undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveWorkspaceId(opts: HostKnowledgeOptions): string {
  if (opts.workspaceId !== undefined) return opts.workspaceId;
  try {
    return getConfig().runtime.workspaceId ?? "";
  } catch {
    return "";
  }
}

/** Bound a promise; a call that never answers counts as a failure. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callKnowledge<T>(
  verb: string,
  verbHash: string,
  opts: HostKnowledgeOptions,
): Promise<T | Unavailable> {
  const endpoint = resolveHostEndpoint({ env: opts.env });
  if (!endpoint) {
    return { unavailable: "no host token" };
  }
  const workspaceId = resolveWorkspaceId(opts);
  if (!workspaceId) {
    return { unavailable: "no workspace id" };
  }
  const deadlineMs = opts.deadlineMs ?? KNOWLEDGE_DEADLINE_MS;
  try {
    return await withDeadline(
      callHostRpc<Record<string, never>, T>({
        url: endpoint.url,
        token: endpoint.token,
        workspaceId,
        service: DB_SERVICE,
        serviceVersion: DB_SERVICE_VERSION,
        verb,
        schemaHash: DB_SCHEMA_HASH,
        verbHash,
        // Empty on purpose for both verbs: the refusal record takes no
        // input, and the host names the caller for the catalogue.
        payload: {},
        deadlineMs,
        errorPrefix: "host knowledge",
        fetchImpl: opts.fetchImpl,
      }),
      deadlineMs,
    );
  } catch (error) {
    return { unavailable: errorMessage(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * The platform's refusal record. Cached in-process by `version`; when the
 * host cannot be read, the last copy seen is returned marked `cached`.
 */
export async function readRefusalRecord(
  opts: HostKnowledgeOptions = {},
): Promise<RefusalRecord | Unavailable> {
  const result = await callKnowledge<unknown>(REFUSAL_RECORD_VERB, REFUSAL_RECORD_VERB_HASH, opts);
  if (
    isRecord(result) &&
    !("unavailable" in result) &&
    typeof result.version === "number" &&
    Number.isInteger(result.version) &&
    typeof result.markdown === "string"
  ) {
    if (cachedRecord?.version !== result.version || cachedRecord.markdown !== result.markdown) {
      cachedRecord = { version: result.version, markdown: result.markdown };
    }
    return { version: result.version, markdown: result.markdown };
  }
  if (cachedRecord) {
    return { ...cachedRecord, cached: true };
  }
  return isRecord(result) && typeof result.unavailable === "string"
    ? { unavailable: result.unavailable }
    : { unavailable: "malformed answer" };
}

/** The failure-modes catalogue the keeper wrote about this agent. */
export async function readFailureModes(
  opts: HostKnowledgeOptions = {},
): Promise<FailureModes | Unavailable> {
  const result = await callKnowledge<unknown>(FAILURE_MODES_VERB, FAILURE_MODES_VERB_HASH, opts);
  if (isRecord(result) && typeof result.unavailable === "string") {
    return { unavailable: result.unavailable };
  }
  if (
    isRecord(result) &&
    (typeof result.body === "string" || result.body === null) &&
    (typeof result.updatedAt === "string" || result.updatedAt === null)
  ) {
    return { body: result.body, updatedAt: result.updatedAt };
  }
  return { unavailable: "malformed answer" };
}
