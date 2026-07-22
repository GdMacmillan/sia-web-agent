/**
 * Harness profiles (Phase 5): construction guard, resolver, serialization.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createHarnessProfile,
  parseHarnessProfileConfig,
  serializeProfile,
  EMPTY_HARNESS_PROFILE,
  REQUIRED_MIDDLEWARE_NAMES,
} from "../../../src/profiles/harness.js";
import {
  resolveHarnessProfile,
  builtinProfileNames,
} from "../../../src/profiles/builtins.js";

describe("createHarnessProfile", () => {
  it("produces a frozen no-op profile from empty options", () => {
    const p = createHarnessProfile();
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.excludedTools.size).toBe(0);
    expect(p.excludedMiddleware.size).toBe(0);
    expect(p.baseSystemPrompt).toBeUndefined();
  });

  it("narrows array fields to Sets", () => {
    const p = createHarnessProfile({
      excludedTools: ["execute_code", "web_search"],
      excludedMiddleware: ["skillsMiddleware"],
    });
    expect(p.excludedTools.has("execute_code")).toBe(true);
    expect(p.excludedMiddleware.has("skillsMiddleware")).toBe(true);
  });

  it("rejects excluding required scaffolding middleware", () => {
    for (const required of REQUIRED_MIDDLEWARE_NAMES) {
      expect(() =>
        createHarnessProfile({ excludedMiddleware: [required] }),
      ).toThrow(/required middleware/);
    }
  });

  it("rejects class-path and underscore-prefixed exclusion names", () => {
    expect(() =>
      createHarnessProfile({ excludedMiddleware: ["module:Class"] }),
    ).toThrow(/class-path/);
    expect(() =>
      createHarnessProfile({ excludedMiddleware: ["_Private"] }),
    ).toThrow(/underscore/);
    expect(() =>
      createHarnessProfile({ excludedMiddleware: ["   "] }),
    ).toThrow(/non-empty/);
  });
});

describe("resolveHarnessProfile", () => {
  it("matches Anthropic Claude model strings (OpenRouter style)", () => {
    const p = resolveHarnessProfile("anthropic/claude-sonnet-4-6");
    expect(p.systemPromptSuffix).toContain("use_parallel_tool_calls");
  });

  it("returns the empty profile for unmatched models", () => {
    expect(resolveHarnessProfile("openai/gpt-5.1")).toBe(EMPTY_HARNESS_PROFILE);
  });

  it("HARNESS_PROFILE=off disables profiles even for a matching model", () => {
    expect(
      resolveHarnessProfile("anthropic/claude-sonnet-4-6", "off"),
    ).toBe(EMPTY_HARNESS_PROFILE);
  });

  it("selects a built-in by explicit name", () => {
    const name = builtinProfileNames()[0];
    const p = resolveHarnessProfile("openai/gpt-5.1", name);
    expect(p.systemPromptSuffix).toContain("use_parallel_tool_calls");
  });

  it("falls back to empty for an unknown override name", () => {
    expect(resolveHarnessProfile("anthropic/claude-sonnet-4-6", "nope")).toBe(
      EMPTY_HARNESS_PROFILE,
    );
  });
});

describe("serialization", () => {
  it("round-trips a profile through serialize -> parse", () => {
    const original = createHarnessProfile({
      systemPromptSuffix: "Think step by step.",
      toolDescriptionOverrides: { task: "delegate work" },
      excludedTools: ["execute_code"],
      excludedMiddleware: ["skillsMiddleware"],
    });
    const json = serializeProfile(original);
    // JSON-safe (survives stringify/parse).
    const reparsed = parseHarnessProfileConfig(JSON.parse(JSON.stringify(json)));
    expect(reparsed.systemPromptSuffix).toBe("Think step by step.");
    expect(reparsed.toolDescriptionOverrides.task).toBe("delegate work");
    expect([...reparsed.excludedTools]).toEqual(["execute_code"]);
    expect([...reparsed.excludedMiddleware]).toEqual(["skillsMiddleware"]);
  });

  it("omits empty/undefined fields when serializing", () => {
    expect(serializeProfile(createHarnessProfile())).toEqual({});
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() =>
      parseHarnessProfileConfig({ systemPromptSuffix: "x", bogus: 1 }),
    ).toThrow();
  });

  it("rejects prototype-pollution keys at any depth", () => {
    expect(() =>
      parseHarnessProfileConfig({ toolDescriptionOverrides: { ["__proto__"]: "x" } }),
    ).toThrow(/dangerous key/);
    expect(() =>
      parseHarnessProfileConfig(JSON.parse('{"__proto__": {"polluted": true}}')),
    ).toThrow(/dangerous key/);
  });
});
