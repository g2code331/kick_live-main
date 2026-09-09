#!/usr/bin/env node
/**
 * Emits the PWA surface into a build output directory:
 *   <outDir>/sw.js         bundled from pwa/sw.ts (esbuild, so it can import shared code)
 *   <outDir>/version.json  what the SW + the update control poll
 *
 * `npm run build:web` calls this after `vite build`; the desktop renderer build deliberately gets
 * no SW (a service worker over file:// only produces console noise).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, readVersionFile, writeFileEnsured } from "../tools/vite-shared.ts";

export async function buildPwa({ outDir, target = "web", log = console.log } = {}) {
  const version = readVersionFile(REPO_ROOT);
  const absOut = path.resolve(outDir);
  if (!fs.existsSync(absOut)) {
    throw new Error(`build-pwa: out dir does not exist (did the vite build run?): ${absOut}`);
  }

  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(REPO_ROOT, "pwa/sw.ts")],
    outfile: path.join(absOut, "sw.js"),
    bundle: true,
    format: "iife",
    target: ["es2022"],
    platform: "browser",
    minify: false,
    legalComments: "none",
    define: {
      __APP_VERSION__: JSON.stringify(version),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    logLevel: "warning",
    metafile: true,
  });

  const meta = {
    schemaVersion: 1,
    product: "kicklive",
    version,
    target,
    generatedAt: new Date().toISOString(),
    sw: "/sw.js",
    update: {
      manifestPath: "/version.json",
      // Where the update control looks for a newer release (overridable per build).
      manifestUrl:
        process.env.VITE_UPDATE_MANIFEST_URL ??
        (version.includes("-")
          ? "https://github.com/g2code331/kick_live-main/releases/download/update-channel-beta/kicklive-update-beta.json"
          : "https://github.com/g2code331/kick_live-main/releases/latest/download/kicklive-update-stable.json"),
    },
  };
  writeFileEnsured(path.join(absOut, "version.json"), JSON.stringify(meta, null, 2) + "\n");

  const swBytes = fs.readFileSync(path.join(absOut, "sw.js"));
  const digest = createHash("sha256").update(swBytes).digest("hex").slice(0, 12);
  log(
    `build-pwa: ${path.relative(REPO_ROOT, absOut)}/sw.js (${String(Math.round(swBytes.length / 1024))} KiB sha256:${digest}) + version.json @ ${version}; ${result.metafile ? Object.keys(result.metafile.inputs).length : 0} inputs`,
  );
  return { version, swSize: swBytes.length };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-pwa.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out-dir");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : "dist/web";
  const targetIdx = args.indexOf("--target");
  await buildPwa({ outDir, target: targetIdx >= 0 ? args[targetIdx + 1] : "web" });
}
