/**
 * `validatePathInProject` accepts registered extra roots (component roots)
 * with the same resolve-then-contain semantics as the project root.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowPathRoot,
  clearAllowedPathRoots,
  getAllowedPathRoots,
  clearProjectRootCache,
  isPathInProject,
  validatePathInProject,
} from "../../../src/utils/path-utils.js";

describe("allowPathRoot", () => {
  let extra: string;

  beforeEach(() => {
    clearProjectRootCache();
    clearAllowedPathRoots();
    extra = mkdtempSync(path.join(tmpdir(), "allowed-root-"));
  });

  afterEach(() => {
    clearAllowedPathRoots();
    clearProjectRootCache();
    rmSync(extra, { recursive: true, force: true });
  });

  it("rejects a path under an unregistered directory", () => {
    const target = path.join(extra, "hello", "entry.ts");
    expect(() => validatePathInProject(target)).toThrow(/Path access denied/);
    expect(isPathInProject(target)).toBe(false);
  });

  it("admits a path under a registered root", () => {
    allowPathRoot(extra);
    const target = path.join(extra, "hello", "entry.ts");
    expect(() => validatePathInProject(target)).not.toThrow();
    expect(isPathInProject(target)).toBe(true);
  });

  it("admits the registered root itself", () => {
    allowPathRoot(extra);
    expect(() => validatePathInProject(extra)).not.toThrow();
  });

  it("still rejects traversal out of a registered root", () => {
    allowPathRoot(extra);
    const target = path.join(extra, "..", "escape.txt");
    expect(() => validatePathInProject(target)).toThrow(/Path access denied/);
  });

  it("rejects a sibling directory that merely shares a prefix", () => {
    allowPathRoot(extra);
    const sibling = `${extra}-sibling/file.txt`;
    expect(() => validatePathInProject(sibling)).toThrow(/Path access denied/);
  });

  it("names the extra roots in the error", () => {
    allowPathRoot(extra);
    expect(() => validatePathInProject("/definitely/not/allowed")).toThrow(
      /Additional allowed roots/,
    );
  });

  it("is idempotent and clearable", () => {
    allowPathRoot(extra);
    allowPathRoot(extra);
    expect(getAllowedPathRoots()).toEqual([path.resolve(extra)]);
    clearAllowedPathRoots();
    expect(getAllowedPathRoots()).toEqual([]);
    expect(() => validatePathInProject(path.join(extra, "x"))).toThrow();
  });

  it("ignores empty input", () => {
    allowPathRoot("");
    expect(getAllowedPathRoots()).toEqual([]);
  });
});
