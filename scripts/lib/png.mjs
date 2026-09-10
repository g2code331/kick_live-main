/**
 * Pure-JS PNG reader/writer, good enough for the icon pipeline (no native deps, no sharp).
 *
 * Supported: 8-bit RGB / RGBA / grayscale+alpha, non-interlaced, filters 0-4, zlib idat.
 * Anything else throws with a clear message — `branding.mjs` then reports "cannot derive, ship
 * the file by hand" instead of writing a corrupt icon.
 */

import zlib from "node:zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Cheap header read (used by the manifest/icon dimension assertions). */
export function readPngHeader(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("not a PNG file");
  const ihdrStart = 8;
  const length = buf.readUInt32BE(ihdrStart);
  if (buf.toString("ascii", ihdrStart + 4, ihdrStart + 8) !== "IHDR") throw new Error("missing IHDR");
  const start = ihdrStart + 8;
  return {
    width: buf.readUInt32BE(start),
    height: buf.readUInt32BE(start + 4),
    bitDepth: buf[start + 8],
    colorType: buf[start + 9],
    compression: buf[start + 10],
    filter: buf[start + 11],
    interlace: buf[start + 12],
    ihdrLength: length,
  };
}

export function pngDimensions(file, fs) {
  const buf = fs.readFileSync(file);
  try {
    const h = readPngHeader(buf);
    return { ok: true, width: h.width, height: h.height, bitDepth: h.bitDepth, colorType: h.colorType, interlace: h.interlace, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err.message, bytes: buf.length };
  }
}

function colorTypeChannels(colorType) {
  switch (colorType) {
    case 0:
      return { channels: 1, alpha: false };
    case 2:
      return { channels: 3, alpha: false };
    case 3:
      return { channels: 1, alpha: false, palette: true };
    case 4:
      return { channels: 2, alpha: true };
    case 6:
      return { channels: 4, alpha: true };
    default:
      throw new Error(`unsupported PNG color type ${String(colorType)}`);
  }
}

