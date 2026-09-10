#!/usr/bin/env node
/**
 * The bundle budget: what a first visit to `/` actually downloads, and the number it must stay under.
 *
 *     node scripts/bundle-budget.mjs            # measure dist/web and check it against the budget
 *     node scripts/bundle-budget.mjs --report    # measure, never fail
 *     node scripts/bundle-budget.mjs --write     # rewrite scripts/bundle-budget.json from what is on disk
 *
 * Why "what a fan loads" and not "total JS". `vite build` emits ~50 chunks and the interesting number is the
 * set a visitor needs before they can read a score. This app boots through `await import("./App")` in
 * `src/main.tsx`, so a static-import walk from the entry stops at 4 KiB and would certify *any* bundle: the
 * fan's set is therefore declared (`FAN_BOOT_CHUNKS`), naming the chunk each boot step lands in — entry, env
 * probe, the app chunk that holds `HomePage`, and the two vendors. A chunk nobody names is a chunk nobody
 * requested yet, which is precisely what the route split is for, and `mustBeOwnChunk` is the other half: an
 * admin screen that stops being its own file has silently become the fan's problem again.
 *
 * Total bytes would have gone *up* from the split (per-chunk overhead, ~15 KiB across 50 files) while the thing
 * that matters went down 40 %; a gate on the wrong metric would have recorded that improvement as a
 * regression.
 *
 * `node scripts/build-web.mjs` runs this after every web build, so the budget is enforced by the command that
 * produces the artifact rather than by a note in a document.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BUDGET_FILE = path.join(REPO_ROOT, "scripts/bundle-budget.json");
const ENTRY_HTML = "index.html";

/** Static `import … from "./x.js"` and bare `import "./x.js"`, relative to the chunk's own directory. */
const STATIC_IMPORT = /(?:^|[;}\n])import[^;]*?from"(\.\/[^"]+\.js)"/g;
const STATIC_SIDE_EFFECT = /(?:^|[;}\n])import"(\.\/[^"]+\.js)"/g;
const MODULE_SCRIPT = /<script[^>]*type="module"[^>]*src="([^"]+)"/;

export function outDirForTarget(target = "web") {
  return path.join(REPO_ROOT, "dist", target);
}

function importsOf(file) {
  const body = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const re of [STATIC_IMPORT, STATIC_SIDE_EFFECT]) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) found.add(path.resolve(path.dirname(file), m[1]));
  }
  return [...found];
}

/**
 * The transitive static import closure of the entry script, with bytes and gzip sizes.
 *
 * Dynamic `import("…")` is deliberately not followed: that *is* the split, and a boot graph that chased it
 * would look identical to the whole bundle.
 */
/** Vite appends an 8-character hash before the extension; the base name is the stable part. */
function baseName(file) {
  return path
    .basename(file)
    .replace(/-[A-Za-z0-9_-]{8}\.js$/, "")
    .replace(/\.js$/, "");
}

export function groupChunks(outDir) {
  const dir = path.join(outDir, "assets");
  const byBase = new Map();
  if (!fs.existsSync(dir)) return byBase;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const abs = path.join(dir, file);
    const bytes = fs.statSync(abs).size;
    const base = baseName(file);
    const current = byBase.get(base);
    // Two files sharing a base name means a stale build was left behind; keep the larger and say so, rather
    // than silently double-counting a chunk that no longer exists in the real graph.
    if (!current || bytes > current.bytes) byBase.set(base, { file: `assets/${file}`, bytes, stale: current ? current.file : null });
    else byBase.set(base, { ...current, stale: file });
  }
  return byBase;
}

