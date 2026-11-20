/**
 * Filesystem Middleware Tests
 *
 * Based on deepagentsjs tests/unit/middleware.test.ts
 * Tests that the filesystem middleware properly:
 * - Creates all required tools (ls, read_file, write_file, edit_file, glob, grep)
 * - Tools have valid schemas and descriptions
 * - Works with different backends
 */

import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createFilesystemMiddleware,
  createFilesystemTools,
  TOOLS_EXCLUDED_FROM_EVICTION,
} from "../../../src/middleware/fs.js";
import {
  FilesystemBackend,
  MAX_BINARY_READ_BYTES,
} from "../../../src/backends/filesystem.js";
import {
  clearPdfTextCache,
  setPdfParserLoader,
} from "../../../src/utils/pdf-text.js";
import { fakeLoader, fakePdf } from "../fixtures/fake-pdf.js";
import { JPEG_BYTES, PNG_BYTES } from "../fixtures/images.js";
import { ToolMessage } from "@langchain/core/messages";
import {
  IMAGE_MAX_BYTES,
  SCAN_MAX_PAGES,
  isFileViewArtifact,
} from "../../../src/utils/file-view.js";
import { normalizeToolResult } from "../../../src/code-execution/ipc-bridge.js";
import { StateBackend } from "../../../src/backends/state.js";

describe("FilesystemMiddleware", () => {
  it("should initialize with default backend (StateBackend)", () => {
    const middleware = createFilesystemMiddleware();
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("FilesystemMiddleware");
    const tools = middleware.tools || [];
    expect(tools.length).toBeGreaterThanOrEqual(6); // ls, read, write, edit, glob, grep
    expect(tools.map((t) => t.name)).toContain("ls");
    expect(tools.map((t) => t.name)).toContain("read_file");
    expect(tools.map((t) => t.name)).toContain("write_file");
    expect(tools.map((t) => t.name)).toContain("edit_file");
    expect(tools.map((t) => t.name)).toContain("glob");
    expect(tools.map((t) => t.name)).toContain("grep");
  });

  it("should initialize with StateBackend", () => {
    const backend = new StateBackend({ state: { files: {} } });
    const middleware = createFilesystemMiddleware({ backend });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("FilesystemMiddleware");
    const tools = middleware.tools || [];
    expect(tools.length).toBeGreaterThanOrEqual(6);
  });

  it("should initialize with FilesystemBackend", () => {
    const backend = new FilesystemBackend({
      rootDir: "/tmp",
      virtualMode: true,
    });
    const middleware = createFilesystemMiddleware({ backend });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("FilesystemMiddleware");
    const tools = middleware.tools || [];
    expect(tools.length).toBeGreaterThanOrEqual(6);
  });

  it("should have tools with proper descriptions", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    tools.forEach((tool) => {
      expect(tool.name).toBeDefined();
      expect((tool as any).description).toBeDefined();
      expect(typeof (tool as any).description).toBe("string");
      expect((tool as any).description.length).toBeGreaterThan(0);
    });
  });

  it("should have tools with proper schemas", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    tools.forEach((tool) => {
      expect(tool.schema).toBeDefined();
    });
  });

  it("should use custom tool descriptions", () => {
    const customDesc = "Custom ls tool description";
    const middleware = createFilesystemMiddleware({
      customToolDescriptions: {
        ls: customDesc,
      },
    });
    expect(middleware).toBeDefined();
    const tools = middleware.tools || [];
    const lsTool = tools.find((t) => t.name === "ls");
    expect(lsTool).toBeDefined();
    expect((lsTool as any).description).toBe(customDesc);
  });

  it("should have correct tool names", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    const toolNames = tools.map((t) => t.name);

    const expectedTools = [
      "ls",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
    ];
    expectedTools.forEach((toolName) => {
      expect(toolNames).toContain(toolName);
    });
  });

  it("should have tools with invoke or func method", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    tools.forEach((tool: any) => {
      // LangChain tools have either .func or .invoke methods
      const hasCallable =
        typeof tool.invoke === "function" || typeof tool.func === "function";
      expect(hasCallable).toBe(true);
    });
  });

  it("should reuse same middleware instance tools", () => {
    const middleware1 = createFilesystemMiddleware();
    const middleware2 = createFilesystemMiddleware();

    expect(middleware1.tools?.length).toBe(middleware2.tools?.length);
    expect(middleware1.name).toBe(middleware2.name);
  });

  it("should work with different backends but same tool count", () => {
    const middleware1 = createFilesystemMiddleware({
      backend: new StateBackend({ state: { files: {} } }),
    });
    const middleware2 = createFilesystemMiddleware({
      backend: new FilesystemBackend({
        rootDir: "/tmp",
        virtualMode: true,
      }),
    });

    expect(middleware1.tools?.length).toBe(middleware2.tools?.length);
    expect(middleware1.name).toBe(middleware2.name);
  });
});

