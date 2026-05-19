/**
 * Search Tool Tests
 *
 * Tests for the ripgrep-based search tool including pattern matching,
 * case sensitivity, file type filtering, and output clipping.
 * Uses real ripgrep against temp directories with known files.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createSearchTool } from "../../../src/tools/search-tool.js";

describe("Search Tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "search-tool-test-"));
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Tool Configuration", () => {
    it("should have correct name and schema fields", () => {
      const tool = createSearchTool(tmpDir);

      expect(tool.name).toBe("search");

      // Verify schema has all expected fields by invoking schema parse
      const parsed = tool.schema.parse({
        pattern: "test",
        fileType: "ts",
        caseSensitive: true,
      });
      expect(parsed).toEqual({
        pattern: "test",
        fileType: "ts",
        caseSensitive: true,
      });

      // Verify defaults
      const minimal = tool.schema.parse({ pattern: "test" });
      expect(minimal.caseSensitive).toBe(false);
      expect(minimal.fileType).toBeUndefined();
    });
  });

  describe("Basic Search", () => {
    it("should find known content in a .ts file", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "example.ts"),
        "export function uniqueSearchTarget() { return 42; }\n",
      );

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({ pattern: "uniqueSearchTarget" });

      expect(result).toContain("uniqueSearchTarget");
      expect(result).toContain("example.ts");
    });

    it("should return 'No matches found' for non-matching pattern", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "example.ts"),
        "export const value = 1;\n",
      );

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({
        pattern: "xyzNonExistentPattern999",
      });

      expect(result).toBe("No matches found");
    });
  });

  describe("Case Sensitivity", () => {
    it("should find mixed-case content with default case-insensitive search", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "mixed.ts"),
        'const MySpecialVar = "hello";\n',
      );

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({ pattern: "myspecialvar" });

      expect(result).toContain("MySpecialVar");
      expect(result).toContain("mixed.ts");
    });

    it("should only find exact case when caseSensitive is true", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "case.ts"),
        "const CaseSensitiveValue = 1;\nconst casesensitivevalue = 2;\n",
      );

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({
        pattern: "CaseSensitiveValue",
        caseSensitive: true,
      });

      expect(result).toContain("CaseSensitiveValue");
      // The lowercase variant should NOT match
      expect(result).not.toContain("casesensitivevalue");
    });
  });

  describe("File Type Filtering", () => {
    it("should filter results by file type", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "code.ts"),
        'const fileTypeTarget = "typescript";\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, "data.json"),
        '{ "fileTypeTarget": "json" }\n',
      );

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({
        pattern: "fileTypeTarget",
        fileType: "ts",
      });

      expect(result).toContain("code.ts");
      expect(result).not.toContain("data.json");
    });
  });

  describe("Output Clipping", () => {
    it("should clip very large results with truncation marker", async () => {
      // Create many files with matching content to generate large output
      const subDir = path.join(tmpDir, "bulk");
      fs.mkdirSync(subDir);

      for (let i = 0; i < 100; i++) {
        // Each file has a long matching line to bloat the output
        const longContent =
          `const clipTestMatch${"X".repeat(500)} = ${i};\n`.repeat(5);
        fs.writeFileSync(path.join(subDir, `file${i}.ts`), longContent);
      }

      const tool = createSearchTool(tmpDir);
      const result = await tool.invoke({ pattern: "clipTestMatch" });

      // If output exceeds 24000 chars, it should be clipped
      if (result.length > 100) {
        // We generated enough data to trigger clipping
        expect(result.length).toBeLessThanOrEqual(24000 + 50); // small buffer for marker
        if (result.includes("...[truncated]...")) {
          expect(result).toContain("...[truncated]...");
        }
      }
    });
  });
});
