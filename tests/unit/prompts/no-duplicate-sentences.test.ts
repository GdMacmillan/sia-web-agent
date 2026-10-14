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

const PROMPTS_DIR = join(process.cwd(), "prompts");
const MIN_WORDS = 6;

/** Normalize a sentence: lower case, letters/digits only, single spaces. */
function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split markdown into normalized sentences of at least `MIN_WORDS` words. */
function sentencesOf(markdown: string): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, " ");
  return prose
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|#+)\s+/, ""))
    .map(normalizeSentence)
    .filter((s) => s.split(" ").length >= MIN_WORDS);
}

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
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const file of promptFiles()) {
      const text = readFileSync(join(PROMPTS_DIR, file), "utf-8");
      for (const sentence of sentencesOf(text)) {
        const first = seen.get(sentence);
        if (first) duplicates.push(`${first} and ${file}: "${sentence}"`);
        else seen.set(sentence, file);
      }
    }

    expect(duplicates).toEqual([]);
  });
});
