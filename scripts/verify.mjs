#!/usr/bin/env node
/**
 * Aggregate repo verify gate: the things that must be true before any packaging or release step is
 * allowed to run. `check` is read-only and is what CI uses; `write` regenerates every derived file
 * and then re-checks (so "run the generator" is always a valid fix for a drift failure).
 *
 *   node scripts/verify.mjs check [--json]
 *   node scripts/verify.mjs write
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, walk } from "../tools/vite-shared.ts";
import { run, tail } from "./lib/run.mjs";
import yaml from "yaml";

const args = process.argv.slice(2);
const mode = args[0] === "write" ? "write" : "check";
const asJson = args.includes("--json");

function step(label, cmd, cmdArgs, opts = {}) {
  const res = run(label, cmd, cmdArgs, { cwd: REPO_ROOT, echo: !asJson, ...opts });
  return { label, ok: res.ok, code: res.code, out: res.stdout + res.stderr };
}

function hookScripts() {
  return walk(REPO_ROOT, (f) => f.endsWith(".sh") && !f.includes("/node_modules/") && !f.includes("/.git/") && !f.includes("/.local/") && !f.includes("/.canvas/"));
}

function checkHooks() {
  const problems = [];
  const notes = [];
  for (const file of hookScripts()) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (!/^#!(\/bin\/bash|\/usr\/bin\/env bash)/.test(text)) problems.push(`${rel}: first line must be "#!/bin/bash" or "#!/usr/bin/env bash" (dpkg runs it with sh otherwise)`);
    if (text.includes("\r\n")) problems.push(`${rel}: CRLF line endings will break /bin/bash`);
    if (/\bbash -c\b[^"']*$/.test(text)) notes.push(`${rel}: nested bash -c, double-check quoting`);
    // `set -e` in a maintainer script is a footgun (any non-zero from an optional tool aborts the
    // install), so the convention here is: set -u, guard optional tools, never exit non-zero
    // except for a genuinely broken payload.
    if (/^set -e/m.test(text)) problems.push(`${rel}: do not use "set -e" in a dpkg maintainer script`);
    if (!/^set -u/m.test(text)) problems.push(`${rel}: missing "set -u"`);
  }
  return { problems, notes };
}

function checkPagesContract() {
  // The web host is Cloudflare Pages, and the SPA-fallback/cache contract lives in three files under
  // public/ that Vite ships inside the bundle: a functions catch-all (dotted misses are real 404s,
  // extensionless routes get the shell), _routes.json (which requests the function sees), and _headers
  // (cache). They deploy silently wrong if edited, so the only check is here, pre-build. This replaces
  // vercel.json's rewrite rule — the same contract, expressed in the two files Pages reads.
  const problems = [];
  if (fs.existsSync(path.join(REPO_ROOT, "vercel.json")))
    problems.push("vercel.json is back: the web host is Cloudflare Pages; the contract lives in public/functions/, public/_routes.json and public/_headers");
  if (fs.existsSync(path.join(REPO_ROOT, "public", "_redirects")))
    problems.push(
      "public/_redirects is forbidden: a blanket `/* /index.html 200` answers missing hashed assets with HTML-200, which is the exact failure pages/functions documents. The shell fallback belongs in public/functions/.",
    );
  const fn = path.join(REPO_ROOT, "public", "functions", "[[catchall]].js");
  if (!fs.existsSync(fn)) problems.push("public/functions/[[catchall]].js is missing: every deep link (/team/4) will 404 instead of booting the SPA");
  else {
    const src = fs.readFileSync(fn, "utf8");
    if (!/ASSETS\.fetch/.test(src)) problems.push("the catch-all must read the shell from env.ASSETS (the static asset the build just uploaded), not from a URL fetch");
    if (!src.includes(String.raw`\.[A-Za-z0-9]+$`)) problems.push("the catch-all must keep extension-bearing misses as 404 (PWA pinning guard) while falling back for routes");
  }
  const routes = path.join(REPO_ROOT, "public", "_routes.json");
  if (!fs.existsSync(routes)) problems.push("public/_routes.json is missing: without it the function runs in front of every hashed asset, paying a Worker invocation per immutable file");
  else {
    const cfg = JSON.parse(fs.readFileSync(routes, "utf8"));
    if (!(cfg.exclude ?? []).includes("/assets/*")) problems.push("public/_routes.json must exclude /assets/* — hashed files are static content, not routes");
    if (!(cfg.include ?? []).includes("/*")) problems.push("public/_routes.json must include /* so extensionless routes reach the fallback");
  }
  const headers = path.join(REPO_ROOT, "public", "_headers");
  if (!fs.existsSync(headers)) problems.push("public/_headers is missing: hashed assets would not be immutable and sw.js would be cached past its own update");
  else {
    const h = fs.readFileSync(headers, "utf8");
    if (!/\/assets\/\*[\s\S]*max-age=31536000, immutable/.test(h)) problems.push("public/_headers: /assets/* must carry Cache-Control: public, max-age=31536000, immutable");
    if (!/\/sw\.js[\s\S]*no-store/.test(h)) problems.push("public/_headers: /sw.js must be no-store — a cached service worker pins the old app through updates");
    if (!/Service-Worker-Allowed: \//.test(h)) problems.push("public/_headers: /sw.js needs Service-Worker-Allowed: / (scope for the whole origin)");
  }
  return problems;
}

function checkGitattributes() {
  const file = path.join(REPO_ROOT, ".gitattributes");
  if (!fs.existsSync(file)) return [".gitattributes is missing: hook scripts need LF endings to stay runnable"];
  const text = fs.readFileSync(file, "utf8");
  const problems = [];
  if (!/\*\.sh[^]*text eol=lf/.test(text)) problems.push(".gitattributes: *.sh should be `text eol=lf` (a CRLF maintainer script fails to run in the deb)");
  if (!/package-lock\.json[^]*linguist-generated/.test(text)) problems.push(".gitattributes: package-lock.json should be linguist-generated (release diffs stay readable)");
  return problems;
}

/** The two template manifests are the shape every release is built from: keep them valid + in step. */
function checkManifestSamples() {
  const dir = path.join(REPO_ROOT, "packaging/updates");
  if (!fs.existsSync(dir)) return ["packaging/updates/ is missing (manifest templates for the update feed)"];
  const version = fs.readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(dir, file);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      problems.push(`packaging/updates/${file}: not parseable JSON (${err.message})`);
      continue;
    }
    // Templates carry a placeholder sha256, so the schema is validated by the release script itself
    // (gate 4) and here we only assert the parts that must not drift.
    if (json.product !== "kicklive") problems.push(`packaging/updates/${file}: product must be "kicklive"`);
    if (json.schemaVersion !== 1) problems.push(`packaging/updates/${file}: schemaVersion must be 1`);
    if (json.version !== version) problems.push(`packaging/updates/${file}: version ${json.version} != VERSION ${version}`);
    if (json.channel !== (file.includes("beta") ? "beta" : "stable")) problems.push(`packaging/updates/${file}: channel must match its file name`);
    for (const [platform, artifact] of Object.entries(json.platforms ?? {})) {
      const a = artifact;
      if (!/^[0-9a-f]{64}$/.test(String(a.sha256))) problems.push(`packaging/updates/${file}: ${platform}.sha256 must be 64 hex chars`);
      if (!String(a.url ?? "").startsWith("https://")) problems.push(`packaging/updates/${file}: ${platform}.url must be https`);
      if (
        String(a.fileName ?? "") !==
        String(a.url ?? "")
          .split("/")
          .pop()
      )
        problems.push(`packaging/updates/${file}: ${platform}.fileName must equal the url basename`);
    }
  }
  return problems;
}

