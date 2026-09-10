#!/usr/bin/env node
/**
 * Secret presence audit for CI.
 *
 *   node scripts/check-secrets.mjs            # in a workflow step: marks missing required secrets as
 *                                             # ::error::, optional ones as ::warning::, and writes a
 *                                             # table to $GITHUB_STEP_SUMMARY when that exists.
 *   node scripts/check-secrets.mjs --json     # machine-readable
 *   node scripts/check-secrets.mjs --job=release
 *
 * The point is the *shape* of a missing-secret failure: by default GitHub Actions silently renders
 * `${{ secrets.X }}` as an empty string, so a release publishes a build wired to no backend and the
 * symptom shows up three steps later as a blank page. This script fails fast and names the secret.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * `required` means: without it the artifact is wrong, not just unpatched. `optional` means a job
 * degrades (no Vercel preview, no notarization) and the run summary has to say so out loud.
 */
const SECRETS = [
  {
    name: "VITE_SUPABASE_URL",
    required: true,
    jobs: ["web", "desktop", "release", "deploy-web"],
    why: "baked into the bundle at build time (src/lib/supabase.ts); an empty value ships an app that cannot load a schedule",
    note: "since Phase 1 there is no fallback project in src/lib/supabase.ts: `npm run build` still succeeds, but the app refuses to boot and prints which variable is missing (src/lib/env.ts)",
  },
  { name: "VITE_SUPABASE_ANON_KEY", required: true, jobs: ["web", "desktop", "release", "deploy-web"], why: "same as above; it is a public anon key, but it must be the one matching the URL" },
  { name: "VERCEL_TOKEN", required: false, jobs: ["deploy-web"], why: "without it the preview/production deploy step is skipped", fallback: "deploy by running `npm run build:web` + your own host" },
  { name: "VERCEL_PROJECT_ID", required: false, jobs: ["deploy-web"], why: "needed with VERCEL_TOKEN" },
  { name: "VERCEL_ORG_ID", required: false, jobs: ["deploy-web"], why: "needed with VERCEL_TOKEN" },
  { name: "NPM_TOKEN", required: false, jobs: [], why: "unused today; listed so a future private-package dependency does not get added silently" },
  // ── Phase 2 (Workers) ──────────────────────────────────────────────────────────────────────
  // Declared now so the registry is the single list of what this product has secrets for, and so a
  // future workflow that adds one of these to a *client* job is caught by the scan below: a
  // service_role key in a web build is not a misconfiguration but a full database exposure.
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    required: false,
    jobs: [],
    why: "Worker secret (RLS bypass). Must never appear in a web/desktop build job — the source scan fails the run if it is baked into source.",
  },
  { name: "SUPABASE_JWT_SECRET", required: false, jobs: [], why: "Worker secret; used to verify the SPA bearer token in workers/src/middleware/auth.ts" },
  { name: "TURNSTILE_SECRET_KEY", required: false, jobs: [], why: "Worker secret; siteverify for signup + write routes (workers/src/middleware/turnstile.ts)" },
  {
    name: "FCM_SERVICE_ACCOUNT",
    required: false,
    jobs: [],
    why: "Worker secret (Phase 5). The downloaded Firebase service-account JSON, containing a private key. Set it with `npx wrangler secret put FCM_SERVICE_ACCOUNT`, never in wrangler.toml and never in a client build.",
  },
  // Phase 6 deliberately adds no secret here. R2 is reached through a *binding* (`MEDIA_BUCKET` in
  // workers/wrangler.toml), so there is no access key to store, rotate, leak in a log, or bake into an
  // artifact — and if this list ever grows a `MEDIA_ACCESS_KEY`, the design was abandoned and this comment
  // is the thing that was supposed to stop it. See docs/R2_MEDIA_ARCHITECTURE.md §2.
];

const REPO_ROOT_FOR_SCAN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const jobFlag = args.find((a) => a.startsWith("--job="))?.slice(6);
const allowEmpty = process.env.KICKLIVE_ALLOW_MISSING_SECRETS === "1";

