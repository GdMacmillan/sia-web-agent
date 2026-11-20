/**
 * A stand-in PDF parser for unit tests.
 *
 * A fake PDF is `%PDF-1.7\n` followed by a JSON array of page strings; the
 * fake parser reads its pages back out of those bytes. It has the same shape
 * as the slice of the real parser that `src/utils/pdf-text.ts` uses.
 */
import type {
  PdfParser,
  PdfParserLoader,
} from "../../../src/utils/pdf-text.js";

export const PDF_HEADER = "%PDF-1.7\n";

export function fakePdf(pages: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(PDF_HEADER + JSON.stringify(pages), "utf8"));
}

interface FakeOptions {
  /** Called once per parsed document. */
  onParse?: () => void;
  /** Called after each page is read, to move a fake clock. */
  onPage?: (pageNumber: number) => void;
  /** Thrown by the parser instead of returning a document. */
  failure?: unknown;
}

export function fakeLoader(options: FakeOptions = {}): PdfParserLoader {
  const parser: PdfParser = {
    async getDocumentProxy(data) {
      options.onParse?.();
      if (options.failure) throw options.failure;
      const text = Buffer.from(data).toString("utf8").slice(PDF_HEADER.length);
      const pages = JSON.parse(text) as string[];
      return {
        numPages: pages.length,
        async getPage(pageNumber) {
          return {
            async getTextContent() {
              options.onPage?.(pageNumber);
              // One item per line, the way a parser reports line ends.
              const lines = pages[pageNumber - 1].split("\n");
              return {
                items: lines.map((str, index) => ({
                  str,
                  hasEOL: index < lines.length - 1,
                })),
              };
            },
          };
        },
      };
    },
  };
  return async () => parser;
}