/**
 * The workflows live here (ci/workflows) and are copied into .github/workflows by `npm run
 * ci:install`, because this repo's automation token cannot write to .github/workflows directly.
 * A syntactically-invalid workflow is invisible until someone pushes, so parse them here.
 */
function checkWorkflows() {
  const problems = [];
  const dirs = ["ci/workflows", ".github/workflows"];
  let parsed = 0;
  for (const rel of dirs) {
    const dir = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(dir)) {
      if (rel === "ci/workflows") problems.push("ci/workflows/ is missing");
      continue;
    }
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        const doc = yaml.parse(text);
        parsed += 1;
        if (!doc?.jobs || Object.keys(doc.jobs).length === 0) problems.push(`${rel}/${file}: no jobs`);
        for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
          if (!Array.isArray(def?.steps) || def.steps.length === 0) problems.push(`${rel}/${file}: job "${job}" has no steps`);
          // A step without runs-on/uses is the classic "job hangs waiting for a runner" bug.
          if (def?.["runs-on"] === undefined && def?.uses === undefined) problems.push(`${rel}/${file}: job "${job}" has no runs-on`);
          for (const [i, st] of (def?.steps ?? []).entries()) {
            if (st?.name === undefined && st?.uses === undefined && typeof st?.run === "string" && st.run.includes("\n"))
              problems.push(`${rel}/${file}: ${job} step ${String(i + 1)} is a multi-line run with no name`);
            if (st?.if !== undefined && String(st.if).includes("${{") && !/[')}]/.test(String(st.if).slice(-1)))
              problems.push(`${rel}/${file}: ${job} step ${String(i + 1)} has a suspicious if: expression`);
          }
        }
        if (doc?.on === undefined) problems.push(`${rel}/${file}: no trigger defined`);
      } catch (err) {
        problems.push(`${rel}/${file}: YAML parse error: ${err.message.split("\n")[0]}`);
      }
    }
  }
  if (parsed === 0) problems.push("no workflow files found in ci/workflows");
  const src = new Set(fs.existsSync(path.join(REPO_ROOT, "ci/workflows")) ? fs.readdirSync(path.join(REPO_ROOT, "ci/workflows")) : []);
  const dst = new Set(fs.existsSync(path.join(REPO_ROOT, ".github/workflows")) ? fs.readdirSync(path.join(REPO_ROOT, ".github/workflows")) : []);
  for (const f of src) if (!dst.has(f)) problems.push(`.github/workflows/${f}: not installed (run npm run ci:install)`);
  return problems;
}

