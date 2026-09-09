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
    note: "the repo also carries a fallback URL in source — a build can therefore look successful while pointing at the wrong project",
  },
  { name: "VITE_SUPABASE_ANON_KEY", required: true, jobs: ["web", "desktop", "release", "deploy-web"], why: "same as above; it is a public anon key, but it must be the one matching the URL" },
  { name: "VERCEL_TOKEN", required: false, jobs: ["deploy-web"], why: "without it the preview/production deploy step is skipped", fallback: "deploy by running `npm run build:web` + your own host" },
  { name: "VERCEL_PROJECT_ID", required: false, jobs: ["deploy-web"], why: "needed with VERCEL_TOKEN" },
  { name: "VERCEL_ORG_ID", required: false, jobs: ["deploy-web"], why: "needed with VERCEL_TOKEN" },
  { name: "NPM_TOKEN", required: false, jobs: [], why: "unused today; listed so a future private-package dependency does not get added silently" },
];

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

export function main() {
  const { rows, blocking, optionalMissing } = audit(process.env, jobFlag);
  if (asJson) {
    console.log(JSON.stringify({ ok: blocking.length === 0, blocking: blocking.length, optionalMissing: optionalMissing.length, rows }, null, 2));
  } else {
    console.log(`check-secrets: job=${jobFlag ?? "any"}`);
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