export function decodePng(buf) {
  const header = readPngHeader(buf);
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${String(header.bitDepth)} (only 8 is supported)`);
  if (header.interlace !== 0) throw new Error("interlaced (Adam7) PNGs are not supported");
  const { channels, alpha, palette } = colorTypeChannels(header.colorType);

  const idat = [];
  let offset = 8;
  let paletteData = null;
  let trns = null;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "PLTE") paletteData = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  if (idat.length === 0) throw new Error("no IDAT chunks");
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const { width, height } = header;
  const bpp = palette ? 1 : channels;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);

  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    unfilter(filterType, line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      if (palette) {
        const idx = line[src];
        out[dst] = paletteData ? paletteData[idx * 3] : 0;
        out[dst + 1] = paletteData ? paletteData[idx * 3 + 1] : 0;
        out[dst + 2] = paletteData ? paletteData[idx * 3 + 2] : 0;
        out[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (channels === 1) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[src];
        out[dst + 3] = 255;
      } else if (channels === 2) {
        const g = line[src];
        out[dst] = out[dst + 1] = out[dst + 2] = g;
        out[dst + 3] = line[src + 1];
      } else if (channels === 3) {
        out[dst] = line[src];
        out[dst + 1] = line[src + 1];
        out[dst + 2] = line[src + 2];
        out[dst + 3] = 255;
      } else {
        out[dst] = line[src];
        out[dst + 1] = line[src + 1];
        out[dst + 2] = line[src + 2];
        out[dst + 3] = line[src + 3];
      }
    }
    prev = line;
  }
  return { width, height, data: out, alpha };
}

function unfilter(filterType, line, prev, bpp) {
  switch (filterType) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < line.length; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < line.length; i++) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < line.length; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        line[i] = (line[i] + paeth(a, b, c)) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter type ${String(filterType)}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Box-average downscale (good enough for favicons; keeps antialiasing without a dependency). */
export function resize(img, targetWidth, targetHeight) {
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  const xRatio = img.width / targetWidth;
  const yRatio = img.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((x + 1) * xRatio)));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const src = (sy * img.width + sx) * 4;
          const sa = img.data[src + 3];
          // Pre-multiplied averaging so transparent pixels do not darken the result.
          r += img.data[src] * sa;
          g += img.data[src + 1] * sa;
          b += img.data[src + 2] * sa;
          a += sa;
          n += 1;
        }
      }
      const alphaSum = a || 1;
      const dst = (y * targetWidth + x) * 4;
      out[dst] = Math.round(r / alphaSum);
      out[dst + 1] = Math.round(g / alphaSum);
      out[dst + 2] = Math.round(b / alphaSum);
      out[dst + 3] = Math.round(a / n);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out, alpha: true };
}

/** Square canvas, image centred, background filled — used for maskable icons. */
export function padToSquare(img, size, rgb) {
  const side = Math.min(size, Math.round((size * Math.min(img.width, img.height)) / Math.max(img.width, img.height)));
  const scaled = resize(img, side, side);
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = rgb[0];
    canvas[i * 4 + 1] = rgb[1];
    canvas[i * 4 + 2] = rgb[2];
    canvas[i * 4 + 3] = 255;
  }
  const ox = Math.floor((size - side) / 2);
  const oy = Math.floor((size - side) / 2);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const src = (y * side + x) * 4;
      const dst = ((y + oy) * size + (x + ox)) * 4;
      const sa = scaled.data[src + 3] / 255;
      canvas[dst] = Math.round(scaled.data[src] * sa + canvas[dst] * (1 - sa));
      canvas[dst + 1] = Math.round(scaled.data[src + 1] * sa + canvas[dst + 1] * (1 - sa));
      canvas[dst + 2] = Math.round(scaled.data[src + 2] * sa + canvas[dst + 2] * (1 - sa));
      canvas[dst + 3] = 255;
    }
  }
  return { width: size, height: size, data: canvas, alpha: false };
}

/**
 * Encode an RGBA image into PNG bytes.
 *
 * Two things this does that a naive writer does not, because these bytes ship — inside the `.deb` for the
 * desktop app and to every visitor for the web brand assets:
 *
 *  - **Colour type follows the pixels.** Grayscale when every pixel has r=g=b, RGB when nothing is
 *    translucent, RGBA only when the image actually needs an alpha channel. Writing the master mark
 *    (1254², no alpha at all) as RGBA wasted a quarter of every file.
 *  - **Per-row filter choice**, all five filters, ranked by summed absolute residual (Paeth included).
 *    Filter 0 alone costs ~8× on the 512px icons.
 *
 * `posterize` (bits kept per channel, 1-8, default 8 = lossless) exists because gradient-heavy art
 * compresses terribly: the brand mark at 192px is 35 KB lossless and 12 KB at six bits, and six bits is
 * 64 levels per channel in a glyph nobody views at 1:1. Only the sizes a browser downloads opt in; the
 * packaging icons stay bit-exact, since an installer icon nobody measures and the master artwork is the
 * source of truth for both.
 */
export function encodePng(img, { posterize = 8 } = {}) {
  const { width, height, data } = img;
  if (posterize < 1 || posterize > 8 || !Number.isInteger(posterize)) {
    throw new Error(`posterize must be an integer 1-8, got ${String(posterize)}`);
  }
  const lossy = posterize < 8;
  const step = 1 << (8 - posterize); // bucket width in 8-bit space
  const mid = step >> 1;
  const q = lossy ? (v) => Math.min(255, ((v / step) | 0) * step + mid) : (v) => v;

  // Measure the channel reduction on the values that will actually be written, so the header cannot lie.
  let opaque = true;
  let gray = true;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) {
    for (let i = 0; i < width * height; i++) {
      const r = q(data[i * 4]);
      const g = q(data[i * 4 + 1]);
      const b = q(data[i * 4 + 2]);
      if (r !== g || g !== b) {
        gray = false;
        break;
      }
    }
  }
  const colorType = opaque && gray ? 0 : opaque ? 2 : 6;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const prevRow = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const candidates = [[], [], [], [], []];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const r = q(data[src]);
      const g = q(data[src + 1]);
      const b = q(data[src + 2]);
      if (colorType === 0) {
        cur[x] = r;
      } else if (colorType === 2) {
        cur[x * 3] = r;
        cur[x * 3 + 1] = g;
        cur[x * 3 + 2] = b;
      } else {
        cur[x * 4] = r;
        cur[x * 4 + 1] = g;
        cur[x * 4 + 2] = b;
        cur[x * 4 + 3] = data[src + 3];
      }
    }
    for (const c of candidates) c.length = 0;
    for (let i = 0; i < stride; i++) {
      const v = cur[i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prevRow[i];
      const c = i >= channels ? prevRow[i - channels] : 0;
      candidates[0].push(v);
      candidates[1].push((v - a) & 0xff);
      candidates[2].push((v - b) & 0xff);
      candidates[3].push((v - ((a + b) >> 1)) & 0xff);
      candidates[4].push((v - paeth(a, b, c)) & 0xff);
    }
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < 5; k++) {
      let score = 0;
      for (const byte of candidates[k]) score += byte < 128 ? byte : 256 - byte;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    raw[y * (stride + 1)] = best;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = candidates[best][i];
    cur.copy(prevRow);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The same image, posterized, as pixels — the definition `encodePng({posterize})` must agree with, so the
 * asset pipeline can assert "what I wrote decodes back to exactly what I chose to keep".
 */
export function posterizeRgba(img, bits) {
  const out = Buffer.from(img.data);
  const step = 1 << (8 - bits);
  const mid = step >> 1;
  for (let i = 0; i < out.length; i += 4) {
    for (const ch of [0, 1, 2]) out[i + ch] = Math.min(255, ((out[i + ch] / step) | 0) * step + mid);
  }
  return { width: img.width, height: img.height, data: out, alpha: img.alpha };
}
