/**
 * Situation context middleware.
 *
 * Tells the model what the host currently reports about its own process
 * — whether its source tree has drifted from the version the host staged,
 * and which upstreams the host offers its components — as one tagged
 * context message appended to each model request. These facts change
 * while the process runs, so they belong in the request, never in the
 * byte-stable system prompt.
 *
 * Request-only: nothing is written back to graph state. The facts are read
 * in the background and reused: a warm cache costs a request nothing, a
 * stale one is served while it refreshes, and only the very first request
 * of the process waits for a read — and then for at most `firstWaitMs`.
 * A fact the host has not reported is left out, and so is one whose reads
 * have been failing for longer than `keepLastGoodMs` (an idle process keeps
 * its last value: nothing has failed). When neither fact is known there is
 * no message at all. Nothing here throws into the model call.
 */

import { createMiddleware, type AgentMiddleware } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { wrapHostContext } from "../utils/host-context.js";
import { resolveHostEndpoint } from "../utils/host-fetch.js";
import {
  readHostStatus,
  type HostAgentSourceView,
} from "../components/lineage-host.js";
import {
  createComponentHost,
  type HostUpstream,
} from "../components/host.js";

export const SITUATION_CONTEXT_MIDDLEWARE_NAME = "situationContextMiddleware";

/** The most paths of one kind named in the drift line. */
export const SITUATION_PATHS_PER_KIND = 10;

/** What the host reports right now. Each half is `undefined` when unknown. */
export interface SituationFacts {
  agentSource?: HostAgentSourceView;
  upstreams?: HostUpstream[];
}

