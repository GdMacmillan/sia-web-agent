/**
 * `deps.host` — authenticated APIs reached through the host, by upstream
 * name. See `docs/COMPONENTS.md` §5 and `docs/HOST_CONTRACT.md` §3.7.
 *
 * The host holds the credential for each upstream it has configured and
 * injects it on the way out; this process only ever names the upstream.
 * Nothing here reads, returns or logs the agent's own host token: it is
 * attached by `hostFetch` and goes no further.
 */

import {
  hostFetch,
  resolveHostEndpoint,
  type ResolveHostEndpointOptions,
} from "../utils/host-fetch.js";

/** One upstream the host will call on the agent's behalf. */
export interface HostUpstream {
  name: string;
  /** `host[:port]` the upstream is pinned to. */
  host: string;
}

export interface ComponentHost {
  /**
   * Call `path` (with any query) on the upstream the host knows as
   * `upstream`. The host adds the credential; a caller's `Authorization`
   * is never sent. Throws before any request when the host lists its
   * upstreams and `upstream` is not one of them.
   */
  fetch(upstream: string, path: string, init?: RequestInit): Promise<Response>;
  /**
   * The upstreams the host will call for this agent, or `undefined` when
   * that is unknown (no host, or one that does not list them).
   */
  upstreams(): Promise<HostUpstream[] | undefined>;
}

export interface CreateComponentHostOptions extends ResolveHostEndpointOptions {
  fetchImpl?: typeof fetch;
  /** How long a listing is reused before `fetch` asks again. */
  cacheMs?: number;
  /** Timeout for the listing request. */
  listTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_LIST_TIMEOUT_MS = 5_000;

/** The exact message a missing upstream fails with. */
export function upstreamNotConfiguredMessage(
  name: string,
  available: readonly HostUpstream[],
): string {
  const names = available.map((u) => u.name).join(", ") || "none";
  return `upstream "${name}" is not configured on this host (available: ${names}) — ask the host's owner to configure it`;
}

function isDotSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not valid percent-encoding: judge it as written.
  }
  return decoded.split("\\").some((part) => part === "." || part === "..");
}

/** `/egress/<upstream>/<path>`; throws on a path that could leave the upstream. */
export function egressPath(upstream: string, path: string): string {
  if (typeof upstream !== "string" || upstream === "") {
    throw new Error("host.fetch: an upstream name is required");
  }
  const raw = typeof path === "string" ? path : "";
  const cut = raw.search(/[?#]/);
  const pathname = cut < 0 ? raw : raw.slice(0, cut);
  const suffix = cut < 0 ? "" : raw.slice(cut);
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (segments.some(isDotSegment)) {
    throw new Error(
      `host.fetch: path ${JSON.stringify(raw)} must not contain "." or ".." segments`,
    );
  }
  return `/egress/${encodeURIComponent(upstream)}/${segments.join("/")}${suffix}`;
}

/** Rebuild a listing field by field; `undefined` when it is not one. */
export function parseUpstreams(body: unknown): HostUpstream[] | undefined {
  const list =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).upstreams
      : undefined;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const upstreams: HostUpstream[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { name, host } = entry as Record<string, unknown>;
    if (typeof name === "string" && name !== "") {
      upstreams.push({ name, host: typeof host === "string" ? host : "" });
    }
  }
  return upstreams;
}

/** A `deps.host` bound to the host endpoint the process was spawned with. */
export function createComponentHost(
  opts: CreateComponentHostOptions = {},
): ComponentHost {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  const listTimeoutMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: HostUpstream[] | undefined } | undefined;

  const list = async (): Promise<HostUpstream[] | undefined> => {
    const endpoint = resolveHostEndpoint(opts);
    if (!endpoint) {
      return undefined;
    }
    let res: Response;
    try {
      res = await hostFetch(
        endpoint,
        "/egress",
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(listTimeoutMs),
        },
        fetchImpl,
      );
    } catch {
      return undefined;
    }
    if (res.status === 404 || res.status === 405) {
      // A host that predates the listing: stable, so worth remembering.
      cached = { at: now(), value: undefined };
      return undefined;
    }
    if (!res.ok) {
      return undefined;
    }
    let value: HostUpstream[] | undefined;
    try {
      value = parseUpstreams(await res.json());
    } catch {
      return undefined;
    }
    if (value !== undefined) {
      cached = { at: now(), value };
    }
    return value;
  };

  const upstreams = async (): Promise<HostUpstream[] | undefined> => {
    const value =
      cached && now() - cached.at < cacheMs ? cached.value : await list();
    return value?.map((u) => ({ ...u }));
  };

  return Object.freeze({
    upstreams,
    async fetch(
      upstream: string,
      path: string,
      init?: RequestInit,
    ): Promise<Response> {
      const target = egressPath(upstream, path);
      const endpoint = resolveHostEndpoint(opts);
      if (!endpoint) {
        throw new Error(
          "host.fetch: this agent has no host token (SIA_DAEMON_TOKEN), so it cannot call upstreams through the host",
        );
      }
      const available = await upstreams();
      if (
        available !== undefined &&
        !available.some((u) => u.name === upstream)
      ) {
        throw new Error(upstreamNotConfiguredMessage(upstream, available));
      }
      return hostFetch(endpoint, target, init, fetchImpl);
    },
  });
}
