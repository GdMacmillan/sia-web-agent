/**
 * System-prompt composition helpers (Phase 4).
 *
 * Covers normalizeSystemPrompt (legacy string -> structured config) and
 * assemblePromptParts (prefix/base/suffix joining), which drive how
 * createDeepAgent composes the final system prompt around the base prompt.
 */
import { describe, it, expect } from "@jest/globals";
import {
  normalizeSystemPrompt,
  assemblePromptParts,
} from "../../src/agent.js";

describe("normalizeSystemPrompt", () => {
  it("maps undefined to an empty config", () => {
    expect(normalizeSystemPrompt(undefined)).toEqual({});
  });

  it("maps a plain string to a prefix (legacy behavior)", () => {
    expect(normalizeSystemPrompt("be terse")).toEqual({ prefix: "be terse" });
  });

  it("passes a structured config through unchanged", () => {
    const cfg = { base: "B", suffix: "S" };
    expect(normalizeSystemPrompt(cfg)).toBe(cfg);
  });
});

describe("assemblePromptParts", () => {
  it("joins non-empty parts with a blank line", () => {
    expect(assemblePromptParts(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  });

  it("drops null / undefined / empty parts", () => {
    expect(assemblePromptParts(["a", null, "", undefined, "b"])).toBe(
      "a\n\nb",
    );
  });

  it("returns an empty string when nothing remains", () => {
    expect(assemblePromptParts([null, undefined, ""])).toBe("");
  });
});

describe("prompt composition (prefix/base/suffix around a base prompt)", () => {
  // Mirrors createDeepAgent's assembly: baseSection is the config base, or the
  // built-in base prompt when base is undefined, or "" when base is null.
  const BASE = "BUILTIN_BASE";
  function compose(sp: string | Record<string, unknown> | undefined): string {
    const cfg = normalizeSystemPrompt(sp as any);
    const baseSection = cfg.base === null ? "" : ((cfg.base as string) ?? BASE);
    return assemblePromptParts([
      cfg.prefix as string,
      baseSection,
      cfg.suffix as string,
    ]);
  }

  it("legacy string prompt is placed before the base prompt", () => {
    expect(compose("custom")).toBe("custom\n\nBUILTIN_BASE");
  });

  it("undefined yields just the base prompt", () => {
    expect(compose(undefined)).toBe("BUILTIN_BASE");
  });

  it("base: null removes the base prompt", () => {
    expect(compose({ prefix: "P", base: null, suffix: "S" })).toBe("P\n\nS");
  });

  it("base override replaces the built-in base prompt", () => {
    expect(compose({ base: "REPLACED", suffix: "S" })).toBe("REPLACED\n\nS");
  });
});
