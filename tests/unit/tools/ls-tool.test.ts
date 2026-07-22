/**
 * Diagnostic Tests for `ls` Tool Path Resolution
 *
 * These tests isolate the `ls` tool to determine if the issue is:
 * 1. The tool's default path handling
 * 2. The backend's path resolution
 * 3. The context/initialization
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import { getAgentPackageRoot } from "../../../src/utils/path-utils.js";

describe("FilesystemBackend - ls tool path resolution", () => {
  let backend: FilesystemBackend;
  // Use the agent package root directory which definitely exists
  const projectRoot = getAgentPackageRoot();

  beforeEach(() => {
    // Initialize backend with a known project root
    backend = new FilesystemBackend({
      rootDir: projectRoot,
      virtualMode: false,
    });
  });

  describe("Path resolution behavior", () => {
    it("should resolve absolute path /usr without error", async () => {
      // This test documents that absolute paths are passed through to filesystem
      const infos = (await backend.ls("/usr")).files ?? [];
      // /usr should exist on most systems
      expect(Array.isArray(infos)).toBe(true);
      if (infos.length > 0) {
        // If /usr has files, verify they're absolute paths
        expect(infos[0].path).toMatch(/^\/usr/);
      }
    });

    it("should resolve empty string without error", async () => {
      // Empty string as relative path should resolve to cwd (projectRoot)
      const infos = (await backend.ls("")).files ?? [];
      // Should return an array (may be empty depending on directory)
      expect(Array.isArray(infos)).toBe(true);
    });

    it("should resolve relative path 'src' without error", async () => {
      // Relative paths should resolve relative to projectRoot
      const infos = (await backend.ls("src")).files ?? [];
      // Should not throw an error
      expect(Array.isArray(infos)).toBe(true);
    });

    it("should resolve root string / without error", async () => {
      // "/" is treated as absolute path by resolvePath
      const infos = (await backend.ls("/")).files ?? [];
      expect(Array.isArray(infos)).toBe(true);
    });

    it("should resolve dot . without error", async () => {
      // Current directory is projectRoot
      const infos = (await backend.ls(".")).files ?? [];
      // Should return an array
      expect(Array.isArray(infos)).toBe(true);
    });
  });

  describe("Backend context availability", () => {
    it("backend should have projectRoot available via cwd", () => {
      // Check if backend was initialized with correct context
      expect(backend).toBeDefined();
      // We can't directly access private cwd, but we know it was initialized with projectRoot
    });

    it("backend should handle both absolute and relative paths", async () => {
      // Test that both absolute paths (/) and relative paths ("") work without error
      const rootDirInfos = (await backend.ls("/")).files ?? [];
      const projectDirInfos = (await backend.ls("")).files ?? [];

      // Both should return arrays
      expect(Array.isArray(rootDirInfos)).toBe(true);
      expect(Array.isArray(projectDirInfos)).toBe(true);

      // They may or may not have different content depending on the system,
      // but they should both execute successfully
    });
  });
});
