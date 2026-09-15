/**
 * Component loader: kind validation, replacement rules, services, and the
 * never-throw guarantee. Entries are served by a stub importer keyed on the
 * entry path so no module loading happens.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { realpathSync } from "node:fs";
import { tool } from "langchain";
import { z } from "zod/v4";
import {
  loadComponents,
  type ImportModule,
} from "../../../src/components/loader.js";
import { readReplaces } from "../../../src/components/replaces-tag.js";
import {
  buildInternals,
  SDK_VERSION,
  type ComponentDeps,
} from "../../../src/components/sdk.js";
import { logger } from "../../../src/utils/logger.js";
import { makeRoot, removeRoot, writeComponent } from "./fixtures.js";

const KNOWN = new Set([
  "CodeExecutionMiddleware",
  "FilesystemMiddleware",
  "knowledgeFormationMiddleware",
]);
const CONFIG = { agentId: "a", agentName: "A", projectRoot: "/tmp/project" };
const PLACEHOLDER_ENTRY = "export default 0;";

/** Importer that serves `modules[entryPath]`, throwing for anything else. */
function stubImporter(modules: Record<string, unknown>): ImportModule {
  return async (absolutePath) => {
    if (!(absolutePath in modules)) {
      throw new Error(`no stub module for ${absolutePath}`);
    }
    return modules[absolutePath];
  };
}

function echoTool(name = "component_echo") {
  return tool(async (input: { text: string }) => `echo:${input.text}`, {
    name,
    description: "Echo.",
    schema: z.object({ text: z.string() }),
  });
}

