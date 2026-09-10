#!/usr/bin/env node
/**
 * Add (or verify) the `--import ./scripts/lib/ts-loader.mjs` prefix on every `node …` script in `package.json`.
 *
 * Why a script rather than a committed `package.json`: the toolchain needs that flag on the *node invocation*, not
 * inside a script body, because every checker imports its `.ts` sources statically — by the time any code in
 * `scripts/worker-routes.mjs` runs, the module graph (including `workers/src/router.ts`) has already been loaded or
 * failed. `package.json` is also the one file in this repository that a local clone is most likely to have its own
 * opinions about, and a prefix is a one-line, idempotent, reversible edit that a script can apply to whatever your
 * copy currently holds — which is the only version of "the fix ships" that cannot clobber somebody's keys.
 *
 *     node scripts/install-ts-loader.mjs           # report
 *     node scripts/install-ts-loader.mjs --write    # apply
 *
 * Node ≥ 22.18 with type stripping enabled needs none of this; `scripts/lib/ts-loader.mjs` registers a hook that
 * shadows the built-in loader, which is a no-op for behaviour and costs a transpile per `.ts` file. Check yours
 * with `node -p "process.features.typescript"`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "package.json");
export const LOADER_FLAG = "--import ./scripts/lib/ts-loader.mjs";

const write = process.argv.includes("--write");
const pkg = JSON.parse(readFileSync(MANIFEST, "utf8"));
const scripts = pkg.scripts ?? {};
const needs = Object.entries(scripts).filter(([name, command]) => name !== "ci:install-loader" && command.startsWith("node ") && !command.includes(LOADER_FLAG));
const covered = Object.entries(scripts).filter(([, command]) => command.startsWith("node ") && command.includes(LOADER_FLAG));

if (needs.length === 0) {
  console.log(`ts-loader: ${String(covered.length)} of the ${String(covered.length)} node scripts already load scripts/lib/ts-loader.mjs`);
  process.exit(0);
}

for (const [name, command] of needs) console.log(`${write ? "patch" : "needs"}  ${name}  ${command}`);
if (!write) {
  console.log(`\nts-loader: ${String(needs.length)} script(s) would fail on a Node without TypeScript stripping. Apply with:  node scripts/install-ts-loader.mjs --write`);
  process.exit(1);
}

for (const [name, command] of needs) scripts[name] = command.replace("node ", `node ${LOADER_FLAG} `, 1);
pkg.scripts = scripts;
pkg.scripts["ci:install-loader"] = "node scripts/install-ts-loader.mjs --write";
writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`ts-loader: wrote package.json (${String(needs.length)} script(s) patched)`);
