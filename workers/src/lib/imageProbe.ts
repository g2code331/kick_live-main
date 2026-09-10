/**
 * Phase 6: "what is this file, actually" — with no dependency.
 *
 * The rule this module exists to enforce is Step 16's smallest and most
 * important item: a client's declared content type is an opinion, so a type is
 * accepted only when the first bytes of the body say so. Everything here reads
 * signatures out of the header block and nothing here trusts a filename, an
 * extension, a `Content-Type`, or a field the form carried.
 *
 * Why the dimensions come out of the header too: R2 cannot answer "how big is
 * this image" without downloading it, and the registry wants width/height on
 * write so the frontend can reserve layout space and a replacement cannot shrink
 * a hero into a blur. Parsing the four formats the app accepts is about eighty
 * lines and no install; a dependency that also decodes pixels would be the
 * wrong trade inside a Worker.
 *
 * SVG is rejected outright rather than "handled carefully". An SVG is a document
 * that can carry a script, and every asset is served from the app's own origin
 * for cache reasons — so a stored SVG is a stored same-origin page.
 */

export interface ProbeResult {
  /** Sniffed MIME type, or null when the bytes match nothing accepted. */
  readonly mime: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** What the sniffing refused, in a form safe to show a client. Never a byte
   *  dump: an error that echoes the beginning of an upload turns an error
   *  display into an exfiltration channel. */
  readonly reason?: string;
}

const MAX_DIMENSION = 8192;
/** 40 megapixels is above any phone camera that will ever post here and far below
 *  the point where a decode of a "small file" becomes an allocation problem
 *  (a 1x1 PNG can declare 100000x100000). */
const MAX_PIXELS = 40_000_000;

export function probeImage(bytes: Uint8Array): ProbeResult {
  if (bytes.length < 12) return { mime: null, width: null, height: null, reason: "TOO_SMALL" };
  if (looksLikeTextMarkup(bytes)) return { mime: null, width: null, height: null, reason: "MARKUP_REJECTED" };
  if (isPng(bytes)) return withBounds(pngDimensions(bytes), "image/png");
  if (isJpeg(bytes)) {
    const dims = jpegDimensions(bytes);
    return dims ? withBounds(dims, "image/jpeg") : { mime: "image/jpeg", width: null, height: null, reason: "DIMENSIONS_UNAVAILABLE" };
  }
  if (isGif(bytes)) return withBounds(gifDimensions(bytes), "image/gif");
  if (isWebp(bytes)) {
    const dims = webpDimensions(bytes);
    return dims ? withBounds(dims, "image/webp") : { mime: "image/webp", width: null, height: null, reason: "DIMENSIONS_UNAVAILABLE" };
  }
  return { mime: null, width: null, height: null, reason: "UNSUPPORTED_TYPE" };
}

/** `MARKUP_REJECTED` and `UNSUPPORTED_TYPE` are different refusals for a reason:
 *  one tells the user "this is a document, not a picture", and the other says
 *  "this is not a format we store". Collapsing them produces a support ticket
 *  that cannot be answered from the error alone. */
export function refusalIsClientSide(reason: string | undefined): boolean {
  return reason === "TOO_SMALL" || reason === "MARKUP_REJECTED" || reason === "UNSUPPORTED_TYPE" || reason === "DIMENSIONS_UNAVAILABLE";
}

function withBounds(dims: { width: number; height: number } | null, mime: string): ProbeResult {
  if (!dims) return { mime, width: null, height: null, reason: "DIMENSIONS_UNAVAILABLE" };
  const { width, height } = dims;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { mime, width: null, height: null, reason: "DIMENSIONS_UNAVAILABLE" };
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return { mime, width, height, reason: "TOO_MANY_PIXELS" };
  }
  if (width * height > MAX_PIXELS) return { mime, width, height, reason: "TOO_MANY_PIXELS" };
  return { mime, width, height };
}

/** Any of the accepted formats' leading bytes appearing after an opening tag:
 *  a polyglot file that a browser sniffs as HTML and an image library sniffs as
 *  an image is the classic stored-XSS shape, so markup wins the argument by
 *  being rejected first. */
function looksLikeTextMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 512))
    .replace(/^[\s\uFEFF]+/, "")
    .toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<?xml");
}

