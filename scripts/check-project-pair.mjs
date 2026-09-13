#!/usr/bin/env node
/**
 * Proves that every Supabase project named in this repository is named *consistently*: the URL, the
 * `SUPABASE_PROJECT_REF` and the anon key must all belong to the same project, in every environment block of
 * `workers/wrangler.toml` and in every generated `.env.<mode>`.
 *
 *   node scripts/check-project-pair.mjs            # human output
 *   node scripts/check-project-pair.mjs --json
 *
 * WHY. A staging project was renamed and only half the pair moved with it: the bundle was rebuilt with the new
 * URL but kept the old project's anon key, so GoTrue answered every sign-in and sign-up with a bare
 * `401 (Unauthorized)`. Nothing in the pipeline objected, because each value is individually well-formed and
 * the boot guard's URL↔key comparison only fires on a *JWT-shaped* key — and a legacy key that has been
 * invalidated still decodes to its own old ref, which the guard had never been asked about. This script asks.
 *
 * It is deliberately not a warning, and it runs in CI before anything is deployed: a client wired to the wrong
 * database is the single failure mode this repository has now been caught producing twice.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const AS_JSON = process.argv.includes("--json");

/** The `ref` claim of a Supabase anon JWT, decoded without verifying anything (anon keys are public). */
export function refFromAnonKey(key) {
  const payload = String(key || "").split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json?.ref === "string" ? json.ref : null;
  } catch {
    return null;
  }
}

const isJwtKey = (k) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(k || ""));
const isPublishable = (k) => /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(String(k || ""));
const refFromUrl = (u) => /^https:\/\/([a-z0-9]+)\.supabase\.(co|in|dev)$/i.exec(String(u || ""))?.[1] ?? null;

/** `[env.x.vars]` / top-level `[vars]` — the same restricted subset of TOML wrangler.toml is written in. */
function tomlBlocks(text) {
  const out = [];
  let cur = { name: "vars (top level)", lines: [] };
  for (const line of text.split("\n")) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) {
      if (cur.lines.length) out.push(cur);
      cur = { name: h[1].trim(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.length) out.push(cur);
  return out;
}

function readVars(lines) {
  const v = {};
  for (const l of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(l);
    if (m) v[m[1]] = m[2];
  }
  return v;
}

function readDotEnv(text) {
  const v = {};
  for (const l of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
    if (m && !l.trim().startsWith("#")) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return v;
}

export function checkRepo(root = REPO) {
  const problems = [];
  const rows = [];

  const check = (where, url, ref, key, extra) => {
    const urlRef = refFromUrl(url);
    const keyRef = isJwtKey(key) ? refFromAnonKey(key) : null;
    const row = { where, urlRef, declaredRef: ref || null, keyRef, keyKind: isJwtKey(key) ? "legacy-jwt" : isPublishable(key) ? "publishable" : key ? "unknown" : "absent" };
    rows.push(row);
    if (!url) return;
    if (!urlRef) problems.push(`${where}: SUPABASE_URL "${url}" is not an https://<ref>.supabase.co|in|dev URL`);
    if (ref && urlRef && ref !== urlRef) problems.push(`${where}: SUPABASE_PROJECT_REF "${ref}" does not match the URL's project "${urlRef}"`);
    if (!key) {
      problems.push(`${where}: no anon key set, so the SPA/Worker cannot reach ${urlRef || "this project"} at all`);
      return;
    }
    if (keyRef && urlRef && keyRef !== urlRef) {
      problems.push(
        `${where}: the anon key is a JWT issued for project "${keyRef}" but the URL points at "${urlRef}". ` +
          `GoTrue answers this with 401 on /auth/v1/signup and /auth/v1/token. Fix: Settings → API keys → copy ` +
          `this project's anon/publishable key into SUPABASE_ANON_KEY, then re-run \`npm run web:env\`.`,
      );
    }
    if (!isJwtKey(key) && !isPublishable(key)) {
      problems.push(`${where}: the anon key is neither a Supabase anon JWT (eyJ…) nor a publishable key (sb_publishable_…)`);
    }
    if (isPublishable(key)) {
      // Nothing to compare: a publishable key carries no ref claim, so the URL is the only evidence. Say so,
      // rather than pretending the check passed with more confidence than it has.
      rows[rows.length - 1].note = "publishable key: no ref claim to compare; the URL is the only identity here";
    }
  };

  const tomlPath = path.join(root, "workers/wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    for (const b of tomlBlocks(fs.readFileSync(tomlPath, "utf8"))) {
      if (!/(^|\.)vars$/.test(b.name) && b.name !== "vars") continue;
      const v = readVars(b.lines);
      if (!v.SUPABASE_URL && !v.SUPABASE_PROJECT_REF) continue;
      check(`workers/wrangler.toml [${b.name}]`, v.SUPABASE_URL, v.SUPABASE_PROJECT_REF, v.SUPABASE_ANON_KEY);
      const expected = b.name === "env.staging.vars" ? ".env.staging" : b.name === "env.production.vars" ? ".env.production" : null;
      if (expected) {
        const f = path.join(root, expected);
        if (!fs.existsSync(f)) problems.push(`${expected} is missing — run \`npm run web:env\` so the Pages build has a pair`);
        else {
          const e = readDotEnv(fs.readFileSync(f, "utf8"));
          check(`${expected}`, e.VITE_SUPABASE_URL, e.VITE_EXPECTED_PROJECT_REF, e.VITE_SUPABASE_ANON_KEY);
          if (e.VITE_SUPABASE_URL !== v.SUPABASE_URL) problems.push(`${expected}: VITE_SUPABASE_URL differs from [${b.name}] — run \`npm run web:env\``);
          if (e.VITE_SUPABASE_ANON_KEY !== v.SUPABASE_ANON_KEY) problems.push(`${expected}: the anon key differs from [${b.name}] — run \`npm run web:env\``);
        }
      }
    }
  } else {
    problems.push("workers/wrangler.toml is missing");
  }

  return { problems, rows };
}

// CLI behaviour only when run directly: scripts/build-web-env.mjs imports refFromAnonKey from here, and a
// module that runs a full check and calls process.exit() on import would hijack its importer's exit code.
const DIRECT = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (DIRECT) {
  const { problems, rows } = checkRepo();
  if (AS_JSON) console.log(JSON.stringify({ ok: problems.length === 0, problems, rows }, null, 2));
  else {
    for (const r of rows) {
      const ok = !problems.some((pr) => pr.startsWith(r.where));
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${r.where.padEnd(46)} url=${String(r.urlRef).padEnd(22)} declared=${String(r.declaredRef).padEnd(22)} key=${String(r.keyRef ?? r.keyKind).padEnd(22)}${r.note ? ` (${r.note})` : ""}`,
      );
    }
    if (problems.length === 0) console.log(`project-pair: ${String(rows.length)} surfaces checked, every URL/ref/key triple belongs to one project ✔`);
    else {
      console.error(`project-pair: ${String(problems.length)} problem(s)`);
      for (const pr of problems) console.error(`  ${pr}`);
    }
    if (problems.length) process.exit(1);
  }
}
