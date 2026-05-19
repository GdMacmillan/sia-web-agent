import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createFileTools } from "../../../src/tools/file-tools.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("File Tools", () => {
  let tools: ReturnType<typeof createFileTools>;
  let fileReadTool: any;
  let fileEditTool: any;
  let fileCreateTool: any;
  let fileDeleteTool: any;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tools-test-"));

    // Create fresh tool instances
    tools = createFileTools(testDir);
    [fileReadTool, fileEditTool, fileCreateTool, fileDeleteTool] = tools;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("file_read", () => {
    it("should read existing file content", async () => {
      const testFile = path.join(testDir, "test.txt");
      const content = "Hello World";
      await fs.writeFile(testFile, content);

      const result = await fileReadTool.func({ filePath: "test.txt" });

      expect(result).toBe(content);
    });

    it("should read file with absolute path", async () => {
      const testFile = path.join(testDir, "absolute.txt");
      const content = "Absolute path test";
      await fs.writeFile(testFile, content);

      const result = await fileReadTool.func({ filePath: testFile });

      expect(result).toBe(content);
    });

    it("should return error for non-existent file", async () => {
      const result = await fileReadTool.func({ filePath: "nonexistent.txt" });

      expect(result).toContain("Error: File not found");
      expect(result).toContain("nonexistent.txt");
    });

    it("should handle nested directory paths", async () => {
      const nestedDir = path.join(testDir, "nested", "deep");
      await fs.mkdir(nestedDir, { recursive: true });
      const testFile = path.join(nestedDir, "file.txt");
      const content = "Nested file";
      await fs.writeFile(testFile, content);

      const result = await fileReadTool.func({
        filePath: "nested/deep/file.txt",
      });

      expect(result).toBe(content);
    });

    it("should reject path traversal outside project root", async () => {
      const result = await fileReadTool.func({
        filePath: "../../../etc/passwd",
      });

      expect(result).toContain("Error");
      expect(result).toContain("outside project root");
    });

    it("should read empty file", async () => {
      const testFile = path.join(testDir, "empty.txt");
      await fs.writeFile(testFile, "");

      const result = await fileReadTool.func({ filePath: "empty.txt" });

      expect(result).toBe("");
    });

    it("should read file with special characters", async () => {
      const testFile = path.join(testDir, "special.txt");
      const content = "Special chars: ñ, é, 中文, 🚀";
      await fs.writeFile(testFile, content, "utf-8");

      const result = await fileReadTool.func({ filePath: "special.txt" });

      expect(result).toBe(content);
    });

    it("should read multiline file", async () => {
      const testFile = path.join(testDir, "multi.txt");
      const content = "Line 1\nLine 2\nLine 3";
      await fs.writeFile(testFile, content);

      const result = await fileReadTool.func({ filePath: "multi.txt" });

      expect(result).toBe(content);
    });
  });

  describe("file_create", () => {
    it("should create new file with content", async () => {
      const result = await fileCreateTool.func({
        filePath: "new.txt",
        content: "New file content",
      });

      expect(result).toContain("Success");
      expect(result).toContain("Created file");

      // Verify file was actually created
      const content = await fs.readFile(path.join(testDir, "new.txt"), "utf-8");
      expect(content).toBe("New file content");
    });

    it("should fail if file already exists", async () => {
      const testFile = path.join(testDir, "exists.txt");
      await fs.writeFile(testFile, "Already here");

      const result = await fileCreateTool.func({
        filePath: "exists.txt",
        content: "New content",
      });

      expect(result).toContain("Error: File already exists");
      expect(result).toContain("Use file_edit");
    });

    it("should create parent directories if needed", async () => {
      const result = await fileCreateTool.func({
        filePath: "deep/nested/dir/file.txt",
        content: "Deep file",
      });

      expect(result).toContain("Success");

      // Verify file and directories were created
      const content = await fs.readFile(
        path.join(testDir, "deep/nested/dir/file.txt"),
        "utf-8",
      );
      expect(content).toBe("Deep file");
    });

    it("should create file with absolute path", async () => {
      const absolutePath = path.join(testDir, "absolute-create.txt");

      const result = await fileCreateTool.func({
        filePath: absolutePath,
        content: "Absolute",
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(absolutePath, "utf-8");
      expect(content).toBe("Absolute");
    });

    it("should reject path traversal outside project root", async () => {
      const result = await fileCreateTool.func({
        filePath: "../../../tmp/bad.txt",
        content: "Should not work",
      });

      expect(result).toContain("Error");
      expect(result).toContain("outside project root");
    });

    it("should create empty file", async () => {
      const result = await fileCreateTool.func({
        filePath: "empty.txt",
        content: "",
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(
        path.join(testDir, "empty.txt"),
        "utf-8",
      );
      expect(content).toBe("");
    });

    it("should create file with special characters", async () => {
      const specialContent = "Unicode: ñ, é, 中文, 🎉\nNewlines\tTabs";

      const result = await fileCreateTool.func({
        filePath: "special.txt",
        content: specialContent,
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(
        path.join(testDir, "special.txt"),
        "utf-8",
      );
      expect(content).toBe(specialContent);
    });

    it("should create file with JSON content", async () => {
      const jsonContent = JSON.stringify(
        { key: "value", nested: { a: 1 } },
        null,
        2,
      );

      const result = await fileCreateTool.func({
        filePath: "data.json",
        content: jsonContent,
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(
        path.join(testDir, "data.json"),
        "utf-8",
      );
      expect(content).toBe(jsonContent);
    });
  });

  describe("file_edit", () => {
    it("should edit existing file by replacing snippet", async () => {
      const testFile = path.join(testDir, "edit.txt");
      await fs.writeFile(testFile, "Original content");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "edit.txt" });

      const result = await fileEditTool.func({
        filePath: "edit.txt",
        originalSnippet: "Original content",
        replacedSnippet: "Updated content",
      });

      expect(result).toContain("Success");
      expect(result).toContain("Edited");

      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("Updated content");
    });

    it("should fail if original snippet not found", async () => {
      const testFile = path.join(testDir, "mismatch.txt");
      await fs.writeFile(testFile, "Some content");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "mismatch.txt" });

      const result = await fileEditTool.func({
        filePath: "mismatch.txt",
        originalSnippet: "Nonexistent snippet",
        replacedSnippet: "New content",
      });

      expect(result).toContain("Error: Snippet not found");
    });

    it("should replace only first occurrence if snippet appears multiple times", async () => {
      const testFile = path.join(testDir, "multi.txt");
      await fs.writeFile(testFile, "foo\nfoo\nbar");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "multi.txt" });

      const result = await fileEditTool.func({
        filePath: "multi.txt",
        originalSnippet: "foo",
        replacedSnippet: "baz",
      });

      expect(result).toContain("Error");
      expect(result).toContain("Found 2 occurrences");
    });

    it("should edit file with absolute path", async () => {
      const absolutePath = path.join(testDir, "absolute-edit.txt");
      await fs.writeFile(absolutePath, "Original");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: absolutePath });

      const result = await fileEditTool.func({
        filePath: absolutePath,
        originalSnippet: "Original",
        replacedSnippet: "Updated via absolute",
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(absolutePath, "utf-8");
      expect(content).toBe("Updated via absolute");
    });

    it("should reject path traversal outside project root", async () => {
      const result = await fileEditTool.func({
        filePath: "../../../etc/passwd",
        originalSnippet: "root",
        replacedSnippet: "hacked",
      });

      expect(result).toContain("Error");
      expect(result).toContain("outside project root");
    });

    it("should edit multiline snippets", async () => {
      const testFile = path.join(testDir, "multiline.txt");
      await fs.writeFile(testFile, "Line 1\nLine 2\nLine 3");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "multiline.txt" });

      const result = await fileEditTool.func({
        filePath: "multiline.txt",
        originalSnippet: "Line 1\nLine 2",
        replacedSnippet: "New Line 1\nNew Line 2",
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("New Line 1\nNew Line 2\nLine 3");
    });

    it("should edit nested file", async () => {
      const nestedDir = path.join(testDir, "a", "b", "c");
      await fs.mkdir(nestedDir, { recursive: true });
      const testFile = path.join(nestedDir, "nested.txt");
      await fs.writeFile(testFile, "Original nested");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "a/b/c/nested.txt" });

      const result = await fileEditTool.func({
        filePath: "a/b/c/nested.txt",
        originalSnippet: "Original nested",
        replacedSnippet: "Updated nested",
      });

      expect(result).toContain("Success");

      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("Updated nested");
    });

    it("should show unified diff in output", async () => {
      const testFile = path.join(testDir, "diff.txt");
      await fs.writeFile(testFile, "const x = 1;");

      // Must read file first (required by file_edit)
      await fileReadTool.func({ filePath: "diff.txt" });

      const result = await fileEditTool.func({
        filePath: "diff.txt",
        originalSnippet: "const x = 1;",
        replacedSnippet: "const x = 2;",
      });

      expect(result).toContain("Diff:");
      expect(result).toContain("---");
      expect(result).toContain("+++");
    });

    it("should fail if file does not exist", async () => {
      const result = await fileEditTool.func({
        filePath: "nonexistent.txt",
        originalSnippet: "any",
        replacedSnippet: "thing",
      });

      expect(result).toContain("Error: File not found");
    });

    // Enhanced error message tests
    describe("error messages", () => {
      it("should show file preview when snippet not found", async () => {
        const testFile = path.join(testDir, "preview.txt");
        await fs.writeFile(testFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

        // Must read file first (required by file_edit)
        await fileReadTool.func({ filePath: "preview.txt" });

        const result = await fileEditTool.func({
          filePath: "preview.txt",
          originalSnippet: "Nonexistent snippet",
          replacedSnippet: "New content",
        });

        expect(result).toContain("Error: Snippet not found");
        expect(result).toContain("File preview:");
        expect(result).toContain("Line 1");
        expect(result).toContain("Use file_read");
      });

      it("should detect whitespace mismatch between tabs and spaces", async () => {
        const testFile = path.join(testDir, "tabs.txt");
        await fs.writeFile(testFile, "function test() {\n\treturn true;\n}");

        // Must read file first (required by file_edit)
        await fileReadTool.func({ filePath: "tabs.txt" });

        // Try to match with spaces instead of tab - should detect whitespace mismatch
        const result = await fileEditTool.func({
          filePath: "tabs.txt",
          originalSnippet: "  return true;",
          replacedSnippet: "  return false;",
        });

        expect(result).toContain("Error: Snippet not found");
        expect(result).toContain("whitespace differs");
        expect(result).toContain("Use file_read");
      });

      it("should show concise message for multiple occurrences", async () => {
        const testFile = path.join(testDir, "multi-occurrence.txt");
        await fs.writeFile(testFile, "foo\nbar\nfoo\nbaz\nfoo");

        // Must read file first (required by file_edit)
        await fileReadTool.func({ filePath: "multi-occurrence.txt" });

        const result = await fileEditTool.func({
          filePath: "multi-occurrence.txt",
          originalSnippet: "foo",
          replacedSnippet: "updated",
        });

        expect(result).toContain("Error: Found 3 occurrences");
        expect(result).toContain("Provide larger snippet");
        expect(result).toContain("surrounding context");
      });

      it("should provide actionable tip for snippet mismatch", async () => {
        const testFile = path.join(testDir, "actionable.txt");
        await fs.writeFile(testFile, "const x = 1;\nconst y = 2;");

        // Must read file first (required by file_edit)
        await fileReadTool.func({ filePath: "actionable.txt" });

        const result = await fileEditTool.func({
          filePath: "actionable.txt",
          originalSnippet: "const z = 3;",
          replacedSnippet: "const z = 4;",
        });

        expect(result).toContain("Error: Snippet not found");
        expect(result).toContain("Use file_read");
      });

      it("should suggest file_read when snippet has wrong whitespace", async () => {
        const testFile = path.join(testDir, "whitespace.txt");
        await fs.writeFile(testFile, "if (x) {\n  return true;\n}");

        // Must read file first (required by file_edit)
        await fileReadTool.func({ filePath: "whitespace.txt" });

        const result = await fileEditTool.func({
          filePath: "whitespace.txt",
          originalSnippet: "if (x) {  return true; }",
          replacedSnippet: "if (x) { return false; }",
        });

        expect(result).toContain("Error: Snippet not found");
        expect(result).toContain("whitespace differs");
        expect(result).toContain("Use file_read");
      });
    });
  });

  describe("file_delete", () => {
    it("should delete existing file", async () => {
      const testFile = path.join(testDir, "delete.txt");
      await fs.writeFile(testFile, "To be deleted");

      const result = await fileDeleteTool.func({ filePath: "delete.txt" });

      expect(result).toContain("Success");
      expect(result).toContain("Deleted file");

      // Verify file no longer exists
      await expect(fs.access(testFile)).rejects.toThrow();
    });

    it("should return error for non-existent file", async () => {
      const result = await fileDeleteTool.func({ filePath: "nonexistent.txt" });

      expect(result).toContain("Error: File not found");
      expect(result).toContain("nonexistent.txt");
    });

    it("should delete file with absolute path", async () => {
      const absolutePath = path.join(testDir, "absolute-delete.txt");
      await fs.writeFile(absolutePath, "Delete me");

      const result = await fileDeleteTool.func({ filePath: absolutePath });

      expect(result).toContain("Success");

      await expect(fs.access(absolutePath)).rejects.toThrow();
    });

    it("should delete nested file", async () => {
      const nestedDir = path.join(testDir, "x", "y");
      await fs.mkdir(nestedDir, { recursive: true });
      const testFile = path.join(nestedDir, "nested.txt");
      await fs.writeFile(testFile, "Nested delete");

      const result = await fileDeleteTool.func({ filePath: "x/y/nested.txt" });

      expect(result).toContain("Success");

      await expect(fs.access(testFile)).rejects.toThrow();
    });

    it("should reject path traversal outside project root", async () => {
      const result = await fileDeleteTool.func({
        filePath: "../../../tmp/file.txt",
      });

      expect(result).toContain("Error");
      expect(result).toContain("outside project root");
    });

    it("should not delete directories", async () => {
      const dir = path.join(testDir, "directory");
      await fs.mkdir(dir);

      const result = await fileDeleteTool.func({ filePath: "directory" });

      // Should fail because unlink doesn't work on directories
      expect(result).toContain("Error");
    });
  });

  describe("path validation", () => {
    it("should handle . and .. segments safely", async () => {
      await fs.writeFile(path.join(testDir, "safe.txt"), "Safe content");

      const result = await fileReadTool.func({ filePath: "./safe.txt" });

      expect(result).toBe("Safe content");
    });

    it("should reject .. that goes outside root", async () => {
      const result = await fileReadTool.func({
        filePath: "../../../etc/passwd",
      });

      expect(result).toContain("Error");
      expect(result).toContain("outside project root");
    });

    it("should accept .. that stays within root", async () => {
      const nestedDir = path.join(testDir, "a", "b");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(testDir, "root.txt"), "Root file");

      const result = await fileReadTool.func({
        filePath: "a/b/../../root.txt",
      });

      expect(result).toBe("Root file");
    });

    it("should normalize paths correctly", async () => {
      await fs.writeFile(path.join(testDir, "normal.txt"), "Normal");

      const result1 = await fileReadTool.func({ filePath: "./normal.txt" });
      const result2 = await fileReadTool.func({ filePath: "normal.txt" });
      const result3 = await fileReadTool.func({ filePath: "./././normal.txt" });

      expect(result1).toBe("Normal");
      expect(result2).toBe("Normal");
      expect(result3).toBe("Normal");
    });
  });

  describe("edge cases", () => {
    it("should handle files with spaces in name", async () => {
      const testFile = path.join(testDir, "file with spaces.txt");
      await fs.writeFile(testFile, "Spaces");

      const result = await fileReadTool.func({
        filePath: "file with spaces.txt",
      });

      expect(result).toBe("Spaces");
    });

    it("should handle files with special characters in name", async () => {
      const testFile = path.join(testDir, "file-with_special.chars!.txt");
      await fs.writeFile(testFile, "Special");

      const result = await fileReadTool.func({
        filePath: "file-with_special.chars!.txt",
      });

      expect(result).toBe("Special");
    });

    it("should handle very long file content with offloading", async () => {
      const longContent = "x".repeat(100001); // Must be > 100000 to trigger rejection

      const createResult = await fileCreateTool.func({
        filePath: "long.txt",
        content: longContent,
      });

      expect(createResult).toContain("Success");

      const readResult = await fileReadTool.func({ filePath: "long.txt" });
      // Large files are rejected with a helpful message
      expect(readResult).toContain("too large");
      expect(readResult).toContain("100001");
      expect(readResult).toContain("grep_code");
    });

    it("should handle multiple operations on same file", async () => {
      // Create
      const createResult = await fileCreateTool.func({
        filePath: "multi.txt",
        content: "Version 1",
      });
      expect(createResult).toContain("Success");

      // Read (first read to track for file_edit)
      const readResult1 = await fileReadTool.func({ filePath: "multi.txt" });
      expect(readResult1).toBe("Version 1");

      // Edit (now it has been read)
      const editResult = await fileEditTool.func({
        filePath: "multi.txt",
        originalSnippet: "Version 1",
        replacedSnippet: "Version 2",
      });
      expect(editResult).toContain("Success");

      // Read again
      const readResult2 = await fileReadTool.func({ filePath: "multi.txt" });
      expect(readResult2).toBe("Version 2");

      // Delete
      const deleteResult = await fileDeleteTool.func({ filePath: "multi.txt" });
      expect(deleteResult).toContain("Success");

      // Read should fail
      const readResult3 = await fileReadTool.func({ filePath: "multi.txt" });
      expect(readResult3).toContain("Error: File not found");
    });
  });
});
