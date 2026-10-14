/**
 * Situation Context Middleware Tests
 *
 * The middleware appends one tagged message with what the host reports about
 * the agent's own process — source drift and the upstreams it offers — read
 * in the background, reused while fresh, and never allowed to hold up or
 * fail a model call.
 */

import { describe, it, expect } from "@jest/globals";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  createSituationCache,
  createSituationContextMiddleware,
  formatAgentSourceLine,
  formatSituation,
  formatUpstreamsLine,
  situationContextMessage,
  type SituationFacts,
} from "../../../src/middleware/situation-context.js";
import type { HostAgentSourceView } from "../../../src/components/lineage-host.js";
import { HOST_CONTEXT_TRUST } from "../../../src/utils/host-context.js";

async function capture(
  middleware: ReturnType<typeof createSituationContextMiddleware>,
  messages: BaseMessage[] = [new HumanMessage("hello")],
): Promise<BaseMessage[]> {
  let seen: BaseMessage[] = [];
  await middleware.wrapModelCall!(
    { messages, systemPrompt: "Static." } as any,
    (async (req: { messages: BaseMessage[] }) => {
      seen = req.messages;
      return new AIMessage("ok");
    }) as any,
  );
  return seen;
}

function source(over: Partial<HostAgentSourceView> = {}): HostAgentSourceView {
  return { baseline: "ok", modified: [], added: [], removed: [], truncated: 0, ...over };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("formatAgentSourceLine", () => {
  it("says the tree is unchanged, naming the staged version and when it was checked", () => {
    expect(
      formatAgentSourceLine(source({ version: "0.13.0", checkedAt: "2026-10-14T10:02:11Z" })),
    ).toBe(
      "Agent source: unchanged from version 0.13.0 as the host staged it, checked 2026-10-14T10:02:11Z.",
    );
  });

  it("counts and lists drifted files by kind", () => {
    expect(
      formatAgentSourceLine(
        source({
          version: "0.13.0",
          modified: ["src/a.ts", "src/b.ts"],
          added: ["notes/x.md"],
          checkedAt: "2026-10-14T10:02:11Z",
        }),
      ),
    ).toBe(
      "Agent source: 3 files differ from version 0.13.0 as the host staged it " +
        "(modified: src/a.ts, src/b.ts; added: notes/x.md), checked 2026-10-14T10:02:11Z.",
    );
  });

  it("caps each kind at ten paths and counts what the host left off", () => {
    const modified = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
    const line = formatAgentSourceLine(source({ modified, removed: ["gone.md"], truncated: 4 }))!;
    expect(line.startsWith("Agent source: 18 files differ from the version the host staged (")).toBe(true);
    expect(line).toContain("f9.ts (+3 more)");
    expect(line).not.toContain("f10.ts");
    expect(line).toContain("removed: gone.md; 4 more not listed");
  });

  it("uses the singular for one file", () => {
    expect(formatAgentSourceLine(source({ removed: ["x"] }))).toBe(
      "Agent source: 1 file differs from the version the host staged (removed: x).",
    );
  });

  it("says nothing when the host could not compare against its baseline", () => {
    expect(formatAgentSourceLine(source({ baseline: "missing", modified: ["x"] }))).toBeUndefined();
    expect(formatAgentSourceLine(undefined)).toBeUndefined();
  });
});

describe("formatUpstreamsLine", () => {
  it("names the upstreams, says none for an empty list, and is silent when unknown", () => {
    expect(
      formatUpstreamsLine([
        { name: "github", host: "api.github.com" },
        { name: "weather", host: "api.example.com" },
      ]),
    ).toBe("Upstreams the host offers your components: github, weather.");
    expect(formatUpstreamsLine([])).toBe("Upstreams the host offers your components: none.");
    expect(formatUpstreamsLine(undefined)).toBeUndefined();
  });
});

describe("formatSituation / situationContextMessage", () => {
  it("is undefined when neither fact is known", () => {
    expect(formatSituation({})).toBeUndefined();
  });

  it("joins the known lines and wraps them as situation context", () => {
    const body = formatSituation({ agentSource: source({ version: "1.0.0" }), upstreams: [] })!;
    expect(situationContextMessage(body).text).toBe(
      `<host-context source="host" kind="situation">\n${HOST_CONTEXT_TRUST.host}\n` +
        "Agent source: unchanged from version 1.0.0 as the host staged it.\n" +
        "Upstreams the host offers your components: none.\n" +
        "</host-context>",
    );
  });
});

describe("createSituationCache", () => {
  it("reuses a fresh read and reads once per TTL, serving the stale value meanwhile", async () => {
    let t = 0;
    let reads = 0;
    let upstreams = [{ name: "a", host: "a" }];
    const cache = createSituationCache({
      now: () => t,
      read: async () => {
        reads++;
        return { upstreams };
      },
    });
    expect((await cache.get()).upstreams).toEqual([{ name: "a", host: "a" }]);
    t = 30_000;
    await cache.get();
    expect(reads).toBe(1);

    upstreams = [{ name: "b", host: "b" }];
    t = 61_000;
    const stale = await cache.get();
    expect(stale.upstreams).toEqual([{ name: "a", host: "a" }]);
    await flush();
    expect(reads).toBe(2);
    expect((await cache.get()).upstreams).toEqual([{ name: "b", host: "b" }]);
  });

  it("keeps each fact through failed reads for the keep window, then drops it", async () => {
    let t = 0;
    let fail = false;
    const cache = createSituationCache({
      now: () => t,
      read: async () => {
        if (fail) throw new Error("down");
        return { agentSource: source(), upstreams: [] };
      },
    });
    await cache.get();
    fail = true;
    t = 5 * 60_000;
    await cache.get();
    await flush();
    expect(await cache.get()).toEqual({ agentSource: source(), upstreams: [] });

    t = 11 * 60_000;
    await cache.get();
    await flush();
    expect(await cache.get()).toEqual({});
  });

  it("keeps one fact when a read returns only the other", async () => {
    let t = 0;
    let facts: SituationFacts = { agentSource: source(), upstreams: [] };
    const cache = createSituationCache({ now: () => t, read: async () => facts });
    await cache.get();
    facts = { upstreams: [{ name: "x", host: "x" }] };
    t = 61_000;
    await cache.get();
    await flush();
    expect(await cache.get()).toEqual({
      agentSource: source(),
      upstreams: [{ name: "x", host: "x" }],
    });
  });

  it("keeps an idle process's last value: nothing has failed", async () => {
    let t = 0;
    let reads = 0;
    const cache = createSituationCache({
      now: () => t,
      read: async () => (++reads === 1 ? { upstreams: [] } : new Promise<never>(() => {})),
    });
    await cache.get();
    t = 60 * 60_000;
    expect(await cache.get()).toEqual({ upstreams: [] });
  });

  it("counts a read that never settles as failed, so the next one can start", async () => {
    let t = 0;
    let reads = 0;
    const cache = createSituationCache({
      now: () => t,
      firstWaitMs: 5,
      readTimeoutMs: 20,
      read: () => {
        reads++;
        return reads === 1 ? new Promise<never>(() => {}) : Promise.resolve({ upstreams: [] });
      },
    });
    expect(await cache.get()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 40));
    t = 61_000;
    await cache.get();
    await flush();
    expect(reads).toBe(2);
    expect(await cache.get()).toEqual({ upstreams: [] });
  });

  it("shares one bounded first wait between concurrent first calls, then never waits", async () => {
    let reads = 0;
    const cache = createSituationCache({
      firstWaitMs: 30,
      read: () => {
        reads++;
        return new Promise<never>(() => {});
      },
    });
    const start = Date.now();
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(Date.now() - start).toBeLessThan(200);
    const later = Date.now();
    await cache.get();
    expect(Date.now() - later).toBeLessThan(20);
    expect(reads).toBe(1);
  });

  it("never rejects", async () => {
    const cache = createSituationCache({ read: () => Promise.reject(new Error("boom")) });
    await expect(cache.get()).resolves.toEqual({});
  });
});

