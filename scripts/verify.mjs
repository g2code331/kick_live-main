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

function checkVercelRewrite() {
  const file = path.join(REPO_ROOT, "vercel.json");
  if (!fs.existsSync(file)) return ["vercel.json is missing"];
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = [];
  const rewrites = cfg.rewrites ?? [];
  const catchAll = rewrites.find((r) => r.source === "/(.*)" || r.source === "/((?!.*\\.).*)" || (r.source ?? "").includes(".*"));
  if (!catchAll) problems.push("vercel.json: no SPA rewrite at all (deep links will 404)");
  else if (catchAll.source === "/(.*)")
    problems.push('vercel.json: rewrite "/(.*)" -> /index.html also swallows missing assets, so a typo\'d /assets/x.js returns HTML with a 200; exclude dotted paths');
  const headers = cfg.headers ?? [];
  const hasJsType = headers.some((h) => JSON.stringify(h).includes("text/javascript"));
  if (!hasJsType) problems.push("vercel.json: no explicit Content-Type for /assets/*.js (defence in depth for module scripts)");
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
  results.push(step("format:check", process.execPath, ["node_modules/prettier/bin/prettier.cjs", "--check", "."]));

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
    ["vercel.json rewrite", checkVercelRewrite()],
    [".gitattributes", checkGitattributes()],
    ["package-lock sanity", checkNoStaleLockfileVersion()],
    ["update manifest templates", checkManifestSamples()],
    ["CI workflows (yaml + installed copy)", checkWorkflows()],
  ]) {
    results.push({ label, ok: problems.length === 0, code: problems.length === 0 ? 0 : 1, out: problems.join("\n") });
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
