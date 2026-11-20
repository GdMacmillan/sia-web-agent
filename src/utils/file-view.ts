/**
 * Files a model looks at rather than reads: images, and PDFs that are scans.
 *
 * `read_file` cannot return these as text, and their bytes must never be
 * stored in the conversation. So the tool returns a short marker string plus
 * a small artifact naming the file, and the file-view middleware attaches the
 * file itself to the outgoing model request. This module holds what the two
 * share: the artifact, the limits, the type check on the bytes and the
 * marker wording.
 */

/** Largest image attached to a model request. */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Most images attached to one model request. */
export const IMAGES_PER_REQUEST = 4;
/** Largest scanned PDF attached to a model request. */
export const SCAN_MAX_BYTES = 10 * 1024 * 1024;
/** Most pages in a scanned PDF attached to a model request. */
export const SCAN_MAX_PAGES = 30;
/** Most scanned PDFs attached to one model request. */
export const SCANS_PER_REQUEST = 1;

/** The image types a model request can carry. */
export const VIEWABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ViewableImageType = (typeof VIEWABLE_IMAGE_TYPES)[number];

/**
 * What `read_file` attaches to its result for a file to be shown. It names
 * the file and nothing more: the bytes are read again, through the same
 * backend, when a model request is built.
 */
export interface FileViewArtifact {
  kind: "image" | "pdf-scan";
  /** The path as it was given to `read_file`. */
  path: string;
  mimeType: string;
  /** Size in bytes when the file was read. */
  size: number;
  /** Page count, for a scanned PDF. */
  pages?: number;
}

export function isFileViewArtifact(value: unknown): value is FileViewArtifact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "image" || candidate.kind === "pdf-scan") &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number"
  );
}

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((byte, index) => bytes[at + index] === byte);
}

/**
 * The image type the bytes actually are, or `undefined` when they are not
 * one of the viewable types. The file name is not trusted: a mislabelled
 * file would make a provider refuse the whole request.
 */
export function sniffImageType(bytes: Uint8Array): ViewableImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // "GIF87a" / "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  // "RIFF" <size> "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return undefined;
}

function mebibytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

const THIS_TURN_ONLY =
  "for this turn only; read the file again to see it in a later turn";

/** The `read_file` result for an image that will be shown. */
export function imageMarker(path: string, mimeType: string, size: number): string {
  return `[image '${path}': ${mimeType}, ${size} bytes — shown after this result ${THIS_TURN_ONLY}]`;
}

/** The `read_file` result for an image over the size limit. */
export function imageTooLargeMarker(
  path: string,
  mimeType: string,
  size: number,
): string {
  return `[image '${path}': ${mimeType}, ${size} bytes — too large to show (limit ${mebibytes(IMAGE_MAX_BYTES)})]`;
}

/** The `read_file` result for a scanned PDF that will be shown. */
export function scanMarker(path: string, pages: number): string {
  return `[PDF '${path}': ${pages} page(s) with no text layer (scanned images) — the pages are shown after this result ${THIS_TURN_ONLY}]`;
}

/** The `read_file` result for a scanned PDF over a limit. */
export function scanTooLargeMarker(path: string, pages: number): string {
  return `[PDF '${path}': ${pages} page(s) with no text layer (scanned images) — too large to show (limits: ${SCAN_MAX_PAGES} pages, ${mebibytes(SCAN_MAX_BYTES)}), and there is no text to extract]`;
}
