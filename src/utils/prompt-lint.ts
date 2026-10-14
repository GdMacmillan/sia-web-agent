/**
 * Prompt lint — the deterministic checks every prompt file is held to,
 * shared by the unit tests (run on the shipped prompts) and by the built-in
 * contract of a prompt component (run on a proposed version).
 *
 * One definition, two callers: a rule kept in a test and a copy of it kept
 * at runtime would drift apart, which is exactly what these checks exist to
 * stop.
 */

/** Sentences shorter than this never count as a duplicate. */
export const MIN_DUPLICATE_SENTENCE_WORDS = 6;

/** Normalize a sentence: lower case, letters/digits only, single spaces. */
export function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split markdown into normalized sentences of at least
 * `MIN_DUPLICATE_SENTENCE_WORDS` words. Fenced code is ignored, and list
 * markers and heading marks are stripped, so short shared phrases ("Use
 * it.", headings) never count.
 */
export function sentencesOf(markdown: string): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, " ");
  return prose
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|#+)\s+/, ""))
    .map(normalizeSentence)
    .filter((s) => s.split(" ").length >= MIN_DUPLICATE_SENTENCE_WORDS);
}

/** One prompt text and the label a duplicate report names it by. */
export interface LabelledText {
  label: string;
  text: string;
}

/**
 * Every sentence stated more than once across `texts`, in input order, as
 * `<first label> and <second label>: "<sentence>"`. Empty when each rule
 * has one home.
 */
export function findDuplicateSentences(
  texts: readonly LabelledText[],
): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const { label, text } of texts) {
    for (const sentence of sentencesOf(text)) {
      const first = seen.get(sentence);
      if (first !== undefined) {
        duplicates.push(`${first} and ${label}: "${sentence}"`);
      } else {
        seen.set(sentence, label);
      }
    }
  }
  return duplicates;
}

/** Whether every ``` fence in `markdown` is closed. */
export function hasBalancedFences(markdown: string): boolean {
  const fences = markdown.split(/\r?\n/).filter((line) => /^\s*```/.test(line));
  return fences.length % 2 === 0;
}

/**
 * Why `text` is not plain text a prompt or skill may carry, or null when it
 * is: no byte-order mark, no NUL, no control character other than newline,
 * carriage return and tab.
 */
export function plainTextProblem(text: string): string | null {
  if (text.charCodeAt(0) === 0xfeff) {
    return "starts with a byte-order mark";
  }
  // eslint-disable-next-line no-control-regex
  const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  if (control !== null) {
    const code = control[0].charCodeAt(0).toString(16).padStart(4, "0");
    return `contains control character U+${code}`;
  }
  return null;
}

/** The text of one `## ` section of a markdown file, heading excluded; "" when absent. */
export function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start === -1) return "";
  const body = markdown.slice(start + heading.length + 4);
  const end = body.search(/^## /m);
  return end === -1 ? body : body.slice(0, end);
}
