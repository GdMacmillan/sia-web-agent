/**
 * End-of-line (EOL) helpers.
 *
 * File content authored on Windows is checked out with CRLF (`\r\n`) line
 * endings, while snippets produced by the model use LF (`\n`). Matching and
 * replacement must happen on a single normalized form, then the file's original
 * line-ending style is restored so we never silently rewrite CRLF files as LF
 * (or mix the two).
 */

/** Supported end-of-line styles. */
export type Eol = "\r\n" | "\n";

/**
 * Detect the dominant end-of-line style of a string.
 *
 * Counts CRLF pairs against bare LFs; ties (and empty input) resolve to LF.
 *
 * @param content - The text to inspect
 * @returns The dominant EOL style
 */
export function detectEol(content: string): Eol {
  const crlf = (content.match(/\r\n/g) || []).length;
  const totalLf = (content.match(/\n/g) || []).length;
  const bareLf = totalLf - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}

/**
 * Normalize all line endings to LF.
 *
 * @param content - The text to normalize
 * @returns The text with every CRLF collapsed to LF
 */
export function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Convert LF-normalized text to the given EOL style.
 *
 * Input is normalized to LF first so the result has uniform line endings even
 * if the source was mixed.
 *
 * @param content - LF-or-mixed text
 * @param eol - Target EOL style
 * @returns The text with every line ending set to `eol`
 */
export function toEol(content: string, eol: Eol): string {
  const lf = toLf(content);
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}
