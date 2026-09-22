/**
 * The lineage reconciler: what settles a pending version, when, and what
 * can never break boot.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  _setLineageReconcilerForTests,
  createLineageReconciler,
  getLineageReconciler,
} from "../../../src/components/lineage-reconcile.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";

/** A graph-memory stub holding nodes in the wire shape the handlers decode. */
function stubAdapter(seed: Array<{ id: string; title: string; outcome: string; tags?: string[] }>) {
  const nodes = new Map<string, { id: string; properties: Record<string, unknown> }>();
  for (const s of seed) {
    nodes.set(s.id, {
      id: s.id,
      properties: {
        agent_output: `${s.title} prose`,
        metadata: {
          entity_type: "component_version",
          title: s.title,
          content: `${s.title} prose`,
          tags: s.tags ?? ["component_version", `outcome:${s.outcome}`],
          status: s.outcome === "candidate" ? "active" : "completed",
          custom_metadata: { outcome: s.outcome, component: s.title.split("@")[0] },
        },
      },
    });
  }
  const updates: Array<{ nodeId: string; properties: Record<string, unknown> }> = [];
  const adapter = {
    workspaceId: "ws",
    searchEntities: jest.fn(async () => ({
      results: [...nodes.values()],
      level_used: "raw",
      levels_tried: ["raw"],
    })),
    graphQuery: jest.fn(async () => ({ nodes: [...nodes.values()], edges: [] })),
    retrieveEntity: jest.fn(async ({ nodeId }: { nodeId: string }) => nodes.get(nodeId) ?? null),
    updateEntity: jest.fn(async (req: { nodeId: string; properties: Record<string, unknown> }) => {
      updates.push(req);
      const node = nodes.get(req.nodeId);
      const incoming = (req.properties as { metadata?: Record<string, unknown> }).metadata ?? {};
      if (node) {
        const meta = node.properties.metadata as Record<string, unknown>;
        node.properties.metadata = { ...meta, ...incoming };
      }
      return { id: req.nodeId, properties: node?.properties ?? {}, version: 2, changed_fields: [] };
    }),
  };
  return { adapter: adapter as unknown as IGraphMemoryAdapter, updates, nodes };
}

