/**
 * PDF text extraction.
 *
 * The real parser is an ESM-only package loaded at run time, which the unit
 * runner cannot import, so every case here injects the fake parser from
 * `tests/unit/fixtures/fake-pdf.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  PDF_MAX_BYTES,
  cleanPdfText,
  clearPdfTextCache,
  extractPdfText,
  isSparsePdfText,
  looksLikePdf,
  pdfTextLines,
  pdfTextWindow,
  type PdfText,
} from "../../../src/utils/pdf-text.js";
import { PDF_HEADER as HEADER, fakeLoader, fakePdf } from "../fixtures/fake-pdf.js";

function text(pages: string[], totalPages = pages.length): PdfText {
  return {
    pages,
    totalPages,
    textLength: pages.join("").replace(/\s+/g, "").length,
  };
}

describe("looksLikePdf", () => {
  it("accepts a header at the start or within the first kilobyte", () => {
    expect(looksLikePdf(fakePdf(["x"]))).toBe(true);
    const padded = Buffer.concat([Buffer.alloc(600, 0x20), Buffer.from(HEADER)]);
    expect(looksLikePdf(new Uint8Array(padded))).toBe(true);
  });

  it("rejects bytes with no header, or a header too far in", () => {
    expect(looksLikePdf(new Uint8Array(Buffer.from("PK\u0003\u0004 zip")))).toBe(
      false,
    );
    const late = Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from(HEADER)]);
    expect(looksLikePdf(new Uint8Array(late))).toBe(false);
  });
});

describe("extractPdfText", () => {
  beforeEach(() => clearPdfTextCache());
  afterEach(() => clearPdfTextCache());

  it("returns each page's text and the counts", async () => {
    const result = await extractPdfText(
      fakePdf(["first page\nsecond line", "page two"]),
      { loader: fakeLoader() },
    );
    expect(result).toEqual({
      ok: true,
      text: {
        pages: ["first page\nsecond line", "page two"],
        totalPages: 2,
        textLength: "firstpagesecondlinepagetwo".length,
        partial: undefined,
      },
    });
  });

  it("refuses a file that is not a PDF without loading the parser", async () => {
    let loaded = false;
    const result = await extractPdfText(
      new Uint8Array(Buffer.from("just some text")),
      {
        loader: async () => {
          loaded = true;
          return fakeLoader()();
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: "the file is named as a PDF but is not one",
    });
    expect(loaded).toBe(false);
  });

  it("refuses a file over the size limit", async () => {
    const big = new Uint8Array(PDF_MAX_BYTES + 1);
    big.set(Buffer.from(HEADER));
    const result = await extractPdfText(big, { loader: fakeLoader() });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("over the");
  });

  it("stops at the page limit and says so", async () => {
    const result = await extractPdfText(fakePdf(["one", "two", "three"]), {
      loader: fakeLoader(),
      maxPages: 2,
    });
    expect(result.ok && result.text.pages).toEqual(["one", "two"]);
    expect(result.ok && result.text.totalPages).toBe(3);
    expect(result.ok && result.text.partial).toBe("page-limit");
  });

  it("keeps the pages read before the deadline, and does not cache them", async () => {
    let clock = 0;
    let parses = 0;
    const loader = fakeLoader({
      onParse: () => parses++,
      onPage: () => {
        clock += 400;
      },
    });
    const bytes = fakePdf(["one", "two", "three"]);
    const options = { loader, deadlineMs: 1000, now: () => clock };

    const result = await extractPdfText(bytes, options);
    expect(result.ok && result.text.pages).toEqual(["one", "two"]);
    expect(result.ok && result.text.partial).toBe("deadline");

    clock = 0;
    await extractPdfText(bytes, options);
    expect(parses).toBe(2);
  });

  it("is an error when the deadline passes before any page is read", async () => {
    let clock = 0;
    const loader = fakeLoader({
      onParse: () => {
        clock += 5000;
      },
    });
    const result = await extractPdfText(fakePdf(["one"]), {
      loader,
      deadlineMs: 1000,
      now: () => clock,
    });
    expect(result).toEqual({
      ok: false,
      error: "the PDF took longer than 1 s to parse",
    });
  });

  it("names a password-protected PDF", async () => {
    const failure = Object.assign(new Error("No password given"), {
      name: "PasswordException",
    });
    const result = await extractPdfText(fakePdf(["x"]), {
      loader: fakeLoader({ failure }),
    });
    expect(result).toEqual({
      ok: false,
      error: "the PDF is password-protected",
    });
  });

  it("reports a parser failure as text, never by throwing", async () => {
    const result = await extractPdfText(fakePdf(["x"]), {
      loader: fakeLoader({ failure: new Error("bad xref") }),
    });
    expect(result).toEqual({
      ok: false,
      error: "the PDF could not be parsed (bad xref)",
    });
  });

  it("parses the same bytes once", async () => {
    let parses = 0;
    const loader = fakeLoader({ onParse: () => parses++ });
    const bytes = fakePdf(["same"]);
    await extractPdfText(bytes, { loader });
    await extractPdfText(fakePdf(["same"]), { loader });
    expect(parses).toBe(1);
    await extractPdfText(fakePdf(["different"]), { loader });
    expect(parses).toBe(2);
  });
});

describe("isSparsePdfText", () => {
  it("treats a document with almost no text per page as a scan", () => {
    expect(isSparsePdfText(text(["", "", ""]))).toBe(true);
    // A page number on each page is not a text layer.
    expect(isSparsePdfText(text(["1", "2", "3"]))).toBe(true);
    expect(isSparsePdfText(text([]))).toBe(true);
  });

  it("treats ordinary text as text", () => {
    expect(isSparsePdfText(text(["The quarterly total is 42 units."]))).toBe(
      false,
    );
  });
});

describe("pdfTextLines", () => {
  it("introduces each page with a separator and trims trailing blank lines", () => {
    expect(pdfTextLines(text(["a\nb\n\n", "", "c"], 5))).toEqual([
      "--- page 1 of 5 ---",
      "a",
      "b",
      "--- page 2 of 5 ---",
      "--- page 3 of 5 ---",
      "c",
    ]);
  });
});

describe("pdfTextWindow", () => {
  const lines = ["aaaa", "bbbb", "cccc", "dddd"];

  it("returns the requested lines and where to continue", () => {
    expect(pdfTextWindow(lines, 1, 2)).toEqual({
      lines: ["bbbb", "cccc"],
      start: 1,
      end: 3,
      total: 4,
    });
  });

  it("stops early at the character cap", () => {
    const window = pdfTextWindow(lines, 0, 10, 9);
    expect(window.lines).toEqual(["aaaa", "bbbb"]);
    expect(window.end).toBe(2);
  });

  it("always returns one line, clipped when it alone is over the cap", () => {
    const window = pdfTextWindow(["x".repeat(50), "next"], 0, 10, 10);
    expect(window.lines).toEqual([`${"x".repeat(10)} [line clipped]`]);
    expect(window.end).toBe(1);
  });
});

describe("cleanPdfText", () => {
  const NUL = String.fromCharCode(0);

  it("drops NUL and the other non-printing controls, keeping tab and line ends", () => {
    expect(cleanPdfText(`a${NUL}b\u0001c\u001fd\u007fe`)).toBe("abcde");
    expect(cleanPdfText("col\tcol\r\nnext\n")).toBe("col\tcol\r\nnext\n");
  });

  it("replaces a lone surrogate and keeps a well-formed pair", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    expect(cleanPdfText(`x${high}y${low}z\u{1F600}`)).toBe(
      "x\ufffdy\ufffdz\u{1F600}",
    );
  });

  it("leaves ordinary text, accents and the typed text \\u0000 alone", () => {
    const plain = "Quote — café, \\u0000 as written";
    expect(cleanPdfText(plain)).toBe(plain);
  });
});

describe("extractPdfText cleans what the parser returns", () => {
  beforeEach(() => clearPdfTextCache());
  afterEach(() => clearPdfTextCache());

  it("returns pages with no NUL, and counts only what is left", async () => {
    const NUL = String.fromCharCode(0);
    const result = await extractPdfText(
      fakePdf([`Total${NUL}${NUL} 42\nnext${NUL}line`]),
      { loader: fakeLoader() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.pages).toEqual(["Total 42\nnextline"]);
    expect(result.text.textLength).toBe("Total42nextline".length);
  });

  it("replaces a lone surrogate the parser hands back", async () => {
    const lone = String.fromCharCode(0xd835);
    const loader = async () => ({
      async getDocumentProxy() {
        return {
          numPages: 1,
          async getPage() {
            return {
              async getTextContent() {
                return { items: [{ str: `x${lone}y` }] };
              },
            };
          },
        };
      },
    });
    const result = await extractPdfText(fakePdf(["unused"]), { loader });
    expect(result.ok && result.text.pages).toEqual(["x\ufffdy"]);
  });
});
