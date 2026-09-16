/**
 * The seed `execute-code` component, loaded from the real `components/`
 * root: discovery, replacement, the tool schema, the contract passing on
 * the shipped version — and the two ways a version fails safely: a
 * sabotaged entry is skipped and the bundled fallback still provides
 * `execute_code`; a sabotaged contract reports `ok: false`.
 *
 * The contract spawns real `tsx` processes; it runs under a temp project
 * root so its workspaces never land in the repo.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { AgentMiddleware } from "langchain";

jest.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: class {
    constructor(_options: unknown) {}
  },
}));

import { createDeepAgent, KNOWN_MIDDLEWARE_NAMES } from "../../../src/agent.js";
import { prepareComponentAssembly } from "../../../src/components/assemble.js";
import { runComponentContract } from "../../../src/components/contract.js";
import { readReplaces } from "../../../src/components/replaces-tag.js";
import {
  _resetComponentsForTests,
  setActiveComponents,
} from "../../../src/components/registry.js";
import { buildInternals } from "../../../src/components/sdk.js";
import { SEED_EXECUTE_CODE_VERSION } from "../../../src/middleware/code-execution.js";
import { clearAllowedPathRoots, getProjectRoot } from "../../../src/utils/path-utils.js";
import { logger } from "../../../src/utils/logger.js";
import { makeRoot, plainImport, removeRoot } from "./fixtures.js";

const repoRoot = getProjectRoot();
const seedDir = path.join(repoRoot, "components", "execute-code");
const seedVersionDir = path.join(seedDir, ".versions", SEED_EXECUTE_CODE_VERSION);

type ToolLike = { name: string; schema: unknown };
type MiddlewareLike = AgentMiddleware & { tools?: ToolLike[] };

function toolNames(list: readonly AgentMiddleware[] | undefined): string[] {
  return (list ?? []).flatMap((m) => ((m as MiddlewareLike).tools ?? []).map((t) => t.name));
}

/** A temp project root: the contract's workspaces go under it. */
function makeProjectRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "seed-project-"));
}

/** Copy the seed into `root` and rewrite one file under its version dir. */
function copySeedWith(
  root: string,
  file: "entry.ts" | "contract.ts",
  replace: [string, string],
): void {
  cpSync(seedDir, path.join(root, "execute-code"), { recursive: true });
  const target = path.join(root, "execute-code", ".versions", SEED_EXECUTE_CODE_VERSION, file);
  const source = readFileSync(target, "utf-8");
  expect(source).toContain(replace[0]);
  writeFileSync(target, source.replace(replace[0], replace[1]));
}

