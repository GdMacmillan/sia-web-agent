/**
 * Filesystem Middleware Tests
 *
 * Based on deepagentsjs tests/unit/middleware.test.ts
 * Tests that the filesystem middleware properly:
 * - Creates all required tools (ls, read_file, write_file, edit_file, glob, grep)
 * - Tools have valid schemas and descriptions
 * - Works with different backends
 */

import { describe, it, expect } from "@jest/globals";
import {
  createFilesystemMiddleware,
  TOOLS_EXCLUDED_FROM_EVICTION,
} from "../../../src/middleware/fs.js";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
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