function u8(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0;
}
function be32(bytes: Uint8Array, at: number): number {
  return u8(bytes, at) * 0x1000000 + (u8(bytes, at + 1) << 16) + (u8(bytes, at + 2) << 8) + u8(bytes, at + 3);
}
function be16(bytes: Uint8Array, at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}
function le16(bytes: Uint8Array, at: number): number {
  return (u8(bytes, at + 1) << 8) | u8(bytes, at);
}
function tag(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (u8(bytes, at + i) !== text.charCodeAt(i)) return false;
  return true;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    u8(bytes, 0) === 0x89 && u8(bytes, 1) === 0x50 && u8(bytes, 2) === 0x4e && u8(bytes, 3) === 0x47 && u8(bytes, 4) === 0x0d && u8(bytes, 5) === 0x0a && u8(bytes, 6) === 0x1a && u8(bytes, 7) === 0x0a
  );
}
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // IHDR is always the first chunk: length(4) "IHDR" width(4) height(4).
  if (!tag(bytes, 12, "IHDR")) return null;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

function isGif(bytes: Uint8Array): boolean {
  return tag(bytes, 0, "GIF87a") || tag(bytes, 0, "GIF89a");
}
function gifDimensions(bytes: Uint8Array): { width: number; height: number } {
  return { width: le16(bytes, 6), height: le16(bytes, 8) };
}

function isJpeg(bytes: Uint8Array): boolean {
  return u8(bytes, 0) === 0xff && u8(bytes, 1) === 0xd8;
}
/**
 * Walk the marker segments until an SOF is found. `0xFFD8` alone is not an
 * image — a truncated file has a start and no frames, and returning null for it
 * is what "we could not tell" means. Standalone markers (RST, SOI, EOI) carry no
 * length, which is the bug every hand-written JPEG walker has at least once.
 */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (u8(bytes, at) !== 0xff) {
      at += 1;
      continue;
    }
    const marker = u8(bytes, at + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = be16(bytes, at + 2);
    if (isSof) {
      return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
    }
    if (marker === 0xd9) return null; // EOI: no SOF before the end of the scan
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function isWebp(bytes: Uint8Array): boolean {
  return tag(bytes, 0, "RIFF") && tag(bytes, 8, "WEBP");
}
/** Three container flavours under one FourCC prefix; only VP8X states a canvas
 *  size unambiguously, so the other two are parsed from their own headers. */
function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = be32(bytes, at + 4);
    if (tag(bytes, at, "VP8X")) {
      return { width: 1 + (u8(bytes, at + 12) | (u8(bytes, at + 13) << 8) | (u8(bytes, at + 14) << 16)), height: 1 + (u8(bytes, at + 15) | (u8(bytes, at + 16) << 8) | (u8(bytes, at + 17) << 16)) };
    }
    if (tag(bytes, at, "VP8L")) {
      // Lossless: a 0x2f signature byte, then 32 bits little-endian holding
      // width-1 (14 bits) and height-1 (14 bits).
      const data = at + 8;
      if (u8(bytes, data) !== 0x2f) return null;
      const bits = (u8(bytes, data + 1) | (u8(bytes, data + 2) << 8) | (u8(bytes, data + 3) << 16) | (u8(bytes, data + 4) << 24)) >>> 0;
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (tag(bytes, at, "VP8 ")) {
      // Lossy: a 3-byte frame tag whose low bit of the first byte marks an
      // interframe, then for a keyframe the 9D 01 2A start code and two 14-bit
      // sizes. Reading the start code only at its expected offset matters: a
      // byte search would find 0x9d inside the macroblock data of any file.
      const data = at + 8;
      const isKeyframe = (u8(bytes, data) & 0x01) === 0;
      if (!isKeyframe || u8(bytes, data + 3) !== 0x9d || u8(bytes, data + 4) !== 0x01 || u8(bytes, data + 5) !== 0x2a) return null;
      return { width: le16(bytes, data + 6) & 0x3fff, height: le16(bytes, data + 8) & 0x3fff };
    }
    if (size < 0) return null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/** SHA-256 over the bytes that were actually read. `crypto.subtle` is async, so
 *  the caller awaits this before the reservation rather than after the write:
 *  the digest is what the dedupe decision is made from. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const probeLimits = { maxDimension: MAX_DIMENSION, maxPixels: MAX_PIXELS };
