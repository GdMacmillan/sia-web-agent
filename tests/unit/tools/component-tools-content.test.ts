/**
 * The component tools over skills and prompts: `describe_component` with
 * and without a name, `create_component` with kind "skill", preparing a
 * version from the in-place seed, the built-in contract and its diff
 * line, and the diff a skill or prompt candidate is announced with (and
 * that a code candidate is announced without).
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { appendFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createComponentTools } from "../../../src/tools/component-tools.js";
import { DIFF_MAX_BYTES } from "../../../src/components/content-diff.js";
import { _resetComponentsForTests } from "../../../src/components/registry.js";
import { _resetContentWarningsForTests } from "../../../src/components/content.js";
import { resetConfig } from "../../../src/config/loader.js";
import { clearAllowedPathRoots } from "../../../src/utils/path-utils.js";
import type { IGraphMemoryAdapter } from "../../../src/vendor/svc-rpc/graph-memory/adapter-interface.js";
import {
  PASSING_CONTRACT,
  SERVICE_ENTRY,
  makeRoot,
  plainImport,
  removeRoot,
  writeComponent,
} from "../components/fixtures.js";
import {
  writeSeedPrompt,
  writeSeedSkill,
} from "../components/content-fixtures.js";

const THREAD = "44444444-4444-4444-8444-444444444444";
const config = { configurable: { thread_id: THREAD } };

interface Captured {
  url: string;
  body: Record<string, unknown> | undefined;
}

function fakeHost() {
  const captured: Captured[] = [];
  const fetchImpl = jest.fn(
    async (url: unknown, init: unknown): Promise<Response> => {
      const req = (init ?? {}) as RequestInit;
      captured.push({
        url: String(url),
        body: typeof req.body === "string" ? JSON.parse(req.body) : undefined,
      });
      const u = String(url);
      if (u.includes("/threads/")) {
        return new Response(
          JSON.stringify({ metadata: { channel: "dev", self_task: true } }),
          {
            status: 200,
          },
        );
      }
      if (u.endsWith("/chat/component-version")) {
        return new Response("{}", { status: 202 });
      }
      if (u.endsWith("/chat/publish")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected request ${u}`);
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, captured };
}

/** A minimal in-memory graph, enough for lineage to record and stamp. */
function memoryGraph() {
  const nodes = new Map<
    string,
    { id: string; properties: Record<string, unknown> }
  >();
  const updates: Array<{
    nodeId: string;
    properties: Record<string, unknown>;
    modes?: unknown;
  }> = [];
  let seq = 0;
  const adapter = {
    workspaceId: "ws",
    storeEntity: jest.fn(
      async (req: { agent_id: string; metadata: Record<string, unknown> }) => {
        seq += 1;
        const id = `n-${seq}`;
        nodes.set(id, {
          id,
          properties: { agent_id: req.agent_id, metadata: req.metadata },
        });
        return {
          id,
          agent_id: req.agent_id,
          timestamp: "t",
          metadata: req.metadata,
        };
      },
    ),
    searchEntities: jest.fn(async () => ({
      results: [...nodes.values()],
      level_used: "raw",
      levels_tried: ["raw"],
    })),
    graphQuery: jest.fn(async () => ({
      nodes: [...nodes.values()],
      edges: [],
    })),
    graphEdges: jest.fn(async (req: Record<string, unknown>) => ({
      id: "e-1",
      ...req,
    })),
    retrieveEntity: jest.fn(
      async ({ nodeId }: { nodeId: string }) => nodes.get(nodeId) ?? null,
    ),
    updateEntity: jest.fn(
      async (req: {
        nodeId: string;
        properties: Record<string, unknown>;
        modes?: unknown;
      }) => {
        updates.push(req);
        const node = nodes.get(req.nodeId);
        if (node) {
          const meta = node.properties.metadata as Record<string, unknown>;
          node.properties.metadata = { ...meta, ...req.properties };
        }
        return {
          id: req.nodeId,
          properties: node?.properties ?? {},
          version: 2,
          changed_fields: [],
        };
      },
    ),
  };
  const entity = (id: string) => {
    const meta = nodes.get(id)?.properties.metadata as Record<string, unknown>;
    return { ...meta, custom: meta.custom_metadata as Record<string, unknown> };
  };
  const idOf = (title: string) =>
    [...nodes.values()].find(
      (n) => (n.properties.metadata as Record<string, unknown>).title === title,
    )?.id;
  return {
    adapter: adapter as unknown as IGraphMemoryAdapter,
    updates,
    entity,
    idOf,
  };
}

