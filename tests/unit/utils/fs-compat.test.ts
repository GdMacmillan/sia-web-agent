import { describe, it, expect } from "@jest/globals";
import { existsSync } from "fs";
// eslint-disable-next-line import/no-extraneous-dependencies
import { rgPath } from "@vscode/ripgrep";
import {
  sanitizePathSegment,
  resolveRipgrep,
} from "../../../src/utils/fs-compat.js";

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
      if (existsSync(rgPath)) {
        expect(resolveRipgrep()).toBe(rgPath);
      } else {
        expect(resolveRipgrep()).toBe("rg");
      }
    });

    it("always returns a non-empty command string", () => {
      expect(typeof resolveRipgrep()).toBe("string");
      expect(resolveRipgrep().length).toBeGreaterThan(0);
    });
  });
});
