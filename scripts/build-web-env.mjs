#!/usr/bin/env node
/**
 * Writes the two Vite mode files `.env.staging` and `.env.production`, derived from
 * `workers/wrangler.toml` — the file that already carries these values, and the one the Worker is deployed from.
 *
 *   node scripts/build-web-env.mjs           # write both
 *   node scripts/build-web-env.mjs --check    # fail if either is stale (CI gate)
 *
 * WHY THIS EXISTS. A Pages deploy that succeeded and then served "KickLive is not configured" is the ordinary
 * outcome of `npm run build:web` run without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`: the build produces a
 * complete, working-looking bundle for a project that is not the app's backend, and nothing in the pipeline
 * objects. The boot guard in src/lib/env.ts is the last line and it does its job — but by then the artefact is
 * already deployed. The documented workaround (`VITE_… npm run build:web`) is worse than it looks: an inline
 * env pair is easy to omit on the second of two copy-pasted commands, and it *cannot* be enforced from a script.
 *
 * So the pair moves into Vite's own per-mode env files, and `npm run build:web:staging` /
 * `build:web:production` select one. That changes the failure from "silently unconfigured bundle" to "the mode
 * file is missing", which is a hard error before a single byte is written.
 *
 * WHY A GENERATOR AND NOT A COMMITTED KEY. `SUPABASE_ANON_KEY` per project already lives in
 * `workers/wrangler.toml` — correctly, because an anon key is public by Supabase's own threat model (RLS is the
 * enforcement layer, and the whole browser bundle is readable anyway). Writing the same value into a second
 * tracked file would create two places for it to drift apart, and drift between a URL and a key is precisely
 * the bug `env.ts` was introduced to catch. Deriving one from the other makes the drift impossible and makes
 * `--check` the thing that proves they still agree.
 *
 * WHAT IS NOT GENERATED. `VITE_API_BASE_URL` stays empty on purpose: the app talks to same-origin `/api`, which
 * the Vite dev proxy serves locally and Cloudflare serves directly once the custom domain routes `/api/*` to the
 * Worker. A per-environment API origin here would be a second routing decision, in a second place, to forget.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT } from "../tools/vite-shared.ts";

const CONFIG = "workers/wrangler.toml";
const ENVS = ["staging", "production"];
const CHECK = process.argv.includes("--check");
const JSON_OUT = process.argv.includes("--json");

const LAG_NOTE =
  "one revision behind on purpose: staging's project moved and only the project owner can supply the new anon key. " +
  "Finish with: paste SUPABASE_ANON_KEY into [env.staging.vars], run `npm run web:env`, commit both files. " +
  "`npm run pair:check` (and CI's config job) stay red until then.";

/**
 * True when the file on disk is *internally consistent* — its own URL, its own baked-in expected ref and its own
 * key all naming one project — while that project is simply not the one the Worker config points at now. That
 * state is a working app pointed at an older database. The half-moved state (URL new, key old) is the one that
 * returns 401 on the login page, and it never passes here.
 */
function isSelfConsistent(text) {
  const read = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(String(text || ""))?.[1]?.trim() ?? "";
  const urlRef = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in|dev)$/i.exec(read("VITE_SUPABASE_URL"))?.[1] ?? null;
  if (!urlRef) return false;
  if (read("VITE_EXPECTED_PROJECT_REF") !== urlRef) return false;
  const key = read("VITE_SUPABASE_ANON_KEY");
  const keyRef = keyRefOf(key);
  return keyRef === null || keyRef === urlRef;
}

/** Decode a Supabase anon JWT's `ref` claim without verifying anything (anon keys are public by design). */
function keyRefOf(key) {
  const payload = String(key || "").split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json?.ref === "string" ? json.ref : null;
  } catch {
    return null;
  }
}