function pathList(kind: string, paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const shown = paths.slice(0, SITUATION_PATHS_PER_KIND).join(", ");
  const more = paths.length - SITUATION_PATHS_PER_KIND;
  return `${kind}: ${shown}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * The drift line, or `undefined` when the host could not compare the tree
 * against its baseline (any `baseline` other than `"ok"`).
 */
export function formatAgentSourceLine(
  source: HostAgentSourceView | undefined,
): string | undefined {
  if (!source || source.baseline !== "ok") {
    return undefined;
  }
  const staged = source.version
    ? `version ${source.version} as the host staged it`
    : "the version the host staged";
  const checked = source.checkedAt ? `, checked ${source.checkedAt}` : "";
  const listed = source.modified.length + source.added.length + source.removed.length;
  const count = listed + source.truncated;
  if (count === 0) {
    return `Agent source: unchanged from ${staged}${checked}.`;
  }
  const parts = [
    pathList("modified", source.modified),
    pathList("added", source.added),
    pathList("removed", source.removed),
    source.truncated > 0 ? `${source.truncated} more not listed` : undefined,
  ].filter((part): part is string => part !== undefined);
  const files = count === 1 ? "1 file differs" : `${count} files differ`;
  return `Agent source: ${files} from ${staged} (${parts.join("; ")})${checked}.`;
}

/** The upstreams line, or `undefined` when the host has not listed them. */
export function formatUpstreamsLine(
  upstreams: HostUpstream[] | undefined,
): string | undefined {
  if (upstreams === undefined) {
    return undefined;
  }
  const names = upstreams.map((u) => u.name).filter((name) => name !== "");
  return `Upstreams the host offers your components: ${names.length > 0 ? names.join(", ") : "none"}.`;
}

/** The message body, or `undefined` when nothing is known. */
export function formatSituation(facts: SituationFacts): string | undefined {
  const lines = [
    formatAgentSourceLine(facts.agentSource),
    formatUpstreamsLine(facts.upstreams),
  ].filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The one place the situation is wrapped as host context. Kept to a single
 * function so the envelope can change without touching the rest.
 */
export function situationContextMessage(body: string): HumanMessage {
  return new HumanMessage({ content: wrapHostContext({ source: "host", kind: "situation" }, body) });
}

export interface SituationCacheOptions {
  /** One read of both facts. May reject; a rejection reads as nothing known. */
  read: () => Promise<SituationFacts>;
  /** How long a read is reused before the next one starts. */
  ttlMs?: number;
  /** How long the first request of the process waits for the first read. */
  firstWaitMs?: number;
  /** How long a fact is kept once reads stop returning it. */
  keepLastGoodMs?: number;
  /** A read that has not settled by then counts as failed, so the next can start. */
  readTimeoutMs?: number;
  now?: () => number;
}

export const SITUATION_TTL_MS = 60_000;
export const SITUATION_FIRST_WAIT_MS = 1_000;
export const SITUATION_KEEP_LAST_GOOD_MS = 10 * 60_000;
export const SITUATION_READ_TIMEOUT_MS = 10_000;

/** Resolve `promise`, or reject once `ms` passes. The timer never holds the process open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("situation read timed out")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface SituationCache {
  /** The facts to show now. Never rejects. */
  get(): Promise<SituationFacts>;
}

/**
 * A stale-while-revalidate cache over `read`. Each fact keeps its own
 * last good value, so a read that loses one half does not erase the other.
 */
export function createSituationCache(opts: SituationCacheOptions): SituationCache {
  const ttlMs = opts.ttlMs ?? SITUATION_TTL_MS;
  const firstWaitMs = opts.firstWaitMs ?? SITUATION_FIRST_WAIT_MS;
  const keepMs = opts.keepLastGoodMs ?? SITUATION_KEEP_LAST_GOOD_MS;
  const readTimeoutMs = opts.readTimeoutMs ?? SITUATION_READ_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  let agentSource: { value: HostAgentSourceView; at: number } | undefined;
  let upstreams: { value: HostUpstream[]; at: number } | undefined;
  let lastAttemptAt: number | undefined;
  let inflight: Promise<void> | undefined;
  // The one bounded wait of the process: started by the first call, shared
  // by any call that arrives while it runs, never started again.
  let firstWait: Promise<void> | undefined;
  let firstWaitOver = false;

  const refresh = (): Promise<void> => {
    lastAttemptAt = now();
    const run = (async () => {
      try {
        const facts = await withTimeout(opts.read(), readTimeoutMs);
        const at = now();
        if (facts.agentSource) agentSource = { value: facts.agentSource, at };
        else if (agentSource && at - agentSource.at > keepMs) agentSource = undefined;
        if (facts.upstreams) upstreams = { value: facts.upstreams, at };
        else if (upstreams && at - upstreams.at > keepMs) upstreams = undefined;
      } catch {
        // Nothing known from this read: each last good value stands until
        // reads have failed to renew it for longer than the keep window.
        const at = now();
        if (agentSource && at - agentSource.at > keepMs) agentSource = undefined;
        if (upstreams && at - upstreams.at > keepMs) upstreams = undefined;
      } finally {
        inflight = undefined;
      }
    })();
    inflight = run;
    return run;
  };

  const current = (): SituationFacts => ({
    ...(agentSource ? { agentSource: agentSource.value } : {}),
    ...(upstreams ? { upstreams: upstreams.value.map((u) => ({ ...u })) } : {}),
  });

  return {
    async get(): Promise<SituationFacts> {
      try {
        if (!inflight && (lastAttemptAt === undefined || now() - lastAttemptAt >= ttlMs)) {
          void refresh();
        }
        if (!firstWaitOver && inflight) {
          if (!firstWait) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const budget = new Promise<void>((resolve) => {
              timer = setTimeout(resolve, firstWaitMs);
              timer.unref?.();
            });
            firstWait = Promise.race([inflight, budget]).finally(() => {
              clearTimeout(timer);
              firstWaitOver = true;
            });
          }
          await firstWait;
        }
        return current();
      } catch {
        return {};
      }
    },
  };
}

export interface SituationContextMiddlewareOptions {
  /** Replaces the cache (tests). */
  cache?: SituationCache;
  /** Overrides the host endpoint lookup and transport (tests). */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Timeout of each background read of the host. */
  readTimeoutMs?: number;
}

/** Read both facts from the host the process was spawned with. */
function hostSituationReader(
  opts: SituationContextMiddlewareOptions,
): () => Promise<SituationFacts> {
  const endpoint = resolveHostEndpoint({ env: opts.env });
  if (!endpoint) {
    return async () => ({});
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.readTimeoutMs ?? 5_000;
  const host = createComponentHost({
    env: opts.env,
    fetchImpl,
    listTimeoutMs: timeoutMs,
  });
  return async () => {
    const [status, offered] = await Promise.all([
      readHostStatus(fetchImpl, endpoint.url, endpoint.token, timeoutMs),
      host.upstreams().catch(() => undefined),
    ]);
    return {
      ...(status.agentSource ? { agentSource: status.agentSource } : {}),
      ...(offered ? { upstreams: offered } : {}),
    };
  };
}

/** Create the situation context middleware. */
export function createSituationContextMiddleware(
  options: SituationContextMiddlewareOptions = {},
): AgentMiddleware {
  let cache = options.cache;
  const cacheOf = (): SituationCache => {
    cache ??= createSituationCache({ read: hostSituationReader(options) });
    return cache;
  };

  return createMiddleware({
    name: SITUATION_CONTEXT_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      let body: string | undefined;
      try {
        body = formatSituation(await cacheOf().get());
      } catch {
        body = undefined;
      }
      if (!body) {
        return handler(request);
      }
      return handler({
        ...request,
        messages: [...request.messages, situationContextMessage(body)],
      });
    },
  });
}
