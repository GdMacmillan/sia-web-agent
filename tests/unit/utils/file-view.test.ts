/**
 * File view helpers: the artifact guard, the type check on bytes and the
 * marker wording `read_file` returns for a file that is shown, not read.
 */

import { describe, it, expect } from "@jest/globals";
import {
  IMAGE_MAX_BYTES,
  imageMarker,
  imageTooLargeMarker,
  isFileViewArtifact,
  scanMarker,
  scanTooLargeMarker,
  sniffImageType,
} from "../../../src/utils/file-view.js";
import { JPEG_BYTES, GIF_BYTES, PNG_BYTES, WEBP_BYTES } from "../fixtures/images.js";

describe("sniffImageType", () => {
  it("names each viewable type from its first bytes", () => {
    expect(sniffImageType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageType(GIF_BYTES)).toBe("image/gif");
    expect(sniffImageType(WEBP_BYTES)).toBe("image/webp");
  });

  it("answers undefined for anything else", () => {
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
    expect(sniffImageType(Buffer.from("<svg xmlns='x'/>"))).toBeUndefined();
    expect(sniffImageType(Buffer.from("%PDF-1.7\n"))).toBeUndefined();
    // "RIFF" alone is not WebP: a WAV file starts the same way.
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBeUndefined();
    // A truncated PNG signature.
    expect(sniffImageType(PNG_BYTES.subarray(0, 4))).toBeUndefined();
  });
});

describe("isFileViewArtifact", () => {
  it("accepts the two kinds read_file produces", () => {
    expect(
      isFileViewArtifact({ kind: "image", path: "/a.png", mimeType: "image/png", size: 10 }),
    ).toBe(true);
    expect(
      isFileViewArtifact({
        kind: "pdf-scan",
        path: "/a.pdf",
        mimeType: "application/pdf",
        size: 10,
        pages: 3,
      }),
    ).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isFileViewArtifact(undefined)).toBe(false);
    expect(isFileViewArtifact(null)).toBe(false);
    expect(isFileViewArtifact("image")).toBe(false);
    expect(isFileViewArtifact({ kind: "video", path: "/a", mimeType: "x", size: 1 })).toBe(false);
    expect(isFileViewArtifact({ kind: "image", path: "", mimeType: "x", size: 1 })).toBe(false);
    expect(isFileViewArtifact({ kind: "image", path: "/a", mimeType: "x" })).toBe(false);
    expect(isFileViewArtifact({ kind: "image", path: 7, mimeType: "x", size: 1 })).toBe(false);
  });
});

describe("markers", () => {
  const markers = [
    imageMarker("/shots/a.png", "image/png", 2048),
    imageTooLargeMarker("/shots/a.png", "image/png", IMAGE_MAX_BYTES + 1),
    scanMarker("/docs/scan.pdf", 3),
    scanTooLargeMarker("/docs/scan.pdf", 45),
  ];

  it("say what the file is and when it can be seen", () => {
    expect(markers[0]).toBe(
      "[image '/shots/a.png': image/png, 2048 bytes — shown after this result for this turn only; read the file again to see it in a later turn]",
    );
    expect(markers[1]).toBe(
      `[image '/shots/a.png': image/png, ${IMAGE_MAX_BYTES + 1} bytes — too large to show (limit 3 MiB)]`,
    );
    expect(markers[2]).toBe(
      "[PDF '/docs/scan.pdf': 3 page(s) with no text layer (scanned images) — the pages are shown after this result for this turn only; read the file again to see it in a later turn]",
    );
    expect(markers[3]).toBe(
      "[PDF '/docs/scan.pdf': 45 page(s) with no text layer (scanned images) — too large to show (limits: 30 pages, 10 MiB), and there is no text to extract]",
    );
  });

  it("never read as a failed tool call", () => {
    // The words an outcome check treats as a tool error.
    const errorWords = /error|failed|exception|not found|permission denied|timed out/i;
    for (const marker of markers) {
      expect(marker).not.toMatch(errorWords);
    }
  });
});