describe("createSituationContextMiddleware", () => {
  it("appends the situation as the last message without touching the others", async () => {
    const middleware = createSituationContextMiddleware({
      cache: { get: async () => ({ upstreams: [{ name: "github", host: "api.github.com" }] }) },
    });
    const human = new HumanMessage("hello");
    const seen = await capture(middleware, [human]);
    expect(seen[0]).toBe(human);
    expect(seen).toHaveLength(2);
    expect(seen[1].text).toBe(
      `<host-context source="host" kind="situation">\n${HOST_CONTEXT_TRUST.host}\nUpstreams the host offers your components: github.\n</host-context>`,
    );
  });

  it("adds no message when nothing is known", async () => {
    const middleware = createSituationContextMiddleware({ cache: { get: async () => ({}) } });
    const human = new HumanMessage("hello");
    expect(await capture(middleware, [human])).toEqual([human]);
  });

  it("proceeds without a message when the cache throws", async () => {
    const middleware = createSituationContextMiddleware({
      cache: {
        get: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(await capture(middleware)).toHaveLength(1);
  });

  it("adds nothing and reads nothing without a host token", async () => {
    let calls = 0;
    const middleware = createSituationContextMiddleware({
      env: {},
      fetchImpl: (async () => {
        calls++;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(await capture(middleware)).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it("reads /status and /egress with the host token and reports both", async () => {
    const seenAuth: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      const body = url.endsWith("/status")
        ? { node: { agentSource: { baseline: "ok", version: "2.0.0" } } }
        : { upstreams: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const middleware = createSituationContextMiddleware({
      env: { SIA_DAEMON_URL: "http://127.0.0.1:9", SIA_DAEMON_TOKEN: "tok" },
      fetchImpl,
    });
    const seen = await capture(middleware);
    expect(seen.at(-1)!.text).toContain(
      "Agent source: unchanged from version 2.0.0 as the host staged it.\nUpstreams the host offers your components: none.",
    );
    expect(seenAuth).toEqual(["Bearer tok", "Bearer tok"]);
  });

  it("never holds a model call past the first-wait budget when the host hangs", async () => {
    let fetches = 0;
    const hang = (() => {
      fetches++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const middleware = createSituationContextMiddleware({
      env: { SIA_DAEMON_URL: "http://127.0.0.1:9", SIA_DAEMON_TOKEN: "tok" },
      fetchImpl: hang,
    });

    const first = Date.now();
    expect(await capture(middleware)).toHaveLength(1);
    const firstMs = Date.now() - first;
    expect(firstMs).toBeGreaterThanOrEqual(900);
    expect(firstMs).toBeLessThan(1_500);

    const second = Date.now();
    expect(await capture(middleware)).toHaveLength(1);
    expect(Date.now() - second).toBeLessThan(50);
    expect(fetches).toBe(2);
  });

  it("costs a warm call no host request", async () => {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return new Response(JSON.stringify({ upstreams: [] }), { status: 200 });
    }) as typeof fetch;
    const middleware = createSituationContextMiddleware({
      env: { SIA_DAEMON_URL: "http://127.0.0.1:9", SIA_DAEMON_TOKEN: "tok" },
      fetchImpl,
    });
    await capture(middleware);
    const afterFirst = fetches;
    for (let i = 0; i < 5; i++) await capture(middleware);
    expect(fetches).toBe(afterFirst);
  });
});
