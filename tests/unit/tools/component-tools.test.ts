/**
 * The four component tools over temp roots: what `describe_component`
 * says, where `prepare_component_version` writes (and its refusal with no
 * host root), `run_component_contract` against fixture contracts and a
 * version that exists only in the host copy, and every leg of
 * `announce_component_version` through an injected `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createComponentTools, buildAnnouncementText } from "../../../src/tools/component-tools.js";
import { createLineageReconciler } from "../../../src/components/lineage-reconcile.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";
import {
  _resetComponentsForTests,
  setActiveComponents,
} from "../../../src/components/registry.js";
import { resetConfig } from "../../../src/config/loader.js";
import {
  clearAllowedPathRoots,
  getAllowedPathRoots,
} from "../../../src/utils/path-utils.js";
import {
  FAILING_CONTRACT,
  PASSING_CONTRACT,
  SERVICE_ENTRY,
  makeRoot,
  plainImport,
  removeRoot,
  writeComponent,
} from "../components/fixtures.js";

const THREAD = "33333333-3333-4333-8333-333333333333";
const config = { configurable: { thread_id: THREAD } };
const CONTRACT = {
  importModule: plainImport,
  config: { agentId: "agent-1", agentName: "Agent One", projectRoot: "/tmp/project" },
};

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function fakeHost(statuses: { thread?: number; event?: number; publish?: number } = {}) {
  const captured: Captured[] = [];
  const fetchImpl = jest.fn(async (url: unknown, init: unknown): Promise<Response> => {
    const req = (init ?? {}) as RequestInit;
    captured.push({
      method: String(req.method ?? "GET"),
      url: String(url),
      headers: { ...(req.headers as Record<string, string>) },
      body: typeof req.body === "string" ? JSON.parse(req.body) : undefined,
    });
    const u = String(url);
    if (u.includes("/threads/")) {
      const status = statuses.thread ?? 200;
      return new Response(
        JSON.stringify({ thread_id: THREAD, metadata: { channel: "dev", self_task: true } }),
        { status },
      );
    }
    if (u.endsWith("/chat/component-version")) {
      return new Response("{}", { status: statuses.event ?? 404 });
    }
    if (u.endsWith("/chat/publish")) {
      return new Response("{}", { status: statuses.publish ?? 200 });
    }
    throw new Error(`unexpected request ${u}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, captured };
}

describe("component tools", () => {
  let project: string;
  let seed: string;
  let host: string;

  const byName = (tools: ReturnType<typeof createComponentTools>, name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool;
  };

  beforeEach(() => {
    project = makeRoot("project-");
    seed = path.join(project, "components");
    mkdirSync(seed);
    host = path.join(makeRoot("host-"), "components");
    writeComponent(seed, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
      manifest: { intent: "Say hello.", lineage: { producedBy: "seed" } },
    });
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    resetConfig();
    removeRoot(project);
    removeRoot(path.dirname(host));
  });

  describe("describe_component", () => {
    it("reports the winning root, the versions and the host root", async () => {
      const tools = createComponentTools({ projectRoot: project, componentsDir: host });
      const text = await byName(tools, "describe_component").invoke({ name: "hello" });
      expect(text).toContain('Component "hello"');
      expect(text).toContain("current version: 0.1.0 (kind service)");
      expect(text).toContain("intent: Say hello.");
      expect(text).toContain(`winning root: ${seed} (seed root shipped with the source tree`);
      expect(text).toContain("shadowed roots: none");
      expect(text).toContain("versions present: 0.1.0");
      expect(text).toContain(`entry: ${path.join(seed, "hello", ".versions", "0.1.0", "entry.ts")}`);
      expect(text).toContain(`host-managed root: ${host}`);
    });

    it("says when no host root is configured and reports unknown names", async () => {
      const tools = createComponentTools({ projectRoot: project, componentsDir: undefined });
      const text = await byName(tools, "describe_component").invoke({ name: "hello" });
      expect(text).toContain("no host-managed component root is configured (SIA_COMPONENTS_DIR)");
      const missing = await byName(tools, "describe_component").invoke({ name: "nope" });
      expect(missing).toBe('Cannot describe component: unknown component "nope"');
    });

    it("shows the host copy winning once it exists", async () => {
      mkdirSync(host, { recursive: true });
      writeComponent(host, "hello", "0.1.0", { entry: SERVICE_ENTRY, currentFile: true });
      const tools = createComponentTools({ projectRoot: project, componentsDir: host });
      const text = await byName(tools, "describe_component").invoke({ name: "hello" });
      expect(text).toContain(`winning root: ${host} (host-managed root`);
      expect(text).toContain(`shadowed roots: ${seed}`);
    });
  });

  describe("prepare_component_version", () => {
    it("writes the next version under the host root and admits it for file tools", async () => {
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
      });
      const text = await byName(tools, "prepare_component_version").invoke({
        name: "hello",
        need: "say it louder",
      });
      const versionDir = path.join(host, "hello", ".versions", "0.1.1");
      expect(text).toContain(`Prepared hello@0.1.1 from hello@0.1.0 under ${host} (the component was copied there first).`);
      expect(text).toContain(`version directory: ${versionDir}`);
      expect(text).toContain("`current` still names 0.1.0");
      expect(text).toContain(`Next: edit ${path.join(versionDir, "entry.ts")}`);
      // No graph memory is configured here; the prepare still succeeds and says so.
      expect(text).toContain("lineage: not recorded — ");
      expect(text).toContain('run_component_contract({ name: "hello", version: "0.1.1" })');

      const manifest = JSON.parse(readFileSync(path.join(versionDir, "component.json"), "utf-8"));
      expect(manifest.lineage).toEqual({
        producedBy: "agent-1",
        parent: "hello@0.1.0",
        need: "say it louder",
      });
      expect(readFileSync(path.join(host, "hello", "current"), "utf-8").trim()).toBe("0.1.0");
      expect(existsSync(path.join(seed, "hello", ".versions", "0.1.1"))).toBe(false);
      expect(getAllowedPathRoots()).toContain(host);
    });

    it("refuses with no host root, an invalid bump, and reports refusals", async () => {
      const none = createComponentTools({ projectRoot: project, componentsDir: undefined });
      const text = await byName(none, "prepare_component_version").invoke({
        name: "hello",
        need: "x",
      });
      expect(text).toBe(
        "Cannot prepare a version: no host-managed component root is configured (SIA_COMPONENTS_DIR); a new version has nowhere to go",
      );
      expect(existsSync(host)).toBe(false);

      const tools = createComponentTools({ projectRoot: project, componentsDir: host });
      const bad = await byName(tools, "prepare_component_version").invoke({
        name: "hello",
        need: "x",
        bump: "huge",
      });
      expect(bad).toMatch(/bump must be/);
      const unknown = await byName(tools, "prepare_component_version").invoke({
        name: "nope",
        need: "x",
      });
      expect(unknown).toBe('Cannot prepare a version: unknown component "nope"');
    });

    it("accepts a minor bump in any case", async () => {
      const tools = createComponentTools({ projectRoot: project, componentsDir: host });
      const text = await byName(tools, "prepare_component_version").invoke({
        name: "hello",
        need: "x",
        bump: "Minor",
      });
      expect(text).toContain("Prepared hello@0.2.0 from hello@0.1.0");
    });
  });

  describe("run_component_contract", () => {
    it("reports pass and fail against the fixture contracts", async () => {
      setActiveComponents({ components: [], roots: [seed] });
      writeComponent(seed, "broken", "0.1.0", {
        entry: SERVICE_ENTRY,
        contract: FAILING_CONTRACT,
        currentFile: true,
      });
      const tools = createComponentTools({ projectRoot: project, componentsDir: undefined, contract: CONTRACT });
      const pass = await byName(tools, "run_component_contract").invoke({ name: "hello" });
      expect(pass).toMatch(/^contract passed for hello@0\.1\.0 in \d+ ms/);
      const fail = await byName(tools, "run_component_contract").invoke({ name: "broken", version: "0.1.0" });
      expect(fail).toMatch(/^contract FAILED for broken@0\.1\.0: .*deliberately failed/);
      const missing = await byName(tools, "run_component_contract").invoke({ name: "hello", version: "9.9.9" });
      expect(missing).toBe('contract FAILED for hello@9.9.9: version "9.9.9" of "hello" not found');
    });

    it("finds a version that exists only in the host copy written after assembly", async () => {
      setActiveComponents({ components: [], roots: [seed] });
      const previous = process.env.SIA_COMPONENTS_DIR;
      process.env.SIA_COMPONENTS_DIR = host;
      resetConfig();
      try {
        const tools = createComponentTools({ projectRoot: project, contract: CONTRACT });
        const prepared = await byName(tools, "prepare_component_version").invoke({
          name: "hello",
          need: "fail on purpose",
        });
        expect(prepared).toContain("Prepared hello@0.1.1");
        // The candidate's contract is rewritten to fail so the run proves
        // it targeted the host copy, not the seed.
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path.join(host, "hello", ".versions", "0.1.1", "contract.ts"), FAILING_CONTRACT);

        const candidate = await byName(tools, "run_component_contract").invoke({ name: "hello", version: "0.1.1" });
        expect(candidate).toMatch(/^contract FAILED for hello@0\.1\.1: .*deliberately failed/);
        const current = await byName(tools, "run_component_contract").invoke({ name: "hello", version: "0.1.0" });
        expect(current).toMatch(/^contract passed for hello@0\.1\.0/);
      } finally {
        if (previous === undefined) delete process.env.SIA_COMPONENTS_DIR;
        else process.env.SIA_COMPONENTS_DIR = previous;
        resetConfig();
      }
    });
  });

  describe("announce_component_version", () => {
    const prepare = async (tools: ReturnType<typeof createComponentTools>) => {
      const text = await byName(tools, "prepare_component_version").invoke({
        name: "hello",
        need: "say it louder",
      });
      expect(text).toContain("Prepared hello@0.1.1");
    };

    it("sends the host event but no room message by default", async () => {
      const { fetchImpl, captured } = fakeHost({ event: 200 });
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "t",
        serverUrl: "http://127.0.0.1:2024",
        env: {},
        fetchImpl,
      });
      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "s" },
        config,
      );
      expect(text).toContain("candidate event: accepted by the host (200).");
      expect(text).toContain("room message: off (SIA_ANNOUNCE_TO_CHAT is not set); the summary stays in this thread.");
      expect(text).toContain("**hello@0.1.1** — s");
      expect(captured.some((c) => c.url.endsWith("/chat/publish"))).toBe(false);
      expect(captured.some((c) => c.url.endsWith("/chat/component-version"))).toBe(true);
    });

    it("posts the room message when the env switch is on", async () => {
      const { fetchImpl, captured } = fakeHost();
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "t",
        serverUrl: "http://127.0.0.1:2024",
        env: { SIA_ANNOUNCE_TO_CHAT: "true" },
        fetchImpl,
      });
      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "s" },
        config,
      );
      expect(text).toContain('message posted to "dev" (200).');
      expect(captured.some((c) => c.url.endsWith("/chat/publish"))).toBe(true);
    });

    it("posts the candidate event and the room message, tolerating a 404 on the event", async () => {
      const { fetchImpl, captured } = fakeHost({ event: 404 });
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        agentName: "Agent One",
        daemonUrl: "http://127.0.0.1:7700/",
        daemonToken: "daemon-token",
        serverUrl: "http://127.0.0.1:2024",
        announceToChat: true,
        fetchImpl,
      });
      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "Prints in caps." },
        config,
      );
      expect(text).toContain("candidate event: the host does not accept component-version events yet (404)");
      expect(text).toContain('message posted to "dev" (200).');
      expect(text).toContain(
        `**hello@0.1.1** — Prints in caps.\n\n[Open the thread](/chat?agentId=agent-1&threadId=${THREAD})`,
      );

      expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET http://127.0.0.1:2024/threads/${THREAD}`,
        "POST http://127.0.0.1:7700/chat/component-version",
        "POST http://127.0.0.1:7700/chat/publish",
      ]);
      expect(captured[1].headers.Authorization).toBe("Bearer daemon-token");
      expect(captured[1].body).toMatchObject({
        agentId: "agent-1",
        name: "hello",
        version: "0.1.1",
        parentVersion: "hello@0.1.0",
        need: "say it louder",
        summary: "Prints in caps.",
        threadId: THREAD,
      });
      expect(typeof captured[1].body?.timestamp).toBe("string");
      expect(captured[2].headers.Authorization).toBe("Bearer daemon-token");
      expect(captured[2].body).toMatchObject({
        agentId: "agent-1",
        channel: "dev",
        sender: "Agent One",
        isAgent: true,
        threadId: THREAD,
        text: `**hello@0.1.1** — Prints in caps.\n\n[Open the thread](/chat?agentId=agent-1&threadId=${THREAD})`,
      });
    });

    it("falls back to the default room when the thread has none, and honours an explicit one", async () => {
      const noThread = fakeHost({ thread: 404 });
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "t",
        serverUrl: "http://127.0.0.1:2024",
        announceToChat: true,
        fetchImpl: noThread.fetchImpl,
      });
      await prepare(tools);
      const announce = byName(tools, "announce_component_version");
      const text = await announce.invoke({ name: "hello", version: "0.1.1", summary: "s" }, config);
      expect(text).toContain('message posted to "general" (200).');
      const publish = noThread.captured.find((c) => c.url.endsWith("/chat/publish"));
      expect(publish?.body?.channel).toBe("general");

      const explicit = await announce.invoke(
        { name: "hello", version: "0.1.1", summary: "s", channel: "ops" },
        config,
      );
      expect(explicit).toContain('message posted to "ops" (200).');
    });

    it("skips the event on a failed outcome and says so", async () => {
      const { fetchImpl, captured } = fakeHost();
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "t",
        serverUrl: "http://127.0.0.1:2024",
        announceToChat: true,
        fetchImpl,
      });
      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "Three rounds, still failing.", outcome: "FAILED" },
        config,
      );
      expect(text).toContain("candidate event: skipped (outcome is failed).");
      expect(text).toContain("**hello@0.1.1** — could not produce a passing version. Three rounds, still failing.");
      expect(captured.some((c) => c.url.endsWith("/chat/component-version"))).toBe(false);
      expect(captured.some((c) => c.url.endsWith("/chat/publish"))).toBe(true);
    });

    it("keeps the summary in the thread when the host endpoint is not configured", async () => {
      const { fetchImpl, captured } = fakeHost();
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        env: {},
        serverUrl: "http://127.0.0.1:2024",
        fetchImpl,
      });
      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "s" },
        config,
      );
      expect(text).toMatch(/host chat endpoint not configured; the summary stays in this thread:\n\*\*hello@0\.1\.1\*\*/);
      expect(captured.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("refuses a candidate whose version does not exist and reports a failed publish", async () => {
      const rejected = fakeHost({ event: 200, publish: 500 });
      const tools = createComponentTools({
        projectRoot: project,
        componentsDir: host,
        agentId: "agent-1",
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "t",
        serverUrl: "http://127.0.0.1:2024",
        announceToChat: true,
        fetchImpl: rejected.fetchImpl,
      });
      const missing = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "s" },
        config,
      );
      expect(missing).toBe('Cannot announce a candidate: version "0.1.1" of "hello" not found');

      await prepare(tools);
      const text = await byName(tools, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "s" },
        config,
      );
      expect(text).toContain("candidate event: accepted by the host (200).");
      expect(text).toContain('message to "dev" rejected by the host (500); the summary stays in this thread.');
    });
  });
});

