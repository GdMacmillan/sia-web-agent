/**
 * Loopback calls to the host that spawned the agent: where it listens and
 * how a request is authenticated. See `docs/HOST_CONTRACT.md` §1.6.
 *
 * The bearer is the agent's own host token. It is attached here and nowhere
 * else, and no caller-supplied `Authorization` survives — a request through
 * this helper is always the agent's, never one a caller dressed up.
 */

/** Where the host listens when `SIA_DAEMON_URL` is unset. */
export const DEFAULT_HOST_URL = "http://127.0.0.1:7700";

export interface HostEndpoint {
  /** Base URL, no trailing slash. */
  url: string;
  token: string;
}

export interface ResolveHostEndpointOptions {
  /** Overrides `SIA_DAEMON_URL`. */
  url?: string;
  /** Overrides `SIA_DAEMON_TOKEN`. */
  token?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The host endpoint, or `undefined` when the agent has no host token — a
 * standalone run, where every authenticated host call would be refused.
 */
export function resolveHostEndpoint(
  opts: ResolveHostEndpointOptions = {},
): HostEndpoint | undefined {
  const env = opts.env ?? process.env;
  const token = (opts.token ?? env.SIA_DAEMON_TOKEN ?? "").trim();
  if (!token) {
    return undefined;
  }
  const url = (opts.url ?? env.SIA_DAEMON_URL ?? "").trim() || DEFAULT_HOST_URL;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * `fetch` against the host. `path` is appended to the base URL as given
 * (it must start with `/`); the bearer replaces any `Authorization` in
 * `init.headers`.
 */
export function hostFetch(
  endpoint: HostEndpoint,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${endpoint.token}`);
  return fetchImpl(`${endpoint.url}${path}`, { ...init, headers });
}
