#!/usr/bin/env node
/**
 * Install / verify the GitHub Actions workflows.
 *
 * This repo's bot token cannot write to .github/workflows/** (GitHub rejects the push from a
 * GitHub App without Actions:write), so the *source of truth* for CI lives in `ci/workflows/` and
 * is copied into place:
 *
 *   npm run ci:install     # copy ci/workflows/*.yml → .github/workflows/
 *   npm run ci:check       # fail if .github/workflows is out of sync with ci/workflows
 *
 * `--push` additionally commits and pushes the result, so a release manager with the right
 * permission can install CI from a clean checkout.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT } from "../tools/vite-shared.ts";
import { run } from "./lib/run.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const doPush = args.includes("--push");
const SRC = path.join(REPO_ROOT, "ci/workflows");
const DEST = path.join(REPO_ROOT, ".github/workflows");

export function diffWorkflows() {
  const srcFiles = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")) : [];
  const problems = [];
  for (const f of srcFiles) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    const destPath = path.join(DEST, f);
    if (!fs.existsSync(destPath)) {
      problems.push(`.github/workflows/${f}: missing`);
      continue;
    }
    const dest = fs.readFileSync(destPath, "utf8");
    if (dest.replace(/^#.*\n/, "") !== src.replace(/^#.*\n/, "")) {
      const lines = src.split("\n").filter((l, i) => l !== dest.split("\n")[i]).length;
      problems.push(`.github/workflows/${f}: ${String(lines)} line(s) differ from ci/workflows/${f}`);
    }
  }
  const destFiles = fs.existsSync(DEST) ? fs.readdirSync(DEST).filter((f) => f.endsWith(".yml")) : [];
  for (const f of destFiles) if (!srcFiles.includes(f)) problems.push(`.github/workflows/${f}: not present in ci/workflows (delete it there too)`);
  return { problems, files: srcFiles };
}

export async function main() {
  const { problems, files } = diffWorkflows();
  if (check) {
    if (problems.length > 0) {
      console.error("ci:check: .github/workflows is out of sync with ci/workflows:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("  fix: npm run ci:install");
      return 1;
    }
    console.log(`ci:check: in sync (${files.length} workflows installed)`);
    return 0;
  }
  fs.mkdirSync(DEST, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
    console.log(`ci:install: .github/workflows/${f}`);
  }
  if (problems.length > 0) console.log(`ci:install: resolved ${String(problems.length)} sync problem(s)`);
  if (doPush) {
    const version = "ci: install GitHub Actions workflows";
    const add = run("git add", "git", ["add", ".github/workflows"], { cwd: REPO_ROOT, echo: false });
    const commit = run("git commit", "git", ["commit", "-m", version], { cwd: REPO_ROOT, echo: false });
    const push = run("git push", "git", ["push"], { cwd: REPO_ROOT, echo: false });
    for (const r of [add, commit, push]) if (!r.ok) console.error(r.stdout + r.stderr);
    return push.ok ? 0 : 1;
  }
  console.log("ci:install: done. Commit .github/workflows (a human with Actions:write may be required) and push.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("install-ci.mjs")) {
  process.exitCode = await main();
}