describe("loadComponents", () => {
  let root: string;
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    root = makeRoot();
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    removeRoot(root);
  });

  async function load(modules: Record<string, unknown>) {
    return loadComponents({
      roots: [root],
      config: CONFIG,
      internals: buildInternals(),
      knownMiddlewareNames: KNOWN,
      importModule: stubImporter(modules),
    });
  }

  it("returns empty output for an empty root", async () => {
    const result = await load({});
    expect(result.middleware).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.services).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it("accepts a middleware whose name matches replaces and tags it", async () => {
    const f = writeComponent(root, "exec", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware", replaces: "CodeExecutionMiddleware" },
    });
    const result = await load({
      [f.entryPath]: { default: () => ({ name: "CodeExecutionMiddleware" }) },
    });
    expect(result.skipped).toEqual([]);
    expect(result.middleware).toHaveLength(1);
    expect(result.middleware[0].replaces).toBe("CodeExecutionMiddleware");
    expect(readReplaces(result.middleware[0].middleware)).toBe(
      "CodeExecutionMiddleware",
    );
    expect(Object.keys(result.middleware[0].middleware)).toEqual(["name"]);
    expect(result.components.map((c) => c.manifest.name)).toEqual(["exec"]);
  });

  it("skips a middleware whose name does not match replaces", async () => {
    const f = writeComponent(root, "exec", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware", replaces: "CodeExecutionMiddleware" },
    });
    const result = await load({
      [f.entryPath]: { default: () => ({ name: "SomethingElse" }) },
    });
    expect(result.middleware).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/does not match replaces/);
  });

  it("skips replaces naming an unknown middleware", async () => {
    const f = writeComponent(root, "exec", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware", replaces: "NoSuchMiddleware" },
    });
    const importModule = jest.fn(stubImporter({ [f.entryPath]: {} }));
    const result = await loadComponents({
      roots: [root],
      config: CONFIG,
      internals: buildInternals(),
      knownMiddlewareNames: KNOWN,
      importModule,
    });
    expect(result.skipped[0].reason).toMatch(/not a middleware in the default stack/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("skips replaces naming required scaffolding", async () => {
    writeComponent(root, "fs", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware", replaces: "FilesystemMiddleware" },
    });
    const result = await load({});
    expect(result.skipped[0].reason).toMatch(/required scaffolding/);
  });

  it("skips a novel middleware whose name collides with a default", async () => {
    const f = writeComponent(root, "sneaky", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware" },
    });
    const result = await load({
      [f.entryPath]: { default: () => ({ name: "CodeExecutionMiddleware" }) },
    });
    expect(result.middleware).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/set "replaces"/);
  });

  it("accepts a novel middleware and leaves it untagged", async () => {
    const f = writeComponent(root, "novel", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware" },
    });
    const result = await load({
      [f.entryPath]: { default: () => ({ name: "novelMiddleware" }) },
    });
    expect(result.middleware).toHaveLength(1);
    expect(result.middleware[0].replaces).toBeUndefined();
    expect(readReplaces(result.middleware[0].middleware)).toBeUndefined();
  });

  it("skips a middleware entry that returns a non-middleware", async () => {
    const f = writeComponent(root, "bad", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware" },
    });
    const result = await load({ [f.entryPath]: { default: () => 42 } });
    expect(result.skipped[0].reason).toMatch(/did not return a middleware/);
  });

  it("collects tools from a tools component", async () => {
    const f = writeComponent(root, "echo", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "tools" },
    });
    const result = await load({
      [f.entryPath]: { default: () => [echoTool()] },
    });
    expect(result.tools.map((t) => t.name)).toEqual(["component_echo"]);
  });

  it("skips a tools entry that does not return an array of tools", async () => {
    const f = writeComponent(root, "echo", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "tools" },
    });
    const result = await load({
      [f.entryPath]: { default: () => [{ name: "no-invoke" }] },
    });
    expect(result.tools).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/array of tools/);
  });

  it("publishes a service, loads services first, and freezes the snapshot", async () => {
    // Alphabetically the consumer sorts first; services must still load first.
    const consumer = writeComponent(root, "alpha-consumer", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "middleware" },
    });
    const service = writeComponent(root, "zeta-service", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
    });
    let seenServices: ComponentDeps["services"] | undefined;
    const result = await load({
      [service.entryPath]: { default: () => ({ ping: () => "pong" }) },
      [consumer.entryPath]: {
        default: (deps: ComponentDeps) => {
          seenServices = deps.services;
          return { name: "consumerMiddleware" };
        },
      },
    });
    expect(result.skipped).toEqual([]);
    expect(Object.keys(result.services)).toEqual(["zeta-service"]);
    expect(result.components.map((c) => c.manifest.name)).toEqual([
      "zeta-service",
      "alpha-consumer",
    ]);
    expect(seenServices).toBeDefined();
    expect(Object.isFrozen(seenServices)).toBe(true);
    const published = seenServices?.["zeta-service"] as { ping: () => string };
    expect(published.ping()).toBe("pong");
  });

  it("skips a component whose sdk range excludes the SDK", async () => {
    writeComponent(root, "old", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { sdk: "^2.0.0" },
    });
    const result = await load({});
    expect(result.skipped[0].reason).toContain(SDK_VERSION);
  });

  it("skips an entry that throws", async () => {
    const f = writeComponent(root, "boom", "0.1.0", { entry: PLACEHOLDER_ENTRY });
    const result = await load({
      [f.entryPath]: {
        default: () => {
          throw new Error("kaboom");
        },
      },
    });
    expect(result.skipped[0].reason).toMatch(/entry failed: kaboom/);
  });

  it("skips an entry whose import fails", async () => {
    writeComponent(root, "missing", "0.1.0", { entry: PLACEHOLDER_ENTRY });
    const result = await load({});
    expect(result.skipped[0].reason).toMatch(/entry failed: no stub module/);
  });

  it("skips an entry with no default export function", async () => {
    const f = writeComponent(root, "nodefault", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
    });
    const result = await load({ [f.entryPath]: { default: "nope" } });
    expect(result.skipped[0].reason).toMatch(/no default export function/);
  });

  it("propagates discovery skips and warns for every skip", async () => {
    writeComponent(root, "no-current", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      current: false,
    });
    writeComponent(root, "old", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { sdk: ">=9" },
    });
    const result = await load({});
    expect(result.skipped.map((s) => s.name).sort()).toEqual([
      "no-current",
      "old",
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("preserves discovery order among non-service components", async () => {
    const a = writeComponent(root, "a-tools", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "tools" },
    });
    const b = writeComponent(root, "b-tools", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { kind: "tools" },
    });
    const result = await load({
      [a.entryPath]: { default: () => [echoTool("a_tool")] },
      [b.entryPath]: { default: () => [echoTool("b_tool")] },
    });
    expect(result.tools.map((t) => t.name)).toEqual(["a_tool", "b_tool"]);
  });

  it("collects the manifest profile of a loaded component only", async () => {
    const ok = writeComponent(root, "ok", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { profile: { excludedTools: ["bash"] } },
    });
    writeComponent(root, "skipped", "0.1.0", {
      entry: PLACEHOLDER_ENTRY,
      manifest: { sdk: "^2.0.0", profile: { excludedTools: ["grep"] } },
    });
    const result = await load({ [ok.entryPath]: { default: () => ({}) } });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].excludedTools.has("bash")).toBe(true);
  });

  it("hands the entry the documented dependency bundle", async () => {
    const f = writeComponent(root, "deps", "0.1.0", { entry: PLACEHOLDER_ENTRY });
    let seen: ComponentDeps | undefined;
    await load({
      [f.entryPath]: {
        default: (deps: ComponentDeps) => {
          seen = deps;
          return {};
        },
      },
    });
    expect(seen).toBeDefined();
    expect(seen?.sdkVersion).toBe(SDK_VERSION);
    expect(typeof seen?.tool).toBe("function");
    expect(typeof seen?.createMiddleware).toBe("function");
    expect(typeof seen?.dispatchCustomEvent).toBe("function");
    expect(typeof seen?.z.object).toBe("function");
    expect(seen?.config).toEqual(CONFIG);
    expect(Object.isFrozen(seen?.config)).toBe(true);
    expect(seen?.manifest.name).toBe("deps");
    expect(seen?.componentDir).toBe(realpathSync(f.versionDir));
    expect(typeof seen?.internals.codeExecution.ToolEnabledExecutor).toBe("function");
    expect(seen?.internals.codeExecution.DEFAULT_TIMEOUT_MS).toBe(60000);
    expect(typeof seen?.logger.warn).toBe("function");
  });
});
