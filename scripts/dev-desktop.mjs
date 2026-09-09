#!/usr/bin/env node
/**
 * Run the desktop shell against a live Vite build, no packaging involved.
 *
 *   npm run dev:desktop            # builds renderer+main, then launches electron
 *   npm run dev:desktop -- --watch # rebuild bundles on change (renderer still needs its own vite)
 *
 * Electron is launched with `--no-sandbox` only when KICKLIVE_DEV=1 and the chrome-sandbox helper
 * is not setuid, because a checkout has no root-owned helper. Documented, not silent.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT } from "../tools/vite-shared.ts";
import { run } from "./lib/run.mjs";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const skipBuild = args.includes("--skip-build");

export async function main() {
  if (!skipBuild) {
    for (const step of ["build:renderer", "build:desktop"]) {
      const res = run(`npm run ${step}${watch ? " -- --watch" : ""}`, "npm", ["run", step, ...(watch ? ["--", "--watch"] : [])], { cwd: REPO_ROOT });
      if (!res.ok) return res.code || 1;
    }
  }
  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules/.bin/electron"))) {
    console.error('dev:desktop: electron is not installed here. Run "npm install" first (the binary comes from a GitHub release asset).');
    return 1;
  }
  const electronArgs = [".", "--enable-logging=stderr"];
  const res = run("electron", "node_modules/.bin/electron", electronArgs, {
    cwd: REPO_ROOT,
    env: {
      KICKLIVE_DEV: "1",
      KICKLIVE_VERBOSE: "1",
      KICKLIVE_RENDERER_ROOT: process.env.KICKLIVE_RENDERER_ROOT ?? path.join(REPO_ROOT, "renderer/dist"),
    },
  });
  return res.code || 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("dev-desktop.mjs")) {
  process.exitCode = await main();
}
