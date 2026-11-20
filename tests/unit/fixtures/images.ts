/**
 * The first bytes of each image type a model request can carry. Enough for
 * the type check; none of them is a complete image.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return [...Buffer.from(text, "latin1")];
}

export const PNG_BYTES = bytes(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // The start of an IHDR chunk.
  0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR"),
);

export const JPEG_BYTES = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"));

export const GIF_BYTES = bytes(...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00);

export const WEBP_BYTES = bytes(
  ...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 "),
);
