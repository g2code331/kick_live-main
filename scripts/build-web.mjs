#!/usr/bin/env node
/**
 * Web / PWA build: `vite build` + the PWA extras, then a build manifest that the release notes and
 * the CI artifact table are built from.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, outDirFor, readVersionFile, walk } from "../tools/vite-shared.ts";
import { sha256File } from "../tools/vite-shared.ts";
import { buildPwa } from "./build-pwa.mjs";
import { fmtSize } from "./lib/run.mjs";

export function emitBuildManifest(outDir, target) {
  const files = walk(outDir).map((file) => {
    const rel = "/" + path.relative(outDir, file).split(path.sep).join("/");
    const stat = fs.statSync(file);
    return { path: rel, bytes: stat.size, sha256: sha256File(file) };
  });
  const manifest = {
    product: "kicklive",
    target,
    version: readVersionFile(REPO_ROOT),
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  };
  fs.writeFileSync(path.join(outDir, "kicklive-build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function main() {
  const { build } = await import("vite");
  const outDir = outDirFor("web");
  console.log(`build:web → vite build (config vite.config.ts) → ${path.relative(REPO_ROOT, outDir)}`);
  await build({ root: REPO_ROOT, configFile: path.join(REPO_ROOT, "vite.config.ts"), logLevel: "info" });
  const pwa = await buildPwa({ outDir, target: "web", log: (line) => console.log(line) });
  const manifest = emitBuildManifest(outDir, "web");
  const jsBytes = manifest.files.filter((f) => /\.(js)$/.test(f.path)).reduce((n, f) => n + f.bytes, 0);
  console.log(`build:web: ${String(manifest.fileCount)} files, ${fmtSize(manifest.totalBytes)} total, JS ${fmtSize(jsBytes)} (version ${manifest.version})`);
  const missingShell = manifest.files.some((f) => f.path === "/index.html");
  if (!missingShell) {
    console.error("build:web: index.html missing from the output");
    process.exitCode = 1;
    return;
  }
  // Phase 4's budget: the boot graph, not the total. Enforced here rather than in a document because this is
  // the command that produces the artifact, and `node scripts/gates.mjs` already treats a non-zero exit from
  // build:web as a failed release gate.
  const { checkBudget, measureBoot, outDirForTarget } = await import("./bundle-budget.mjs");
  const budgetFile = path.join(REPO_ROOT, "scripts/bundle-budget.json");
  if (fs.existsSync(budgetFile)) {
    const measured = measureBoot(outDirForTarget("web"));
    const problems = checkBudget(measured, JSON.parse(fs.readFileSync(budgetFile, "utf8")));
    const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
    console.log(
      `build:web: a fan loads ${kb(measured.boot.bytes)} raw / ${kb(measured.boot.gz)} gzipped across ${String(measured.fan.length)} boot chunks, of ${String(measured.chunkCount)} JS chunks in the build`,
    );
    if (problems.length) {
      console.error(`build:web: BUNDLE BUDGET FAILED\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    }
  } else {
    console.log("build:web: no scripts/bundle-budget.json — skipped the budget (create it with `node scripts/bundle-budget.mjs --write`)");
  }
  const hasSw = manifest.files.some((f) => f.path === "/sw.js");
  if (!hasSw) {
    console.error("build:web: sw.js missing — the PWA surface cannot self-update");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("build-web.mjs")) {
  await main();
}