/** A host whose `/status` answers are scripted per call. */
function scriptedHost(answers: Array<unknown | Error>) {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = jest.fn(async (url: string) => {
    calls.push(url);
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") {
      return new Response("nope", { status: answer });
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const status = (component: Record<string, unknown>) => ({
  node: { components: { components: [{ name: "execute-code", versions: [], ...component }] } },
});

/** A clock the test advances; `sleep` resolves when the clock passes the wake time. */
function fakeClock() {
  let now = 1_000;
  const sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      now += ms;
      for (const s of [...sleepers]) {
        if (s.at <= now) {
          sleepers.splice(sleepers.indexOf(s), 1);
          s.resolve();
        }
      }
      // Let the woken poll run to its next await (the fetch stub crosses a
      // macrotask boundary while reading the response body).
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const settleOf = (updates: Array<{ properties: Record<string, unknown> }>) =>
  updates
    .map((u) => (u.properties as { custom_metadata?: { outcome?: string } }).custom_metadata?.outcome)
    .filter((o): o is string => typeof o === "string");

function build(overrides: Partial<Parameters<typeof createLineageReconciler>[0]> = {}) {
  const clock = fakeClock();
  const store = stubAdapter([{ id: "e-023", title: "execute-code@0.2.3", outcome: "candidate" }]);
  const reconciler = createLineageReconciler({
    agentId: "agent-1",
    daemonUrl: "http://127.0.0.1:7700",
    getAdapter: () => store.adapter,
    discoverLocalVersions: async () => [{ name: "execute-code", version: "0.2.3" }],
    now: clock.now,
    sleep: clock.sleep,
    pollIntervalMs: 3_000,
    bootCapMs: 12_000,
    turnThrottleMs: 60_000,
    ...overrides,
  });
  return { clock, store, reconciler };
}

describe("boot poll", () => {
  it("finds the pending version on disk and settles it when the host reports activated", async () => {
    const host = scriptedHost([
      status({ active: "0.2.1", candidate: { version: "0.2.3" } }),
      status({ active: "0.2.3", lastOutcome: { version: "0.2.3", result: "activated", at: "t1" } }),
    ]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });

    const boot = reconciler.onBoot();
    await clock.advance(0);
    expect(reconciler.pending()).toEqual([{ name: "execute-code", version: "0.2.3", entityId: "e-023" }]);
    await clock.advance(3_000);
    await boot;

    expect(host.calls).toHaveLength(2);
    expect(settleOf(store.updates)).toEqual(["converged"]);
    expect(reconciler.pending()).toEqual([]);
  });

  it("carries the host's error as the reason on a revert", async () => {
    const host = scriptedHost([
      status({ active: "0.2.1", lastOutcome: { version: "0.2.3", result: "reverted", error: "contract: 422" } }),
    ]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });
    const boot = reconciler.onBoot();
    await clock.advance(0);
    await boot;
    const meta = store.updates[0]?.properties.custom_metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ outcome: "reverted", reason: "contract: 422" });
  });

  it("keeps polling on a host error and rejects a vanished version once the cap is reached", async () => {
    const host = scriptedHost([500, new Error("ECONNREFUSED"), status({ active: "0.2.1" })]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });

    const boot = reconciler.onBoot();
    await clock.advance(0);
    await clock.advance(3_000);
    await clock.advance(3_000);
    expect(settleOf(store.updates)).toEqual([]);
    await clock.advance(3_000);
    await clock.advance(3_000);
    await boot;

    expect(settleOf(store.updates)).toEqual(["rejected"]);
  });

  it("does not reject at the cap when the host never reported a component store", async () => {
    const host = scriptedHost([{ node: {} }]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });
    const boot = reconciler.onBoot();
    for (let i = 0; i < 6; i += 1) await clock.advance(3_000);
    await boot;
    expect(settleOf(store.updates)).toEqual([]);
    expect(reconciler.pending()).toHaveLength(1);
  });

  it("does nothing when nothing on disk is pending", async () => {
    const host = scriptedHost([status({ active: "0.2.1" })]);
    const { clock, reconciler } = build({
      fetchImpl: host.fetchImpl,
      discoverLocalVersions: async () => [],
    });
    const boot = reconciler.onBoot();
    await clock.advance(0);
    await boot;
    expect(host.calls).toHaveLength(0);
  });

  it("skips versions whose entity is already settled", async () => {
    const host = scriptedHost([status({ active: "0.2.1" })]);
    const store = stubAdapter([{ id: "e-023", title: "execute-code@0.2.3", outcome: "reverted" }]);
    const { clock, reconciler } = build({ fetchImpl: host.fetchImpl, getAdapter: () => store.adapter });
    const boot = reconciler.onBoot();
    await clock.advance(0);
    await boot;
    expect(reconciler.pending()).toEqual([]);
    expect(host.calls).toHaveLength(0);
  });

  it("latches off when graph memory is unavailable and never calls the host", async () => {
    const host = scriptedHost([status({ active: "0.2.1" })]);
    const { clock, reconciler } = build({
      fetchImpl: host.fetchImpl,
      getAdapter: () => {
        throw new Error("memory-adapter: SIA_WORKSPACE_ID is required");
      },
    });
    const boot = reconciler.onBoot();
    await clock.advance(0);
    await expect(boot).resolves.toBeUndefined();
    expect(host.calls).toHaveLength(0);
    expect(reconciler.enabled()).toBe(false);
    await reconciler.onTurn();
    expect(host.calls).toHaveLength(0);
  });

  it("never throws, whatever discovery does", async () => {
    const { reconciler } = build({
      discoverLocalVersions: async () => {
        throw new Error("disk on fire");
      },
    });
    await expect(reconciler.onBoot()).resolves.toBeUndefined();
  });

  it("does not poll without a daemon url but still accepts a push", async () => {
    const host = scriptedHost([status({ active: "0.2.1" })]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl, daemonUrl: undefined });
    const boot = reconciler.onBoot();
    await clock.advance(0);
    await boot;
    expect(host.calls).toHaveLength(0);
    expect(reconciler.pending()).toHaveLength(1);

    const result = await reconciler.onHostOutcome({
      kind: "rejected",
      agentId: "agent-1",
      component: "execute-code",
      version: "0.2.3",
      at: "t2",
    });
    expect(result).toEqual({ status: "settled", entityId: "e-023" });
    expect(settleOf(store.updates)).toEqual(["rejected"]);
  });
});

