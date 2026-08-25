/**
 * Tools API Production-Surface Tests
 *
 * Runs the generator and the full execute-code round trip against the REAL
 * tool definitions (filesystem tools over a disk backend, plus the standard
 * tool set), never stubs. Stub-based gates previously passed while production
 * descriptions broke the generated modules — e.g. a description containing
 * "**\/*.py" terminated the generated JSDoc block early and made every
 * category index unparseable. These tests also rehearse the literal
 * acceptance program (read a prompt file through the tools-api import and
 * print its first line) through workspace generation, the IPC bridge, and
 * the tsx subprocess.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createFilesystemTools } from "../../../src/middleware/fs.js";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import {
  createSearchTool,
  createBashTool,
  createWebSearchTool,
  storeEntityTool,
  retrieveEntityTool,
  searchEntitiesTool,
  listEntitiesTool,
  updateEntityStatusTool,
  updateEntityTool,
  promoteEntitiesTool,
  traverseGraphTool,
  createChecklistTools,
} from "../../../src/tools/index.js";
import {
  generateToolAPIs,
  escapeJsDocText,
} from "../../../src/code-execution/tool-api-generator.js";
import { normalizeToolResult } from "../../../src/code-execution/ipc-bridge.js";
import { Command } from "@langchain/langgraph";
import { ToolEnabledExecutor } from "../../../src/code-execution/tool-enabled-executor.js";

/** Execution timeout: well under the jest timeout so a hang reports as timedOut */
const EXEC_TIMEOUT_MS = 30000;

/**
 * Build the production tool set rooted at `rootDir`.
 *
 * The six filesystem tools are always included — they are the tools the
 * acceptance flow exercises and the ones whose descriptions contain
 * comment-hostile text. The standard tools are included per-tool when they
 * construct in a test environment; construction failures are skipped (never
 * replaced with stubs) so the gate still covers everything that constructs.
 */
function buildProductionTools(rootDir: string): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [
    ...createFilesystemTools(
      new FilesystemBackend({ rootDir, virtualMode: false }),
    ),
  ];

  const optionalFactories: Array<
    [string, () => StructuredToolInterface | StructuredToolInterface[]]
  > = [
    ["search", () => createSearchTool(rootDir)],
    ["bash", () => createBashTool(rootDir)],
    ["web_search", () => createWebSearchTool()],
    ["checklists", () => createChecklistTools()],
  ];
  for (const [name, factory] of optionalFactories) {
    try {
      const created = factory();
      tools.push(...(Array.isArray(created) ? created : [created]));
    } catch {
      // Tool does not construct outside a full runtime environment; skip it
      // rather than substituting a stub.
      console.warn(`tools-api production gate: skipping ${name} (constructor threw)`);
    }
  }

  // Memory tools are module-level instances; if their module imported, they
  // constructed.
  tools.push(
    storeEntityTool,
    retrieveEntityTool,
    searchEntitiesTool,
    listEntitiesTool,
    updateEntityStatusTool,
    updateEntityTool,
    promoteEntitiesTool,
    traverseGraphTool,
  );

  return tools;
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

