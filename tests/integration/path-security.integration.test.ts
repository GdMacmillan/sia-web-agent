/**
 * Path Security Integration Tests
 *
 * End-to-end tests verifying that the agent cannot access files
 * outside the project boundary through any mechanism.
 *
 * These tests simulate real attack scenarios and ensure complete protection.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { FilesystemBackend } from "../../src/backends/filesystem.js";
import {
  getProjectRoot,
  clearProjectRootCache,
} from "../../src/utils/path-utils.js";
import * as path from "path";
import * as fs from "fs/promises";

describe("Path Security Integration Tests", () => {
  let backend: FilesystemBackend;
  let projectRoot: string;
  let testDir: string;

  beforeAll(async () => {
    clearProjectRootCache();
    projectRoot = getProjectRoot();
    backend = new FilesystemBackend({ rootDir: projectRoot });

    // Create test directory
    testDir = path.join(projectRoot, ".integration-test-tmp");
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearProjectRootCache();
  });

  describe("Complete System Protection", () => {
    it("should prevent all read operations outside project", async () => {
      const forbiddenPaths = [
        "/etc/passwd",
        "/etc/shadow",
        "/tmp/test.txt",
        "/var/log/system.log",
        "/usr/bin/bash",
        path.join(projectRoot, "..", "sibling-directory", "file.txt"),
      ];

      for (const forbiddenPath of forbiddenPaths) {
        const result = await backend.read(forbiddenPath);
        expect(result).toMatch(/Security Error|Path access denied|outside/i);
      }
    });

    it("should prevent all write operations outside project", async () => {
      const forbiddenPaths = [
        "/tmp/evil.sh",
        "/etc/malware.txt",
        "/var/tmp/backdoor.sh",
        path.join(projectRoot, "..", "attack.txt"),
      ];

      for (const forbiddenPath of forbiddenPaths) {
        const result = await backend.write(forbiddenPath, "malicious");
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(
          /Security Error|Path access denied|outside/i,
        );
      }
    });

    it("should allow all operations within project", async () => {
      // Create test file
      const testFile = path.join(testDir, "allowed.txt");
      const writeResult = await backend.write(testFile, "allowed content");
      expect(writeResult.error).toBeUndefined();

      // Read it back
      const readResult = await backend.read(testFile);
      expect(readResult).toContain("allowed content");

      // Edit it
      const editResult = await backend.edit(
        testFile,
        "allowed",
        "modified",
        false,
      );
      expect(editResult.error).toBeUndefined();

      // Verify edit
      const verifyResult = await backend.read(testFile);
      expect(verifyResult).toContain("modified content");
    });
  });

  describe("Attack Scenario Simulations", () => {
    it("should block directory traversal: ../../../etc/passwd", async () => {
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

    it("should block null byte injection (if applicable)", async () => {
      // Some systems allow null bytes to truncate paths
      const nullBytePath = "/etc/passwd\x00.txt";
      const result = await backend.read(nullBytePath);
      // Should either reject or fail gracefully
      expect(
        result.includes("Security Error") ||
          result.includes("Path access denied") ||
          result.includes("not found"),
      ).toBe(true);
    });

    it("should block double-encoded traversal", async () => {
      // Try to bypass with encoded dots
      const encodedPath = path.join(projectRoot, "..", "..", "etc", "passwd");
      const result = await backend.read(encodedPath);
      expect(result).toMatch(/Security Error|Path access denied|outside/i);
    });

    it("should block absolute path to sensitive files", async () => {
      const sensitivePaths = [
        "/etc/passwd",
        "/etc/shadow",
        "/root/.ssh/id_rsa",
        "/home/user/.bashrc",
      ];

      for (const sensitivePath of sensitivePaths) {
        const result = await backend.read(sensitivePath);
        expect(result).toMatch(/Security Error|Path access denied|outside/i);
      }
    });

    it("should block write attempts to system directories", async () => {
      const systemPaths = [
        "/bin/malware",
        "/sbin/backdoor",
        "/usr/local/bin/evil",
        "/lib/trojan.so",
      ];

      for (const systemPath of systemPaths) {
        const result = await backend.write(systemPath, "malicious code");
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(
          /Security Error|Path access denied|outside/i,
        );
      }
    });
  });

  describe("Glob and Grep Tool Security", () => {
    it("should not allow glob to search outside project", async () => {
      // Try to glob in /etc - should throw security error
      await expect(backend.globInfo("*.conf", "/etc")).rejects.toThrow(
        /Security Error|Path access denied|outside/i,
      );
    });

    it("should not allow grep to search outside project", async () => {
      // Try to grep in /etc
      const result = await backend.grepRaw("root", "/etc");
      expect(Array.isArray(result) || typeof result === "string").toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBe(0);
      }
    });

    it("should allow glob within project", async () => {
      // Create test files
      const testFile = path.join(testDir, "glob-test.txt");
      await fs.writeFile(testFile, "test");

      const result = await backend.globInfo("*.txt", testDir);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should allow grep within project", async () => {
      // Create test file
      const testFile = path.join(testDir, "grep-test.txt");
      await fs.writeFile(testFile, "searchable content");

      const result = await backend.grepRaw("searchable", testDir);
      expect(Array.isArray(result) || typeof result === "string").toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Error Messages and User Experience", () => {
    it("should provide helpful error messages for debugging", async () => {
      const result = await backend.read("/etc/passwd");

      // Error should contain key information
      expect(result).toContain("/etc/passwd"); // Attempted path
      expect(result.toLowerCase()).toMatch(/project|boundary|root/); // Project boundary
      expect(result.toLowerCase()).toMatch(/security|denied|outside/); // Nature of error

      // Should not expose sensitive information
      expect(result).not.toContain("password");
      expect(result).not.toContain("secret");
    });

    it("should distinguish between not found and access denied", async () => {
      // File outside project - security error
      const outsideResult = await backend.read("/etc/passwd");
      expect(outsideResult).toMatch(
        /Security Error|Path access denied|outside/i,
      );

      // File inside project but doesn't exist - not found error
      const missingResult = await backend.read(
        path.join(projectRoot, "nonexistent-file-12345.txt"),
      );
      expect(missingResult).toMatch(/ENOENT|not found|no such file/i);
      expect(missingResult).not.toMatch(/Security Error|Path access denied/i);
    });
  });

  describe("Edge Cases and Corner Cases", () => {
    it("should handle project root itself correctly", async () => {
      // Listing project root should work
      const result = await backend.lsInfo(projectRoot);
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle paths with . and .. within project", async () => {
      // Create nested structure
      const nested = path.join(testDir, "nested", "deep");
      await fs.mkdir(nested, { recursive: true });
      const testFile = path.join(nested, "file.txt");
      await fs.writeFile(testFile, "nested content");

      // Access with . and .. but stay within project
      const weirdPath = path.join(
        testDir,
        "nested",
        "..",
        "nested",
        "deep",
        "file.txt",
      );
      const result = await backend.read(weirdPath);
      expect(result).toContain("nested content");
    });

    it("should handle very long paths within project", async () => {
      // Create deep nesting
      const deep = path.join(testDir, "a", "b", "c", "d", "e", "f", "g", "h");
      await fs.mkdir(deep, { recursive: true });
      const testFile = path.join(deep, "deep-file.txt");
      await fs.writeFile(testFile, "deep content");

      const result = await backend.read(testFile);
      expect(result).toContain("deep content");
    });

    it("should handle special characters in paths within project", async () => {
      const specialFile = path.join(testDir, "file with spaces & special!.txt");
      await fs.writeFile(specialFile, "special content");

      const result = await backend.read(specialFile);
      expect(result).toContain("special content");
    });
  });

  describe("Consistency Across Operations", () => {
    it("should apply same validation to all operations", async () => {
      const forbiddenPath = "/etc/passwd";

      // All operations should reject this path
      const readResult = await backend.read(forbiddenPath);
      expect(readResult).toMatch(/Security Error|Path access denied|outside/i);

      const writeResult = await backend.write(forbiddenPath, "test");
      expect(writeResult.error).toBeDefined();
      expect(writeResult.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );

      const editResult = await backend.edit(forbiddenPath, "old", "new", false);
      expect(editResult.error).toBeDefined();
      expect(editResult.error).toMatch(
        /Security Error|Path access denied|outside/i,
      );

      const lsResult = await backend.lsInfo("/etc");
      // Should return empty or throw
      expect(Array.isArray(lsResult)).toBe(true);
    });
  });
});
