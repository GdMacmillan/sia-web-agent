/**
 * `deps.host`: upstream calls go to the host's egress route with the
 * agent's own bearer (never a caller's), paths cannot leave the upstream,
 * a name the host does not list fails with the message that names it, an
 * older host that cannot list is not a failure, and the token never comes
 * back out of any of it.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  createComponentHost,
  egressPath,
  parseUpstreams,
  upstreamNotConfiguredMessage,
} from "../../../src/components/host.js";
import {
  buildComponentDeps,
  buildInternals,
} from "../../../src/components/sdk.js";
import type { ComponentManifest } from "../../../src/components/manifest.js";

const TOKEN = "agent-host-token-0123456789";
const URL_BASE = "http://127.0.0.1:7700";

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  headers: Headers;
}

function fakeHost(
  listing: { status: number; body?: unknown } | "throw" = {
    status: 200,
    body: { upstreams: [] },
  },
) {
  const seen: Seen[] = [];
  const fetchImpl = jest.fn(
    async (url: unknown, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        authorization: headers.get("authorization"),
        headers,
      });
      if (String(url) === `${URL_BASE}/egress`) {
        if (listing === "throw") throw new Error("connection refused");
        return new Response(JSON.stringify(listing.body ?? {}), {
          status: listing.status,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

const LISTED = {
  status: 200,
  body: {
    upstreams: [
      { name: "github", host: "api.github.com" },
      {
        name: "search",
        host: "api.example.com",
        value: "should-never-surface",
      },
    ],
  },
};

function host(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createComponentHost({
    url: URL_BASE,
    token: TOKEN,
    env: {},
    fetchImpl,
    ...extra,
  });
}

describe("egressPath", () => {
  it("encodes the upstream and keeps the path and query", () => {
    expect(egressPath("github", "/user/repos?per_page=5")).toBe(
      "/egress/github/user/repos?per_page=5",
    );
    expect(egressPath("github", "user")).toBe("/egress/github/user");
    expect(egressPath("a/b", "x")).toBe("/egress/a%2Fb/x");
  });

  it.each([
    "../admin",
    "a/../../b",
    "a/%2e%2e/b",
    "a/%2E%2E",
    "./x",
    "a/..\\b",
    "..?q=1",
  ])("rejects a dot segment: %s", (path) => {
    expect(() => egressPath("github", path)).toThrow(
      /must not contain "\." or "\.\." segments/,
    );
  });

  it("allows dots inside a segment and in the query", () => {
    expect(egressPath("github", "repos/a..b/file.txt?ref=../x")).toBe(
      "/egress/github/repos/a..b/file.txt?ref=../x",
    );
  });

  it("requires an upstream name", () => {
    expect(() => egressPath("", "x")).toThrow(/upstream name is required/);
  });
});

describe("parseUpstreams", () => {
  it("rebuilds entries field by field and drops anything else", () => {
    expect(parseUpstreams(LISTED.body)).toEqual([
      { name: "github", host: "api.github.com" },
      { name: "search", host: "api.example.com" },
    ]);
    expect(
      parseUpstreams({ upstreams: [null, { host: "x" }, { name: "" }] }),
    ).toEqual([]);
    expect(parseUpstreams({})).toBeUndefined();
    expect(parseUpstreams([])).toBeUndefined();
  });
});

describe("createComponentHost", () => {
  it("sends the agent's bearer to the egress route and overwrites a caller's Authorization", async () => {
    const { fetchImpl, seen } = fakeHost(LISTED);
    const res = await host(fetchImpl).fetch("github", "/user/repos", {
      method: "POST",
      headers: { Authorization: "Bearer from-the-caller", "x-extra": "kept" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const call = seen.find((s) => s.url.includes("/egress/github/"));
    expect(call?.url).toBe(`${URL_BASE}/egress/github/user/repos`);
    expect(call?.method).toBe("POST");
    expect(call?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.get("x-extra")).toBe("kept");
    expect(seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("throws the message naming the missing upstream, before any upstream request", async () => {
    const { fetchImpl, seen } = fakeHost(LISTED);
    await expect(host(fetchImpl).fetch("gitlab", "/projects")).rejects.toThrow(
      'upstream "gitlab" is not configured on this host (available: github, search) — ask the host\'s owner to configure it',
    );
    expect(seen.map((s) => s.url)).toEqual([`${URL_BASE}/egress`]);
  });

  it("says `available: none` when the host lists nothing", async () => {
    const { fetchImpl } = fakeHost({ status: 200, body: { upstreams: [] } });
    await expect(host(fetchImpl).fetch("github", "/user")).rejects.toThrow(
      'upstream "github" is not configured on this host (available: none) — ask the host\'s owner to configure it',
    );
    expect(upstreamNotConfiguredMessage("x", [])).toContain(
      "(available: none)",
    );
  });

  it.each([404, 405])(
    "treats a %s listing as unknown and calls through without a pre-check",
    async (status) => {
      const { fetchImpl, seen } = fakeHost({ status });
      const h = host(fetchImpl);
      expect(await h.upstreams()).toBeUndefined();
      const res = await h.fetch("github", "/user");
      expect(res.status).toBe(200);
      expect(seen.map((s) => s.url)).toEqual([
        `${URL_BASE}/egress`,
        `${URL_BASE}/egress/github/user`,
      ]);
    },
  );

  it("treats a failed listing as unknown and asks again next time", async () => {
    const { fetchImpl, seen } = fakeHost("throw");
    const h = host(fetchImpl);
    expect(await h.upstreams()).toBeUndefined();
    expect(await h.upstreams()).toBeUndefined();
    expect(seen.filter((s) => s.url.endsWith("/egress"))).toHaveLength(2);
  });

  it("reuses a listing for the cache window, then reads it again", async () => {
    let t = 0;
    const { fetchImpl, seen } = fakeHost(LISTED);
    const h = host(fetchImpl, { cacheMs: 1_000, now: () => t });
    await h.fetch("github", "/a");
    await h.fetch("github", "/b");
    expect(seen.filter((s) => s.url.endsWith("/egress"))).toHaveLength(1);
    t = 1_000;
    await h.fetch("github", "/c");
    expect(seen.filter((s) => s.url.endsWith("/egress"))).toHaveLength(2);
  });

  it("returns copies, so a caller cannot edit the cached listing", async () => {
    const { fetchImpl } = fakeHost(LISTED);
    const h = host(fetchImpl);
    const first = await h.upstreams();
    first?.splice(0);
    expect((await h.upstreams())?.map((u) => u.name)).toEqual([
      "github",
      "search",
    ]);
  });

  it("refuses without a host token and never sends a request", async () => {
    const { fetchImpl, seen } = fakeHost(LISTED);
    const h = createComponentHost({ env: {}, fetchImpl });
    expect(await h.upstreams()).toBeUndefined();
    await expect(h.fetch("github", "/user")).rejects.toThrow(/no host token/);
    expect(seen).toHaveLength(0);
  });

  it("reads SIA_DAEMON_URL and SIA_DAEMON_TOKEN from the env", async () => {
    const { fetchImpl, seen } = fakeHost({ status: 404 });
    const h = createComponentHost({
      env: {
        SIA_DAEMON_URL: "http://127.0.0.1:9999/",
        SIA_DAEMON_TOKEN: TOKEN,
      },
      fetchImpl,
    });
    await h.fetch("github", "/user");
    expect(seen.map((s) => s.url)).toEqual([
      "http://127.0.0.1:9999/egress",
      "http://127.0.0.1:9999/egress/github/user",
    ]);
  });

  it("never puts the token in a result or an error", async () => {
    const { fetchImpl } = fakeHost(LISTED);
    const h = host(fetchImpl);
    const listed = await h.upstreams();
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(JSON.stringify(listed)).not.toContain("should-never-surface");
    const errors: string[] = [];
    for (const attempt of [
      () => h.fetch("gitlab", "/x"),
      () => h.fetch("github", "../x"),
      () => h.fetch("", "/x"),
      () => createComponentHost({ env: {}, fetchImpl }).fetch("github", "/x"),
    ]) {
      try {
        await attempt();
      } catch (error) {
        errors.push(
          String((error as Error).message) + String((error as Error).stack),
        );
      }
    }
    expect(errors).toHaveLength(4);
    for (const message of errors) {
      expect(message).not.toContain(TOKEN);
    }
    expect(Object.keys(h).sort()).toEqual(["fetch", "upstreams"]);
    expect(Object.isFrozen(h)).toBe(true);
  });
});

describe("buildComponentDeps", () => {
  it("hands every component a host", () => {
    const deps = buildComponentDeps({
      manifest: { name: "x" } as ComponentManifest,
      componentDir: "/tmp/x",
      config: { agentId: "a", agentName: "A", projectRoot: "/tmp" },
      services: {},
      internals: buildInternals(),
    });
    expect(typeof deps.host.fetch).toBe("function");
    expect(typeof deps.host.upstreams).toBe("function");
  });

  it("uses an injected host as given", () => {
    const { fetchImpl } = fakeHost();
    const injected = host(fetchImpl);
    const deps = buildComponentDeps({
      manifest: { name: "x" } as ComponentManifest,
      componentDir: "/tmp/x",
      config: { agentId: "a", agentName: "A", projectRoot: "/tmp" },
      services: {},
      internals: buildInternals(),
      host: injected,
    });
    expect(deps.host).toBe(injected);
  });
});
