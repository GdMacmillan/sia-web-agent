/**
 * Text extraction from PDF files.
 *
 * A PDF is binary, but most carry a text layer, and the text is what a model
 * can read. This module pulls that text out page by page, on this machine,
 * so reading a PDF costs no model call and puts no file bytes into the
 * conversation. A PDF with no text layer (a scan) is reported as such; what
 * happens to it is the caller's decision.
 *
 * The parser is loaded on first use through an injectable loader, so nothing
 * pays for it until a PDF is read and tests can supply their own.
 */

import { createHash } from "node:crypto";
import { LRUCache } from "./lru-cache.js";

/** Largest PDF this module will parse. */
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** Pages extracted from one document; the rest are reported, not read. */
export const PDF_MAX_PAGES = 500;
/** Wall-clock budget for one extraction. */
export const PDF_DEADLINE_MS = 20_000;
/** Characters of PDF text returned by one read; the rest is paged. */
export const PDF_MAX_CHARS_PER_READ = 100_000;
/**
 * Below this many non-whitespace characters per page on average, the
 * document is treated as having no text layer: a scan, perhaps with a page
 * number or a stamp, rather than a document someone typed.
 */
export const PDF_SPARSE_CHARS_PER_PAGE = 16;

/** The header may sit anywhere in the first kilobyte (PDF 1.7, appendix H). */
const PDF_HEADER_WINDOW = 1024;
const PDF_HEADER = "%PDF-";

// ---------------------------------------------------------------------------
// The slice of a PDF parser this module needs
// ---------------------------------------------------------------------------

export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup?(): unknown;
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy?(): unknown;
}

export interface PdfParser {
  getDocumentProxy(data: Uint8Array): Promise<PdfDocument>;
}

export type PdfParserLoader = () => Promise<PdfParser>;

const loadDefaultParser: PdfParserLoader = async () =>
  (await import("unpdf")) as unknown as PdfParser;

let activeLoader: PdfParserLoader = loadDefaultParser;

/** Replace the parser loader, or restore the default with no argument. Test hook. */
export function setPdfParserLoader(loader?: PdfParserLoader): void {
  activeLoader = loader ?? loadDefaultParser;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface PdfText {
  /** Text of each extracted page, in order. */
  pages: string[];
  /** Pages in the document, which may exceed `pages.length`. */
  totalPages: number;
  /** Non-whitespace characters across the extracted pages. */
  textLength: number;
  /** Why extraction stopped before the last page, when it did. */
  partial?: "page-limit" | "deadline";
}

export type PdfTextResult =
  | { ok: true; text: PdfText }
  | { ok: false; error: string };

export interface ExtractPdfTextOptions {
  loader?: PdfParserLoader;
  maxPages?: number;
  deadlineMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** Whether `bytes` starts like a PDF, whatever the file is named. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, PDF_HEADER_WINDOW);
  return Buffer.from(window).toString("latin1").includes(PDF_HEADER);
}

/** A scan: the pages carry (almost) no text of their own. */
export function isSparsePdfText(text: PdfText): boolean {
  if (text.pages.length === 0) return true;
  return text.textLength < text.pages.length * PDF_SPARSE_CHARS_PER_PAGE;
}

class DeadlineError extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new DeadlineError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Characters a text layer can hold that are not text: the C0 controls other
 * than tab, line feed and carriage return, and DEL. A glyph with no Unicode
 * mapping often comes out as U+0000. They are dropped, so what the model reads
 * is printable and can be stored anywhere it is copied to; some stores (a
 * Postgres `jsonb` column, for one) reject U+0000 outright.
 */
// eslint-disable-next-line no-control-regex
const NON_PRINTING = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Half of a surrogate pair with no other half: not a character at all. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `raw` with non-printing characters dropped and broken pairs replaced. */
export function cleanPdfText(raw: string): string {
  return raw.replace(NON_PRINTING, "").replace(LONE_SURROGATE, "\ufffd");
}

function pageText(items: PdfTextItem[]): string {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const str = cleanPdfText(item.str);
    text += item.hasEOL ? `${str}\n` : str;
  }
  return text;
}

function describeFailure(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") {
    return "the PDF is password-protected";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `the PDF could not be parsed (${message})`;
}

/**
 * Parsed text by content hash, so reading a long PDF a window at a time
 * parses it once. Bounded: a handful of documents, each at most the text of
 * {@link PDF_MAX_PAGES} pages.
 */
const extracted = new LRUCache<string, PdfText>({ maxSize: 8 });

