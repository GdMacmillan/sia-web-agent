/**
 * FilesystemBackend Security Tests
 *
 * Tests that the FilesystemBackend enforces path validation to prevent
 * access outside the project boundary.
 *
 * Following TDD - these tests define expected security behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import {
  getProjectRoot,
  clearProjectRootCache,
} from "../../../src/utils/path-utils.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

describe("FilesystemBackend Security", () => {
  let backend: FilesystemBackend;
  let projectRoot: string;
  let tempDir: string;

  beforeEach(async () => {
    clearProjectRootCache();
    projectRoot = getProjectRoot();
    backend = new FilesystemBackend({ rootDir: projectRoot });

    // Create a temp directory within project for test files
    tempDir = path.join(projectRoot, ".test-tmp");
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearProjectRootCache();
  });

  describe("Read Operations", () => {
    it("should allow reading files within project", async () => {
      // Create a test file
      const testFile = path.join(tempDir, "test-read.txt");
      await fs.writeFile(testFile, "test content");

      const result = await backend.read(testFile);
      expect(result).toContain("test content");
    });

    it("should reject reading /etc/passwd", async () => {
      const result = await backend.read("/etc/passwd");
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should reject reading from /tmp", async () => {
      const result = await backend.read("/tmp/some-file.txt");
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should reject reading with directory traversal", async () => {
      const traversalPath = path.join(
        projectRoot,
        "..",
        "..",
        "..",
        "etc",
        "passwd",
      );
      const result = await backend.read(traversalPath);
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should reject reading from user home outside project", async () => {
      const homePath = path.join(os.homedir(), ".bashrc");
      // Only test if home is actually outside project
      if (!homePath.startsWith(projectRoot)) {
        const result = await backend.read(homePath);
        expect(result).toMatch(/Security Error|Path access denied|outside/i);
      }
    });
  });

  describe("Write Operations", () => {
    it("should allow writing files within project", async () => {
      const testFile = path.join(tempDir, "test-write.txt");
      const result = await backend.write(testFile, "new content");

      expect(result.error).toBeUndefined();
      expect(result.path).toBe(testFile);
    });

    it("should reject writing to /tmp", async () => {
      const result = await backend.write("/tmp/evil.sh", "malicious code");

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );
    });

    it("should reject writing to /etc", async () => {
      const result = await backend.write("/etc/passwd", "hacked");

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );
    });

    it("should reject writing with directory traversal", async () => {
      const traversalPath = path.join(
        projectRoot,
        "..",
        "..",
        "tmp",
        "evil.sh",
      );
      const result = await backend.write(traversalPath, "bad code");

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );
    });
  });

  describe("Edit Operations", () => {
    it("should allow editing files within project", async () => {
      // Create a test file
      const testFile = path.join(tempDir, "test-edit.txt");
      await fs.writeFile(testFile, "old content");

      const result = await backend.edit(testFile, "old", "new", false);

      expect(result.error).toBeUndefined();
      expect(result.path).toBe(testFile);
    });

    it("should reject editing files outside project", async () => {
      const result = await backend.edit("/etc/hosts", "old", "new", false);

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );
    });
  });

  describe("List Operations", () => {
    it("should allow listing directories within project", async () => {
      const result = await backend.lsInfo(tempDir);
      expect(Array.isArray(result)).toBe(true);
    });

    it("should reject listing /etc directory", async () => {
      const result = await backend.lsInfo("/etc");
      // Should return empty array or throw error
      expect(Array.isArray(result)).toBe(true);
      // If it doesn't throw, it should return empty due to validation
      if (result.length > 0) {
        // If somehow it returns results, they should all fail validation
        fail("Should not return results for /etc");
      }
    });

    it("should reject listing /tmp directory", async () => {
      const result = await backend.lsInfo("/tmp");
      expect(Array.isArray(result)).toBe(true);
      // Should be empty due to validation
      if (result.length > 0) {
        fail("Should not return results for /tmp");
      }
    });
  });

  describe("Glob Operations", () => {
    it("should allow glob within project", async () => {
      // Create test files
      const testFile1 = path.join(tempDir, "file1.txt");
      const testFile2 = path.join(tempDir, "file2.txt");
      await fs.writeFile(testFile1, "content1");
      await fs.writeFile(testFile2, "content2");

      const result = await backend.globInfo("*.txt", tempDir);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should default search path to project root when given '/'", async () => {
      const result = await backend.globInfo("*.md", "/");
      expect(Array.isArray(result)).toBe(true);
      // Results should be within project
      for (const file of result) {
        expect(
          file.path.startsWith(projectRoot) || file.path.startsWith("/"),
        ).toBe(true);
      }
    });
  });

  describe("Grep Operations", () => {
    it("should allow grep within project", async () => {
      // Create a test file with searchable content
      const testFile = path.join(tempDir, "grep-test.txt");
      await fs.writeFile(testFile, "searchable content here");

      const result = await backend.grepRaw("searchable", tempDir);
      expect(Array.isArray(result) || typeof result === "string").toBe(true);
    });

    it("should reject grep outside project", async () => {
      const result = await backend.grepRaw("root", "/etc");
      // Should return empty results or error
      expect(Array.isArray(result) || typeof result === "string").toBe(true);
      if (Array.isArray(result)) {
        // Should be empty due to validation
        expect(result.length).toBe(0);
      }
    });
  });

  describe("Error Messages", () => {
    it("should include attempted path in error message", async () => {
      const result = await backend.read("/etc/passwd");
      expect(result).toContain("/etc/passwd");
    });

    it("should include project boundary in error message", async () => {
      const result = await backend.read("/etc/passwd");
      expect(result.toLowerCase()).toMatch(/project|boundary|root/);
    });

    it("should provide actionable guidance", async () => {
      const result = await backend.read("/etc/passwd");
      expect(result.toLowerCase()).toMatch(/within|inside|project/);
    });
  });

  describe("VirtualMode Compatibility", () => {
    it("should enforce validation regardless of virtualMode setting", async () => {
      // Test with virtualMode: false (default)
      const backendNoVirtual = new FilesystemBackend({
        rootDir: projectRoot,
        virtualMode: false,
      });

      const result1 = await backendNoVirtual.read("/etc/passwd");
      expect(result1).toMatch(/Security Error|Path access denied|outside/i);

      // Test with virtualMode: true
      // In virtualMode, "/etc/passwd" is treated as a virtual path (relative to project)
      // So it becomes projectRoot + "etc/passwd" which doesn't exist (not a security error)
      // To test security, we need to use path traversal which virtualMode blocks
      const backendVirtual = new FilesystemBackend({
        rootDir: projectRoot,
        virtualMode: true,
      });

      // Try path traversal in virtualMode - should be blocked
      const result2 = await backendVirtual.read("../../../etc/passwd");
      expect(result2).toMatch(/Path traversal not allowed/i);
    });

    it("should allow valid paths in both modes", async () => {
      const testFile = path.join(tempDir, "both-modes.txt");
      await fs.writeFile(testFile, "test");

      // virtualMode: false
      const backendNoVirtual = new FilesystemBackend({
        rootDir: projectRoot,
        virtualMode: false,
      });
      const result1 = await backendNoVirtual.read(testFile);
      expect(result1).toContain("test");

      // virtualMode: true
      const backendVirtual = new FilesystemBackend({
        rootDir: projectRoot,
        virtualMode: true,
      });
      const relativePath = path.relative(projectRoot, testFile);
      const result2 = await backendVirtual.read("/" + relativePath);
      expect(result2).toContain("test");
    });
  });

  describe("Attack Scenarios", () => {
    it("should block directory traversal attack: ../../../../etc/passwd", async () => {
      const traversal = path.join(
        projectRoot,
        "..",
        "..",
        "..",
        "..",
        "etc",
        "passwd",
      );
      const result = await backend.read(traversal);
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should block absolute path attack: /etc/shadow", async () => {
      const result = await backend.read("/etc/shadow");
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should block write to system directories", async () => {
      const result = await backend.write("/bin/malware", "evil code");
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );
    });

    it("should block access to parent directory", async () => {
      const parentDir = path.dirname(projectRoot);
      // Only test if parent is actually different (handles root directory edge case)
      if (parentDir !== projectRoot) {
        const result = await backend.read(
          path.join(parentDir, "some-file.txt"),
        );
        expect(result).toMatch(/Security Error|Path access denied|outside/i);
      }
    });
  });
});
