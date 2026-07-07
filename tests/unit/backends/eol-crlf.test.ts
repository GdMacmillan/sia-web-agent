import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { performStringReplacement } from "../../../src/backends/utils.js";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";

describe("CRLF / EOL-aware editing", () => {
  describe("performStringReplacement", () => {
    it("matches an LF oldString against CRLF content and preserves CRLF", () => {
      const content = "line1\r\nline2\r\nline3\r\n";
      const result = performStringReplacement(
        content,
        "line1\nline2", // LF snippet from the model
        "changed",
        false,
      );
      expect(Array.isArray(result)).toBe(true);
      const [newContent, occurrences] = result as [string, number];
      expect(occurrences).toBe(1);
      expect(newContent).toBe("changed\r\nline3\r\n");
    });

    it("preserves LF for an LF file", () => {
      const result = performStringReplacement("a\nb\nc\n", "b", "B", false);
      const [newContent] = result as [string, number];
      expect(newContent).toBe("a\nB\nc\n");
    });

    it("still reports a not-found error", () => {
      const result = performStringReplacement("a\r\nb\r\n", "zzz", "x", false);
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(/String not found/);
    });
  });

  describe("FilesystemBackend.edit round-trip", () => {
    let testDir: string;
    let backend: FilesystemBackend;

    beforeEach(async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), "eol-edit-test-"));
      backend = new FilesystemBackend({ rootDir: testDir, virtualMode: true });
    });

    afterEach(async () => {
      if (testDir && (await fs.stat(testDir).catch(() => null))) {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("edits a CRLF file with an LF snippet and keeps CRLF on disk", async () => {
      const abs = path.join(testDir, "crlf.txt");
      await fs.writeFile(abs, "alpha\r\nbeta\r\ngamma\r\n");

      const result = await backend.edit("/crlf.txt", "alpha\nbeta", "ALPHABETA");
      expect((result as { error?: string }).error).toBeUndefined();

      const onDisk = await fs.readFile(abs, "utf-8");
      expect(onDisk).toBe("ALPHABETA\r\ngamma\r\n");
    });

    it("leaves an LF file as LF after an edit", async () => {
      const abs = path.join(testDir, "lf.txt");
      await fs.writeFile(abs, "a\nb\nc\n");

      await backend.edit("/lf.txt", "b", "B");

      const onDisk = await fs.readFile(abs, "utf-8");
      expect(onDisk).toBe("a\nB\nc\n");
      expect(onDisk).not.toContain("\r");
    });
  });
});