describe("component tools — skills and prompts", () => {
  let project: string;
  let host: string;

  const byName = (
    tools: ReturnType<typeof createComponentTools>,
    name: string,
  ) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool;
  };

  beforeEach(() => {
    _resetContentWarningsForTests();
    project = makeRoot("project-");
    const seed = path.join(project, "components");
    mkdirSync(seed);
    host = path.join(makeRoot("host-"), "components");
    mkdirSync(host);
    writeComponent(seed, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      contract: PASSING_CONTRACT,
      currentFile: true,
      manifest: { intent: "Say hello.", lineage: { producedBy: "seed" } },
    });
    writeSeedSkill(project, "probe");
    writeSeedPrompt(project, "answer", "Answer the question asked.\n");
  });

  afterEach(() => {
    _resetComponentsForTests();
    clearAllowedPathRoots();
    resetConfig();
    removeRoot(project);
    removeRoot(path.dirname(host));
  });

  const tools = (extra: Record<string, unknown> = {}) =>
    createComponentTools({
      projectRoot: project,
      componentsDir: host,
      agentId: "agent-1",
      env: {},
      contract: { importModule: plainImport },
      ...extra,
    });

  const prepare = (t: ReturnType<typeof createComponentTools>, name: string) =>
    byName(t, "prepare_component_version").invoke(
      { name, need: "say it plainer" },
      config,
    );

  describe("describe_component", () => {
    it("lists code components, skills and prompts without a name", async () => {
      const text = await byName(tools(), "describe_component").invoke({});
      expect(text).toContain("Components: hello@0.1.0");
      expect(text).toContain(
        "skills: 1 (0 with host versions), named skill-<name>",
      );
      expect(text).toContain(
        "prompts: 1 (0 with host versions), named prompt-<name>: prompt-answer",
      );
    });

    it("describes a skill read in place from the source tree", async () => {
      const text = await byName(tools(), "describe_component").invoke({
        name: "skill-probe",
      });
      expect(text).toContain('Component "skill-probe" (the probe skill)');
      expect(text).toContain(
        `current version: 1.0.0 (seed, served from ${path.join(project, "skills", "probe", "SKILL.md")})`,
      );
      expect(text).toContain("versions present: 1.0.0 (seed)");
      expect(text).toContain(
        "change it by preparing a version, never by editing it",
      );
      expect(text).toContain("contract: built in:");
    });

    it("names an unknown skill as a skill", async () => {
      expect(
        await byName(tools(), "describe_component").invoke({
          name: "skill-absent",
        }),
      ).toBe('Cannot describe component: unknown skill "absent"');
    });

    it("says when the seed changed under an activated version", async () => {
      const t = tools();
      await prepare(t, "skill-probe");
      symlinkSync(
        path.join(".versions", "1.0.1"),
        path.join(host, "skill-probe", "current"),
        "dir",
      );
      const before = await byName(t, "describe_component").invoke({
        name: "skill-probe",
      });
      expect(before).toContain("current version: 1.0.1 (host version");
      expect(before).not.toContain("seed changed");
      appendFileSync(
        path.join(project, "skills", "probe", "SKILL.md"),
        "\nNew upstream rule.\n",
      );
      const after = await byName(t, "describe_component").invoke({
        name: "skill-probe",
      });
      expect(after).toContain(
        "seed changed since this version's lineage was prepared from it",
      );
    });
  });

  describe("create_component", () => {
    it("creates a new skill with kind skill", async () => {
      const text = await byName(tools(), "create_component").invoke(
        {
          name: "skill-trip-planning",
          kind: "skill",
          intent: "Plan trips.",
          need: "plan my trip",
        },
        config,
      );
      expect(text).toContain("Created skill-trip-planning@0.1.0");
      expect(text).toContain("(a new skill: no parent, nothing served yet)");
      expect(text).toContain("do not create `current`");
    });

    it("refuses an unknown kind and a prompt", async () => {
      expect(
        await byName(tools(), "create_component").invoke(
          { name: "x", kind: "widget", intent: "i", need: "n" },
          config,
        ),
      ).toContain('kind must be "tools" or "skill"');
      expect(
        await byName(tools(), "create_component").invoke(
          { name: "prompt-answer", kind: "skill", intent: "i", need: "n" },
          config,
        ),
      ).toContain("prompts are not created");
    });
  });

  describe("prepare and run", () => {
    it("prepares from the copy shipped with the source tree", async () => {
      const text = await prepare(tools(), "skill-probe");
      expect(text).toContain(
        "Prepared skill-probe@1.0.1 from skill-probe@1.0.0 (the copy shipped with the source tree)",
      );
      expect(text).toContain(
        "Edit this version only, never the source tree's copy.",
      );
    });

    it("runs the built-in contract and reports the diff against the parent", async () => {
      const t = tools();
      await prepare(t, "skill-probe");
      const unchanged = await byName(t, "run_component_contract").invoke(
        { name: "skill-probe", version: "1.0.1" },
        config,
      );
      expect(unchanged).toContain("(built-in content contract)");
      expect(unchanged).toContain("diff against skill-probe@1.0.0: none yet");
      appendFileSync(
        path.join(host, "skill-probe", ".versions", "1.0.1", "SKILL.md"),
        "One more rule.\n",
      );
      const changed = await byName(t, "run_component_contract").invoke(
        { name: "skill-probe", version: "1.0.1" },
        config,
      );
      expect(changed).toContain("diff against skill-probe@1.0.0: +1 −0");
    });
  });

  describe("announce_component_version", () => {
    const announcing = () => {
      const host_ = fakeHost();
      const graph = memoryGraph();
      const t = tools({
        daemonUrl: "http://127.0.0.1:7700",
        daemonToken: "daemon-token",
        serverUrl: "http://127.0.0.1:2024",
        fetchImpl: host_.fetchImpl,
        adapter: () => graph.adapter,
        now: () => new Date("2026-10-14T10:00:00.000Z"),
      });
      const eventBody = () =>
        host_.captured.find((c) => c.url.endsWith("/chat/component-version"))
          ?.body;
      return { t, eventBody, graph };
    };

    it("sends a skill candidate's diff and records it on its lineage", async () => {
      const { t, eventBody, graph } = announcing();
      await prepare(t, "skill-probe");
      appendFileSync(
        path.join(host, "skill-probe", ".versions", "1.0.1", "SKILL.md"),
        "One more rule.\n",
      );
      const text = await byName(t, "announce_component_version").invoke(
        { name: "skill-probe", version: "1.0.1", summary: "Adds a rule." },
        config,
      );
      expect(text).toContain("diff: +1 −0 against skill-probe@1.0.0.");
      const diff = String(eventBody()?.diff);
      expect(diff).toContain("--- a/SKILL.md (skill-probe@1.0.0)");
      expect(diff).toContain("+One more rule.");
      const id = graph.idOf("skill-probe@1.0.1");
      expect(id).toBeDefined();
      const stamped = graph.entity(id as string);
      expect(stamped.custom).toMatchObject({ diff_added: 1, diff_removed: 0 });
      expect(String(stamped.custom.diff_sha256)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(stamped.content)).toContain(
        "Diff against skill-probe@1.0.0 (+1 −0)",
      );
      expect(stamped.tags).toEqual(expect.arrayContaining(["announced"]));

      // A re-announce of the same version records the diff once.
      const writes = graph.updates.length;
      await byName(t, "announce_component_version").invoke(
        { name: "skill-probe", version: "1.0.1", summary: "Adds a rule." },
        config,
      );
      const later = graph.updates.slice(writes);
      expect(JSON.stringify(later)).not.toContain("Diff against");
    });

    it("sends no diff field when the version matches its parent", async () => {
      const { t, eventBody } = announcing();
      await prepare(t, "skill-probe");
      const text = await byName(t, "announce_component_version").invoke(
        { name: "skill-probe", version: "1.0.1", summary: "No change." },
        config,
      );
      expect(text).toContain(
        "diff: none — skill-probe@1.0.1 matches skill-probe@1.0.0.",
      );
      expect(eventBody()).not.toHaveProperty("diff");
    });

    it("cuts a large diff to what the host carries", async () => {
      const { t, eventBody } = announcing();
      await prepare(t, "skill-probe");
      const lines = Array.from(
        { length: 1500 },
        (_, i) => `A long added rule line, number ${i}.`,
      );
      appendFileSync(
        path.join(host, "skill-probe", ".versions", "1.0.1", "notes.md"),
        `${lines.join("\n")}\n`,
      );
      const text = await byName(t, "announce_component_version").invoke(
        { name: "skill-probe", version: "1.0.1", summary: "Many notes." },
        config,
      );
      expect(text).toContain("(cut to fit what the host carries)");
      const diff = String(eventBody()?.diff);
      expect(Buffer.byteLength(diff, "utf-8")).toBeLessThanOrEqual(
        DIFF_MAX_BYTES,
      );
      expect(diff).toMatch(/… diff truncated: \d+ more lines\n$/);
    });

    it("sends no diff for a code component", async () => {
      const { t, eventBody } = announcing();
      await prepare(t, "hello");
      const text = await byName(t, "announce_component_version").invoke(
        { name: "hello", version: "0.1.1", summary: "Louder." },
        config,
      );
      expect(text).not.toContain("diff:");
      expect(eventBody()).toBeDefined();
      expect(eventBody()).not.toHaveProperty("diff");
    });
  });
});
