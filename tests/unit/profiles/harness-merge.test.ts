/**
 * `mergeHarnessProfile`: folding a component overlay into a resolved profile.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createHarnessProfile,
  mergeHarnessProfile,
  EMPTY_HARNESS_PROFILE,
} from "../../../src/profiles/harness.js";

describe("mergeHarnessProfile", () => {
  it("returns an equivalent frozen profile when both sides are empty", () => {
    const merged = mergeHarnessProfile(EMPTY_HARNESS_PROFILE, EMPTY_HARNESS_PROFILE);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged.baseSystemPrompt).toBeUndefined();
    expect(merged.systemPromptSuffix).toBeUndefined();
    expect(merged.excludedTools.size).toBe(0);
    expect(merged.excludedMiddleware.size).toBe(0);
    expect(Object.keys(merged.toolDescriptionOverrides)).toEqual([]);
  });

  it("unions the excluded tool and middleware sets", () => {
    const base = createHarnessProfile({
      excludedTools: ["a"],
      excludedMiddleware: ["skillsMiddleware"],
    });
    const overlay = createHarnessProfile({
      excludedTools: ["b", "a"],
      excludedMiddleware: ["CodeExecutionMiddleware"],
    });
    const merged = mergeHarnessProfile(base, overlay);
    expect([...merged.excludedTools].sort()).toEqual(["a", "b"]);
    expect([...merged.excludedMiddleware].sort()).toEqual([
      "CodeExecutionMiddleware",
      "skillsMiddleware",
    ]);
  });

  it("joins prompt suffixes with a blank line", () => {
    const base = createHarnessProfile({ systemPromptSuffix: "One." });
    const overlay = createHarnessProfile({ systemPromptSuffix: "Two." });
    expect(mergeHarnessProfile(base, overlay).systemPromptSuffix).toBe(
      "One.\n\nTwo.",
    );
  });

  it("keeps a lone suffix from either side", () => {
    const withSuffix = createHarnessProfile({ systemPromptSuffix: "Only." });
    expect(
      mergeHarnessProfile(withSuffix, EMPTY_HARNESS_PROFILE).systemPromptSuffix,
    ).toBe("Only.");
    expect(
      mergeHarnessProfile(EMPTY_HARNESS_PROFILE, withSuffix).systemPromptSuffix,
    ).toBe("Only.");
  });

  it("lets the overlay win on tool descriptions and base prompt", () => {
    const base = createHarnessProfile({
      baseSystemPrompt: "base",
      toolDescriptionOverrides: { task: "old", bash: "keep" },
    });
    const overlay = createHarnessProfile({
      baseSystemPrompt: "overlay",
      toolDescriptionOverrides: { task: "new" },
    });
    const merged = mergeHarnessProfile(base, overlay);
    expect(merged.baseSystemPrompt).toBe("overlay");
    expect(merged.toolDescriptionOverrides).toEqual({ task: "new", bash: "keep" });
  });

  it("keeps the base prompt when the overlay does not set one", () => {
    const base = createHarnessProfile({ baseSystemPrompt: "base" });
    expect(
      mergeHarnessProfile(base, EMPTY_HARNESS_PROFILE).baseSystemPrompt,
    ).toBe("base");
  });

  it("does not mutate either input", () => {
    const base = createHarnessProfile({ excludedTools: ["a"] });
    const overlay = createHarnessProfile({ excludedTools: ["b"] });
    mergeHarnessProfile(base, overlay);
    expect([...base.excludedTools]).toEqual(["a"]);
    expect([...overlay.excludedTools]).toEqual(["b"]);
  });
});
