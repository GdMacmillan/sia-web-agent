/**
 * Glob patterns reach the file tools from the model, so a pattern must never
 * be able to stall the process.
 *
 * A repeated extglob such as `+(*a)` compiles to a regular expression that
 * backtracks exponentially against a file name made of one repeated character
 * followed by a different one. Matching is synchronous, so a slow match blocks
 * everything else. The file tools therefore treat extglob syntax as literal
 * text.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { FilesystemBackend } from "../../../src/backends/filesystem.js";
import {
  createFileData,
  globSearchFiles,
  grepMatchesFromFiles,
  grepSearchFiles,
} from "../../../src/backends/utils.js";

// With extglobs enabled this name takes several seconds to reject.
const SLOW_NAME = `${"a".repeat(30)}!`;
const SLOW_PATTERN = "+(*a)";
const BUDGET_MS = 1000;

function elapsed<T>(fn: () => T): { result: T; ms: number } {
  const start = Date.now();
  const result = fn();
  return { result, ms: Date.now() - start };
}

describe("glob patterns cannot stall matching", () => {
  describe("in-memory file search", () => {
    const files = {
      [`/${SLOW_NAME}`]: createFileData("needle"),
      "/src/app.ts": createFileData("needle"),
      "/src/app.js": createFileData("needle"),
    };

    it("globSearchFiles returns promptly for a repeated extglob", () => {
      const { result, ms } = elapsed(() =>
        globSearchFiles(files, SLOW_PATTERN, "/"),
      );
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(result).toBe("No files found");
    });

    it("grepSearchFiles returns promptly for a repeated extglob filter", () => {
      const { ms } = elapsed(() =>
        grepSearchFiles(files, "needle", "/", SLOW_PATTERN),
      );
      expect(ms).toBeLessThan(BUDGET_MS);
    });

    it("grepMatchesFromFiles returns promptly for a repeated extglob filter", () => {
      const { result, ms } = elapsed(() =>
        grepMatchesFromFiles(files, "needle", "/", SLOW_PATTERN),
      );
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(result).toEqual([]);
    });

    it("still supports wildcards, globstars and braces", () => {
      expect(globSearchFiles(files, "**/*.ts", "/")).toBe("/src/app.ts");
      expect(globSearchFiles(files, "src/*.{ts,js}", "/").split("\n")).toEqual(
        expect.arrayContaining(["/src/app.ts", "/src/app.js"]),
      );
      const matches = grepMatchesFromFiles(files, "needle", "/", "*.{ts,js}");
      expect(
        Array.isArray(matches) && matches.map((m) => m.path).sort(),
      ).toEqual(["/src/app.js", "/src/app.ts"]);
    });
  });

  describe("on-disk file search", () => {
    let testDir: string;
    let backend: FilesystemBackend;

    beforeEach(async () => {
      testDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-backtrack-"));
      backend = new FilesystemBackend({ rootDir: testDir, virtualMode: true });
      await fs.writeFile(path.join(testDir, SLOW_NAME), "needle");
      await fs.mkdir(path.join(testDir, "src"));
      await fs.writeFile(path.join(testDir, "src", "app.ts"), "needle");
      await fs.writeFile(path.join(testDir, "src", "app.js"), "needle");
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("glob returns promptly for a repeated extglob", async () => {
      const start = Date.now();
      const result = await backend.glob(SLOW_PATTERN, "/");
      expect(Date.now() - start).toBeLessThan(BUDGET_MS);
      expect(result.files).toEqual([]);
    });

    it("the built-in grep fallback returns promptly for a repeated extglob filter", async () => {
      const start = Date.now();
      const results = await (backend as any).pythonSearch(
        "needle",
        testDir,
        SLOW_PATTERN,
      );
      expect(Date.now() - start).toBeLessThan(BUDGET_MS);
      expect(results).toEqual({});
    });

    it("glob still supports wildcards, globstars and braces", async () => {
      const result = await backend.glob("**/*.{ts,js}", "/");
      expect((result.files ?? []).map((f) => f.path).sort()).toEqual([
        "/src/app.js",
        "/src/app.ts",
      ]);
    });
  });
});