describe("TOOLS_EXCLUDED_FROM_EVICTION", () => {
  it("should be an array", () => {
    expect(Array.isArray(TOOLS_EXCLUDED_FROM_EVICTION)).toBe(true);
  });

  it("should contain read_file", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("read_file");
  });

  it("should contain write_file", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("write_file");
  });

  it("should contain all filesystem tools", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("ls");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("glob");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("grep");
    expect(TOOLS_EXCLUDED_FROM_EVICTION).toContain("edit_file");
  });

  it("should have exactly 6 tools", () => {
    expect(TOOLS_EXCLUDED_FROM_EVICTION.length).toBe(6);
  });
});

describe("read_file on binary files", () => {
  let dir: string;
  let parses: number;

  async function readFile(input: {
    file_path: string;
    offset?: number;
    limit?: number;
  }): Promise<string> {
    const backend = new FilesystemBackend({ rootDir: dir, virtualMode: true });
    const tools = createFilesystemTools(backend);
    const tool = tools.find((t) => t.name === "read_file")!;
    return String(await tool.invoke(input));
  }

  /** Call `read_file` the way the agent loop does: with a tool call. */
  async function callReadFile(file_path: string): Promise<ToolMessage> {
    const backend = new FilesystemBackend({ rootDir: dir, virtualMode: true });
    const tools = createFilesystemTools(backend);
    const tool = tools.find((t) => t.name === "read_file")!;
    const message = await tool.invoke({
      name: "read_file",
      args: { file_path },
      id: "call_1",
      type: "tool_call",
    });
    expect(ToolMessage.isInstance(message)).toBe(true);
    return message as ToolMessage;
  }

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-read-binary-"));
    parses = 0;
    clearPdfTextCache();
    setPdfParserLoader(fakeLoader({ onParse: () => parses++ }));
  });

  afterEach(async () => {
    setPdfParserLoader();
    clearPdfTextCache();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("returns a PDF as numbered text with a separator per page", async () => {
    await fsp.writeFile(
      path.join(dir, "report.pdf"),
      fakePdf(["Quarterly report for the north region", "Total: 42 units sold"]),
    );
    const out = await readFile({ file_path: "/report.pdf" });
    const lines = out.split("\n").map((line) => line.replace(/^\s*\d+\t/, ""));
    expect(lines).toEqual([
      "--- page 1 of 2 ---",
      "Quarterly report for the north region",
      "--- page 2 of 2 ---",
      "Total: 42 units sold",
    ]);
    expect(out).toMatch(/^\s*1\t--- page 1 of 2 ---/);
    expect(out).not.toContain("binary file");
  });

  it("pages a long PDF by line and parses it once", async () => {
    const page = Array.from({ length: 9 }, (_, i) => `line ${i + 1} of text`);
    await fsp.writeFile(path.join(dir, "long.pdf"), fakePdf([page.join("\n")]));

    const first = await readFile({ file_path: "/long.pdf", limit: 4 });
    expect(first).toContain("line 3 of text");
    expect(first).not.toContain("line 4 of text");
    expect(first).toContain(
      "[PDF text, lines 1-4 of 10. Continue with offset=4.]",
    );

    const rest = await readFile({ file_path: "/long.pdf", offset: 4, limit: 100 });
    expect(rest).toMatch(/^\s*5\tline 4 of text/);
    expect(rest).toContain("line 9 of text");
    expect(rest).not.toContain("Continue with offset");
    expect(parses).toBe(1);
  });

  it("answers an offset past the end like a text file does", async () => {
    await fsp.writeFile(
      path.join(dir, "short.pdf"),
      fakePdf(["A short document with one line of text"]),
    );
    const out = await readFile({ file_path: "/short.pdf", offset: 50 });
    expect(out).toBe("Error: Line offset 50 exceeds file length (2 lines)");
  });

  it("says a PDF with no text layer is a scan", async () => {
    await fsp.writeFile(path.join(dir, "scan.pdf"), fakePdf(["", "", ""]));
    const out = await readFile({ file_path: "/scan.pdf" });
    expect(out).toContain("3 page(s) with no text layer");
  });

  it("names a scanned PDF in an artifact so its pages can be shown", async () => {
    const bytes = fakePdf(["", "", ""]);
    await fsp.writeFile(path.join(dir, "scan.pdf"), bytes);
    const message = await callReadFile("/scan.pdf");
    expect(message.content).toBe(
      "[PDF '/scan.pdf': 3 page(s) with no text layer (scanned images) — the pages are shown after this result for this turn only; read the file again to see it in a later turn]",
    );
    expect(message.artifact).toEqual({
      kind: "pdf-scan",
      path: "/scan.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      pages: 3,
    });
  });

  it("gives a scan with too many pages a marker and no artifact", async () => {
    const pages = Array.from({ length: SCAN_MAX_PAGES + 1 }, () => "");
    await fsp.writeFile(path.join(dir, "long-scan.pdf"), fakePdf(pages));
    const message = await callReadFile("/long-scan.pdf");
    expect(message.content).toBe(
      `[PDF '/long-scan.pdf': ${SCAN_MAX_PAGES + 1} page(s) with no text layer (scanned images) — too large to show (limits: 30 pages, 10 MiB), and there is no text to extract]`,
    );
    expect(message.artifact).toBeUndefined();
  });

  it("gives a PDF with text no artifact", async () => {
    await fsp.writeFile(
      path.join(dir, "report.pdf"),
      fakePdf(["Quarterly report for the north region"]),
    );
    const message = await callReadFile("/report.pdf");
    expect(message.content).toContain("Quarterly report for the north region");
    expect(message.artifact).toBeUndefined();
  });

  it("names an image in an artifact and returns a marker, never its bytes", async () => {
    await fsp.writeFile(path.join(dir, "shot.png"), PNG_BYTES);
    const message = await callReadFile("/shot.png");
    expect(message.content).toBe(
      `[image '/shot.png': image/png, ${PNG_BYTES.byteLength} bytes — shown after this result for this turn only; read the file again to see it in a later turn]`,
    );
    expect(message.artifact).toEqual({
      kind: "image",
      path: "/shot.png",
      mimeType: "image/png",
      size: PNG_BYTES.byteLength,
    });
    expect(isFileViewArtifact(message.artifact)).toBe(true);
    expect(message.name).toBe("read_file");
  });

  it("takes an image's type from its bytes, not its name", async () => {
    await fsp.writeFile(path.join(dir, "photo.png"), JPEG_BYTES);
    const message = await callReadFile("/photo.png");
    expect(message.content).toContain("[image '/photo.png': image/jpeg,");
    expect((message.artifact as { mimeType: string }).mimeType).toBe("image/jpeg");
  });

  it("keeps the placeholder for a file named as an image that is not one", async () => {
    await fsp.writeFile(path.join(dir, "not.png"), Buffer.from([0, 1, 2, 3]));
    const message = await callReadFile("/not.png");
    expect(message.content).toBe(
      "[binary file '/not.png': image/png, 4 bytes — not shown as text]",
    );
    expect(message.artifact).toBeUndefined();
  });

  it("keeps the placeholder for an image type that cannot be shown", async () => {
    await fsp.writeFile(path.join(dir, "photo.heic"), Buffer.from([0, 0, 0, 24]));
    const message = await callReadFile("/photo.heic");
    expect(message.content).toBe(
      "[binary file '/photo.heic': image/heic, 4 bytes — not shown as text]",
    );
    expect(message.artifact).toBeUndefined();
  });

  it("gives an image over the size limit a marker and no artifact", async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(PNG_BYTES);
    await fsp.writeFile(path.join(dir, "big.png"), big);
    const message = await callReadFile("/big.png");
    expect(message.content).toBe(
      `[image '/big.png': image/png, ${IMAGE_MAX_BYTES + 1} bytes — too large to show (limit 3 MiB)]`,
    );
    expect(message.artifact).toBeUndefined();
  });

  it("gives a text file and a failed read no artifact", async () => {
    await fsp.writeFile(path.join(dir, "notes.txt"), "hello\n");
    const text = await callReadFile("/notes.txt");
    expect(text.content).toContain("hello");
    expect(text.artifact).toBeUndefined();
    const missing = await callReadFile("/missing.png");
    expect(String(missing.content)).toMatch(/^Error: /);
    expect(missing.artifact).toBeUndefined();
  });

  it("returns only the marker string to a caller that is not the agent loop", async () => {
    await fsp.writeFile(path.join(dir, "shot.png"), PNG_BYTES);
    const backend = new FilesystemBackend({ rootDir: dir, virtualMode: true });
    const tool = createFilesystemTools(backend).find((t) => t.name === "read_file")!;
    // The code-execution tools API invokes a tool with its arguments alone
    // and passes the result through this normalizer.
    const result = await tool.invoke({ file_path: "/shot.png" });
    expect(typeof result).toBe("string");
    expect(normalizeToolResult(result)).toBe(
      `[image '/shot.png': image/png, ${PNG_BYTES.byteLength} bytes — shown after this result for this turn only; read the file again to see it in a later turn]`,
    );
  });

  it("reports a file named .pdf that is not one as an error", async () => {
    await fsp.writeFile(path.join(dir, "fake.pdf"), Buffer.from([0, 1, 2, 3]));
    const out = await readFile({ file_path: "/fake.pdf" });
    expect(out).toBe(
      "Error: Cannot read '/fake.pdf': the file is named as a PDF but is not one",
    );
    expect(parses).toBe(0);
  });

  it("keeps the placeholder for other binary files", async () => {
    await fsp.writeFile(
      path.join(dir, "clip.mp4"),
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
    );
    const out = await readFile({ file_path: "/clip.mp4" });
    expect(out).toBe(
      "[binary file '/clip.mp4': video/mp4, 4 bytes — not shown as text]",
    );
  });

  it("describes a binary file too large to load without reading it", async () => {
    const file = path.join(dir, "huge.pdf");
    await fsp.writeFile(file, "");
    // Sparse: the size is what matters, not the content.
    await fsp.truncate(file, MAX_BINARY_READ_BYTES + 1);
    const out = await readFile({ file_path: "/huge.pdf" });
    expect(out).toBe(
      `[binary file '/huge.pdf': application/pdf, ${MAX_BINARY_READ_BYTES + 1} bytes — too large to read]`,
    );
    expect(parses).toBe(0);
  });
});
