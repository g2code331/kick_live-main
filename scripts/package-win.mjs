#!/usr/bin/env node
/**
 * Build the Windows desktop artifact (NSIS installer) with electron-builder, then hash it into the
 * same release/checksums.json + release/artifacts.json contract the Linux packager writes, so the
 * update-manifest builder has one source of truth for every platform.
 *
 *   node scripts/package-win.mjs [--skip-build] [--dir]
 *
 * electron-builder cannot cross-build an NSIS installer from Linux (it shells out to makensis and
 * needs the Windows Electron runtime), so this script is meant to run on a windows-latest runner.
 * `--dir` stops at release/win-unpacked (no installer) for a fast layout check. The same
 * network-download caveat as package-linux.mjs applies: electron-builder pulls the Electron runtime
 * zip from github.com release assets, available in CI, and the failure is printed with the reason
 * rather than a stack trace.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, readVersionFile, walk } from "../tools/vite-shared.ts";
import { fmtSize, run, tail } from "./lib/run.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);

export async function main() {
  const version = readVersionFile(REPO_ROOT);
  if (!has("skip-build")) {
    const build = run("npm run build", "npm", ["run", "build"], { cwd: REPO_ROOT });
    if (!build.ok) {
      console.error("package-win: npm run build failed");
      return build.code || 1;
    }
  }
  for (const required of ["renderer/dist/index.html", "build/electron/main.cjs", "build/electron/preload.cjs"]) {
    if (!fs.existsSync(path.join(REPO_ROOT, required))) {
      console.error(`package-win: ${required} is missing — run "npm run build" first`);
      return 1;
    }
  }

  const builderArgs = ["--no", "electron-builder", "--config", "electron-builder.yml", "--win", "--x64", "--publish", "never"];
  if (has("dir")) builderArgs.push("--dir");
  else builderArgs.push("nsis");
  console.log(`package-win: electron-builder ${has("dir") ? "dir" : "nsis"} @ v${version}`);
  const res = run("electron-builder", "npx", builderArgs, { cwd: REPO_ROOT, env: { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? "" } });
  const out = res.stdout + res.stderr;
  if (!res.ok) {
    const blocked = /ETIMEDOUT|ENOTFOUND|self-signed|unable to verify|EAI_AGAIN|Could not download|download.*failed/i.test(out);
    console.error(`\npackage-win: electron-builder failed${blocked ? " — it could not download the Electron runtime tooling" : ""}`);
    if (blocked) {
      console.error(
        "  This step needs network access to github.com release assets. In CI it is available;\n" + "  locally you can pre-seed ~/.cache/electron with electron-v" + version + "-win32-x64.zip.",
      );
    }
    console.error(tail(out, 20));
    return res.code || 1;
  }

  if (has("dir")) {
    console.log("package-win: --dir build reached release/win-unpacked (no installer, no checksums).");
    return 0;
  }

  const releaseDir = path.join(REPO_ROOT, "release");
  // Only the Windows artifacts this run produced — never re-hash Linux .deb/.AppImage that a
  // download-artifact step may have staged into the same dir on the release job.
  const artifacts = fs.existsSync(releaseDir) ? walk(releaseDir, (f) => /\.(exe|msi|nsis\.7z|blockmap)$/.test(f) && !/packaging-report|checksums|artifacts\.json/.test(f)) : [];
  const rows = [];
  for (const file of artifacts) {
    const stat = fs.statSync(file);
    rows.push({ name: path.basename(file), bytes: stat.size, sha256: (await hashFile(file)).slice(0, 16), full: await hashFile(file) });
  }
  if (rows.length === 0) {
    console.error("package-win: no .exe installer found in release/ after the build");
    return 1;
  }
  const manifest = {
    product: "kicklive",
    version,
    generatedAt: new Date().toISOString(),
    targets: ["nsis"],
    artifacts: rows.map((r) => ({ name: r.name, bytes: r.bytes, sha256: r.sha256, path: `release/${r.name}` })),
  };
  fs.writeFileSync(path.join(releaseDir, "artifacts-win.json"), JSON.stringify(manifest, null, 2) + "\n");
  // Windows gets its own checksums file so the two OS legs of the release matrix never clobber each
  // other's release/checksums.json; the release job merges both into the manifest.
  const checksums = Object.fromEntries(rows.map((r) => [`release/${r.name}`, r.full]));
  fs.writeFileSync(path.join(releaseDir, "checksums-win.json"), JSON.stringify({ version, generatedAt: manifest.generatedAt, files: checksums }, null, 2) + "\n");
  console.log("\npackage-win: artifacts");
  for (const r of rows) console.log(`  ${r.name.padEnd(42)} ${fmtSize(r.bytes).padStart(10)}  sha256:${r.sha256}…`);
  return 0;
}

async function hashFile(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("package-win.mjs")) {
  process.exitCode = await main();
}