/**
 * An in-memory graph holding nodes in the wire shape the vendored handlers
 * decode. Updates merge the flat patch into the node's metadata the way
 * the server does.
 */
function memoryGraph() {
  const nodes = new Map<string, { id: string; properties: Record<string, unknown> }>();
  const edges: Array<{ fromNodeId: string; toNodeId: string; type: string }> = [];
  const updates: Array<{ nodeId: string; properties: Record<string, unknown> }> = [];
  let seq = 0;
  const adapter = {
    workspaceId: "ws",
    storeEntity: jest.fn(async (req: { agent_id: string; metadata: Record<string, unknown> }) => {
      seq += 1;
      const id = `n-${seq}`;
      nodes.set(id, { id, properties: { agent_id: req.agent_id, metadata: req.metadata } });
      return { id, agent_id: req.agent_id, timestamp: "t", metadata: req.metadata };
    }),
    searchEntities: jest.fn(async () => ({
      results: [...nodes.values()],
      level_used: "raw",
      levels_tried: ["raw"],
    })),
    graphQuery: jest.fn(async () => ({ nodes: [...nodes.values()], edges: [] })),
    graphEdges: jest.fn(async (req: { fromNodeId: string; toNodeId: string; type: string }) => {
      edges.push({ fromNodeId: req.fromNodeId, toNodeId: req.toNodeId, type: req.type });
      return { id: `e-${edges.length}`, ...req };
    }),
    retrieveEntity: jest.fn(async ({ nodeId }: { nodeId: string }) => nodes.get(nodeId) ?? null),
    updateEntity: jest.fn(async (req: { nodeId: string; properties: Record<string, unknown> }) => {
      updates.push(req);
      const node = nodes.get(req.nodeId);
      if (node) {
        const meta = node.properties.metadata as Record<string, unknown>;
        node.properties.metadata = { ...meta, ...req.properties };
      }
      return { id: req.nodeId, properties: node?.properties ?? {}, version: 2, changed_fields: [] };
    }),
  };
  const entity = (id: string) => {
    const meta = nodes.get(id)?.properties.metadata as Record<string, unknown>;
    return { ...meta, custom: meta.custom_metadata as Record<string, unknown> };
  };
  return { adapter: adapter as unknown as IGraphMemoryAdapter, nodes, edges, updates, entity };
}

