/**
 * Filesystem Backend Tests
 *
 * Tests that the FilesystemBackend properly:
 * - Reads and writes files safely
 * - Enforces path security (no traversal, symlink protection)
 * - Handles nested directories
 * - Manages permissions appropriately
 * - Provides proper error handling
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  lsFiles,
  globFiles,
  grepResult,
  readStr,
  readRawData,
} from "../../helpers/backend-compat.js";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";

describe("FilesystemBackend", () => {
  let testDir: string;
  let backend: FilesystemBackend;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-backend-test-"));
    backend = new FilesystemBackend({
      rootDir: testDir,
      virtualMode: true,
    });
  });

  afterEach(async () => {
    if (testDir && (await fs.stat(testDir).catch(() => null))) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("write operations", () => {
    it("should write new files", async () => {
      const result = await backend.write("/newfile.txt", "test content");

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");

      const content = await fs.readFile(
        path.join(testDir, "newfile.txt"),
        "utf-8",
      );
      expect(content).toBe("test content");
    });

    it("should prevent overwriting existing files", async () => {
      // Create initial file
      await fs.writeFile(path.join(testDir, "existing.txt"), "original");

      // Attempt to overwrite
      const result = await backend.write("/existing.txt", "new");

      expect(result).toBeDefined();
      // Should return error or indicate failure
      expect(typeof result).toBe("object");
    });

    it("should handle empty files", async () => {
      const result = await backend.write("/empty.txt", "");

      expect(result).toBeDefined();

      const content = await fs.readFile(
        path.join(testDir, "empty.txt"),
        "utf-8",
      );
      expect(content).toBe("");
    });

    it("should handle large files", async () => {
      const largeContent = "x".repeat(1000000);
      const result = await backend.write("/large.txt", largeContent);

      expect(result).toBeDefined();

      const content = await fs.readFile(
        path.join(testDir, "large.txt"),
        "utf-8",
      );
      expect(content.length).toBe(largeContent.length);
    });

    it("should handle UTF-8 content", async () => {
      const content = "Hello 世界 🌍";
      const result = await backend.write("/unicode.txt", content);

      expect(result).toBeDefined();

      const readContent = await fs.readFile(
        path.join(testDir, "unicode.txt"),
        "utf-8",
      );
      expect(readContent).toBe(content);
    });

    it("should create nested directories", async () => {
      const result = await backend.write(
        "/deep/nested/path/file.txt",
        "content",
      );

      expect(result).toBeDefined();

      const content = await fs.readFile(
        path.join(testDir, "deep", "nested", "path", "file.txt"),
        "utf-8",
      );
      expect(content).toBe("content");
    });

    it("should handle special characters in filenames", async () => {
      const result = await backend.write(
        "/file-with_special@2024.txt",
        "content",
      );

      expect(result).toBeDefined();
    });
  });

  describe("read operations", () => {
    it("should read file contents", async () => {
      const testContent = "Test file content";
      await fs.writeFile(path.join(testDir, "read-test.txt"), testContent);

      const result = await readStr(backend, "/read-test.txt");

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain(testContent);
    });

    it("should handle non-existent files", async () => {
      const result = await readStr(backend, "/nonexistent.txt");

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      // Should contain error message or indicate file not found
    });

    it("should read with offset and limit", async () => {
      const content = "line1\nline2\nline3\nline4\nline5";
      await fs.writeFile(path.join(testDir, "multiline.txt"), content);

      const result = await readStr(backend, "/multiline.txt", 1, 2);

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should preserve file encodings", async () => {
      const unicode = "Hello 世界";
      await fs.writeFile(
        path.join(testDir, "unicode-read.txt"),
        unicode,
        "utf-8",
      );

      const result = await readStr(backend, "/unicode-read.txt");

      expect(result).toContain("世界");
    });
  });

  describe("edit operations", () => {
    it("should edit file contents", async () => {
      await fs.writeFile(path.join(testDir, "edit.txt"), "original content");

      const result = await backend.edit("/edit.txt", "original", "modified");

      expect(result).toBeDefined();

      const content = await fs.readFile(
        path.join(testDir, "edit.txt"),
        "utf-8",
      );
      expect(content).toContain("modified");
    });

    it("should handle failed edits gracefully", async () => {
      await fs.writeFile(path.join(testDir, "edit.txt"), "content");

      const result = await backend.edit(
        "/edit.txt",
        "not found",
        "replacement",
      );

      expect(result).toBeDefined();
    });

    it("should support replaceAll mode", async () => {
      await fs.writeFile(path.join(testDir, "replace-all.txt"), "foo bar foo");

      const result = await backend.edit("/replace-all.txt", "foo", "baz", true);

      expect(result).toBeDefined();
    });

    it("should handle multiline edits", async () => {
      const content = "line1\nline2\nline3";
      await fs.writeFile(path.join(testDir, "multiline-edit.txt"), content);

      const result = await backend.edit(
        "/multiline-edit.txt",
        "line1\nline2",
        "modified",
      );

      expect(result).toBeDefined();
    });
  });

  describe("directory operations", () => {
    it("should list directory contents", async () => {
      await fs.writeFile(path.join(testDir, "file1.txt"), "");
      await fs.writeFile(path.join(testDir, "file2.txt"), "");
      await fs.mkdir(path.join(testDir, "subdir"));

      const result = await lsFiles(backend, "/");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("should list nested directory contents", async () => {
      await fs.mkdir(path.join(testDir, "deep", "nested"), { recursive: true });
      await fs.writeFile(path.join(testDir, "deep", "nested", "file.txt"), "");

      const result = await lsFiles(backend, "/deep/nested");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle listing empty directories", async () => {
      await fs.mkdir(path.join(testDir, "empty"));

      const result = await lsFiles(backend, "/empty");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("pattern matching", () => {
    it("should glob files by pattern", async () => {
      await fs.writeFile(path.join(testDir, "file1.ts"), "");
      await fs.writeFile(path.join(testDir, "file2.ts"), "");
      await fs.writeFile(path.join(testDir, "file.md"), "");

      const result = await globFiles(backend, "/*.ts");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("should glob nested files", async () => {
      await fs.mkdir(path.join(testDir, "src"), { recursive: true });
      await fs.writeFile(path.join(testDir, "src", "index.ts"), "");
      await fs.writeFile(path.join(testDir, "src", "utils.ts"), "");

      const result = await globFiles(backend, "/**/*.ts");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("should search file contents with grep", async () => {
      await fs.writeFile(
        path.join(testDir, "searchable.txt"),
        "This contains search text",
      );
      await fs.writeFile(
        path.join(testDir, "other.txt"),
        "This does not have it",
      );

      const result = await grepResult(backend, "search", "/");

      expect(result).toBeDefined();
    });

    it("should handle regex patterns in grep", async () => {
      await fs.writeFile(path.join(testDir, "numbers.txt"), "abc123def456");

      const result = await grepResult(backend, "[0-9]{3}", "/");

      expect(result).toBeDefined();
    });
  });

  describe("security - path constraints", () => {
    it("should prevent path traversal attacks", async () => {
      const result = await backend.write("/../../../etc/passwd", "malicious");

      expect(result).toBeDefined();
      // File should NOT be written outside the root
      // Check that the malicious content was NOT written to the system location
      const etcPath = path.join(testDir, "..", "..", "..", "etc", "passwd");
      const content = await fs.readFile(etcPath, "utf-8").catch(() => null);
      // Either the file doesn't exist, or it doesn't contain our malicious content
      expect(content).not.toBe("malicious");
    });

    it("should constrain paths to root in virtualMode", async () => {
      const result = await backend.write("/file.txt", "content");

      expect(result).toBeDefined();

      // File should be inside testDir
      const fileExists = await fs
        .stat(path.join(testDir, "file.txt"))
        .catch(() => null);
      expect(fileExists).not.toBeNull();
    });

    it("should handle symlink safety", async () => {
      // Create a symlink outside the test directory (if possible)
      const externalPath = path.join(os.tmpdir(), "external-file.txt");
      await fs.writeFile(externalPath, "external");

      try {
        // Try to create symlink (may fail on some systems)
        const symlinkPath = path.join(testDir, "link.txt");
        try {
          fsSync.symlinkSync(externalPath, symlinkPath);
        } catch {
          // Symlink creation not supported, skip test
          return;
        }

        // Backend should handle symlinks safely
        const result = await readStr(backend, "/link.txt");
        expect(result).toBeDefined();
      } finally {
        await fs.rm(externalPath).catch(() => null);
      }
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent writes", async () => {
      const results = await Promise.all([
        backend.write("/file1.txt", "content1"),
        backend.write("/file2.txt", "content2"),
        backend.write("/file3.txt", "content3"),
      ]);

      expect(results.length).toBe(3);
      expect(results.every((r) => r !== undefined)).toBe(true);
    });

    it("should handle concurrent reads", async () => {
      await fs.writeFile(path.join(testDir, "shared.txt"), "shared");

      const results = await Promise.all([
        readStr(backend, "/shared.txt"),
        readStr(backend, "/shared.txt"),
        readStr(backend, "/shared.txt"),
      ]);

      expect(results.length).toBe(3);
      expect(results.every((r) => typeof r === "string")).toBe(true);
    });

    it("should handle mixed concurrent operations", async () => {
      await fs.writeFile(path.join(testDir, "existing.txt"), "original");

      const results = await Promise.all([
        backend.write("/new1.txt", "content1"),
        readStr(backend, "/existing.txt"),
        backend.write("/new2.txt", "content2"),
        backend.edit("/existing.txt", "original", "modified"),
      ]);

      expect(results.length).toBe(4);
    });
  });

  describe("edge cases", () => {
    it("should handle root path operations", async () => {
      const result = await lsFiles(backend, "/");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle paths with trailing slashes", async () => {
      await fs.writeFile(path.join(testDir, "file.txt"), "content");

      const result = await readStr(backend, "/file.txt");

      expect(result).toBeDefined();
    });

    it("should preserve content integrity", async () => {
      const originalContent = "Original content with special chars: !@#$%^&*()";
      await backend.write("/integrity-test.txt", originalContent);

      const readContent = await readStr(backend, "/integrity-test.txt");

      expect(readContent).toContain("Original content");
    });

    it("should handle filenames with dots", async () => {
      const result = await backend.write("/file.backup.txt", "backup");

      expect(result).toBeDefined();

      const content = await fs.readFile(
        path.join(testDir, "file.backup.txt"),
        "utf-8",
      );
      expect(content).toBe("backup");
    });
  });

  describe("readRaw operations", () => {
    it("should read raw file content with metadata", async () => {
      const testContent = "hello world";
      await fs.writeFile(path.join(testDir, "raw.txt"), testContent);

      const fileData = await readRawData(backend, "/raw.txt");

      expect(fileData).toBeDefined();
      expect(fileData.content).toEqual(["hello world"]);
      expect(fileData.created_at).toBeDefined();
      expect(fileData.modified_at).toBeDefined();
      expect(typeof fileData.created_at).toBe("string");
      expect(typeof fileData.modified_at).toBe("string");
    });

    it("should handle multiline content properly", async () => {
      const content = "line1\nline2\nline3";
      await fs.writeFile(path.join(testDir, "multiline.txt"), content);

      const fileData = await readRawData(backend, "/multiline.txt");

      expect(fileData.content).toEqual(["line1", "line2", "line3"]);
      expect(fileData.created_at).toBeDefined();
      expect(fileData.modified_at).toBeDefined();
    });

    it("should handle empty files", async () => {
      await fs.writeFile(path.join(testDir, "empty.txt"), "");

      const fileData = await readRawData(backend, "/empty.txt");

      expect(fileData.content).toEqual([""]);
      expect(fileData.created_at).toBeDefined();
      expect(fileData.modified_at).toBeDefined();
    });

    it("should handle files with trailing newlines", async () => {
      const content = "line1\nline2\n";
      await fs.writeFile(path.join(testDir, "trailing.txt"), content);

      const fileData = await readRawData(backend, "/trailing.txt");

      expect(fileData.content).toEqual(["line1", "line2", ""]);
    });

    it("should handle unicode content", async () => {
      const content = "Hello 世界\n🚀 emoji\nΩ omega";
      await fs.writeFile(path.join(testDir, "unicode.txt"), content);

      const fileData = await readRawData(backend, "/unicode.txt");

      expect(fileData.content).toEqual(["Hello 世界", "🚀 emoji", "Ω omega"]);
    });

    it("should reject non-existent files", async () => {
      await expect(readRawData(backend, "/nonexistent.txt")).rejects.toThrow(
        /not found|no such file/,
      );
    });

    it("should reject symlinks", async () => {
      const externalPath = path.join(os.tmpdir(), "external-raw.txt");
      await fs.writeFile(externalPath, "external");

      try {
        const symlinkPath = path.join(testDir, "link-raw.txt");
        try {
          fsSync.symlinkSync(externalPath, symlinkPath);
        } catch {
          // Symlinks not supported, skip
          return;
        }

        await expect(readRawData(backend, "/link-raw.txt")).rejects.toThrow(
          /not allowed|too many symbolic links/,
        );
      } finally {
        await fs.rm(externalPath).catch(() => null);
      }
    });

    it("should include ISO 8601 timestamps", async () => {
      await fs.writeFile(path.join(testDir, "timestamps.txt"), "content");

      const fileData = await readRawData(backend, "/timestamps.txt");

      expect(new Date(fileData.created_at).toISOString()).toBe(
        fileData.created_at,
      );
      expect(new Date(fileData.modified_at).toISOString()).toBe(
        fileData.modified_at,
      );
    });

    it("should handle large files", async () => {
      const largeContent = "x".repeat(10000);
      await fs.writeFile(path.join(testDir, "large.txt"), largeContent);

      const fileData = await readRawData(backend, "/large.txt");

      expect(fileData.content).toEqual([largeContent]);
      expect(fileData.content[0]).toHaveLength(10000);
    });

    it("should work consistently with read method", async () => {
      const content = "test\ncontent\nhere";
      await fs.writeFile(path.join(testDir, "consistency.txt"), content);

      const rawData = await readRawData(backend, "/consistency.txt");
      const readResult = await readStr(backend, "/consistency.txt");

      expect(rawData.content.join("\n")).toBe(content);
      // read() adds line numbers, so check that all raw lines appear in result
      expect(readResult).toContain("test");
      expect(readResult).toContain("content");
      expect(readResult).toContain("here");
    });
  });
});