function describe(value) {
  if (value === undefined) return { state: "unset", detail: "not present in the environment" };
  if (value.trim() === "") return { state: "empty", detail: "present but empty (the usual `${{ secrets.X }}` typo shape)" };
  if (value.includes("${{")) return { state: "unexpanded", detail: "literal expression text reached the shell" };
  const shape = value.length > 26 ? `${value.slice(0, 6)}…${value.slice(-4)} (${String(value.length)} chars)` : `${value} (${String(value.length)} chars)`;
  return { state: "set", detail: shape };
}

export function audit(env, job) {
  const rows = [];
  for (const secret of SECRETS) {
    if (job && secret.jobs.length > 0 && !secret.jobs.includes(job)) continue;
    const value = env[secret.name];
    const { state, detail } = describe(value);
    const ok = state === "set";
    rows.push({ ...secret, state, detail, ok, appliesToJob: job ? secret.jobs.includes(job) : true });
  }
  const blocking = rows.filter((r) => r.required && !r.ok);
  return { rows, blocking, optionalMissing: rows.filter((r) => !r.required && !r.ok) };
}

/** Directories whose contents ship to a browser or an Electron renderer, i.e. must hold no key. */
const SCANNED_DIRS = ["src", "pwa", "shared", "server", "desktop/src", "workers/src"];

/**
 * Hardcoded-backend detector. Phase 1 removed the fallback URL and the fallback anon key from
 * `src/lib/supabase.ts`; this is what stops them creeping back in (a copy-paste from an older
 * deployment guide is the realistic way that happens). Two patterns: a Supabase project URL written
 * as a literal, and any JWT-shaped literal. `.example` files are skipped — placeholders are the point
 * of those.
 */
export function scanSource(root = process.cwd()) {
  const findings = [];
  const urlLiteral = /["'`]https:\/\/([a-z0-9-]{12,})\.supabase\.(co|in|net)[\/"'`]/i;
  const jwtLiteral = /["']eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}["']/;
  // Phase 5 and 6 additions. Each pattern is chosen to be *unambiguous*: a scanner that fires on a
  // placeholder, a doc example or a base64 blob gets muted inside a week, which is worse than no scanner,
  // because the green check reads as a claim. So: a PEM header, an AWS key id, a Supabase token prefix, a
  // Firebase service-account field name, and an FCM legacy server key — not "high entropy strings".
  const PATTERNS = [
    { kind: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, commentSensitive: true, note: "a private key in the tree; a service-account JSON is the usual shape" },
    { kind: "service-account-json", re: /"type"\s*:\s*"service_account"/, note: "a downloaded Google service-account file; only `wrangler secret put FCM_SERVICE_ACCOUNT`" },
    { kind: "service-account-client-email", re: /["']firebase-adminsdk-[A-Za-z0-9_-]+@/, note: "the client_email of a Firebase service account, which identifies the key to rotate" },
    { kind: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/, note: "an AWS/S3 key. There is no reason for one here: R2 is a binding, not a credential" },
    { kind: "supabase-token", re: /\bsb(?:p|secret)_[A-Za-z0-9]{20,}/, note: "a Supabase personal access key or dashboard secret" },
    { kind: "fcm-legacy-server-key", re: /\bAAAA[A-Za-z0-9_-]{7,}:APA9[0-9A-Za-z_-]{20,}/, note: "a legacy FCM server key; the v1 API uses the service account instead" },
  ];
  const isCommentLine = (line) => /^\s*(\/\/|\*|#|--|\/\*)/.test(line);

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
        walk(full);
        continue;
      }
      // `.pem`/`.key`/`.p12` are in the list because that is where a real key lives; they are not text
      // files, and the extension filter is what would otherwise let them walk straight through the audit.
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|html|css|json|pem|key|p12|pfx)$/.test(entry.name)) continue;
      if (/\.example$/i.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      const isKeyMaterial = /\.(pem|key|p12|pfx)$/i.test(entry.name);
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const url = urlLiteral.exec(line);
        if (url) findings.push({ file: path.relative(root, full), line: i + 1, kind: "hardcoded-supabase-url", detail: `project ref ${url[1]}` });
        if (jwtLiteral.test(line)) findings.push({ file: path.relative(root, full), line: i + 1, kind: "hardcoded-jwt", detail: line.trim().slice(0, 24) + "…" });
        for (const pattern of PATTERNS) {
          // A documented example of a key header is not a key. Skipping comment lines keeps this repo's own
          // prose (workers/src/services/fcm.ts names the PEM format it parses) from tripping the rule, at the
          // known cost that a key *commented out* in a source file is not reported — history is where that one
          // lives, and it is `git filter-repo`'s problem, not a grep's.
          // …but the exemption is disabled inside a key file, where `-----BEGIN …` is the *format*, and a
          // PEM banner line otherwise looks exactly like a SQL comment to this heuristic.
          if (pattern.commentSensitive && !isKeyMaterial && isCommentLine(line)) continue;
          if (pattern.re.test(line)) findings.push({ file: path.relative(root, full), line: i + 1, kind: pattern.kind, detail: pattern.note });
        }
      });
    }
  };

  for (const dir of SCANNED_DIRS) walk(path.join(root, dir));
  return findings;
}

