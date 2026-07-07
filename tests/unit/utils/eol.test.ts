import { describe, it, expect } from "@jest/globals";
import { detectEol, toLf, toEol } from "../../../src/utils/eol.js";

describe("eol helpers", () => {
  describe("detectEol", () => {
    it("detects CRLF when it dominates", () => {
      expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
    });

    it("detects LF when it dominates", () => {
      expect(detectEol("a\nb\nc")).toBe("\n");
    });

    it("defaults to LF for empty or newline-free content", () => {
      expect(detectEol("")).toBe("\n");
      expect(detectEol("single line")).toBe("\n");
    });

    it("does not miscount bare LF as CRLF", () => {
      // 1 CRLF vs 2 bare LF => LF dominates.
      expect(detectEol("a\r\nb\nc\nd")).toBe("\n");
    });
  });

  describe("toLf", () => {
    it("collapses CRLF to LF", () => {
      expect(toLf("a\r\nb\r\n")).toBe("a\nb\n");
    });

    it("leaves LF content unchanged", () => {
      expect(toLf("a\nb\n")).toBe("a\nb\n");
    });
  });

  describe("toEol", () => {
    it("restores CRLF uniformly", () => {
      expect(toEol("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
    });

    it("normalizes mixed input before applying the target EOL", () => {
      expect(toEol("a\r\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
      expect(toEol("a\r\nb\nc", "\n")).toBe("a\nb\nc");
    });

    it("is a no-op round trip for LF", () => {
      expect(toEol("a\nb", "\n")).toBe("a\nb");
    });
  });
});