function checkNoStaleLockfileVersion() {
  const lock = path.join(REPO_ROOT, "package-lock.json");
  if (!fs.existsSync(lock)) return ["package-lock.json is missing — `npm ci` cannot run"];
  const data = JSON.parse(fs.readFileSync(lock, "utf8"));
  const problems = [];
  const rootPkg = data.packages?.[""];
  if (!rootPkg) problems.push("package-lock.json: no root package entry (regenerate with npm install)");
  else {
    const version = fs.readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
    if (rootPkg.version !== version) problems.push(`package-lock.json root version ${rootPkg.version} != VERSION ${version} (run npm install --package-lock-only)`);
    if (rootPkg.name !== "kicklive") problems.push(`package-lock.json root name is "${rootPkg.name}" (must be kicklive)`);
  }
  return problems;
}

/**
 * `.env.staging` / `.env.production` are tracked, generated files: if one goes stale the next Pages build ships
 * a bundle pointed at the wrong project, and that is invisible until somebody signs in and sees nothing. Cheaper
 * to prove here than to discover in a deploy log.
 */
function checkWebEnvSync() {
  const res = run("", process.execPath, ["scripts/build-web-env.mjs", "--check"], { echo: false });
  return res.code === 0 ? [] : [(res.stdout + res.stderr).trim().split("\n").slice(-2).join(" ") || "web:env:check failed"];
}

/**
 * The migrations are *executed* on a real Postgres (PGlite) as part of `verify`, because three privilege defects
 * in this repository were invisible to every static check and only surfaced when a human pasted SETUP.sql into
 * the Supabase editor. It skips — naming the reason — when the dev dependency is absent, since that is a
 * half-installed tree rather than a broken migration.
 */
function checkSqlExecutes() {
  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules/@electric-sql/pglite/package.json"))) {
    return ["SKIP (not a failure): @electric-sql/pglite is not installed — run `npm ci`"];
  }
  const res = run("", process.execPath, ["scripts/sql-pglite.mjs", "--json"], { echo: false });
  if (res.code === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return [`sql-pglite exited ${String(res.code)} without JSON output`, (res.stderr || "").trim().split("\n")[0]];
  }
  return (parsed.failures || []).slice(0, 8).map((f) => `[${f.code}] ${f.file}: ${f.message}`);
}

/**
 * A GitHub Actions file whose `${…}` expressions were mangled while writing it still *parses* as YAML — the
 * damage looks like a plausible string value, and the failure only appears on the runner as "Unrecognized named-value"
 * or an empty secret. This happened for real while authoring full-stack.yml, so it is now a check: any three
 * consecutive asterisks inside a workflow is treated as exactly what it is, a redaction artefact that landed in
 * a committed file.
 */
function checkWorkflowExpressions() {
  const problems = [];
  for (const rel of ["ci/workflows", ".github/workflows"]) {
    const dir = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const masked = (text.match(/\*{3}/g) || []).length;
      if (masked) problems.push(`${rel}/${file}: ${String(masked)} run(s) of "***" — an expression was mangled in transit; rewrite the file and re-run npm run ci:install`);
      // Every action expression must be closed on the same line it opens.
      text.split("\n").forEach((line, i) => {
        const opens = (line.match(/\$\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        if (opens && closes < opens) problems.push(`${rel}/${file}:${String(i + 1)}: \${ opened ${String(opens)}x but only ${String(closes)} closing brace(s)`);
      });
    }
  }
  return problems;
}

/**
 * No merge-conflict markers anywhere the build reads.
 *
 * Not paranoia, archaeology: `workers/wrangler.toml` — the single source of truth for both Supabase triples, read
 * by regex by this repo's own scripts and parsed by `toml` in CI — carried a committed
 * `<<<<<<< HEAD / ======= / >>>>>>> origin/arena…` block from a hand-resolved merge, and *every* check stayed
 * green because a regex scanner walks the lines it cares about and skips the garbage in between. The docs file
 * beside it had the same block, and markdown just renders it as an ugly quote. Anything that "parses well enough"
 * hides that a deploy reading that file dies on line 46.
 */
function checkMergeMarkers() {
  const problems = [];
  const exts = /\.(ts|tsx|js|mjs|cjs|json|toml|ya?ml|sql|md)$/;
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".cache", ".tmp"]);
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (problems.length > 8) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(abs);
        continue;
      }
      if (!exts.test(entry.name)) continue;
      const text = fs.readFileSync(abs, "utf8");
      const line = text.split("\n").findIndex((l) => /^<{7}( |$)/.test(l) || /^>{7}( |$)/.test(l));
      if (line >= 0) problems.push(`${path.relative(REPO_ROOT, abs)}:${String(line + 1)}: unresolved merge marker — resolve it, then re-run`);
    }
  };
  walk(REPO_ROOT);
  return problems;
}

