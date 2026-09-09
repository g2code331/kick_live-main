#!/usr/bin/env node
/**
 * Prints the Worker's route table as a Markdown table — the README embeds its output so the
 * documentation cannot claim routes the code does not have.
 *
 *   node scripts/worker-routes.mjs            # markdown, for copy/paste into workers/README.md
 *   node scripts/worker-routes.mjs --json     # machine-readable, for the deploy checklist
 *   node scripts/worker-routes.mjs --check    # exit 1 if workers/README.md is out of date
 *
 * It imports `workers/src/router.ts` directly (node 22 strips the types; the router has no runtime
 * dependencies beyond types), so there is exactly one route table in this repository.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

const { ROUTES } = await import(path.join(REPO, "workers/src/router.ts"));
const { capabilityTable } = await import(path.join(REPO, "workers/src/lib/capabilities.ts"));

const status = (route) => (route.implemented ? "**yes**" : "—");

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        total: ROUTES.length,
        implemented: ROUTES.filter((r) => r.implemented).length,
        capabilities: capabilityTable(),
        routes: ROUTES.map((r) => ({
          method: r.method,
          pattern: r.pattern,
          capability: r.capability,
          phase: r.phase,
          implemented: Boolean(r.implemented),
          rateLimit: r.rateLimit ?? "public",
          cache: r.cache,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Simple, stable markdown (no alignment padding — prettier owns the final formatting).
const markdown = [
  "| Route | Capability | Cache | Rate budget | Phase | Live | Purpose |",
  "| ----- | ---------- | ----- | ----------- | ----- | ---- | ------- |",
  ...ROUTES.map(
    (route) =>
      `| \`${route.method} ${route.pattern}\` | ${route.capability ?? "_public_"} | ${route.cache} | ${route.rateLimit ?? "public"} | ${route.phase} | ${status(route)} | ${route.summary.replace(/\s+/g, " ").trim()}${route.invariants ? ` — _${route.invariants.replace(/\s+/g, " ").trim()}_` : ""} |`,
  ),
].join("\n");

if (args.includes("--check")) {
  const readme = fs.readFileSync(path.join(REPO, "workers/README.md"), "utf8");
  const declared = (readme.match(/^\| `(GET|POST|PUT|PATCH|DELETE) /gm) ?? []).length;
  if (declared !== ROUTES.length) {
    console.error(`worker-routes: README lists ${String(declared)} routes, router.ts declares ${String(ROUTES.length)} — regenerate with \`node scripts/worker-routes.mjs\``);
    process.exit(1);
  }
  console.log(`worker-routes: README lists all ${String(ROUTES.length)} declared routes`);
  process.exit(0);
}

console.log(markdown);