describe("seed execute-code component", () => {
  let projectRoot: string;
  let warn: ReturnType<typeof jest.spyOn>;
  const config = () => ({
    agentId: "a",
    agentName: "A",
    projectRoot,
  });

  beforeEach(() => {
    projectRoot = makeProjectRoot();
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    _resetComponentsForTests();
    clearAllowedPathRoots();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function assembleSeed(componentsDir?: string) {
    return prepareComponentAssembly({
      projectRoot: repoRoot,
      componentsDir,
      tools: [],
      knownMiddlewareNames: KNOWN_MIDDLEWARE_NAMES,
      config: config(),
      internals: buildInternals(),
      importModule: plainImport,
    });
  }

  it("is discovered from the shipped root through the one-line current file", async () => {
    const assembly = await assembleSeed();
    expect(assembly.loaded?.skipped).toEqual([]);
    const loaded = assembly.loaded?.components.map((c) => `${c.manifest.name}@${c.manifest.version}`);
    expect(loaded).toEqual([`execute-code@${SEED_EXECUTE_CODE_VERSION}`]);
    expect(assembly.loaded?.components[0].versionDir).toBe(seedVersionDir);
    expect(assembly.loaded?.components[0].manifest.replaces).toBe("CodeExecutionMiddleware");
    expect(assembly.loaded?.components[0].manifest.lineage.producedBy).toBe("seed");
  });

  it("loads as a CodeExecutionMiddleware replacement carrying execute_code", async () => {
    const assembly = await assembleSeed();
    const [replacement] = assembly.loaded?.middleware ?? [];
    expect(replacement?.middleware.name).toBe("CodeExecutionMiddleware");
    expect(readReplaces(replacement.middleware)).toBe("CodeExecutionMiddleware");
    expect(toolNames([replacement.middleware])).toEqual(["execute_code"]);
    expect(assembly.middleware.map((m) => m.name)).toEqual([
      "CodeExecutionMiddleware",
      "componentsMiddleware",
    ]);
  });

  it("advertises a schema with timeout optional and no defaults", async () => {
    const assembly = await assembleSeed();
    const tool = (assembly.loaded?.middleware[0].middleware as MiddlewareLike).tools?.[0];
    const schema = toJsonSchema(tool!.schema as never) as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(["code"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "code",
      "description",
      "timeout",
    ]);
    expect(schema.properties?.timeout.type).toBe("number");
    expect(JSON.stringify(schema)).not.toContain('"default"');
  });

  it("swaps the seed instance into both stacks and the bundled one never registers", async () => {
    const assembly = await assembleSeed();
    const agent = await createDeepAgent({
      model: { invoke: jest.fn(), stream: jest.fn(), modelName: "m" } as any,
      tools: [],
      projectRoot: repoRoot,
      middleware: assembly.middleware,
    });
    const options = (agent as unknown as { options: { middleware?: AgentMiddleware[] } }).options;
    const seedInstance = assembly.loaded?.middleware[0].middleware;
    const inMain = (options.middleware ?? []).filter((m) => m.name === "CodeExecutionMiddleware");
    expect(inMain).toHaveLength(1);
    expect(inMain[0]).toBe(seedInstance);
    expect(toolNames(options.middleware).filter((n) => n === "execute_code")).toHaveLength(1);
  });

  it("passes its own contract on the shipped version", async () => {
    const result = await runComponentContract("execute-code", {
      importModule: plainImport,
      config: config(),
    });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, version: SEED_EXECUTE_CODE_VERSION });
    expect(result.durationMs).toBeLessThan(30_000);
  }, 60_000);

  describe("a sabotaged version", () => {
    let root: string;

    beforeEach(() => {
      root = makeRoot("components-sabotage-");
    });

    afterEach(() => {
      removeRoot(root);
    });

    it("with a wrong middleware name is skipped and the bundled fallback still provides execute_code", async () => {
      copySeedWith(root, "entry.ts", [
        'name: "CodeExecutionMiddleware"',
        'name: "SomethingElse"',
      ]);
      const assembly = await assembleSeed(root);
      expect(assembly.loaded?.components).toEqual([]);
      expect(assembly.loaded?.skipped).toEqual([
        expect.objectContaining({
          name: "execute-code",
          reason: expect.stringMatching(/does not match replaces/),
        }),
      ]);
      expect(assembly.middleware).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: "execute-code" }),
        "component skipped",
      );

      const agent = await createDeepAgent({
        model: { invoke: jest.fn(), stream: jest.fn(), modelName: "m" } as any,
        tools: [],
        projectRoot: repoRoot,
        middleware: assembly.middleware,
      });
      const options = (agent as unknown as { options: { middleware?: AgentMiddleware[] } }).options;
      expect(toolNames(options.middleware)).toContain("execute_code");
    });

    it("with a contract that asserts the wrong answer fails the contract", async () => {
      copySeedWith(root, "contract.ts", [
        'arithmetic.trim() === "42"',
        'arithmetic.trim() === "43"',
      ]);
      setActiveComponents({ components: [], roots: [root] });
      const result = await runComponentContract("execute-code", {
        importModule: plainImport,
        config: config(),
      });
      expect(result.ok).toBe(false);
      expect(result.version).toBe(SEED_EXECUTE_CODE_VERSION);
      expect(result.error).toMatch(/arithmetic: expected "42", got "42"/);
    }, 60_000);
  });
});
