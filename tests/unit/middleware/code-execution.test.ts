/**
 * The bundled `createCodeExecutionMiddleware`: a thin shell that evaluates
 * the seed component's in-tree twin with an in-tree dependency bundle.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tool, type AgentMiddleware } from "langchain";
import { z } from "zod/v4";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  CODE_EXECUTION_MIDDLEWARE_NAME,
  createCodeExecutionMiddleware,
} from "../../../src/middleware/code-execution.js";
import { buildComponentDeps, buildInternals } from "../../../src/components/sdk.js";
import seedEntry from "../../../src/components/seed/execute-code/entry.js";

type ToolLike = { name: string; schema: unknown; invoke: (args: unknown, config?: unknown) => Promise<unknown> };
type MiddlewareLike = AgentMiddleware & {
  tools?: ToolLike[];
  dispose?: (threadId?: string) => Promise<void>;
};

function stubTool(name: string) {
  return tool(async () => name, { name, description: name, schema: z.object({}) });
}

describe("createCodeExecutionMiddleware", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("builds the CodeExecutionMiddleware carrying execute_code", () => {
    const middleware = createCodeExecutionMiddleware({
      projectRoot: "/tmp/project",
      tools: [],
    }) as MiddlewareLike;
    expect(middleware.name).toBe(CODE_EXECUTION_MIDDLEWARE_NAME);
    expect(middleware.tools?.map((t) => t.name)).toEqual(["execute_code"]);
    // The contract's cleanup hook rides along, off the enumerable surface.
    expect(typeof middleware.dispose).toBe("function");
    expect(Object.keys(middleware)).not.toContain("dispose");
  });

  it("advertises timeout as optional with no default", () => {
    const middleware = createCodeExecutionMiddleware({
      projectRoot: "/tmp/project",
      tools: [],
    }) as MiddlewareLike;
    const schema = toJsonSchema(middleware.tools![0].schema as never) as {
      required?: string[];
    };
    expect(schema.required).toEqual(["code"]);
    expect(JSON.stringify(schema)).not.toContain('"default"');
  });

  it("agrees with the twin on the middleware name", () => {
    const deps = buildComponentDeps({
      manifest: {
        name: "execute-code",
        version: "0.0.0",
        kind: "middleware",
        intent: "test",
        sdk: "^1.0.0",
        entry: "entry.ts",
        contract: "contract.ts",
        replaces: CODE_EXECUTION_MIDDLEWARE_NAME,
        depth: 0,
        lineage: { producedBy: "test" },
      },
      componentDir: "/tmp/component",
      config: { agentId: "a", agentName: "A", projectRoot: "/tmp/project" },
      services: {},
      internals: buildInternals(),
    });
    const twin = seedEntry(deps) as MiddlewareLike;
    const shell = createCodeExecutionMiddleware({
      projectRoot: "/tmp/project",
      tools: [],
    }) as MiddlewareLike;
    expect(twin.name).toBe(shell.name);
    expect(twin.tools?.map((t) => t.name)).toEqual(shell.tools?.map((t) => t.name));
  });

  it("exposes the call-site tools, filtered by allowedToolPatterns, to the executor", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "code-exec-shell-"));
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const middleware = createCodeExecutionMiddleware({
      projectRoot,
      tools: [stubTool("web_search"), stubTool("bash"), stubTool("read_file")],
      allowedToolPatterns: [/^web_/, /^read_/],
    }) as MiddlewareLike;
    cleanups.push(() => middleware.dispose?.());

    const output = await middleware.tools![0].invoke(
      {
        code: [
          'import { readdirSync, readFileSync, statSync } from "node:fs";',
          'import { dirname, join } from "node:path";',
          'import { fileURLToPath } from "node:url";',
          "const here = dirname(fileURLToPath(import.meta.url));",
          "const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {",
          "  const full = join(dir, name);",
          "  return statSync(full).isDirectory() ? walk(full) : [full];",
          "});",
          'const text = walk(join(here, "tools-api")).map((f) => readFileSync(f, "utf-8")).join("\\n");',
          "console.log(JSON.stringify({",
          '  webSearch: text.includes("web_search"),',
          '  readFile: text.includes("read_file"),',
          '  bash: text.includes("bash"),',
          "}));",
        ].join("\n"),
      },
      { configurable: { thread_id: "shell-test" } },
    );
    const seen = JSON.parse(String(output).trim()) as Record<string, boolean>;
    expect(seen).toEqual({ webSearch: true, readFile: true, bash: false });
  }, 30_000);
});
