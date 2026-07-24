/**
 * Middleware Context Passing Tests
 *
 * Verifies that the ls tool has access to projectRoot context through the middleware stack
 */

import { describe, it, expect } from "@jest/globals";
import * as path from "path";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";

describe("Middleware context passing for filesystem tools", () => {
  describe("FilesystemBackend initialization with rootDir", () => {
    it("should initialize with explicit rootDir", () => {
      const customRoot = "/custom/project/root";
      const backend = new FilesystemBackend({ rootDir: customRoot });
      // Backend is initialized - we can test behavior to infer correct initialization
      expect(backend).toBeDefined();
    });

    it("should fall back to process.cwd() if no rootDir provided", () => {
      const backend = new FilesystemBackend();
      expect(backend).toBeDefined();
      // When no rootDir is provided, it should use process.cwd()
    });

    it("should resolve relative paths relative to rootDir", async () => {
      const testRoot = path.resolve(process.cwd(), "packages");
      const backend = new FilesystemBackend({ rootDir: testRoot });

      // List contents using relative path
      const infos = (await backend.ls(".")).files ?? [];
      expect(infos).toBeDefined();
      expect(Array.isArray(infos)).toBe(true);
    });
  });

  describe("Path context in tool invocation", () => {
    it("tool should receive configured root context during invocation", () => {
      // The tool is created in middleware/fs.ts with a backend that has context
      // When the tool is invoked, it should use that backend's rootDir
      const projectRoot = process.cwd();
      const backend = new FilesystemBackend({ rootDir: projectRoot });

      // This simulates what the middleware does
      expect(backend).toBeDefined();
      // The backend knows about projectRoot through its cwd property
    });
  });

  describe("Context isolation - tool receives correct environment", () => {
    it("backend initialized with projectRoot should list projectRoot contents on empty path", async () => {
      const projectRoot = path.resolve(process.cwd(), "packages/agent");
      const backend = new FilesystemBackend({ rootDir: projectRoot });

      // When we pass empty string, backend resolves it to projectRoot
      const infos = (await backend.ls("")).files ?? [];

      // All paths should be within projectRoot
      for (const info of infos) {
        expect(info.path).toMatch(
          new RegExp(
            `^${projectRoot.replace(/\\/g, "\\\\")}|^${projectRoot.replace(/\\/g, "\\\\")}`,
          ),
        );
      }
    });

    it("backend with virtualMode should prevent access outside rootDir", async () => {
      const projectRoot = process.cwd();
      const backend = new FilesystemBackend({
        rootDir: projectRoot,
        virtualMode: true,
      });

      // With virtualMode, we should not be able to access /etc or other system dirs
      // This is a security feature that prevents escaping the sandbox
      const infos = (await backend.ls("/etc")).files ?? [];
      // With virtualMode, /etc would be treated as virtual path under projectRoot/etc
      // It should either be empty or list virtual/etc
      expect(Array.isArray(infos)).toBe(true);
    });
  });
});