describe("Tools API production surface", () => {
  // One tmp root for the whole file: getProjectRoot() caches its result, so
  // SIA_PROJECT_ROOT must point at a single stable directory before the first
  // tool invocation and stay there.
  let tmpDir: string;
  let executor: ToolEnabledExecutor;
  let savedProjectRoot: string | undefined;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tools-api-production-"));
    savedProjectRoot = process.env.SIA_PROJECT_ROOT;
    process.env.SIA_PROJECT_ROOT = tmpDir;

    // Fixture mirroring the acceptance flow's target file
    mkdirSync(join(tmpDir, "prompts"), { recursive: true });
    writeFileSync(
      join(tmpDir, "prompts", "manager.md"),
      "You are **ARCHITECT**, the orchestrator.\nSecond line.\n",
    );

    executor = new ToolEnabledExecutor({
      projectRoot: tmpDir,
      tools: buildProductionTools(tmpDir),
    });
  });

  afterAll(async () => {
    if (savedProjectRoot === undefined) {
      delete process.env.SIA_PROJECT_ROOT;
    } else {
      process.env.SIA_PROJECT_ROOT = savedProjectRoot;
    }
    await executor.cleanup();
    if (tmpDir && existsSync(tmpDir)) {
      // Give subprocess/socket handles a moment to release before rm
      await new Promise((resolve) => setTimeout(resolve, 100));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits only valid TypeScript from the production tool set", async () => {
    const outputDir = join(tmpDir, "gen-gate", "tools-api");
    await generateToolAPIs({
      tools: buildProductionTools(tmpDir),
      outputDir,
      ipcSocketPath: join(tmpDir, "gen-gate", "test.sock"),
    });

    expect(transpileAll(outputDir)).toEqual([]);
  });

  it("keeps property docs from schema descriptions, escaped for JSDoc", async () => {
    const outputDir = join(tmpDir, "gen-docs", "tools-api");
    await generateToolAPIs({
      tools: buildProductionTools(tmpDir),
      outputDir,
      ipcSocketPath: join(tmpDir, "gen-docs", "test.sock"),
    });

    const globModule = readFileSync(
      join(outputDir, "filesystem", "glob.ts"),
      "utf-8",
    );
    // Tool description: comment-terminating sequences are escaped
    expect(globModule).toContain("**\\/*.py");
    // Property descriptions from the zod schema survive into @param docs,
    // with the same escaping applied
    expect(globModule).toContain("@param input.pattern");
    expect(globModule).toContain("**\\/*.ts");
  });

  it("runs the acceptance rehearsal: read a prompt file via the tools-api import", async () => {
    const code = [
      'import { readFile } from "./tools-api/filesystem";',
      'const content = await readFile({ file_path: "prompts/manager.md" });',
      'console.log("NONCE|" + content.split("\\n")[0]);',
    ].join("\n");

    const result = await executor.execute("rehearsal-read", code, EXEC_TIMEOUT_MS);

    // read_file returns cat -n style output, so the first line carries a
    // line-number prefix before the file text.
    expect(result.output).toMatch(/NONCE\|.*You are \*\*ARCHITECT\*\*,/);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 60000);

  it("returns a plain string from write_file through the bridge", async () => {
    const code = [
      'import { writeFile } from "./tools-api/filesystem";',
      "const result = await writeFile({",
      '  file_path: "written-by-tools-api.txt",',
      '  content: "hello from tools-api",',
      "});",
      'console.log("WRITE_TYPE|" + typeof result);',
      'console.log("WRITE_RESULT|" + result);',
    ].join("\n");

    const result = await executor.execute("rehearsal-write", code, EXEC_TIMEOUT_MS);

    expect(result.output).toContain("WRITE_TYPE|string");
    expect(result.output).toContain("WRITE_RESULT|Successfully wrote to");
    expect(result.output).not.toContain("[object Object]");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    const writtenPath = join(tmpDir, "written-by-tools-api.txt");
    expect(existsSync(writtenPath)).toBe(true);
    expect(readFileSync(writtenPath, "utf-8")).toBe("hello from tools-api");
  }, 60000);

  it("invokes read_file with only file_path and no graph run active", async () => {
    const readFileTool = createFilesystemTools(
      new FilesystemBackend({ rootDir: tmpDir, virtualMode: false }),
    ).find((t) => t.name === "read_file")!;

    // No offset/limit (they default in the handler) and no Pregel config —
    // the invocation profile of the code-execution bridge.
    const result = await readFileTool.invoke({
      file_path: join(tmpDir, "prompts", "manager.md"),
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("You are **ARCHITECT**,");
    expect(result).not.toContain("Error:");
  });
});

describe("escapeJsDocText", () => {
  it("escapes comment-terminating sequences", () => {
    expect(escapeJsDocText("e.g., '**/*.py' for all Python files")).toBe(
      "e.g., '**\\/*.py' for all Python files",
    );
  });

  it("is idempotent on already-escaped text", () => {
    const once = escapeJsDocText("'**/*.ts' and '*.py'");
    expect(escapeJsDocText(once)).toBe(once);
  });

  it("leaves clean text unchanged", () => {
    expect(escapeJsDocText("Read the contents of a file")).toBe(
      "Read the contents of a file",
    );
  });
});

describe("normalizeToolResult", () => {
  it("passes strings through unchanged", () => {
    expect(normalizeToolResult("plain result")).toBe("plain result");
  });

  it("flattens message-like results to their string content", () => {
    expect(
      normalizeToolResult({ content: "Successfully wrote to 'a.txt'" }),
    ).toBe("Successfully wrote to 'a.txt'");
  });

  it("stringifies non-string message content", () => {
    expect(normalizeToolResult({ content: [{ type: "text", text: "hi" }] })).toBe(
      '[{"type":"text","text":"hi"}]',
    );
  });

  it("rejects Command results with an error string", () => {
    const result = normalizeToolResult(new Command({ update: { files: {} } }));
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("not supported via the tools API");
  });

  it("JSON-stringifies other values", () => {
    expect(normalizeToolResult({ ok: true })).toBe('{"ok":true}');
    expect(normalizeToolResult(42)).toBe("42");
  });
});
