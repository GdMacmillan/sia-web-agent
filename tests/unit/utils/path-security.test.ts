/**
 * Path Security Tests
 *
 * Tests for path validation utilities that ensure file operations
 * are restricted to the project boundary.
 *
 * These tests follow the TDD approach - they define the expected behavior
 * before the validation utilities are implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as path from "path";
import * as os from "os";
import {
  validatePathInProject,
  isPathInProject,
  resolveAndValidate,
  getProjectRoot,
  clearProjectRootCache,
} from "../../../src/utils/path-utils.js";

describe("Path Security Utilities", () => {
  let projectRoot: string;

  beforeEach(() => {
    clearProjectRootCache();
    projectRoot = getProjectRoot();
  });

  afterEach(() => {
    clearProjectRootCache();
  });

  describe("validatePathInProject", () => {
    it("should allow paths within project root", () => {
      const validPath = path.join(projectRoot, "src", "index.ts");
      expect(() => validatePathInProject(validPath)).not.toThrow();
    });

    it("should allow project root itself", () => {
      expect(() => validatePathInProject(projectRoot)).not.toThrow();
    });

    it("should allow relative paths resolved within project", () => {
      const relativePath = path.join(projectRoot, "packages", "agent");
      expect(() => validatePathInProject(relativePath)).not.toThrow();
    });

    it("should reject absolute paths outside project", () => {
      expect(() => validatePathInProject("/etc/passwd")).toThrow(
        /Security Error: Path access denied/,
      );
    });

    it("should reject parent directory traversal (../../../etc/passwd)", () => {
      const traversalPath = path.join(
        projectRoot,
        "..",
        "..",
        "..",
        "etc",
        "passwd",
      );
      expect(() => validatePathInProject(traversalPath)).toThrow(
        /Security Error: Path access denied/,
      );
    });

    it("should reject paths to /tmp", () => {
      expect(() => validatePathInProject("/tmp/evil.sh")).toThrow(
        /Security Error: Path access denied/,
      );
    });

    it("should reject paths to user home directory outside project", () => {
      const homePath = path.join(os.homedir(), ".ssh", "id_rsa");
      // Only reject if home is actually outside project
      if (!homePath.startsWith(projectRoot)) {
        expect(() => validatePathInProject(homePath)).toThrow(
          /Security Error: Path access denied/,
        );
      }
    });

    it("should provide helpful error message with attempted path", () => {
      try {
        validatePathInProject("/etc/passwd");
        fail("Expected error to be thrown");
      } catch (error: any) {
        expect(error.message).toContain("Attempted to access: /etc/passwd");
        expect(error.message).toContain("Resolved to:");
        expect(error.message).toContain("Project boundary:");
        expect(error.message).toContain(projectRoot);
      }
    });

    it("should normalize paths before validation", () => {
      // Path with double slashes should be normalized
      const weirdPath = path.join(projectRoot, "src", "..", "src", "index.ts");
      expect(() => validatePathInProject(weirdPath)).not.toThrow();
    });

    it("should handle current directory marker (.)", () => {
      const currentDirPath = path.join(projectRoot, ".", "src", "index.ts");
      expect(() => validatePathInProject(currentDirPath)).not.toThrow();
    });

    it("should reject empty paths", () => {
      expect(() => validatePathInProject("")).toThrow();
    });
  });

  describe("isPathInProject", () => {
    it("should return true for paths within project", () => {
      const validPath = path.join(projectRoot, "src", "index.ts");
      expect(isPathInProject(validPath)).toBe(true);
    });

    it("should return false for paths outside project", () => {
      expect(isPathInProject("/etc/passwd")).toBe(false);
    });

    it("should return true for project root", () => {
      expect(isPathInProject(projectRoot)).toBe(true);
    });

    it("should return false for parent directory", () => {
      const parentPath = path.dirname(projectRoot);
      // Only test if parent is actually outside project (handles edge case of root directory)
      if (parentPath !== projectRoot) {
        expect(isPathInProject(parentPath)).toBe(false);
      }
    });

    it("should handle null gracefully", () => {
      expect(isPathInProject(null as any)).toBe(false);
    });

    it("should handle undefined gracefully", () => {
      expect(isPathInProject(undefined as any)).toBe(false);
    });

    it("should handle empty string gracefully", () => {
      expect(isPathInProject("")).toBe(false);
    });
  });

  describe("resolveAndValidate", () => {
    it("should resolve relative paths from project root", () => {
      const result = resolveAndValidate("src/index.ts");
      expect(result).toBe(path.join(projectRoot, "src/index.ts"));
    });

    it("should preserve absolute paths within project", () => {
      const absPath = path.join(projectRoot, "src", "index.ts");
      const result = resolveAndValidate(absPath);
      expect(result).toBe(absPath);
    });

    it("should throw on resolution outside project", () => {
      expect(() => resolveAndValidate("/etc/passwd")).toThrow(
        /Security Error: Path access denied/,
      );
    });

    it("should handle . and .. correctly when within project", () => {
      const result = resolveAndValidate("src/../src/index.ts");
      expect(result).toBe(path.join(projectRoot, "src", "index.ts"));
    });

    it("should throw when .. escapes project boundary", () => {
      // Try to escape by going up from project root
      const escapeAttempt = path.join("..", "..", "etc", "passwd");
      expect(() => resolveAndValidate(escapeAttempt)).toThrow(
        /Security Error: Path access denied/,
      );
    });
  });

  describe("Edge Cases", () => {
    it("should handle paths with special characters", () => {
      const specialPath = path.join(projectRoot, "file with spaces.txt");
      expect(() => validatePathInProject(specialPath)).not.toThrow();
    });

    it("should handle paths with unicode characters", () => {
      const unicodePath = path.join(projectRoot, "文件.txt");
      expect(() => validatePathInProject(unicodePath)).not.toThrow();
    });

    it("should handle very long paths within project", () => {
      const longPath = path.join(
        projectRoot,
        "a",
        "very",
        "long",
        "path",
        "with",
        "many",
        "segments",
        "file.txt",
      );
      expect(() => validatePathInProject(longPath)).not.toThrow();
    });

    it("should handle case sensitivity appropriately", () => {
      // On case-insensitive filesystems (macOS, Windows), different casing should work
      // On case-sensitive filesystems (Linux), they're treated as different paths
      const originalPath = path.join(projectRoot, "SRC", "INDEX.ts");
      // This test just ensures validation runs without crashing
      const result = isPathInProject(originalPath);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("Symlink Scenarios", () => {
    // These tests document expected behavior for future symlink validation
    // Currently we don't validate symlinks, but we should in the future

    it("should document symlink behavior (future implementation)", () => {
      // Future: symlinks pointing outside project should be rejected
      // Future: symlinks within project should be allowed
      // For now, we just document the expected behavior
      expect(true).toBe(true); // Placeholder
    });
  });

  describe("Performance", () => {
    it("should validate paths quickly", () => {
      const testPath = path.join(projectRoot, "src", "index.ts");
      const iterations = 1000;

      const start = Date.now();
      for (let i = 0; i < iterations; i++) {
        isPathInProject(testPath);
      }
      const duration = Date.now() - start;

      // Should complete 1000 validations in under 100ms
      expect(duration).toBeLessThan(100);
    });
  });
});
