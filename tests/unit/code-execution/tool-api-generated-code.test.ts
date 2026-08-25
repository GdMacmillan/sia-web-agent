/**
 * Generated Code Quality Tests
 *
 * Pins that every file emitted by the tool API generator is valid TypeScript,
 * and that the runtime module keeps its exact line shapes. Existence/substring
 * checks alone let a reflowed template ship syntactically invalid output; the
 * transpile gate catches that class of regression regardless of how the
 * generator source gets reformatted.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import ts from "typescript";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { generateToolAPIs } from "../../../src/code-execution/tool-api-generator.js";

/** Tools spanning every built-in category plus the misc fallback */
function makeTools(): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: "read_file",
      description: "Read a file",
      schema: z.object({ path: z.string().describe("File path") }),
      func: async () => "content",
    }),
    new DynamicStructuredTool({
      name: "search_entities",
      description: "Search entities",
      schema: z.object({ query: z.string() }),
      func: async () => "results",
    }),
    new DynamicStructuredTool({
      name: "search",
      description: "Search the codebase",
      schema: z.object({ pattern: z.string() }),
      func: async () => "matches",
    }),
    new DynamicStructuredTool({
      name: "bash",
      description: "Run a shell command",
      schema: z.object({ command: z.string() }),
      func: async () => "output",
    }),
    new DynamicStructuredTool({
      name: "echo_message",
      description: "Echo a message",
      schema: z.object({ message: z.string() }),
      func: async ({ message }) => `Echo: ${message}`,
    }),
  ];
}

/** Recursively collect all .ts files under a directory */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- test helper walking a mkdtemp directory this test created.
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Transpile every generated .ts file and return formatted diagnostics */
function transpileAll(outputDir: string): string[] {
  const problems: string[] = [];
  const files = collectTsFiles(outputDir);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const result = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    for (const diag of result.diagnostics ?? []) {
      problems.push(
        `${file}: ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`,
      );
    }
  }
  return problems;
}

describe("Generated tool API code quality", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-api-gencode-"));
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits only valid TypeScript across all categories", async () => {
    const outputDir = join(tmpDir, "tools-api");
    await generateToolAPIs({
      tools: makeTools(),
      outputDir,
      ipcSocketPath: join(tmpDir, "test.sock"),
    });

    expect(transpileAll(outputDir)).toEqual([]);
  });

  it("emits valid TypeScript with a Windows named-pipe socket path", async () => {
    const outputDir = join(tmpDir, "tools-api-win");
    await generateToolAPIs({
      tools: makeTools(),
      outputDir,
      ipcSocketPath: "\\\\.\\pipe\\code-exec-abc-tools",
    });

    expect(transpileAll(outputDir)).toEqual([]);

    // The pipe path's backslashes must be escaped in the emitted source
    const runtime = readFileSync(join(outputDir, "_runtime.ts"), "utf-8");
    expect(runtime).toContain(
      'const IPC_SOCKET_PATH = "\\\\\\\\.\\\\pipe\\\\code-exec-abc-tools";',
    );
  });

  it("keeps the runtime module's load-bearing line shapes", async () => {
    const outputDir = join(tmpDir, "tools-api");
    await generateToolAPIs({
      tools: makeTools(),
      outputDir,
      ipcSocketPath: join(tmpDir, "test.sock"),
    });

    const runtime = readFileSync(join(outputDir, "_runtime.ts"), "utf-8");

    // Whole-line pins: a formatter re-mangle of the generator source that
    // merges or splits these lines fails here even if it stays syntactically
    // valid by luck.
    expect(runtime).toMatch(/^ *const lines = messageBuffer\.split\("\\n"\);$/m);
    expect(runtime).toMatch(
      /^ *console\.error\("Failed to parse IPC response:", e\);$/m,
    );
    expect(runtime).toMatch(/^const IPC_SOCKET_PATH = ".*";$/m);
    expect(runtime).toContain("export async function callTool(");
    expect(runtime).toContain("export function closeConnection(");
  });
});
