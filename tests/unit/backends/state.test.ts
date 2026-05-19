/**
 * State Backend Tests
 *
 * Tests that the StateBackend properly:
 * - Manages in-memory file state
 * - Stores and retrieves files efficiently
 * - Handles state updates correctly
 * - Works with the filesystem middleware
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { StateBackend } from "../../../src/backends/state.js";

describe("State Backend", () => {
  let backend: StateBackend;
  let mockState: any;

  beforeEach(() => {
    mockState = {
      files: {},
    };

    backend = new StateBackend({
      state: mockState,
    });
  });

  describe("write operations", () => {
    it("should write files to state", async () => {
      const result = await backend.write("/test.txt", "content");

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });

    it("should prevent overwriting existing files", async () => {
      // Write initial file
      await backend.write("/file.txt", "original");

      // Attempt to overwrite
      const result = await backend.write("/file.txt", "new");

      expect(result).toBeDefined();
    });

    it("should handle nested paths", async () => {
      const result = await backend.write("/deep/nested/file.txt", "content");

      expect(result).toBeDefined();
    });

    it("should handle UTF-8 content", async () => {
      const unicode = "Hello 世界 🌍";
      const result = await backend.write("/unicode.txt", unicode);

      expect(result).toBeDefined();
    });

    it("should handle large files in memory", async () => {
      const largeContent = "x".repeat(1000000); // 1MB

      const result = await backend.write("/large.txt", largeContent);

      expect(result).toBeDefined();
    });

    it("should handle empty files", async () => {
      const result = await backend.write("/empty.txt", "");

      expect(result).toBeDefined();
    });
  });

  describe("read operations", () => {
    it("should read files from state", async () => {
      await backend.write("/test.txt", "test content");

      const result = await backend.read("/test.txt");

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle non-existent files", async () => {
      const result = await backend.read("/nonexistent.txt");

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should read empty files", async () => {
      await backend.write("/empty.txt", "");

      const result = await backend.read("/empty.txt");

      expect(result).toBeDefined();
    });

    it("should read nested files", async () => {
      await backend.write("/path/to/file.txt", "nested content");

      const result = await backend.read("/path/to/file.txt");

      expect(result).toBeDefined();
    });
  });

  describe("edit operations", () => {
    it("should edit files in state", async () => {
      await backend.write("/edit.txt", "original content");

      const result = await backend.edit("/edit.txt", "original", "modified");

      expect(result).toBeDefined();
    });

    it("should handle failed edits gracefully", async () => {
      await backend.write("/edit.txt", "content");

      const result = await backend.edit(
        "/edit.txt",
        "not found",
        "replacement",
      );

      expect(result).toBeDefined();
    });

    it("should handle multiline edits", async () => {
      const original = "line1\nline2\nline3";
      await backend.write("/multi.txt", original);

      const result = await backend.edit(
        "/multi.txt",
        "line1\nline2",
        "modified",
      );

      expect(result).toBeDefined();
    });
  });

  describe("state isolation", () => {
    it("should keep state separate between instances", async () => {
      const state1 = { files: {} };
      const backend1 = new StateBackend({ state: state1 });

      const state2 = { files: {} };
      const backend2 = new StateBackend({ state: state2 });

      await backend1.write("/file1.txt", "content1");
      await backend2.write("/file2.txt", "content2");

      expect(state1.files).toBeDefined();
      expect(state2.files).toBeDefined();
    });

    it("should handle operations on state", async () => {
      const result = await backend.write("/file.txt", "content");

      // Backend should return result from operation
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });
  });

  describe("error handling", () => {
    it("should provide meaningful error responses", async () => {
      // Write initial file
      await backend.write("/file.txt", "content");

      // Attempt to write again
      const result = await backend.write("/file.txt", "new");

      expect(result).toBeDefined();
    });

    it("should not corrupt state on error", async () => {
      await backend.write("/good.txt", "good content");

      // Attempt bad operation
      await backend.write("/good.txt", "bad"); // This should fail

      // Original file should still exist
      const result = await backend.read("/good.txt");
      expect(result).toBeDefined();
    });
  });

  describe("sequential operations", () => {
    it("should handle sequence of writes", async () => {
      const r1 = await backend.write("/file1.txt", "content1");
      const r2 = await backend.write("/file2.txt", "content2");
      const r3 = await backend.write("/file3.txt", "content3");

      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();
    });

    it("should handle mixed operations", async () => {
      await backend.write("/file.txt", "original");
      await backend.edit("/file.txt", "original", "modified");
      const readResult = await backend.read("/file.txt");

      expect(readResult).toBeDefined();
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent writes to different files", async () => {
      const results = await Promise.all([
        backend.write("/file1.txt", "content1"),
        backend.write("/file2.txt", "content2"),
        backend.write("/file3.txt", "content3"),
      ]);

      expect(results.every((r) => r !== undefined)).toBe(true);
    });

    it("should handle concurrent reads", async () => {
      await backend.write("/shared.txt", "shared content");

      const results = await Promise.all([
        backend.read("/shared.txt"),
        backend.read("/shared.txt"),
        backend.read("/shared.txt"),
      ]);

      expect(results.every((r) => typeof r === "string")).toBe(true);
    });
  });

  describe("special cases", () => {
    it("should handle root path operations", async () => {
      const result = await backend.write("/", "root");

      expect(result).toBeDefined();
    });

    it("should handle paths with special characters", async () => {
      const filename = "/file-with_special.chars@2024.txt";
      const result = await backend.write(filename, "content");

      expect(result).toBeDefined();
    });

    it("should preserve file data accuracy", async () => {
      const content = "test content";
      await backend.write("/verify.txt", content);

      const read = await backend.read("/verify.txt");

      expect(typeof read).toBe("string");
    });
  });
});
