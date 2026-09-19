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
  // `--mode=<name>` selects Vite's per-mode env file (`.env.<name>`) for the build. It is threaded through here
  // rather than told to operators as an inline `VITE_…=… npm run build:web` because a value that has to be typed
  // correctly on the *build* line is a value that will one day be omitted on the second of two copy-pasted
  // commands, and the result is a complete-looking bundle pointed at no backend at all (the boot guard says so,
  // but by then the artefact has been deployed). A named mode cannot be forgotten silently: the file is there
  // or the build refuses.
  const modeArg = process.argv.find((a) => a.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length);
  if (mode && !/^[a-z][a-z0-9_-]*$/.test(mode)) {
    console.error(`build:web: --mode=${mode} is not a valid mode name (lowercase, starts with a letter)`);
    process.exitCode = 1;
    return;
  }
  if (mode && !fs.existsSync(path.join(REPO_ROOT, `.env.${mode}`))) {
    console.error(
      `build:web: --mode=${mode} needs .env.${mode}, which does not exist. Generate it with \`npm run web:env\` ` +
        `(it is derived from workers/wrangler.toml, so there is no key to copy by hand). Building without it would\n` +
        `produce a bundle whose boot screen says "KickLive is not configured" — which is what the last Pages deploy did.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`build:web → vite build (config vite.config.ts${mode ? `, mode ${mode} → .env.${mode}` : ""}) → ${path.relative(REPO_ROOT, outDir)}`);
  await build({ root: REPO_ROOT, configFile: path.join(REPO_ROOT, "vite.config.ts"), logLevel: "info", ...(mode ? { mode } : {}) });
  const pwa = await buildPwa({ outDir, target: "web", log: (line) => console.log(line) });
  // The Firebase background-push worker, generated from VITE_FIREBASE_* when configured; a no-op (and a
  // cleanup of any stale worker) otherwise, so an unconfigured build ships no dead push worker.
  const { buildFirebaseSw } = await import("./build-firebase-sw.mjs");
  await buildFirebaseSw({ outDir, mode, log: (line) => console.log(line) });
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
