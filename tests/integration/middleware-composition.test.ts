/**
 * Middleware Composition Tests
 *
 * Tests that multiple middleware components work together by verifying
 * they expose the correct tools and can be composed.
 *
 * Note: Tests that verify agent behavior with tools (LLM invocation)
 * are handled by the evaluation test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createFilesystemMiddleware } from "../../src/middleware/fs.js";
import { createSubAgentMiddleware } from "../../src/middleware/subagents.js";
import { FilesystemBackend } from "../../src/backends/filesystem.js";
import { createStandardModel } from "../../src/deep-agent-setup.js";

describe("Middleware Composition", () => {
  let testDir: string;
  let fsBackend: FilesystemBackend;
  let model: any;

  beforeEach(async () => {
    // Setup test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "middleware-compose-"));

    // Create filesystem backend
    fsBackend = new FilesystemBackend({
      rootDir: testDir,
      virtualMode: true,
    });

    // Setup model for subagent middleware (needed for task tool creation)
    model = await createStandardModel();
  });

  afterEach(async () => {
    // Cleanup test directory
    if (testDir && (await fs.stat(testDir).catch(() => null))) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("middleware availability", () => {
    it("should expose filesystem tools", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      expect(fsMiddleware.tools).toBeDefined();
      expect(Array.isArray(fsMiddleware.tools)).toBe(true);
      expect(fsMiddleware.tools.length).toBeGreaterThan(0);

      const toolNames = fsMiddleware.tools.map((t: any) => t.name);
      expect(toolNames).toContain("ls");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("glob");
      expect(toolNames).toContain("grep");
    });

    it("should expose subagent tools", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      const subagentMiddleware = await createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: fsMiddleware.tools,
        generalPurposeAgent: true,
      });

      expect(subagentMiddleware.tools).toBeDefined();
      expect(Array.isArray(subagentMiddleware.tools)).toBe(true);

      const toolNames = subagentMiddleware.tools.map((t: any) => t.name);
      expect(toolNames).toContain("task");
    });
  });

  describe("tool composition", () => {
    it("should combine tools from multiple middleware", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      const subagentMiddleware = await createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: fsMiddleware.tools,
        generalPurposeAgent: true,
      });

      const composedTools = [
        ...fsMiddleware.tools,
        ...subagentMiddleware.tools.filter(
          (t: any) => !fsMiddleware.tools.some((ft: any) => ft.name === t.name),
        ),
      ];

      // Should have filesystem + subagent tools
      expect(composedTools.length).toBeGreaterThan(fsMiddleware.tools.length);
    });
  });

  describe("middleware stacking", () => {
    it("should support stacking filesystem and subagent middleware", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      const subagentMiddleware = await createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: fsMiddleware.tools,
        generalPurposeAgent: true,
      });

      const fsTools = fsMiddleware.tools;
      const subagentTools = subagentMiddleware.tools;

      expect(fsTools.length).toBeGreaterThan(0);
      expect(subagentTools.length).toBeGreaterThan(0);
    });
  });

  describe("middleware capabilities", () => {
    it("should provide all expected filesystem tools", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      const toolNames = fsMiddleware.tools.map((t: any) => t.name);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("ls");
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("glob");
    });

    it("should provide task delegation capability", async () => {
      const fsMiddleware = createFilesystemMiddleware({
        backend: fsBackend,
      });

      const subagentMiddleware = await createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: fsMiddleware.tools,
        generalPurposeAgent: true,
      });

      const taskTool = subagentMiddleware.tools.find(
        (t: any) => t.name === "task",
      );

      expect(taskTool).toBeDefined();
      expect(typeof taskTool!.func).toBe("function");
    });
  });
});
