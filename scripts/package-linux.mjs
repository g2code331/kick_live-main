#!/usr/bin/env node
/**
 * Build the Linux desktop artifacts with electron-builder, then run the layout tests against the
 * real output.
 *
 *   node scripts/package-linux.mjs [--targets deb,AppImage] [--dir] [--skip-build] [--require-full]
 *
 * `--dir` stops at release/linux-unpacked (fast, no fpm/AppImage tooling needed) — useful for a
 * layout check without producing shippable artifacts.
 *
 * Requirement this script cannot satisfy offline: electron-builder downloads the Electron runtime
 * zip + fpm from GitHub release assets. If that host is unreachable the failure is printed with
 * the exact reason instead of a stack trace, because that is the #1 "CI works, my laptop doesn't"
 * complaint for this pipeline.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, fmtBytes, readVersionFile, walk } from "../tools/vite-shared.ts";
import { fmtSize, run, tail } from "./lib/run.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

function targets() {
  if (has("dir")) return ["dir"];
  return String(flag("targets", "deb,AppImage"))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export async function main() {
  const version = readVersionFile(REPO_ROOT);
  if (!has("skip-build")) {
    const build = run("npm run build", "npm", ["run", "build"], { cwd: REPO_ROOT });
    if (!build.ok) {
      console.error("package-linux: npm run build failed");
      return build.code || 1;
    }
  }
  for (const required of ["renderer/dist/index.html", "build/electron/main.cjs", "build/electron/preload.cjs"]) {
    if (!fs.existsSync(path.join(REPO_ROOT, required))) {
      console.error(`package-linux: ${required} is missing — run "npm run build" first`);
      return 1;
    }
  }

  const builderArgs = ["--no", "electron-builder", "--config", "electron-builder.yml", "--linux", "--x64", "--publish", "never"];
  for (const t of targets()) builderArgs.push(t === "dir" ? "--dir" : `--${t}`);
  console.log(`package-linux: electron-builder ${targets().join(",")} @ v${version}`);
  const res = run("electron-builder", "npx", builderArgs, { cwd: REPO_ROOT, env: { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? "" } });
  const out = res.stdout + res.stderr;
  if (!res.ok) {
    const blocked = /ETIMEDOUT|ENOTFOUND|self-signed|unable to verify|EAI_AGAIN|Could not download|download.*failed/i.test(out);
    console.error(`\npackage-linux: electron-builder failed${blocked ? " — it could not download the Electron runtime/fpm tooling" : ""}`);
    if (blocked) {
      console.error(
        "  This step needs network access to github.com release assets. In CI it is available;\n" +
          "  locally you can pre-seed the caches:\n" +
          "    export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/\n" +
          "    mkdir -p ~/.cache/electron-builder && <place electron-v" +
          version +
          "-linux-x64.zip in ~/.cache/electron>",
      );
    }
    console.error(tail(out, 20));
    return res.code || 1;
  }

  const releaseDir = path.join(REPO_ROOT, "release");
  const artifacts = fs.existsSync(releaseDir) ? walk(releaseDir, (f) => /\.(deb|AppImage|rpm|zip|tar\.gz|blockmap|yml|json)$/.test(f) && !/packaging-report|checksums|artifacts\.json/.test(f)) : [];
  const rows = [];
  for (const file of artifacts) {
    const stat = fs.statSync(file);
    rows.push({
      name: path.basename(file),
      bytes: stat.size,
      sha256: (await hashFile(file)).slice(0, 16),
      full: await hashFile(file),
    });
  }
  const manifest = {
    product: "kicklive",
    version,
    generatedAt: new Date().toISOString(),
    targets: targets(),
    artifacts: rows.map((r) => ({ name: r.name, bytes: r.bytes, sha256: r.sha256, path: `release/${r.name}` })),
  };
  fs.writeFileSync(path.join(releaseDir, "artifacts.json"), JSON.stringify(manifest, null, 2) + "\n");
  // release/*.deb/AppImage are hashed at build time so `verify-packaging` (tier C) and the update
  // manifest builder agree on one source of truth instead of each re-reading the files.
  const checksums = Object.fromEntries(rows.map((r) => [`release/${r.name}`, r.full]));
  fs.writeFileSync(path.join(releaseDir, "checksums.json"), JSON.stringify({ version, generatedAt: manifest.generatedAt, files: checksums }, null, 2) + "\n");
  console.log("\npackage-linux: artifacts");
  for (const r of rows) console.log(`  ${r.name.padEnd(42)} ${fmtSize(r.bytes).padStart(10)}  sha256:${r.sha256}…`);

  const verify = run("verify-packaging", process.execPath, ["scripts/verify-packaging.mjs", ...(has("dir") ? [] : ["--require-full"])], { cwd: REPO_ROOT });
  return verify.ok ? 0 : verify.code || 1;
}

async function hashFile(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("package-linux.mjs")) {
  process.exitCode = await main();
}