export function measureBoot(outDir) {
  const html = path.join(outDir, ENTRY_HTML);
  if (!fs.existsSync(html)) throw new Error(`no ${ENTRY_HTML} in ${path.relative(REPO_ROOT, outDir)} — run npm run build:web first`);
  const src = fs.readFileSync(html, "utf8").match(MODULE_SCRIPT)?.[1];
  if (!src) throw new Error(`${ENTRY_HTML} has no <script type="module" src=…>; the entry chunk cannot be identified`);
  const entryAbs = path.join(outDir, src.replace(/^\.?\//, ""));
  if (!fs.existsSync(entryAbs)) throw new Error(`entry chunk ${src} referenced by ${ENTRY_HTML} does not exist on disk`);

  const groups = groupChunks(outDir);
  const entryBase = baseName(entryAbs);
  const measure = (base) => {
    // Two chunks can share a base name legitimately: `src/main.tsx` and the PWA's registration entry both
    // become `index-<hash>.js`. The entry is whatever index.html points at, so prefer the real path over the
    // largest file with a matching name — otherwise the budget measures a chunk nobody downloads.
    const found = base === entryBase ? { file: path.relative(outDir, entryAbs).split(path.sep).join("/"), bytes: fs.statSync(entryAbs).size, stale: null } : groups.get(base);
    if (!found) return null;
    const abs = path.join(outDir, found.file);
    return { file: found.file, bytes: found.bytes, gz: zlib.gzipSync(fs.readFileSync(abs), { level: 9 }).length, staleSibling: found.stale };
  };

  const fan = FAN_BOOT_CHUNKS.map((base) => ({ base, chunk: measure(base) }));
  const cssFiles = [...new Set([...cssRefs(outDir, src)])].sort();
  const css = cssFiles.map((file) => ({ file, bytes: fs.statSync(path.join(outDir, file)).size, gz: zlib.gzipSync(fs.readFileSync(path.join(outDir, file)), { level: 9 }).length }));
  const all = [...groups.values()];
  // Two copies of React is the classic `manualChunks` mistake and it fails at runtime ("Invalid hook call")
  // rather than at build time, so it needs a build-time proxy. `Symbol.for("react.element")` is emitted by
  // every copy of the React runtime and is a *string* — a symbol-registry key survives minification, an
  // identifier does not — so counting the chunks that contain it counts the copies.
  const reactCopies = [...groups.values()].filter((c) => fs.readFileSync(path.join(outDir, c.file), "utf8").includes("react.element")).length;

  return {
    entry: { file: path.relative(outDir, entryAbs).split(path.sep).join("/"), bytes: fs.statSync(entryAbs).size },
    groups,
    fan,
    css,
    boot: {
      bytes: fan.reduce((n, f) => n + (f.chunk?.bytes ?? 0), 0),
      gz: fan.reduce((n, f) => n + (f.chunk?.gz ?? 0), 0),
      missing: fan.filter((f) => !f.chunk).map((f) => f.base),
    },
    cssBoot: { bytes: css.reduce((n, c) => n + c.bytes, 0), gz: css.reduce((n, c) => n + c.gz, 0) },
    totalJs: all.reduce((n, c) => n + c.bytes, 0),
    chunkCount: all.length,
    reactCopies,
    // Not a failure: `dist/web` is emptied on every build, so two files sharing a base name means two chunks
    // that Vite named the same way (main + PWA), which is worth printing but not worth gating.
    sharedBaseNames: all.filter((c) => c.stale).map((c) => `${c.file} (+ ${c.stale})`),
  };
}

/** The chunks a visitor to `/` needs before a score is on screen. Names are hashes-free on purpose. */
export const FAN_BOOT_CHUNKS = ["index", "env", "App", "vendor-react", "vendor-supabase"];
export const MUST_BE_OWN_CHUNK = ["AdminPortal", "TeamOwnerPortal", "MediaPortal", "TeamPortal", "MatchDetails", "StandingsPage"];

function* cssRefs(outDir, entrySrc) {
  const html = fs.readFileSync(path.join(outDir, ENTRY_HTML), "utf8");
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g))
    yield path
      .relative(outDir, path.join(outDir, m[1].replace(/^\//, "")))
      .split(path.sep)
      .join("/");
}

const KB = 1024;
const fmt = (n) => `${(n / KB).toFixed(1)} KiB`;

export function checkBudget(measure, budget) {
  const problems = [];
  if (measure.boot.missing.length) problems.push(`no chunk named ${measure.boot.missing.join(", ")} — the fan's boot set changed shape; update FAN_BOOT_CHUNKS or find out why the file vanished`);
  if (measure.boot.bytes > budget.bootBytesMax) problems.push(`a fan downloads ${fmt(measure.boot.bytes)} raw of JS to render /, budget ${fmt(budget.bootBytesMax)}`);
  if (measure.boot.gz > budget.bootGzippedBytesMax) problems.push(`a fan downloads ${fmt(measure.boot.gz)} gzipped of JS to render /, budget ${fmt(budget.bootGzippedBytesMax)}`);
  if (measure.cssBoot.bytes > budget.bootCssBytesMax) problems.push(`boot CSS is ${fmt(measure.cssBoot.bytes)} raw, budget ${fmt(budget.bootCssBytesMax)}`);
  if (measure.reactCopies !== 1) problems.push(`${String(measure.reactCopies)} chunks define React internals; the vendor split must keep exactly one (two Reacts = "Invalid hook call" at runtime)`);
  for (const name of budget.mustBeOwnChunk ?? []) {
    if (!measure.groups.has(name)) problems.push(`${name} is not its own chunk — an eager import has merged it back into the boot graph`);
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const report = argv.includes("--report");
  const write = argv.includes("--write");
  const outDir = outDirForTarget(argv.includes("--desktop") ? "renderer" : "web");
  const measure = measureBoot(outDir);

  console.log(
    `bundle budget (${path.relative(REPO_ROOT, outDir)}): a fan loads ${fmt(measure.boot.bytes)} raw / ${fmt(measure.boot.gz)} gzipped to render /, CSS ${fmt(measure.cssBoot.bytes)}, ${String(measure.chunkCount)} JS chunks totalling ${fmt(measure.totalJs)}, React copies ${String(measure.reactCopies)}`,
  );
  for (const { base, chunk } of measure.fan) {
    console.log(chunk ? `  ${fmt(chunk.bytes).padStart(10)}  ${chunk.file}   (${base})` : `  ${"MISSING".padStart(10)}  ${base}`);
  }
  const offBoot = [...measure.groups.entries()].filter(([base]) => !FAN_BOOT_CHUNKS.includes(base)).sort((a, b) => b[1].bytes - a[1].bytes);
  if (offBoot.length)
    console.log(
      `  not fetched by a visitor to /: ${offBoot
        .slice(0, 4)
        .map(([base, c]) => `${base} ${fmt(c.bytes)}`)
        .join(", ")}${offBoot.length > 4 ? `, +${String(offBoot.length - 4)} more` : ""} (${fmt(offBoot.reduce((n, [, c]) => n + c.bytes, 0))} total)`,
    );
  for (const c of measure.css) console.log(`  ${fmt(c.bytes).padStart(10)}  ${c.file}`);

  if (write) {
    const budget = {
      bootBytesMax: Math.ceil((measure.boot.bytes * 1.08) / KB) * KB,
      bootGzippedBytesMax: Math.ceil((measure.boot.gz * 1.1) / KB) * KB,
      bootCssBytesMax: Math.ceil((measure.cssBoot.bytes * 1.1) / KB) * KB,
      mustBeOwnChunk: MUST_BE_OWN_CHUNK,
      recordedAt: new Date().toISOString(),
      note: "Ceilings, not targets: ~8-10% of headroom so a normal dependency bump does not fail a build, while a re-merged portal or an eager chart library does. Regenerate with `node scripts/bundle-budget.mjs --write` and read the diff before committing it.",
    };
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`bundle-budget: wrote ${path.relative(REPO_ROOT, BUDGET_FILE)} (fan boot ${fmt(measure.boot.bytes)} raw / ${fmt(measure.boot.gz)} gz, headroom included)`);
    return;
  }

  if (report) return;
  if (!fs.existsSync(BUDGET_FILE)) {
    console.error(`bundle-budget: no scripts/bundle-budget.json (run \`node scripts/bundle-budget.mjs --write\` after a build)`);
    process.exitCode = 1;
    return;
  }
  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
  const problems = checkBudget(measure, budget);
  if (problems.length) {
    console.error(`\nbundle-budget: FAILED\n  ${problems.join("\n  ")}`);
    console.error("  If the increase is intended, rerun with --write and read the diff of scripts/bundle-budget.json in review.");
    process.exitCode = 1;
  } else {
    console.log(
      `bundle-budget: ok — a fan loads ${fmt(measure.boot.bytes)} of ${fmt(budget.bootBytesMax)} raw, ${fmt(measure.boot.gz)} of ${fmt(budget.bootGzippedBytesMax)} gzipped, ${String(budget.mustBeOwnChunk.length)} routes still own their chunks`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("bundle-budget.mjs")) {
  main();
}
