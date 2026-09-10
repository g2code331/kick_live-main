#!/usr/bin/env node
/**
 * Brand asset pipeline for the browser.
 *
 *     node scripts/brand-assets.mjs            # write the derived files and print the table
 *     node scripts/brand-assets.mjs --check     # fail if what is on disk is not what this would write
 *     node scripts/brand-assets.mjs --report    # sizes only, nothing written
 *
 * Why this exists. `shared/branding.ts` calls `public/kicklive-icon.png` the **master**: 1254², 2.4 MB,
 * the source `branding.mjs` derives `.ico`, `.icns`, the hicolor PNGs and the PWA icons from. It is the
 * right thing to keep at full resolution and the wrong thing to hand a browser — yet until Phase 4 every
 * page did exactly that: `<link rel="icon" href="./kicklive-icon.png">`, a 32 px header mark reading the
 * 1254² file, and `AppBackground` tiling it at 1.5 % opacity. `kicklive-wordmark.png` (2.16 MB) was the
 * header's centred logo. So the first paint of every route on every device cost ~4.6 MB of PNG that was
 * then scaled *down* by 6× to 100×.
 *
 * The masters stay untouched, in place, at full resolution — deleting them would break the packaging
 * pipeline for a byte-count. What changes is that nothing the browser loads references them: `public/brand/`
 * holds the sizes the UI actually draws, encoded by the repo's own PNG codec (`scripts/lib/png.mjs`, the
 * same one `branding.mjs` uses, so there is one encoder in this repository and not two).
 *
 * `maxBytes` per file and `PAGE_BUDGET_BYTES` for what a first paint pulls are part of the pipeline, not a
 * separate config, so `--check` (and `tests/unit/brand-assets.test.ts`, which imports this file) fails on an
 * edit that quietly doubles an asset. They are ceilings with room: the actual figures today are printed by
 * `--report`.
 *
 * Per-target `bits` is deliberate and it is not a style preference. `bits` is the number of bits per
 * channel kept (8 = lossless): the mark is a glow on a near-black field, which is exactly the kind of
 * gradient PNG cannot compress, and the win from 8 → 6 bits is ~40 % with nothing to see at these sizes.
 * A favicon is viewed at 1:1 and stays lossless; a 1.5 %-opacity watermark is never resolved by an eye and
 * goes to 4 bits. Each line in TARGETS says which, and `--check` makes the table and the files on disk the
 * same fact.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { decodePng, encodePng, posterizeRgba, readPngHeader, resize } from "./lib/png.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MASTER_ICON = "public/kicklive-icon.png";
const MASTER_WORDMARK = "public/kicklive-wordmark.png";

/**
 * `w`/`h` in px, `bits` per channel, `from` the master, `why` is the reason the number is what it is.
 * Width-only entries derive the height from the master's aspect ratio.
 */
const KB = 1024;

export const PAGE_BUDGET_BYTES = 96 * KB;

/** What the first paint of an authenticated page pulls, by filename. */
export const PAINT_ASSETS = ["brand/icon-192.png", "brand/wordmark-312.png", "brand/pattern-192.png", "brand/icon-32.png"];

export const TARGETS = [
  {
    file: "public/brand/icon-32.png",
    from: MASTER_ICON,
    w: 32,
    bits: 8,
    maxBytes: 4 * KB,
    why: "index.html favicon; seen at 1:1 in a tab, so lossless",
  },
  {
    file: "public/brand/icon-64.png",
    from: MASTER_ICON,
    w: 64,
    bits: 8,
    maxBytes: 12 * KB,
    why: "embedded in public/favicon.svg (2× a 32px tab icon) and any 16-24px slot at 3×",
  },
  {
    file: "public/brand/icon-192.png",
    from: MASTER_ICON,
    w: 192,
    bits: 6,
    maxBytes: 48 * KB,
    why: "Header's refresh mark: h-20 = 80 CSS px, so 192 is a 2.4× margin for zoom and hidpi",
  },
  {
    file: "public/brand/pattern-192.png",
    from: MASTER_ICON,
    w: 192,
    bits: 4,
    maxBytes: 32 * KB,
    why: "AppBackground's opacity-[0.015] tiled watermark — 4 bits is 16 levels per channel, and the layer is 1.5% visible",
  },
  {
    file: "public/brand/wordmark-312.png",
    from: MASTER_WORDMARK,
    w: 312,
    bits: 6,
    maxBytes: 40 * KB,
    why: "Header's centred wordmark: h-9 → h-[3.25rem] = 52 CSS px tall, 208 px of height at 4×",
  },
];

function buildTarget(root, target, masters) {
  const master = masters.get(target.from);
  const h = target.h ?? Math.round((master.height * target.w) / master.width);
  const scaled = resize(master, target.w, h);
  const expected = target.bits < 8 ? posterizeRgba(scaled, target.bits) : scaled;
  const bytes = encodePng(scaled, { posterize: target.bits });

  // Round-trip proof: decode what we are about to write and compare it, byte for byte, with the pixels we
  // decided to keep. Without this, a codec change could quietly write a file the browser renders wrong and
  // the only symptom would be a logo that looks slightly off in production.
  const back = decodePng(bytes);
  const header = readPngHeader(bytes);
  if (back.width !== target.w || back.height !== h) throw new Error(`${target.file}: wrote ${String(back.width)}x${String(back.height)}, expected ${String(target.w)}x${String(h)}`);
  if (header.bitDepth !== 8 || header.interlace !== 0) throw new Error(`${target.file}: unexpected bit depth or interlace`);
  if (expected.alpha !== false && back.data.length !== expected.data.length) throw new Error(`${target.file}: channel layout changed`);
  for (let i = 0; i < expected.data.length; i++) {
    if (back.data[i] !== expected.data[i]) {
      throw new Error(
        `${target.file}: pixel ${String(i)} is ${String(back.data[i])} after decode but ${String(expected.data[i])} in the source ` +
          `(colorType ${String(header.colorType)} assumed ${expected.alpha === false ? "opaque" : "translucent"} — encodePng's channel choice and the pixels disagree)`,
      );
    }
  }
  return { ...target, bytes, width: target.w, height: h };
}

