/**
 * Path Utilities Tests
 *
 * Tests for consistent project root resolution across different contexts.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as path from "path";
import * as fs from "fs";
import {
  getProjectRoot,
  getAgentPackageRoot,
  resolveProjectPath,
  getRelativeProjectPath,
  findProjectRootByMarker,
  findProjectRootByName,
  findProjectRootFromModule,
  clearProjectRootCache,
  getPathDiagnostics,
} from "../../../src/utils/path-utils.js";

describe("Path Utilities", () => {
  beforeEach(() => {
    // Clear cache before each test
    clearProjectRootCache();
  });

  afterEach(() => {
    // Clear cache after each test
    clearProjectRootCache();
  });

  describe("getProjectRoot", () => {
    it("should return a valid project root", () => {
      const root = getProjectRoot();

      expect(root).toBeDefined();
      expect(typeof root).toBe("string");
      expect(root.length).toBeGreaterThan(0);
    });

    it("should return an absolute path", () => {
      const root = getProjectRoot();

      expect(path.isAbsolute(root)).toBe(true);
    });

    it("should resolve to the standalone @sia-web/agent repo root", () => {
      const root = getProjectRoot();

      const packageJsonPath = path.join(root, "package.json");
      expect(fs.existsSync(packageJsonPath)).toBe(true);

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      expect(packageJson.name).toBe("@sia-web/agent");
    });

    it("should contain sia-web-agent directory name", () => {
      const root = getProjectRoot();
      expect(root.includes("sia-web-agent")).toBe(true);
    });

    it("should cache the result", () => {
      const root1 = getProjectRoot();
      const root2 = getProjectRoot();

      expect(root1).toBe(root2);
    });

    it("should return consistent path after cache clear", () => {
      const root1 = getProjectRoot();
      clearProjectRootCache();
      const root2 = getProjectRoot();

      expect(root1).toBe(root2);
    });
  });

  describe("getAgentPackageRoot", () => {
    it("should return the project root (standalone repo layout)", () => {
      const agentRoot = getAgentPackageRoot();
      const projectRoot = getProjectRoot();

      expect(agentRoot).toBe(projectRoot);
    });

    it("should have prompts/ and skills/ as siblings", () => {
      const agentRoot = getAgentPackageRoot();

      expect(fs.existsSync(path.join(agentRoot, "prompts"))).toBe(true);
      expect(fs.existsSync(path.join(agentRoot, "skills"))).toBe(true);
    });

    it("should have absolute path", () => {
      const agentRoot = getAgentPackageRoot();

      expect(path.isAbsolute(agentRoot)).toBe(true);
    });
  });

  describe("resolveProjectPath", () => {
    it("should resolve relative paths to absolute", () => {
      const relative = "src/index.ts";
      const absolute = resolveProjectPath(relative);

      expect(path.isAbsolute(absolute)).toBe(true);
      expect(absolute).toContain("src");
      expect(absolute).toContain("index.ts");
    });

    it("should return absolute paths unchanged", () => {
      const absolute = "/absolute/path/to/file.ts";
      const result = resolveProjectPath(absolute);

      expect(result).toBe(absolute);
    });

    it("should construct path from project root", () => {
      const relative = "src/utils/path-utils.ts";
      const resolved = resolveProjectPath(relative);
      const projectRoot = getProjectRoot();

      expect(resolved).toBe(path.join(projectRoot, relative));
    });

    it("should handle nested paths", () => {
      const relative = "packages/agent/src/index.ts";
      const resolved = resolveProjectPath(relative);

      expect(resolved).toContain("packages");
      expect(resolved).toContain("agent");
      expect(resolved).toContain("src");
    });
  });

  describe("getRelativeProjectPath", () => {
    it("should convert absolute path to relative", () => {
      const projectRoot = getProjectRoot();
      const absolute = path.join(projectRoot, "src/index.ts");
      const relative = getRelativeProjectPath(absolute);

      expect(relative).toBe("src/index.ts");
      expect(relative).not.toContain(projectRoot);
    });

    it("should handle paths at project root", () => {
      const projectRoot = getProjectRoot();
      const relative = getRelativeProjectPath(projectRoot);

      // path.relative returns empty string for same path
      expect(relative).toBe("");
    });

    it("should handle nested paths correctly", () => {
      const projectRoot = getProjectRoot();
      const absolute = path.join(
        projectRoot,
        "packages/agent/src/utils/path-utils.ts",
      );
      const relative = getRelativeProjectPath(absolute);

      expect(relative).toBe("packages/agent/src/utils/path-utils.ts");
    });
  });

  describe("findProjectRootByMarker", () => {
    it("should find project root from current working directory", () => {
      const root = findProjectRootByMarker(process.cwd());

      expect(root).toBeDefined();
      expect(root).not.toBeNull();
    });

    it("should find marker file in directory", () => {
      const projectRoot = getProjectRoot();
      const root = findProjectRootByMarker(projectRoot);

      expect(root).toBe(projectRoot);
    });

    it("should return null for non-existent path", () => {
      const root = findProjectRootByMarker("/non/existent/path");

      expect(root).toBeNull();
    });

    it("should walk up directory tree to find marker", () => {
      const projectRoot = getProjectRoot();
      const nestedPath = path.join(projectRoot, "packages", "agent", "src");
      const root = findProjectRootByMarker(nestedPath);

      expect(root).toBe(projectRoot);
    });

    it("should prioritize marker files in order", () => {
      const projectRoot = getProjectRoot();

      // Check which marker was found
      const hasPriority = ["langgraph.json", "CLAUDE.md", "package.json"].some(
        (marker) => fs.existsSync(path.join(projectRoot, marker)),
      );

      expect(hasPriority).toBe(true);
    });
  });

  describe("findProjectRootByName", () => {
    it("should return null when the legacy 'self-improving-agent' directory name is not present", () => {
      // This fallback strategy only matches the original monorepo directory name.
      // In the standalone @sia-web/agent repo it is expected to return null.
      const root = findProjectRootByName(process.cwd());

      expect(root).toBeNull();
    });

    it("should return null if directory not found", () => {
      const root = findProjectRootByName("/usr/bin");

      expect(root).toBeNull();
    });

    it("should walk up the tree without throwing", () => {
      expect(() => findProjectRootByName(process.cwd())).not.toThrow();
    });
  });

  describe("clearProjectRootCache", () => {
    it("should clear the cached project root", () => {
      const root1 = getProjectRoot();
      clearProjectRootCache();
      const root2 = getProjectRoot();

      // Results should still be the same
      expect(root1).toBe(root2);
    });

    it("should allow recalculation after cache clear", () => {
      getProjectRoot();
      clearProjectRootCache();

      // Should not throw and should return valid result
      const root = getProjectRoot();
      expect(root).toBeDefined();
    });
  });

  describe("getPathDiagnostics", () => {
    it("should return diagnostic object", () => {
      const diag = getPathDiagnostics();

      expect(diag).toBeDefined();
      expect(typeof diag).toBe("object");
    });

    it("should include projectRoot", () => {
      const diag = getPathDiagnostics();

      expect(diag.projectRoot).toBeDefined();
      expect(typeof diag.projectRoot).toBe("string");
      expect(diag.projectRoot.length).toBeGreaterThan(0);
    });

    it("should include agentPackageRoot", () => {
      const diag = getPathDiagnostics();

      expect(diag.agentPackageRoot).toBeDefined();
      expect(typeof diag.agentPackageRoot).toBe("string");
    });

    it("should include current working directory", () => {
      const diag = getPathDiagnostics();

      expect(diag.cwd).toBeDefined();
      expect(diag.cwd).toBe(process.cwd());
    });

    it("should include detection strategy used", () => {
      const diag = getPathDiagnostics();

      expect(diag.detectionStrategy).toBeDefined();
      expect(typeof diag.detectionStrategy).toBe("string");

      // Should be one of the known strategies
      const validStrategies = [
        "monorepo (package.json with workspaces)",
        "git repository (.git directory)",
        "project marker (langgraph.json or CLAUDE.md)",
        "directory name (self-improving-agent)",
        "fallback (process.cwd)",
      ];
      expect(validStrategies).toContain(diag.detectionStrategy);
    });

    it("should have consistent projectRoot with getProjectRoot()", () => {
      const diag = getPathDiagnostics();
      const root = getProjectRoot();

      expect(diag.projectRoot).toBe(root);
    });
  });

  describe("findProjectRootFromModule", () => {
    it("should return string or null (depends on environment)", () => {
      const root = findProjectRootFromModule();

      // In test environments, import.meta.url might not work correctly
      // So we just verify it returns the right type
      expect(root === null || typeof root === "string").toBe(true);
    });

    it("should find the same root as getProjectRoot when available", () => {
      const moduleRoot = findProjectRootFromModule();
      const projectRoot = getProjectRoot();

      // Both should find the same root (if moduleRoot is available)
      if (moduleRoot) {
        expect(moduleRoot).toBe(projectRoot);
      }
    });

    it("should not throw even if import.meta.url is unavailable", () => {
      // This function should handle environments without import.meta.url
      // gracefully and return null rather than throwing
      expect(() => {
        findProjectRootFromModule();
      }).not.toThrow();
    });
  });

  describe("Hybrid strategy priority", () => {
    it("should resolve via the git-repository strategy in the standalone repo", () => {
      const diag = getPathDiagnostics();

      // Standalone repo has no `workspaces` field, so the monorepo strategy is
      // skipped and detection falls through to the `.git` directory marker.
      expect(diag.detectionStrategy).toBe(
        "git repository (.git directory)",
      );
    });

    it("should resolve to the repo root, not a nested package path", () => {
      const root = getProjectRoot();

      // Standalone layout: src/ and prompts/ live directly under the root,
      // and there is no nested packages/agent path to confuse the resolver.
      expect(root.endsWith("packages/agent")).toBe(false);
      expect(fs.existsSync(path.join(root, "src"))).toBe(true);
      expect(fs.existsSync(path.join(root, "prompts"))).toBe(true);
    });

    it("should have .git directory at project root", () => {
      const root = getProjectRoot();
      const gitPath = path.join(root, ".git");

      expect(fs.existsSync(gitPath)).toBe(true);
    });

    it("should have langgraph.json at project root", () => {
      const root = getProjectRoot();

      expect(fs.existsSync(path.join(root, "langgraph.json"))).toBe(true);
    });
  });

  describe("Path resolution from different directories", () => {
    it("should resolve to a path containing sia-web-agent", () => {
      const root = getProjectRoot();
      expect(root.includes("sia-web-agent")).toBe(true);
      expect(root.endsWith("packages/agent")).toBe(false);
    });

    it("should not double-prepend project root to paths", () => {
      const projectRoot = getProjectRoot();
      const testPath = "tests/fixtures/test.txt";
      const resolved = resolveProjectPath(testPath);

      const fixturesCount = (resolved.match(/tests\/fixtures/g) || []).length;
      expect(fixturesCount).toBe(1);

      expect(resolved).toBe(path.join(projectRoot, testPath));
    });

    it("should construct absolute paths without duplication", () => {
      const fixtures = "tests/fixtures";
      const testFile = path.join(fixtures, "test.txt");
      const resolved = resolveProjectPath(testFile);

      const count = (resolved.match(/tests\/fixtures/g) || []).length;
      expect(count).toBe(1);

      expect(resolved).toContain("sia-web-agent");
      expect(resolved).toContain("tests");
      expect(resolved).toContain("fixtures");
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle empty strings", () => {
      const result = resolveProjectPath("");
      const root = getProjectRoot();

      // Empty string should resolve to project root
      expect(result).toBe(root);
    });

    it("should handle paths with . and ..", () => {
      const relative = "packages/agent/../web";
      const resolved = resolveProjectPath(relative);

      // Should resolve the .. correctly
      expect(resolved).toContain("packages");
      expect(resolved).toContain("web");
    });

    it("should handle absolute paths unchanged", () => {
      const absolute = "/etc/passwd";
      const result = resolveProjectPath(absolute);

      expect(result).toBe(absolute);
    });

    it("should return valid absolute path from getProjectRoot", () => {
      const root = getProjectRoot();

      expect(path.isAbsolute(root)).toBe(true);
      expect(fs.existsSync(root)).toBe(true);
    });

    it("should not return path with trailing slash", () => {
      const root = getProjectRoot();

      expect(root.endsWith("/")).toBe(false);
    });
  });

  describe("Integration tests", () => {
    it("should resolve and unresolve paths correctly", () => {
      const relative = "src/utils/path-utils.ts";
      const absolute = resolveProjectPath(relative);
      const backToRelative = getRelativeProjectPath(absolute);

      expect(backToRelative).toBe(relative);
    });

    it("should handle complex nested paths", () => {
      const relative = "packages/agent/tests/unit/utils/path-utils.test.ts";
      const absolute = resolveProjectPath(relative);

      expect(absolute).toContain("packages");
      expect(absolute).toContain("agent");
      expect(absolute).toContain("tests");
      expect(path.isAbsolute(absolute)).toBe(true);
    });

    it("should maintain path consistency across calls", () => {
      const root1 = getProjectRoot();
      const agent1 = getAgentPackageRoot();
      const root2 = getProjectRoot();
      const agent2 = getAgentPackageRoot();

      expect(root1).toBe(root2);
      expect(agent1).toBe(agent2);
      expect(agent1).toContain(root1);
    });

    it("should work with all path functions together", () => {
      const projectRoot = getProjectRoot();
      const agentRoot = getAgentPackageRoot();
      const resolved = resolveProjectPath("src/index.ts");
      const relative = getRelativeProjectPath(resolved);

      expect(projectRoot).toBeDefined();
      expect(agentRoot).toBeDefined();
      expect(resolved).toBeDefined();
      expect(relative).toBeDefined();
      expect(relative).toBe("src/index.ts");
    });
  });
});