describe("component lineage", () => {
  let project: string;
  let seed: string;
  let host: string;
  const NOW = "2026-09-22T10:00:00.000Z";

  const byName = (tools: ReturnType<typeof createComponentTools>, name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool;
  };

  beforeEach(() => {
    project = makeRoot("project-");
    seed = path.join(project, "components");
    mkdirSync(seed);
    host = path.join(makeRoot("host-"), "components");
    writeComponent(seed, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
      manifest: { intent: "Say hello.", lineage: { producedBy: "seed" } },
    });
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    resetConfig();
    removeRoot(project);
    removeRoot(path.dirname(host));
  });

  const build = (graph: ReturnType<typeof memoryGraph>) => {
    const reconciler = createLineageReconciler({
      agentId: "agent-1",
      daemonUrl: undefined,
      getAdapter: () => graph.adapter,
      discoverLocalVersions: async () => [],
    });
    const tools = createComponentTools({
      projectRoot: project,
      componentsDir: host,
      agentId: "agent-1",
      adapter: () => graph.adapter,
      reconciler,
      now: () => new Date(NOW),
      env: {},
      serverUrl: "http://127.0.0.1:2024",
      fetchImpl: fakeHost().fetchImpl,
    });
    return { tools, reconciler };
  };

  const prepare = (tools: ReturnType<typeof createComponentTools>, need = "say it louder") =>
    byName(tools, "prepare_component_version").invoke({ name: "hello", need }, config);

  it("prepare creates the parent entity when it is missing and links the child to it", async () => {
    const graph = memoryGraph();
    const { tools, reconciler } = build(graph);
    const text = await prepare(tools);
    expect(text).toContain("Prepared hello@0.1.1 from hello@0.1.0");
    expect(text).toContain("lineage: recorded (id n-2; supersedes hello@0.1.0; parent entity created)");

    const parent = graph.entity("n-1");
    expect(parent.title).toBe("hello@0.1.0");
    expect(parent.entity_type).toBe("component_version");
    expect(parent.status).toBe("completed");
    expect(parent.tags).toEqual(expect.arrayContaining(["outcome:converged", "produced-by:seed"]));
    expect(parent.custom).toMatchObject({
      component: "hello",
      version: "0.1.0",
      outcome: "converged",
      provenance: { produced_by: "seed" },
    });

    const child = graph.entity("n-2");
    expect(child.title).toBe("hello@0.1.1");
    expect(child.status).toBe("active");
    expect(child.tags).toEqual(
      expect.arrayContaining([
        "component_version",
        "component:hello",
        "version:0.1.1",
        "outcome:candidate",
        "produced-by:agent-1",
      ]),
    );
    expect(child.custom).toMatchObject({
      component: "hello",
      version: "0.1.1",
      need: "say it louder",
      thread_id: THREAD,
      depth: 0,
      provenance: { produced_by: "agent-1", parent: "hello@0.1.0" },
      outcome: "candidate",
    });
    expect(graph.edges).toEqual([{ fromNodeId: "n-2", toNodeId: "n-1", type: "SUPERSEDES" }]);
    expect(reconciler.pending()).toEqual([{ name: "hello", version: "0.1.1", entityId: "n-2" }]);
  });

  it("prepare links to an existing parent entity instead of creating one", async () => {
    const graph = memoryGraph();
    await graph.adapter.storeEntity({
      agent_id: "seed",
      user_input: "[component_version] hello@0.1.0",
      agent_output: "the seed",
      context: "component_version hello",
      metadata: {
        entity_type: "component_version",
        title: "hello@0.1.0",
        tags: ["component_version"],
        status: "completed",
        custom_metadata: { outcome: "converged" },
      },
    });
    const { tools } = build(graph);
    const text = await prepare(tools);
    expect(text).toContain("lineage: recorded (id n-2; supersedes hello@0.1.0)");
    expect(text).not.toContain("parent entity created");
    expect(graph.edges).toEqual([{ fromNodeId: "n-2", toNodeId: "n-1", type: "SUPERSEDES" }]);
  });

  it("prepare still succeeds when graph memory is unreachable, and says so", async () => {
    const graph = memoryGraph();
    const down = async () => {
      throw new Error("nats: no responders");
    };
    (graph.adapter.searchEntities as jest.Mock).mockImplementation(down);
    (graph.adapter.graphQuery as jest.Mock).mockImplementation(down);
    const { tools, reconciler } = build(graph);
    const text = await prepare(tools);
    expect(text).toContain("Prepared hello@0.1.1 from hello@0.1.0");
    expect(text).toContain("lineage: not recorded — nats: no responders");
    expect(existsSync(path.join(host, "hello", ".versions", "0.1.1", "component.json"))).toBe(true);
    expect(graph.adapter.storeEntity).not.toHaveBeenCalled();
    expect(reconciler.pending()).toEqual([]);
  });

  it("announce marks a candidate announced", async () => {
    const graph = memoryGraph();
    const { tools } = build(graph);
    await prepare(tools);
    const text = await byName(tools, "announce_component_version").invoke(
      { name: "hello", version: "0.1.1", summary: "Louder now." },
      config,
    );
    expect(text).toContain("lineage: announced (id n-2)");
    const child = graph.entity("n-2");
    expect(child.custom.provenance).toEqual({
      produced_by: "agent-1",
      parent: "hello@0.1.0",
      announced_at: NOW,
    });
    expect(child.custom.outcome).toBe("candidate");
    expect(graph.updates[0]?.properties).toMatchObject({ tags: ["announced"] });
    expect(graph.updates[0]?.modes).toMatchObject({ tags: "merge" });
  });

  it("announce settles a failed outcome with the summary as the reason, once", async () => {
    const graph = memoryGraph();
    const { tools, reconciler } = build(graph);
    await prepare(tools);
    const text = await byName(tools, "announce_component_version").invoke(
      { name: "hello", version: "0.1.1", summary: "Three rounds, still failing.", outcome: "failed" },
      config,
    );
    expect(text).toContain("lineage: settled as failed (id n-2)");
    const child = graph.entity("n-2");
    expect(child.custom).toMatchObject({
      outcome: "failed",
      reason: "Three rounds, still failing.",
      settled_at: NOW,
    });
    expect(child.status).toBe("completed");
    expect(child.tags).toContain("outcome:failed");
    expect(child.tags).not.toContain("outcome:candidate");
    expect(reconciler.pending()).toEqual([]);

    const again = await byName(tools, "announce_component_version").invoke(
      { name: "hello", version: "0.1.1", summary: "Still.", outcome: "failed" },
      config,
    );
    expect(again).toContain("lineage: already settled (id n-2)");
    expect(graph.updates).toHaveLength(1);
  });

  it("announce says when a version has no entity and carries on", async () => {
    const graph = memoryGraph();
    const { tools } = build(graph);
    writeComponent(host, "hello", "0.1.1", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      manifest: {
        intent: "Say hello.",
        lineage: { producedBy: "agent-1", parent: "hello@0.1.0", need: "n" },
      },
    });
    const text = await byName(tools, "announce_component_version").invoke(
      { name: "hello", version: "0.1.1", summary: "s" },
      config,
    );
    expect(text).toContain("lineage: no entity for hello@0.1.1; nothing updated");
    expect(text).toContain("**hello@0.1.1** — s");
  });
});

describe("buildAnnouncementText", () => {
  it("omits the link without a thread id", () => {
    expect(
      buildAnnouncementText({ name: "hello", version: "0.1.1", summary: "s", outcome: "candidate", agentId: "a" }),
    ).toBe("**hello@0.1.1** — s");
  });
});
