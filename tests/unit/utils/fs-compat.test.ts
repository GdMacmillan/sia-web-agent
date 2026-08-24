import { describe, it, expect } from "@jest/globals";
import { existsSync } from "fs";
import { join, isAbsolute } from "path";
import {
  sanitizePathSegment,
  resolveRipgrep,
} from "../../../src/utils/fs-compat.js";
import { getProjectRoot } from "../../../src/utils/path-utils.js";

/**
 * Recompute the path `resolveRipgrep` should find, using the same
 * `@vscode/ripgrep-<platform>-<arch>/bin/rg` layout the source relies on.
 * Deliberately does not import `@vscode/ripgrep`: that module is ESM-only and
 * throws while evaluating when its platform package is absent.
 */
const PLATFORM_PKG = `@vscode/ripgrep-${process.platform}-${
  process.env.npm_config_arch || process.arch
}`;
const BINARY_NAME = process.platform === "win32" ? "rg.exe" : "rg";

function expectedBundledPath(): string | null {
  for (const root of [getProjectRoot(), process.cwd()].filter(Boolean)) {
    const candidate = join(
      root,
      "node_modules",
      PLATFORM_PKG,
      "bin",
      BINARY_NAME,
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

describe("fs-compat", () => {
  describe("sanitizePathSegment", () => {
    it("leaves safe identifiers unchanged", () => {
      expect(sanitizePathSegment("default")).toBe("default");
      expect(sanitizePathSegment("thread-1_abc")).toBe("thread-1_abc");
    });

    it("replaces colons/dots from an ISO timestamp thread id", () => {
      expect(sanitizePathSegment("2026-07-06T12:00:00.000Z")).toBe(
        "2026-07-06T12_00_00_000Z",
      );
    });

    it("neutralizes traversal sequences", () => {
      expect(sanitizePathSegment("../../etc")).toBe("______etc");
    });

    it("replaces Windows-invalid filename characters", () => {
      expect(sanitizePathSegment('a*b?c"d<e>f|g')).toBe("a_b_c_d_e_f_g");
    });

    it("falls back to a safe segment for empty input", () => {
      expect(sanitizePathSegment("")).toBe("_");
    });
  });

  describe("resolveRipgrep", () => {
    it("returns the bundled path when present, else 'rg'", () => {
      const bundled = expectedBundledPath();
      if (bundled) {
        expect(resolveRipgrep()).toBe(bundled);
      } else {
        expect(resolveRipgrep()).toBe("rg");
      }
    });

    it("resolves an absolute path inside the platform package when bundled", () => {
      const bundled = expectedBundledPath();
      if (!bundled) {
        // No bundled binary on this host; the PATH fallback is covered above.
        return;
      }
      const resolved = resolveRipgrep();
      expect(isAbsolute(resolved)).toBe(true);
      expect(resolved).toContain(PLATFORM_PKG);
      expect(existsSync(resolved)).toBe(true);
    });

    it("always returns a non-empty command string", () => {
      expect(typeof resolveRipgrep()).toBe("string");
      expect(resolveRipgrep().length).toBeGreaterThan(0);
    });
  });
});
