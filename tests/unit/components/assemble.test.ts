/**
 * Assembly wiring: root resolution, path allow-listing, tool deduplication
 * and the no-op guarantee when no component root exists.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tool } from "langchain";
import { z } from "zod/v4";
import type { StructuredTool } from "@langchain/core/tools";
import {
  prepareComponentAssembly,
  resolveComponentRoots,
} from "../../../src/components/assemble.js";
import {
  _resetComponentsForTests,
  getActiveComponents,
  COMPONENTS_MIDDLEWARE_NAME,
} from "../../../src/components/registry.js";
import { buildInternals } from "../../../src/components/sdk.js";
import {
  clearAllowedPathRoots,
  getAllowedPathRoots,
  clearProjectRootCache,
} from "../../../src/utils/path-utils.js";
import { logger } from "../../../src/utils/logger.js";
import {
  SERVICE_ENTRY,
  makeRoot,
  plainImport,
  removeRoot,
  writeComponent,
} from "./fixtures.js";

const KNOWN = new Set(["CodeExecutionMiddleware"]);
const CONFIG = { agentId: "a", agentName: "A", projectRoot: "/tmp/project" };

function builtin(name: string): StructuredTool {
  return tool(async () => name, {
    name,
    description: name,
    schema: z.object({}),
  }) as unknown as StructuredTool;
}

const TOOL_ENTRY = (name: string) => `
export default function (deps: any) {
  return [deps.tool(async () => "x", { name: ${JSON.stringify(name)}, description: "x", schema: deps.z.object({}) })];
}
`;

describe("resolveComponentRoots", () => {
  let projectRoot: string;
  let override: string;

  beforeEach(() => {
    projectRoot = makeRoot("project-");
    override = makeRoot("override-");
  });

  afterEach(() => {
    removeRoot(projectRoot);
    removeRoot(override);
  });

  it("returns nothing when neither root exists", () => {
    expect(
      resolveComponentRoots({ projectRoot, componentsDir: undefined }),
    ).toEqual([]);
    expect(
      resolveComponentRoots({
        projectRoot,
        componentsDir: path.join(override, "missing"),
      }),
    ).toEqual([]);
  });

  it("lists the override before the seed root", () => {
    const seed = path.join(projectRoot, "components");
    mkdirSync(seed);
    expect(
      resolveComponentRoots({ projectRoot, componentsDir: override }),
    ).toEqual([path.resolve(override), path.resolve(seed)]);
  });

  it("drops a root that is the same directory as another", () => {
    const seed = path.join(projectRoot, "components");
    mkdirSync(seed);
    const alias = path.join(override, "alias");
    symlinkSync(seed, alias, "dir");
    expect(resolveComponentRoots({ projectRoot, componentsDir: alias })).toEqual(
      [path.resolve(alias)],
    );
  });
});

describe("prepareComponentAssembly", () => {
  let projectRoot: string;
  let override: string;
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    projectRoot = makeRoot("project-");
    override = makeRoot("override-");
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    _resetComponentsForTests();
    clearAllowedPathRoots();
    clearProjectRootCache();
    removeRoot(projectRoot);
    removeRoot(override);
  });

  const prepare = (tools: StructuredTool[], componentsDir?: string) =>
    prepareComponentAssembly({
      projectRoot,
      componentsDir,
      tools,
      knownMiddlewareNames: KNOWN,
      config: CONFIG,
      internals: buildInternals(),
      importModule: plainImport,
    });

  it("is a no-op when no root exists", async () => {
    const tools = [builtin("search")];
    const assembly = await prepare(tools);
    expect(assembly.middleware).toEqual([]);
    expect(assembly.tools).toBe(tools);
    expect(assembly.profileOverlays).toEqual([]);
    expect(assembly.loaded).toBeNull();
    expect(assembly.roots).toEqual([]);
    expect(getAllowedPathRoots()).toEqual([]);
    expect(getActiveComponents().components).toEqual([]);
  });

  it("loads a real service component and records it as active", async () => {
    writeComponent(override, "hello", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifest: { profile: { excludedTools: ["bash"] } },
    });
    const assembly = await prepare([builtin("search")], override);
    expect(assembly.loaded?.skipped).toEqual([]);
    expect(Object.keys(assembly.loaded?.services ?? {})).toEqual(["hello"]);
    expect(assembly.middleware.map((m) => m.name)).toEqual([
      COMPONENTS_MIDDLEWARE_NAME,
    ]);
    expect(assembly.profileOverlays).toHaveLength(1);
    expect(assembly.profileOverlays[0].excludedTools.has("bash")).toBe(true);
    const active = getActiveComponents();
    expect(active.components.map((c) => c.manifest.name)).toEqual(["hello"]);
    expect(active.roots).toEqual([path.resolve(override)]);
    expect((active.services.hello as { ping: () => string }).ping()).toBe("pong");
  });

  it("allow-lists each root as given and fully resolved", async () => {
    writeComponent(override, "hello", "0.1.0", { entry: SERVICE_ENTRY });
    await prepare([], override);
    const allowed = getAllowedPathRoots();
    expect(allowed).toContain(path.resolve(override));
    expect(allowed).toContain(realpathSync(override));
  });

  it("appends component tools after the built-ins", async () => {
    writeComponent(override, "echo", "0.1.0", {
      entry: TOOL_ENTRY("component_echo"),
      manifest: { kind: "tools" },
    });
    const assembly = await prepare([builtin("search")], override);
    expect(assembly.tools.map((t) => t.name)).toEqual(["search", "component_echo"]);
  });

  it("skips a component tool that collides with a built-in tool", async () => {
    writeComponent(override, "clash", "0.1.0", {
      entry: TOOL_ENTRY("search"),
      manifest: { kind: "tools" },
    });
    const search = builtin("search");
    const assembly = await prepare([search], override);
    expect(assembly.tools).toEqual([search]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "search" }),
      expect.stringMatching(/collides/),
    );
  });

  it("skips a component tool that collides with a middleware tool", async () => {
    writeComponent(override, "clash", "0.1.0", {
      entry: TOOL_ENTRY("read_file"),
      manifest: { kind: "tools" },
    });
    const assembly = await prepare([], override);
    expect(assembly.tools).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "read_file" }),
      expect.stringMatching(/collides/),
    );
  });

  it("adds no middleware when a root exists but nothing loads", async () => {
    writeComponent(override, "old", "0.1.0", {
      entry: SERVICE_ENTRY,
      manifest: { sdk: "^2.0.0" },
    });
    const assembly = await prepare([], override);
    expect(assembly.middleware).toEqual([]);
    expect(assembly.loaded?.skipped).toHaveLength(1);
  });

  it("reads the seed root under the project root", async () => {
    const seed = path.join(projectRoot, "components");
    mkdirSync(seed);
    writeComponent(seed, "seeded", "0.1.0", { entry: SERVICE_ENTRY });
    const assembly = await prepare([]);
    expect(assembly.roots).toEqual([path.resolve(seed)]);
    expect(Object.keys(assembly.loaded?.services ?? {})).toEqual(["seeded"]);
  });
});
