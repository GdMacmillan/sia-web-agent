import { describe, it, expect } from "@jest/globals";
import * as path from "path";
import { validatePath } from "../../../src/tools/file-tools.js";

describe("file-tools validatePath (containment)", () => {
  const projectRoot = path.resolve("/home/user/project");

  it("accepts a relative path inside the root", () => {
    const resolved = validatePath("src/index.ts", projectRoot);
    expect(resolved).toBe(path.resolve(projectRoot, "src/index.ts"));
  });

  it("accepts an absolute path inside the root", () => {
    const abs = path.join(projectRoot, "a", "b.ts");
    expect(validatePath(abs, projectRoot)).toBe(path.resolve(abs));
  });

  it("accepts the root itself", () => {
    expect(validatePath(projectRoot, projectRoot)).toBe(projectRoot);
  });

  it("rejects a sibling directory that shares the root's name prefix", () => {
    // The old startsWith(projectRoot) check wrongly accepted this.
    const sibling = path.resolve("/home/user/project-evil/secret.ts");
    expect(() => validatePath(sibling, projectRoot)).toThrow(
      /outside project root/,
    );
  });

  it("rejects a parent-directory traversal", () => {
    expect(() => validatePath("../outside.ts", projectRoot)).toThrow(
      /outside project root/,
    );
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => validatePath("/etc/passwd", projectRoot)).toThrow(
      /outside project root/,
    );
  });

  it("rejects a deep traversal that escapes the root", () => {
    expect(() =>
      validatePath("src/../../elsewhere/x.ts", projectRoot),
    ).toThrow(/outside project root/);
  });
});
