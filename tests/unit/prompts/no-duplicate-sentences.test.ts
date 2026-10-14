/**
 * No rule is stated twice across the prompt files.
 *
 * Every agent prompt is assembled from its own file plus the shared
 * fragment (and, where it applies, the web-search notice), so a sentence
 * repeated across files reaches the model twice and the two copies drift
 * apart over time. Each rule has one home.
 *
 * Deterministic by construction: text is normalized (case, punctuation,
 * whitespace), fenced code is ignored, and only sentences of six or more
 * words are compared, so short shared phrases ("Use it.", headings) never
 * count as a duplicate.
 */
import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findDuplicateSentences,
  normalizeSentence,
  sentencesOf,
} from "../../../src/utils/prompt-lint.js";

const PROMPTS_DIR = join(process.cwd(), "prompts");

function promptFiles(): string[] {
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

describe("prompt files", () => {
  it("normalizes case, punctuation and whitespace before comparing", () => {
    expect(normalizeSentence("You MUST report  what\nhappened.")).toBe(
      normalizeSentence("you must report what happened"),
    );
    expect(sentencesOf("Too short to count. Use it.")).toEqual([]);
  });

  it("covers every prompt file, fragments included", () => {
    const files = promptFiles();
    for (const name of [
      "manager.md",
      "planner.md",
      "researcher.md",
      "answer.md",
      "shared.md",
      "no-web-search.md",
    ]) {
      expect(files).toContain(name);
    }
  });

  it("state no sentence of six or more words twice", () => {
    const texts = promptFiles().map((file) => ({
      label: file,
      text: readFileSync(join(PROMPTS_DIR, file), "utf-8"),
    }));

    expect(findDuplicateSentences(texts)).toEqual([]);
  });
});
