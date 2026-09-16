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
      expect(text).toContain(
        `Next: store the lineage entity, edit ${path.join(versionDir, "entry.ts")}`,
      );
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
      expect(text).toMatch(/^host chat endpoint not configured; the summary stays in this thread:\n\*\*hello@0\.1\.1\*\*/);
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

describe("buildAnnouncementText", () => {
  it("omits the link without a thread id", () => {
    expect(
      buildAnnouncementText({ name: "hello", version: "0.1.1", summary: "s", outcome: "candidate", agentId: "a" }),
    ).toBe("**hello@0.1.1** — s");
  });
});
