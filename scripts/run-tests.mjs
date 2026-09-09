#!/usr/bin/env node
/**
 * Test entry point: `node scripts/run-tests.mjs [unit|integration|all] [-- <node --test args>]`
 *
 * Why a script and not `node --test tests/unit`: this project runs TypeScript sources directly
 * through node's type stripping, and node's directory scan only matches its built-in JS patterns,
 * so a bare directory argument finds zero tests and exits 0. A green "no tests" result in CI is the
 * worst possible outcome, so the file list is expanded here and an empty list is a hard failure.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const passthroughIndex = args.indexOf("--");
const positional = (passthroughIndex >= 0 ? args.slice(0, passthroughIndex) : args).filter((a) => !a.startsWith("-"));
const extra = passthroughIndex >= 0 ? args.slice(passthroughIndex + 1) : args.filter((a) => a.startsWith("-"));
const which = positional[0] ?? "all";

function testFiles(dir) {
  const root = path.join(REPO, dir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.test\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
    }
  }
  return out.sort();
}

const dirs = which === "all" ? ["tests/unit", "tests/integration"] : [`tests/${which}`];
const files = dirs.flatMap(testFiles);
if (files.length === 0) {
  console.error(`run-tests: no *.test.ts files found under ${dirs.join(", ")} — refusing to report success`);
  process.exit(1);
}

// `--test-reporter-destination` is intentionally omitted: node resolves it relative to cwd, so a
// bare "1" writes the report into a file called ./1 instead of onto the console.
const reporter = process.env.TEST_REPORTER ?? "spec";
const cmdArgs = ["--test", "--test-reporter", reporter, ...extra, ...files];
console.log(`run-tests: ${String(files.length)} file(s) from ${dirs.join(", ")}`);
const res = spawnSync(process.execPath, cmdArgs, { cwd: REPO, stdio: "inherit", env: { ...process.env } });
if (res.error) {
  console.error(`run-tests: failed to spawn node --test: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