/** The one-bracket-per-line `[env.X.vars]` shape wrangler documents, and this repository uses. */
function varsFor(toml, env) {
  const header = `[env.${env}.vars]`;
  const at = toml.indexOf(header);
  if (at < 0) throw new Error(`${CONFIG}: no ${header} block`);
  const rest = toml.slice(at + header.length);
  const stop = rest.search(/^\s*\[/m);
  const block = stop < 0 ? rest : rest.slice(0, stop);
  const out = {};
  for (const m of block.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

async function render(env, vars) {
  const url = vars.SUPABASE_URL;
  const key = vars.SUPABASE_ANON_KEY;
  const ref = vars.SUPABASE_PROJECT_REF;
  if (!url || !key || !ref) throw new Error(`${CONFIG}: [env.${env}.vars] is missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_PROJECT_REF`);
  // The same assertion env.ts makes at boot, applied before the file exists at all: a key for another project
  // is a *valid looking* pair, which is why a build can ship it.
  const refFromUrl = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in|dev)$/i.exec(url)?.[1];
  if (refFromUrl !== ref) throw new Error(`${CONFIG}: [env.${env}.vars] SUPABASE_URL parses to "${refFromUrl}" but SUPABASE_PROJECT_REF says "${ref}"`);
  // …and the rule that the swap to a new staging project broke. A key from the *previous* project is a valid
  // string, 208 characters, and GoTrue answers every sign-in with a bare 401. Decoding the `ref` claim is free,
  // so refuse to propagate the pair into the browser's config file — the operator learns it here, in a red
  // terminal, instead of their users learning it on the login page.
  const { refFromAnonKey } = await import("./check-project-pair.mjs");
  const keyRef = refFromAnonKey(key);
  if (keyRef && refFromUrl && keyRef !== refFromUrl) {
    throw new Error(
      `${CONFIG}: [env.${env}.vars] SUPABASE_ANON_KEY is a JWT issued for project "${keyRef}" while SUPABASE_URL points at ` +
        `"${refFromUrl}". Paste ${env}'s own key (Settings → API keys; the sb_publishable_… string if legacy keys are off).`,
    );
  }
  if (keyRef && refFromUrl === null) throw new Error(`${CONFIG}: [env.${env}.vars] SUPABASE_URL "${url}" is not an https://<ref>.supabase.co URL`);
  return (
    `# GENERATED by scripts/build-web-env.mjs from ${CONFIG} [env.${env}.vars]. Do not edit — edit that file and re-run\n` +
    `# \`npm run web:env\`. \`npm run web:env:check\` fails CI if this drifts, so a Pages build can never again be the\n` +
    `# only place a project's identity is remembered.\n` +
    `#\n` +
    `# Selected by mode: \`npm run build:web:${env}\` → vite --mode ${env} → this file. A shell-provided VITE_* still\n` +
    `# wins (Vite reads process.env first), which is how the CI workflow keeps overriding it from GitHub Environments.\n` +
    `# The anon key is public by design (RLS is the enforcement layer); a service_role key must NEVER appear here.\n` +
    `VITE_SUPABASE_URL=${url}\n` +
    `VITE_SUPABASE_ANON_KEY=${key}\n` +
    `VITE_EXPECTED_PROJECT_REF=${ref}\n` +
    `VITE_API_BASE_URL=\n`
  );
}

/**
 * The mobile bundle's env. It reuses production's Supabase pair (mobile ships against production data),
 * but unlike every other mode it sets a NON-EMPTY `VITE_API_BASE_URL`: the deployed Worker's absolute
 * origin. That origin is the production site itself, because the zone routes `kicklive.football/api/*`
 * to the Worker — so the API base is `https://<production host>`, read from the first https origin in
 * `[env.production.vars] ALLOWED_ORIGINS`. If that origin ever changes, this file goes stale and
 * `npm run web:env:check` (a CI gate) turns red, which is the whole point.
 */
async function renderMobile(prodVars) {
  const url = prodVars.SUPABASE_URL;
  const key = prodVars.SUPABASE_ANON_KEY;
  const ref = prodVars.SUPABASE_PROJECT_REF;
  if (!url || !key || !ref) throw new Error(`${CONFIG}: [env.production.vars] is missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_PROJECT_REF (mobile reuses production)`);
  const refFromUrl = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in|dev)$/i.exec(url)?.[1];
  if (refFromUrl !== ref) throw new Error(`${CONFIG}: [env.production.vars] SUPABASE_URL parses to "${refFromUrl}" but SUPABASE_PROJECT_REF says "${ref}"`);
  const { refFromAnonKey } = await import("./check-project-pair.mjs");
  const keyRef = refFromAnonKey(key);
  if (keyRef && refFromUrl && keyRef !== refFromUrl) {
    throw new Error(`${CONFIG}: [env.production.vars] SUPABASE_ANON_KEY is for project "${keyRef}" while SUPABASE_URL points at "${refFromUrl}" (mobile reuses production)`);
  }
  const origins = String(prodVars.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const apiBase = origins.find((o) => /^https:\/\/[a-z0-9.-]+$/i.test(o) && !o.startsWith("https://www.") && !/^https:\/\/localhost$/i.test(o));
  if (!apiBase) {
    throw new Error(`${CONFIG}: [env.production.vars] ALLOWED_ORIGINS has no plain https origin to use as the mobile API base — got "${prodVars.ALLOWED_ORIGINS ?? ""}"`);
  }
  return (
    `# GENERATED by scripts/build-web-env.mjs from ${CONFIG} [env.production.vars]. Do not edit — edit that file and re-run\n` +
    `# \`npm run web:env\`. \`npm run web:env:check\` fails CI if this drifts.\n` +
    `#\n` +
    `# The MOBILE build (Capacitor Android/iOS). Selected by \`npm run build:web:mobile\` → vite --mode mobile.\n` +
    `# It reuses production's Supabase project, but sets VITE_API_BASE_URL to the deployed Worker's absolute\n` +
    `# origin because a device-loaded bundle (https://localhost / capacitor://localhost) cannot use a relative\n` +
    `# /api. The Worker's ALLOWED_ORIGINS must list the Capacitor origins or every request fails CORS.\n` +
    `VITE_SUPABASE_URL=${url}\n` +
    `VITE_SUPABASE_ANON_KEY=${key}\n` +
    `VITE_EXPECTED_PROJECT_REF=${ref}\n` +
    `VITE_API_BASE_URL=${apiBase}\n`
  );
}

const reports = [];
let stale = 0;
for (const env of ENVS) {
  const file = `.env.${env}`;
  const full = path.join(REPO_ROOT, file);
  let content;
  try {
    content = await render(env, varsFor(fs.readFileSync(path.join(REPO_ROOT, CONFIG), "utf8"), env));
  } catch (e) {
    // The generator refusing is normal during a project move (it will not write a mismatched pair). In `--check`
    // that is only fatal when the file that *is* there is also inconsistent; otherwise it is the documented lag.
    const existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    const lag = CHECK && existing !== null && isSelfConsistent(existing);
    if (!lag) stale++;
    reports.push({ env, file, ok: Boolean(lag), error: lag ? null : e.message, why: lag ? LAG_NOTE : undefined, lagging: Boolean(lag) });
    continue;
  }
  const current = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  if (CHECK) {
    const ok = current === content;
    const lagging = !ok && current !== null && isSelfConsistent(current);
    if (!ok && !lagging) stale++;
    reports.push({
      env,
      file,
      ok: ok || lagging,
      lagging,
      why: current === null ? "missing — run `npm run web:env`" : lagging ? LAG_NOTE : "stale — the Worker config changed since it was generated",
    });
  } else if (current !== content) {
    fs.writeFileSync(full, content);
    reports.push({ env, file, ok: true, written: true });
  } else {
    reports.push({ env, file, ok: true });
  }
}

// The MOBILE mode is the one build that cannot use same-origin `/api`. Android loads the bundle from
// https://localhost and iOS from capacitor://localhost, so a relative `/api` resolves to the *device*,
// not the Worker. The mobile bundle therefore points at the deployed Worker's absolute origin, which is
// the production zone that routes `/api/*` to `kicklive-api`. Everything else (the Supabase pair, the
// project-ref guard) is production's, derived the same way so the same anti-drift check covers it.
{
  const file = ".env.mobile";
  const full = path.join(REPO_ROOT, file);
  let content;
  try {
    content = await renderMobile(varsFor(fs.readFileSync(path.join(REPO_ROOT, CONFIG), "utf8"), "production"));
  } catch (e) {
    const existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    const lag = CHECK && existing !== null && isSelfConsistent(existing);
    if (!lag) stale++;
    reports.push({ env: "mobile", file, ok: Boolean(lag), error: lag ? null : e.message, why: lag ? LAG_NOTE : undefined, lagging: Boolean(lag) });
    content = null;
  }
  if (content !== null) {
    const current = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    if (CHECK) {
      const ok = current === content;
      const lagging = !ok && current !== null && isSelfConsistent(current);
      if (!ok && !lagging) stale++;
      reports.push({
        env: "mobile",
        file,
        ok: ok || lagging,
        lagging,
        why: current === null ? "missing — run `npm run web:env`" : lagging ? LAG_NOTE : "stale — the Worker config changed since it was generated",
      });
    } else if (current !== content) {
      fs.writeFileSync(full, content);
      reports.push({ env: "mobile", file, ok: true, written: true });
    } else {
      reports.push({ env: "mobile", file, ok: true });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ check: CHECK, stale, reports }, null, 2));
} else {
  for (const r of reports) {
    const label = r.error ? `ERROR ${r.error}` : CHECK ? (r.lagging ? `current, lagging — ${r.why}` : r.ok ? "current" : r.why) : r.written ? "written" : "unchanged";
    console.log(`web-env: ${r.file.padEnd(16)} ${label}`);
  }
  if (CHECK && stale) {
    console.error(`web-env: ${stale} mode file(s) out of step with ${CONFIG} — run \`npm run web:env\` and commit the result`);
    console.error(
      "web-env: if `npm run web:env` itself refuses, the Worker config holds a key from a different project.\n" +
        "         That is not a formatting problem to write around: `node scripts/check-project-pair.mjs` names the\n" +
        "         two projects, and the fix is the *deployed project's own* anon/publishable key in SUPABASE_ANON_KEY.",
    );
  }
}
process.exit(stale ? 1 : 0);