/** `public/favicon.svg`, regenerated from the 64px derivative instead of carrying a 1254² raster inside an SVG. */
function buildFaviconSvg(root, icon64) {
  const target = TARGETS.find((t) => t.file === "public/brand/icon-64.png");
  const b64 = icon64.bytes.toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(icon64.width)}" height="${String(icon64.height)}" viewBox="0 0 ${String(icon64.width)} ${String(icon64.height)}"><!-- generated by scripts/brand-assets.mjs from ${target.from} (${String(fs.statSync(path.join(root, target.from)).size)} bytes of master); do not hand-edit --><image width="${String(icon64.width)}" height="${String(icon64.height)}" href="data:image/png;base64,${b64}"/></svg>\n`;
  // Prove the payload survives the text round trip, or a browser would show a broken favicon and nothing else.
  const decoded = decodePng(Buffer.from(b64, "base64"));
  if (decoded.width !== icon64.width || decoded.height !== icon64.height) throw new Error("favicon.svg: embedded PNG does not decode at the expected size");
  return {
    file: "public/favicon.svg",
    bytes: Buffer.from(svg, "utf8"),
    width: icon64.width,
    height: icon64.height,
    why: "replaces a 330 KB SVG whose only content was a 1254² base64 raster",
    from: "derived from public/brand/icon-64.png",
  };
}

function loadMasters(root) {
  const map = new Map();
  for (const file of [MASTER_ICON, MASTER_WORDMARK]) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) throw new Error(`missing master asset ${file} — this script derives from it and does not replace it`);
    map.set(file, decodePng(fs.readFileSync(abs)));
  }
  return map;
}

function fmt(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${String(bytes)} B`;
}

export function buildAll(root = REPO_ROOT) {
  const masters = loadMasters(root);
  const built = TARGETS.map((t) => buildTarget(root, t, masters));
  const icon64 = built.find((b) => b.file.endsWith("icon-64.png"));
  const favicon = buildFaviconSvg(root, icon64);
  favicon.maxBytes = 16 * KB;
  built.push(favicon);
  return built;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const reportOnly = argv.includes("--report");
  const built = buildAll(REPO_ROOT);

  const rows = [];
  const drift = [];
  const overBudget = [];
  let totalNow = 0;
  let totalNew = 0;
  for (const item of built) {
    const abs = path.join(REPO_ROOT, item.file);
    const before = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    totalNow += before;
    totalNew += item.bytes.length;
    rows.push({ file: item.file, from: item.from, dims: `${String(item.width)}x${String(item.height)}`, before, after: item.bytes.length, why: item.why });
    // Drift is only an error in --check mode: on a write run the whole point is that the files change.
    if (check) {
      if (fs.existsSync(abs)) {
        const onDisk = fs.readFileSync(abs);
        if (!onDisk.equals(item.bytes)) {
          drift.push(`${item.file} is ${fmt(onDisk.length)} on disk and this pipeline writes ${fmt(item.bytes.length)} — rerun node scripts/brand-assets.mjs`);
        }
      } else {
        drift.push(`${item.file} does not exist (run node scripts/brand-assets.mjs)`);
      }
    }
    if (item.maxBytes && item.bytes.length > item.maxBytes) {
      overBudget.push(`${item.file} is ${fmt(item.bytes.length)} and the pipeline's ceiling is ${fmt(item.maxBytes)}`);
    }
    if (!check && !reportOnly) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, item.bytes);
    }
  }

  for (const r of rows) {
    const delta = r.before > 0 ? `${r.before > r.after ? "-" : "+"}${fmt(Math.abs(r.before - r.after))}` : "new";
    console.log(`${r.file.padEnd(34)} ${r.dims.padEnd(10)} ${fmt(r.before).padStart(9)} → ${fmt(r.after).padStart(9)}  ${delta.padStart(9)}   ${r.why}`);
  }
  console.log(
    `\nbrand assets: ${fmt(totalNow)} on disk → ${fmt(totalNew)} written, from ${fmt(fs.statSync(path.join(REPO_ROOT, MASTER_ICON)).size + fs.statSync(path.join(REPO_ROOT, MASTER_WORDMARK)).size)} of masters kept untouched.`,
  );

  const paint = PAINT_ASSETS.reduce((n, name) => {
    const item = built.find((b) => b.file === `public/${name}`);
    if (!item) throw new Error(`PAINT_ASSETS names ${name}, which this pipeline does not write`);
    return n + item.bytes.length;
  }, 0);
  const paintLine = `first paint pulls ${fmt(paint)} of brand art (budget ${fmt(PAGE_BUDGET_BYTES)})`;
  if (paint > PAGE_BUDGET_BYTES) overBudget.push(`${paintLine} — over`);
  console.log(`brand-assets: ${paintLine}; per-file ceilings ${overBudget.length ? "EXCEEDED" : "ok"}`);

  if (overBudget.length) {
    console.error(`\nbrand-assets: BUDGET\n  ${overBudget.join("\n  ")}`);
    process.exitCode = 1;
  }
  if (drift.length) {
    console.error(`\nbrand-assets: DRIFT\n  ${drift.join("\n  ")}`);
    process.exitCode = 1;
  } else if (check) {
    console.log("brand-assets: ok — every derived file matches what this pipeline writes");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("brand-assets.mjs")) {
  main();
}