export async function main() {
  const results = [];
  if (mode === "write") {
    results.push(step("branding:write", process.execPath, ["scripts/branding.mjs", "write"]));
    results.push(step("version:write", process.execPath, ["scripts/version.mjs", "write"]));
  }
  results.push(step("branding:check", process.execPath, ["scripts/branding.mjs", "check"]));
  results.push(step("version:check", process.execPath, ["scripts/version.mjs", "check"]));
  results.push(step("typecheck", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]));
  results.push(step("typecheck:node", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.node.json"]));
  // The Worker is a third program, and until now only `npm run gates` typechecked it: a broken
  // `workers/src` could pass `npm run verify`, which is the command the checklists tell people to run.
  results.push(step("typecheck:workers", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.workers.json"]));
  results.push(step("format:check", process.execPath, ["node_modules/prettier/bin/prettier.cjs", "--check", "."]));

  // Two checks a machine with no database and no Cloudflare account can still run, each of which has already
  // caught something real: a stale mode file that would have shipped a misconfigured bundle, and a privilege
  // assertion that was certifying nothing. Both are cheap; neither is decorative.
  {
    const probs = checkWebEnvSync();
    results.push({ label: "web env files (build:web:staging / :production)", ok: probs.length === 0, code: probs.length ? 1 : 0, out: probs.join("\n") });
  }
  {
    const probs = checkSqlExecutes();
    const skipped = probs.length === 1 && probs[0].startsWith("SKIP");
    results.push({ label: "migrations execute (PGlite, supabase/SETUP.sql)", ok: probs.length === 0 || skipped, code: probs.length && !skipped ? 1 : 0, out: probs.join("\n") });
  }

  const hooks = checkHooks();
  const hookResults = [];
  for (const file of hookScripts()) {
    const res = run("", "bash", ["-n", file], { echo: false });
    hookResults.push({ label: `bash -n ${path.relative(REPO_ROOT, file)}`, ok: res.code === 0, code: res.code, out: res.stdout + res.stderr });
  }
  results.push(...hookResults);
  if (hooks.problems.length > 0) results.push({ label: "hook script conventions", ok: false, code: 1, out: hooks.problems.join("\n") });
  else results.push({ label: "hook script conventions", ok: true, code: 0, out: hooks.notes.join("\n") });

  for (const [label, problems] of [
    ["Pages contract (public/_redirects + _headers)", checkPagesContract()],
    [".gitattributes", checkGitattributes()],
    ["package-lock sanity", checkNoStaleLockfileVersion()],
    ["update manifest templates", checkManifestSamples()],
    ["CI workflows (yaml + installed copy)", checkWorkflows()],
  ]) {
    results.push({ label, ok: problems.length === 0, code: problems.length === 0 ? 0 : 1, out: problems.join("\n") });
  }

  {
    // One walk of the tree, not three: this scans every tracked source file.
    const probs = checkMergeMarkers();
    results.push({ label: "no committed merge-conflict markers", ok: probs.length === 0, code: probs.length === 0 ? 0 : 1, out: probs.join("\n") });
  }

  {
    const probs = checkWorkflowExpressions();
    results.push({ label: "workflow expressions intact (no masked $-braces)", ok: probs.length === 0, code: probs.length ? 1 : 0, out: probs.join("\n") });
  }

  const failed = results.filter((r) => !r.ok);
  if (asJson) {
    console.log(JSON.stringify({ mode, ok: failed.length === 0, results: results.map((r) => ({ label: r.label, ok: r.ok, out: tail(r.out, 6) })) }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.ok ? "✅ PASS" : "❌ FAIL"} ${r.label}`);
      if (!r.ok)
        console.log(
          tail(r.out, 12)
            .split("\n")
            .map((l) => `       ${l}`)
            .join("\n"),
        );
    }
    console.log(`\nverify (${mode}): ${String(results.length - failed.length)}/${String(results.length)} checks passed`);
    if (failed.length > 0 && mode === "check") console.log('hint: "npm run verify:write" regenerates the derived files');
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("verify.mjs")) {
  process.exitCode = await main();
}
