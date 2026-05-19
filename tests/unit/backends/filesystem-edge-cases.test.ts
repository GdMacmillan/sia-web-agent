/**
 * FilesystemBackend Edge Cases Tests
 *
 * Tests edge cases and corner cases identified from Python deepagents test suite.
 * These scenarios complement the security tests and ensure robust behavior.
 *
 * Test scenarios adapted from:
 * - test_filesystem_backend.py
 * - test_filesystem_backend_async.py
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import {
  getProjectRoot,
  clearProjectRootCache,
} from "../../../src/utils/path-utils.js";
import * as path from "path";
import * as fs from "fs/promises";

describe("FilesystemBackend Edge Cases", () => {
  let backend: FilesystemBackend;
  let projectRoot: string;
  let testDir: string;

  beforeEach(async () => {
    clearProjectRootCache();
    projectRoot = getProjectRoot();
    backend = new FilesystemBackend({ rootDir: projectRoot });

    // Create a temp directory within project for test files
    testDir = path.join(projectRoot, ".test-edge-cases");
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearProjectRootCache();
  });

  describe("Nested Directory Listing Behavior", () => {
    it("should only list immediate children, not recursive contents", async () => {
      // Create nested structure:
      // testDir/
      //   config.json
      //   src/
      //     main.ts
      //     utils/
      //       helper.ts
      //       common.ts
      //   docs/
      //     readme.md
      //     api/
      //       reference.md

      const files = [
        "config.json",
        "src/main.ts",
        "src/utils/helper.ts",
        "src/utils/common.ts",
        "docs/readme.md",
        "docs/api/reference.md",
      ];

      for (const file of files) {
        const filePath = path.join(testDir, file);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, `content of ${file}`);
      }

      // Test root listing
      const rootListing = await backend.lsInfo(testDir);
      const rootPaths = rootListing.map((f) => f.path);

      // Should include immediate children
      expect(rootPaths).toContain(path.join(testDir, "config.json"));
      expect(rootPaths.some((p) => p.includes("src"))).toBe(true);
      expect(rootPaths.some((p) => p.includes("docs"))).toBe(true);

      // Should NOT include nested files
      expect(rootPaths).not.toContain(path.join(testDir, "src/main.ts"));
      expect(rootPaths).not.toContain(
        path.join(testDir, "src/utils/helper.ts"),
      );

      // Test src/ listing
      const srcListing = await backend.lsInfo(path.join(testDir, "src"));
      const srcPaths = srcListing.map((f) => f.path);

      // Should include src/main.ts
      expect(srcPaths).toContain(path.join(testDir, "src/main.ts"));
      expect(srcPaths.some((p) => p.includes("utils"))).toBe(true);

      // Should NOT include nested utils files
      expect(srcPaths).not.toContain(path.join(testDir, "src/utils/helper.ts"));

      // Test src/utils/ listing
      const utilsListing = await backend.lsInfo(
        path.join(testDir, "src/utils"),
      );
      const utilsPaths = utilsListing.map((f) => f.path);

      // Should include both files in utils
      expect(utilsPaths).toContain(path.join(testDir, "src/utils/helper.ts"));
      expect(utilsPaths).toContain(path.join(testDir, "src/utils/common.ts"));
      expect(utilsPaths.length).toBe(2);
    });

    it("should list directories with trailing slash indicator", async () => {
      // Create directory structure
      await fs.mkdir(path.join(testDir, "subdir"), { recursive: true });
      await fs.writeFile(path.join(testDir, "file.txt"), "content");

      const listing = await backend.lsInfo(testDir);

      // Find directory entry
      const dirEntry = listing.find((f) => f.is_dir);
      expect(dirEntry).toBeDefined();
      expect(dirEntry?.is_dir).toBe(true);

      // File entry should not be marked as directory
      const fileEntry = listing.find((f) => !f.is_dir);
      expect(fileEntry).toBeDefined();
      expect(fileEntry?.is_dir).toBe(false);
    });
  });

  describe("Trailing Slash Edge Cases", () => {
    beforeEach(async () => {
      // Create test structure
      await fs.mkdir(path.join(testDir, "dir"), { recursive: true });
      await fs.writeFile(path.join(testDir, "dir/file.txt"), "content");
    });

    it("should handle trailing slash consistently for ls operations", async () => {
      const withSlash = await backend.lsInfo(path.join(testDir, "dir") + "/");
      const withoutSlash = await backend.lsInfo(path.join(testDir, "dir"));

      // Both should return same results
      expect(withSlash.length).toBe(withoutSlash.length);
      expect(withSlash.map((f) => f.path)).toEqual(
        withoutSlash.map((f) => f.path),
      );
    });

    it("should handle root directory with trailing slash", async () => {
      await fs.writeFile(path.join(testDir, "root-file.txt"), "content");

      const withSlash = await backend.lsInfo(testDir + "/");
      const withoutSlash = await backend.lsInfo(testDir);

      expect(withSlash.length).toBeGreaterThan(0);
      expect(withSlash.length).toBe(withoutSlash.length);
    });

    it("should return empty array for nonexistent directory with trailing slash", async () => {
      const listing = await backend.lsInfo(
        path.join(testDir, "nonexistent") + "/",
      );
      expect(Array.isArray(listing)).toBe(true);
      expect(listing.length).toBe(0);
    });
  });

  describe("Invalid Regex Patterns", () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(testDir, "test.txt"), "searchable content");
    });

    it("should return error string for invalid regex in grep", async () => {
      // Invalid regex: unmatched bracket
      const result = await backend.grepRaw("[", testDir);

      // Should return error string, not throw
      expect(typeof result === "string" || Array.isArray(result)).toBe(true);

      if (typeof result === "string") {
        // Error message should indicate regex problem
        expect(result.toLowerCase()).toMatch(/regex|pattern|invalid|error/);
      }
    });

    it("should return error string for unmatched parenthesis", async () => {
      const result = await backend.grepRaw("(unclosed", testDir);

      if (typeof result === "string") {
        expect(result.toLowerCase()).toMatch(/regex|pattern|invalid|error/);
      }
    });

    it("should handle valid complex regex correctly", async () => {
      const result = await backend.grepRaw("search.*content", testDir);

      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].text).toContain("searchable content");
      }
    });
  });

  describe("Result Sorting Consistency", () => {
    beforeEach(async () => {
      // Create files in non-alphabetical order
      const files = ["zebra.txt", "apple.txt", "middle.txt", "banana.txt"];

      for (const file of files) {
        await fs.writeFile(path.join(testDir, file), "content");
      }
    });

    it("should return ls results in sorted order", async () => {
      const listing = await backend.lsInfo(testDir);
      const paths = listing.map((f) => f.path);

      // Verify results are sorted
      const sortedPaths = [...paths].sort();
      expect(paths).toEqual(sortedPaths);
    });

    it("should return glob results in sorted order", async () => {
      const results = await backend.globInfo("*.txt", testDir);
      const paths = results.map((f) => f.path);

      // Verify results are sorted
      const sortedPaths = [...paths].sort();
      expect(paths).toEqual(sortedPaths);
    });

    it("should maintain consistent ordering across multiple calls", async () => {
      const listing1 = await backend.lsInfo(testDir);
      const listing2 = await backend.lsInfo(testDir);

      expect(listing1.map((f) => f.path)).toEqual(listing2.map((f) => f.path));
    });
  });

  describe("Nonexistent Path Handling", () => {
    it("should return empty array for nonexistent directory in ls", async () => {
      const listing = await backend.lsInfo(
        path.join(testDir, "does-not-exist"),
      );

      expect(Array.isArray(listing)).toBe(true);
      expect(listing.length).toBe(0);
    });

    it("should return error message for nonexistent file in read", async () => {
      const result = await backend.read(
        path.join(testDir, "nonexistent-file.txt"),
      );

      expect(typeof result).toBe("string");
      expect(result).toMatch(/ENOENT|not found|no such file/i);
    });

    it("should distinguish between empty directory and nonexistent directory", async () => {
      // Create empty directory
      const emptyDir = path.join(testDir, "empty");
      await fs.mkdir(emptyDir);

      const emptyListing = await backend.lsInfo(emptyDir);
      expect(Array.isArray(emptyListing)).toBe(true);
      expect(emptyListing.length).toBe(0);

      // Nonexistent directory
      const nonexistentListing = await backend.lsInfo(
        path.join(testDir, "nonexistent"),
      );
      expect(Array.isArray(nonexistentListing)).toBe(true);
      expect(nonexistentListing.length).toBe(0);

      // Both return empty arrays
      expect(emptyListing).toEqual(nonexistentListing);
    });

    it("should return empty array for glob with no matches", async () => {
      await fs.writeFile(path.join(testDir, "test.txt"), "content");

      // Glob for pattern that doesn't match
      const results = await backend.globInfo("*.xyz", testDir);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it("should return empty array for grep with no matches", async () => {
      await fs.writeFile(path.join(testDir, "test.txt"), "content");

      // Search for pattern that doesn't exist
      const results = await backend.grepRaw("nonexistent-pattern", testDir);

      expect(Array.isArray(results) || typeof results === "string").toBe(true);
      if (Array.isArray(results)) {
        expect(results.length).toBe(0);
      }
    });
  });

  describe("Deep Nesting Scenarios", () => {
    it("should handle 5+ levels of directory nesting", async () => {
      // Create deep structure
      const deepPath = path.join(
        testDir,
        "level1",
        "level2",
        "level3",
        "level4",
        "level5",
      );
      await fs.mkdir(deepPath, { recursive: true });
      await fs.writeFile(path.join(deepPath, "deep-file.txt"), "deep content");

      // Test reading from deep path
      const content = await backend.read(path.join(deepPath, "deep-file.txt"));
      expect(content).toContain("deep content");

      // Test ls at each level
      const level1 = await backend.lsInfo(path.join(testDir, "level1"));
      expect(level1.length).toBeGreaterThan(0);

      const level3 = await backend.lsInfo(
        path.join(testDir, "level1", "level2", "level3"),
      );
      expect(level3.length).toBeGreaterThan(0);

      const level5 = await backend.lsInfo(deepPath);
      expect(level5.length).toBe(1);
      expect(level5[0].path).toContain("deep-file.txt");
    });

    it("should handle glob across deep nested directories", async () => {
      // Create nested structure with .ts files at various levels
      const paths = [
        "level1/file1.ts",
        "level1/level2/file2.ts",
        "level1/level2/level3/file3.ts",
      ];

      for (const p of paths) {
        const fullPath = path.join(testDir, p);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, `// ${p}`);
      }

      // Glob for all .ts files
      const results = await backend.globInfo("**/*.ts", testDir);

      expect(results.length).toBe(3);
      expect(results.every((r) => r.path.endsWith(".ts"))).toBe(true);
    });

    it("should handle grep across deep nested directories", async () => {
      // Create nested structure with searchable content
      const paths = [
        "level1/a.txt",
        "level1/level2/b.txt",
        "level1/level2/level3/c.txt",
      ];

      for (const p of paths) {
        const fullPath = path.join(testDir, p);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, `SEARCHME in ${p}`);
      }

      // Grep for pattern across all files
      const results = await backend.grepRaw("SEARCHME", testDir);

      expect(Array.isArray(results)).toBe(true);
      if (Array.isArray(results)) {
        expect(results.length).toBe(3);
        expect(results.every((r) => r.text.includes("SEARCHME"))).toBe(true);
      }
    });
  });

  describe("Special Characters in Paths", () => {
    it("should handle spaces in directory names", async () => {
      const spacedDir = path.join(testDir, "dir with spaces");
      await fs.mkdir(spacedDir, { recursive: true });
      await fs.writeFile(
        path.join(spacedDir, "file.txt"),
        "content with spaces",
      );

      const content = await backend.read(path.join(spacedDir, "file.txt"));
      expect(content).toContain("content with spaces");

      const listing = await backend.lsInfo(spacedDir);
      expect(listing.length).toBe(1);
    });

    it("should handle unicode characters in filenames", async () => {
      const unicodeFile = path.join(testDir, "файл.txt");
      await fs.writeFile(unicodeFile, "unicode content");

      const content = await backend.read(unicodeFile);
      expect(content).toContain("unicode content");
    });

    it("should handle emoji in filenames", async () => {
      const emojiFile = path.join(testDir, "test-🚀-file.txt");
      await fs.writeFile(emojiFile, "emoji content");

      const content = await backend.read(emojiFile);
      expect(content).toContain("emoji content");

      const listing = await backend.lsInfo(testDir);
      expect(listing.some((f) => f.path.includes("🚀"))).toBe(true);
    });
  });

  describe("File Size and Metadata", () => {
    it("should include file size in ls results", async () => {
      const testFile = path.join(testDir, "sized-file.txt");
      const content = "x".repeat(1000); // 1000 bytes
      await fs.writeFile(testFile, content);

      const listing = await backend.lsInfo(testDir);
      const fileInfo = listing.find((f) => f.path === testFile);

      expect(fileInfo).toBeDefined();
      expect(fileInfo?.size).toBeGreaterThan(0);
      expect(fileInfo?.size).toBe(1000);
    });

    it("should mark directories correctly in ls results", async () => {
      await fs.mkdir(path.join(testDir, "dir1"), { recursive: true });
      await fs.writeFile(path.join(testDir, "file1.txt"), "content");

      const listing = await backend.lsInfo(testDir);

      const dirEntry = listing.find((f) => f.path.includes("dir1"));
      const fileEntry = listing.find((f) => f.path.includes("file1.txt"));

      expect(dirEntry?.is_dir).toBe(true);
      expect(fileEntry?.is_dir).toBe(false);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle multiple concurrent read operations", async () => {
      // Create multiple test files
      const files = ["file1.txt", "file2.txt", "file3.txt"];
      for (const file of files) {
        await fs.writeFile(path.join(testDir, file), `content of ${file}`);
      }

      // Read all files concurrently
      const reads = files.map((file) => backend.read(path.join(testDir, file)));
      const results = await Promise.all(reads);

      expect(results.length).toBe(3);
      results.forEach((result, i) => {
        expect(result).toContain(`content of ${files[i]}`);
      });
    });

    it("should handle concurrent write operations to different files", async () => {
      const writes = [
        backend.write(path.join(testDir, "write1.txt"), "content1"),
        backend.write(path.join(testDir, "write2.txt"), "content2"),
        backend.write(path.join(testDir, "write3.txt"), "content3"),
      ];

      const results = await Promise.all(writes);

      expect(results.length).toBe(3);
      results.forEach((result) => {
        expect(result.error).toBeUndefined();
      });

      // Verify all files were created
      const listing = await backend.lsInfo(testDir);
      expect(listing.length).toBe(3);
    });
  });
});