function reportScan(findings) {
  if (findings.length === 0) {
    console.log("source scan: no hardcoded Supabase URL or key in shipped source ✔");
    return;
  }
  for (const f of findings) console.log(`::error::${f.file}:${String(f.line)} — ${f.kind} (${f.detail})`);
  console.error(
    `source scan: ${String(findings.length)} hardcoded backend value(s). Put them in the environment and read them in\n` + `  src/lib/env.ts (web) or workers/src/env.ts (Worker); see .env.example.`,
  );
}

export function main() {
  const scanOnly = args.includes("--scan-only");
  const findings = scanSource(REPO_ROOT_FOR_SCAN);
  if (scanOnly) {
    reportScan(findings);
    if (asJson) console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
    return findings.length === 0 ? 0 : 1;
  }

  const { rows, blocking, optionalMissing } = audit(process.env, jobFlag);
  if (asJson) {
    console.log(JSON.stringify({ ok: blocking.length === 0, blocking: blocking.length, optionalMissing: optionalMissing.length, rows }, null, 2));
  } else {
    console.log(`check-secrets: job=${jobFlag ?? "any"}`);
    if (findings.length === 0) console.log("  source scan: clean");
    for (const r of rows) {
      const mark = r.ok ? "set" : r.required ? "MISSING" : "unset (optional)";
      console.log(`  ${mark.padEnd(17)} ${r.name.padEnd(24)} ${r.detail}${r.ok ? "" : ` — ${r.why}`}`);
      if (!r.ok && r.note) console.log(`  ${" ".repeat(17)} note: ${r.note}`);
      if (r.required && !r.ok) console.log(`::error::secret ${r.name} is ${r.state}: ${r.why}`);
      else if (!r.ok) console.log(`::warning::optional secret ${r.name} is ${r.state}: ${r.why}`);
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const lines = ["", "### Secrets audit", "", "| secret | state | required | used by | why it matters |", "|---|---|---|---|---|"];
      for (const r of rows) lines.push(`| \`${r.name}\` | ${r.ok ? "✅ set" : `❌ ${r.state}`} | ${r.required ? "yes" : "no"} | ${r.jobs.join(", ") || "—"} | ${r.why.replace(/\|/g, "/")} |`);
      if (rows.length === 0) lines.push("| — | — | — | — | nothing this job reads |");
      lines.push("");
      if (blocking.length > 0) lines.push(`**${String(blocking.length)} required secret(s) missing.** A release published without them ships a client wired to the wrong backend.`);
      else if (optionalMissing.length > 0) lines.push(`${String(optionalMissing.length)} optional secret(s) unset: ${optionalMissing.map((r) => r.name).join(", ")}.`);
      else lines.push("All required secrets present.");
      fs.appendFileSync(summary, lines.join("\n") + "\n");
    }
  }
  if (findings.length > 0) {
    reportScan(findings);
    if (!allowEmpty) return 1;
    console.warn("::warning::source scan findings ignored because KICKLIVE_ALLOW_MISSING_SECRETS=1");
  }

  if (blocking.length > 0 && !allowEmpty) {
    if (!asJson)
      console.error(
        `check-secrets: ${String(blocking.length)} required secret(s) missing (${blocking.map((r) => r.name).join(", ")}).\n` +
          `  set them with:  gh secret set ${blocking[0].name} --repo "$GITHUB_REPOSITORY" < value.txt\n` +
          `  or run this job locally with the values exported. KICKLIVE_ALLOW_MISSING_SECRETS=1 downgrades this to a warning.`,
      );
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-secrets.mjs")) {
  process.exitCode = main();
}