/** Forget cached extractions. Test hook. */
export function clearPdfTextCache(): void {
  extracted.clear();
}

/**
 * Extract the text of a PDF, page by page.
 *
 * Never throws: a file that is not a PDF, is too large, is encrypted or does
 * not parse comes back as `{ ok: false, error }`, with `error` phrased to
 * follow "Cannot read '<path>':".
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> {
  const {
    loader = activeLoader,
    maxPages = PDF_MAX_PAGES,
    deadlineMs = PDF_DEADLINE_MS,
    now = Date.now,
  } = options;

  if (bytes.byteLength > PDF_MAX_BYTES) {
    return {
      ok: false,
      error: `the PDF is ${bytes.byteLength} bytes, over the ${PDF_MAX_BYTES}-byte limit`,
    };
  }
  if (!looksLikePdf(bytes)) {
    return { ok: false, error: "the file is named as a PDF but is not one" };
  }

  // Hash before parsing: the parser may take ownership of the buffer.
  const key = createHash("sha256").update(bytes).digest("hex");
  const cached = extracted.get(key);
  if (cached) return { ok: true, text: cached };

  const deadline = now() + deadlineMs;
  let document: PdfDocument | undefined;
  try {
    const parser = await loader();
    document = await within(parser.getDocumentProxy(bytes), deadline - now());

    const totalPages = document.numPages;
    const limit = Math.min(totalPages, maxPages);
    const pages: string[] = [];
    let partial: PdfText["partial"] =
      totalPages > limit ? "page-limit" : undefined;

    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      try {
        const page = await within(
          document.getPage(pageNumber),
          deadline - now(),
        );
        const content = await within(page.getTextContent(), deadline - now());
        pages.push(pageText(content.items));
        page.cleanup?.();
      } catch (error) {
        if (!(error instanceof DeadlineError)) throw error;
        partial = "deadline";
        break;
      }
    }

    if (partial === "deadline" && pages.length === 0) {
      return {
        ok: false,
        error: `the PDF took longer than ${Math.round(deadlineMs / 1000)} s to parse`,
      };
    }

    const textLength = pages.reduce(
      (sum, page) => sum + page.replace(/\s+/g, "").length,
      0,
    );
    const text: PdfText = { pages, totalPages, textLength, partial };
    // A run cut short by the clock may do better next time; do not pin it.
    if (partial !== "deadline") extracted.set(key, text);
    return { ok: true, text };
  } catch (error) {
    if (error instanceof DeadlineError) {
      return {
        ok: false,
        error: `the PDF took longer than ${Math.round(deadlineMs / 1000)} s to parse`,
      };
    }
    return { ok: false, error: describeFailure(error) };
  } finally {
    try {
      await document?.destroy?.();
    } catch {
      // Nothing to release.
    }
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The extracted text as lines, each page introduced by a separator line so a
 * reader paging through by line number always knows which page it is on.
 */
export function pdfTextLines(text: PdfText): string[] {
  const lines: string[] = [];
  text.pages.forEach((page, index) => {
    lines.push(`--- page ${index + 1} of ${text.totalPages} ---`);
    const body = page.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (body) lines.push(...body.split("\n"));
  });
  return lines;
}

export interface PdfTextWindow {
  /** The lines to show. */
  lines: string[];
  /** Index of the first line shown (0-based). */
  start: number;
  /** Index after the last line shown: the offset to continue from. */
  end: number;
  /** Lines in the whole document. */
  total: number;
}

/**
 * The window `[offset, offset + limit)` of `lines`, cut short where it would
 * pass `maxChars`. At least one line is always returned, clipped if it alone
 * is over the cap, so a reader can never be stuck on an oversized line.
 */
export function pdfTextWindow(
  lines: string[],
  offset: number,
  limit: number,
  maxChars: number = PDF_MAX_CHARS_PER_READ,
): PdfTextWindow {
  const start = Math.max(0, Math.floor(offset));
  const hardEnd = Math.min(
    start + Math.max(1, Math.floor(limit)),
    lines.length,
  );
  const selected: string[] = [];
  let chars = 0;
  let end = start;
  while (end < hardEnd) {
    const line = lines[end];
    if (selected.length > 0 && chars + line.length > maxChars) break;
    selected.push(
      line.length > maxChars
        ? `${line.slice(0, maxChars)} [line clipped]`
        : line,
    );
    chars += line.length + 1;
    end++;
  }
  return { lines: selected, start, end, total: lines.length };
}