describe("turn check", () => {
  it("rejects a vanished version at once, throttled to once per minute", async () => {
    const host = scriptedHost([status({ active: "0.2.1", candidate: { version: "0.2.3" } }), status({ active: "0.2.1" })]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });
    reconciler.track("e-023", "execute-code", "0.2.3");

    await reconciler.onTurn();
    expect(host.calls).toHaveLength(1);
    expect(settleOf(store.updates)).toEqual([]);

    await reconciler.onTurn();
    expect(host.calls).toHaveLength(1);

    await clock.advance(60_000);
    await reconciler.onTurn();
    expect(host.calls).toHaveLength(2);
    expect(settleOf(store.updates)).toEqual(["rejected"]);
    expect(reconciler.pending()).toEqual([]);
  });

  it("does not call the host while nothing is pending", async () => {
    const host = scriptedHost([status({ active: "0.2.1" })]);
    const { reconciler } = build({ fetchImpl: host.fetchImpl });
    await reconciler.onTurn();
    expect(host.calls).toHaveLength(0);
  });
});

describe("host push", () => {
  it("settles immediately and a later poll is a no-op", async () => {
    const host = scriptedHost([
      status({ active: "0.2.3", lastOutcome: { version: "0.2.3", result: "activated" } }),
    ]);
    const { clock, store, reconciler } = build({ fetchImpl: host.fetchImpl });
    reconciler.track("e-023", "execute-code", "0.2.3");

    const result = await reconciler.onHostOutcome({
      kind: "converged",
      agentId: "agent-1",
      component: "execute-code",
      version: "0.2.3",
      at: "2026-09-22T00:00:00Z",
    });
    expect(result).toEqual({ status: "settled", entityId: "e-023" });
    expect(settleOf(store.updates)).toEqual(["converged"]);

    await clock.advance(60_000);
    await reconciler.onTurn();
    expect(host.calls).toHaveLength(0);
    expect(settleOf(store.updates)).toEqual(["converged"]);
  });

  it("ignores another agent's frame and a malformed one", async () => {
    const { reconciler, store } = build();
    reconciler.track("e-023", "execute-code", "0.2.3");
    expect(
      await reconciler.onHostOutcome({
        kind: "converged",
        agentId: "someone-else",
        component: "execute-code",
        version: "0.2.3",
      }),
    ).toEqual({ status: "ignored", reason: "other_agent" });
    expect(await reconciler.onHostOutcome({ kind: "activated", agentId: "agent-1" })).toEqual({
      status: "ignored",
      reason: "invalid_frame",
    });
    expect(await reconciler.onHostOutcome(null)).toEqual({ status: "ignored", reason: "invalid_frame" });
    expect(store.updates).toHaveLength(0);
  });

  it("looks the entity up by title when the version was never tracked", async () => {
    const { reconciler, store } = build();
    const result = await reconciler.onHostOutcome({
      kind: "failed",
      agentId: "agent-1",
      component: "execute-code",
      version: "0.2.3",
      reason: "revert: boom",
    });
    expect(result).toEqual({ status: "settled", entityId: "e-023" });
    const meta = store.updates[0]?.properties.custom_metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ outcome: "failed", reason: "revert: boom" });
  });

  it("reports an unknown version without writing", async () => {
    const { reconciler, store } = build();
    expect(
      await reconciler.onHostOutcome({
        kind: "converged",
        agentId: "agent-1",
        component: "execute-code",
        version: "9.9.9",
      }),
    ).toEqual({ status: "not_found" });
    expect(store.updates).toHaveLength(0);
  });

  it("reports an already settled entity as such", async () => {
    const store = stubAdapter([{ id: "e-023", title: "execute-code@0.2.3", outcome: "converged" }]);
    const { reconciler } = build({ getAdapter: () => store.adapter });
    expect(
      await reconciler.onHostOutcome({
        kind: "reverted",
        agentId: "agent-1",
        component: "execute-code",
        version: "0.2.3",
      }),
    ).toEqual({ status: "already_settled", entityId: "e-023" });
    expect(store.updates).toHaveLength(0);
  });

  it("the shared reconciler (what the graph module's export delegates to) refuses another agent's frame", async () => {
    // The process's own id comes from configuration; a frame for anyone
    // else is ignored before memory or the host is touched.
    _setLineageReconcilerForTests(null);
    try {
      expect(
        await getLineageReconciler().onHostOutcome({
          kind: "converged",
          agentId: "not-this-process",
          component: "execute-code",
          version: "0.2.3",
        }),
      ).toEqual({ status: "ignored", reason: "other_agent" });
    } finally {
      _setLineageReconcilerForTests(null);
    }
  });
});
