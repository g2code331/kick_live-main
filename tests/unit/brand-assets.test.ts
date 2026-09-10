/**
 * Phase 4 · the browser-facing brand assets.
 *
 * `public/kicklive-icon.png` is the *master*: 1254², 2.4 MB, and the source `scripts/branding.mjs` derives
 * `.ico`/`.icns`/hicolor/PWA icons from (`shared/branding.ts` says so). It is correct for that job and wrong
 * for a tab favicon, which is what it was until this file existed — `index.html` and the header pulled the
 * master, and `AppBackground` tiled it behind every route at 1.5 % opacity.
 *
 * So the pins here are the three that keep that from coming back:
 *   1. nothing in `src/` or `index.html` references a master file (only reference-shaped patterns, so this
 *      module's own prose about those filenames cannot trip it);
 *   2. the derived bytes on disk are what the pipeline writes today, inside ceilings the pipeline owns;
 *   3. the PNG codec's channel choice and posterize step are exact — the reason the derivatives can be 30×
 *      smaller without being *wrong*, and the reason that claim needs a test rather than a look.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { PAINT_ASSETS, PAGE_BUDGET_BYTES, TARGETS, buildAll } from "../../scripts/brand-assets.mjs";
import { decodePng, encodePng, posterizeRgba, readPngHeader, resize } from "../../scripts/lib/png.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const built = buildAll(REPO);
const byFile = new Map(built.map((item) => [item.file, item]));

/** Reference shapes only: prose that *names* a master is not a page loading it. */
const MASTER_REF = /(?:src|href)=["']\.?\/?kicklive-(?:icon|wordmark|logo)\.png["']|assetUrl\(\s*["']kicklive-(?:icon|wordmark|logo)\.png|url\(\s*['"]?\/?kicklive-(?:icon|wordmark|logo)\.png/;
const MASTERS = ["public/kicklive-icon.png", "public/kicklive-wordmark.png", "public/kicklive-logo.png"];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(abs, out);
    else if (/\.(tsx?|html|css)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe("brand assets · what the browser loads", () => {
  it("the masters still exist and are still the masters", () => {
    for (const rel of MASTERS) {
      const abs = path.join(REPO, rel);
      assert.ok(fs.existsSync(abs), `${rel} must stay in the tree: scripts/branding.mjs derives packaging icons from it`);
    }
    const brand = fs.readFileSync(path.join(REPO, "shared/branding.ts"), "utf8");
    assert.match(brand, /masterIcon: "public\/kicklive-icon\.png"/, "the branding pipeline's source of truth, unchanged by Phase 4");
  });

  it("no page, component or stylesheet references a master", () => {
    const files = [...sources(path.join(REPO, "src")), path.join(REPO, "index.html")];
    const offenders: string[] = [];
    for (const file of files) {
      const body = fs
        .readFileSync(file, "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (MASTER_REF.test(body)) offenders.push(path.relative(REPO, file));
    }
    assert.deepEqual(offenders, [], "a browser must never be asked to fetch a 1-2 MB master for a mark it draws at 32-80 px");
  });

  it("each derived file is on disk, at the declared size and within the pipeline's ceiling", () => {
    for (const target of TARGETS) {
      const item = byFile.get(target.file);
      assert.ok(item, `${target.file} is not produced by the pipeline`);
      const abs = path.join(REPO, target.file);
      assert.ok(fs.existsSync(abs), `${target.file} missing — run npm run brand:assets`);
      const onDisk = fs.readFileSync(abs);
      assert.ok(onDisk.equals(item.bytes), `${target.file} is not what the pipeline writes — run npm run brand:assets`);
      const header = readPngHeader(onDisk);
      assert.equal(header.width, target.w, `${target.file} width`);
      assert.equal(
        header.height,
        target.h ?? Math.round((header.width * decodePng(fs.readFileSync(path.join(REPO, target.from))).height) / decodePng(fs.readFileSync(path.join(REPO, target.from))).width),
        `${target.file} height keeps the master's aspect`,
      );
      assert.ok(onDisk.length <= target.maxBytes, `${target.file} is ${String(onDisk.length)} bytes, ceiling ${String(target.maxBytes)}`);
    }
  });

  it("keeps the whole first paint inside the brand budget", () => {
    let total = 0;
    for (const name of PAINT_ASSETS) {
      const item = byFile.get(`public/${name}`);
      assert.ok(item, `PAINT_ASSETS names ${name}, which the pipeline does not write`);
      total += item.bytes.length;
    }
    assert.ok(total <= PAGE_BUDGET_BYTES, `first paint pulls ${String(total)} bytes of brand art, budget ${String(PAGE_BUDGET_BYTES)}`);
    // The number the phase was for, kept visible in the test output rather than only in a doc.
    console.log(`      brand art on first paint: ${(total / 1024).toFixed(1)} KiB (was ~5 MB, uncached, per cold visit)`);
  });

  it("regenerated favicon.svg is still a valid SVG carrying a decodable PNG", () => {
    const svg = fs.readFileSync(path.join(REPO, "public/favicon.svg"), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const b64 = svg.match(/base64,([A-Za-z0-9+/=]+)"\//)?.[1];
    assert.ok(b64, "no embedded raster");
    const png = Buffer.from(b64, "base64");
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    const header = readPngHeader(png);
    assert.deepEqual([header.width, header.height], [64, 64]);
    assert.ok(svg.length < 20 * 1024, `favicon.svg is ${String(svg.length)} bytes; it used to be 330 KB of embedded 1254² raster`);
  });
});

describe("brand assets · the codec the pipeline depends on", () => {
  const img = (w: number, h: number, at: (x: number, y: number) => number[]) => {
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = at(x, y);
        data.set([r, g, b, a], (y * w + x) * 4);
      }
    return { width: w, height: h, data, alpha: true };
  };

  it("picks grayscale, RGB or RGBA from the pixels rather than always writing four channels", () => {
    const gray = img(4, 4, () => [10, 10, 10, 255]);
    const rgb = img(4, 4, (x) => [x * 40, x * 40, 200, 255]);
    const rgba = img(4, 4, (x, y) => [x * 40, 10, 200, y % 2 ? 128 : 255]);
    assert.equal(readPngHeader(encodePng(gray)).colorType, 0, "opaque and r=g=b is grayscale");
    assert.equal(readPngHeader(encodePng(rgb)).colorType, 2, "opaque colour is RGB, not RGBA with a wasted alpha channel");
    assert.equal(readPngHeader(encodePng(rgba)).colorType, 6, "translucency needs RGBA");
  });

  it("round-trips exactly, lossless and posterized", () => {
    const master = decodePng(fs.readFileSync(path.join(REPO, "public/kicklive-icon.png")));
    const small = resize(master, 48, 48);
    for (const bits of [8, 6, 4]) {
      const bytes = encodePng(small, { posterize: bits });
      const back = decodePng(bytes);
      const want = bits < 8 ? posterizeRgba(small, bits) : small;
      assert.equal(back.data.length, want.data.length);
      for (let i = 0; i < want.data.length; i++) assert.equal(back.data[i], want.data[i], `pixel ${String(i)} at ${String(bits)} bits`);
      if (bits < 8) assert.ok(bytes.length < encodePng(small).length, `${String(bits)} bits should compress smaller than lossless`);
    }
  });

  it("refuses a nonsense bit depth instead of writing a silently lossy file", () => {
    const small = img(2, 2, () => [1, 2, 3, 255]);
    for (const bits of [0, 9, 7.5]) assert.throws(() => encodePng(small, { posterize: bits as number }), /posterize must be an integer 1-8/);
  });

  it("the pipeline itself is deterministic, which is what makes --check meaningful", () => {
    const again = buildAll(REPO);
    assert.deepEqual(
      again.map((b) => `${b.file}:${String(b.bytes.length)}:${b.bytes.subarray(0, 24).toString("hex")}`),
      built.map((b) => `${b.file}:${String(b.bytes.length)}:${b.bytes.subarray(0, 24).toString("hex")}`),
      "two runs produced different bytes — a decoder or zlib setting is not reproducible",
    );
  });
});
