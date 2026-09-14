#!/usr/bin/env node
/**
 * GO-LIVE PREFLIGHT — one command that answers "is this repository able to ship production *right now*?",
 * read-only, with no credentials and no network.
 *
 *   npm run preflight:production
 *   npm run preflight:production -- --dsn="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"
 *
 * Why it exists: everything a deploy needs is spread over `pair:check`, `web:env:check`, `sql:bundle:check`,
 * `cf:check`, `check-secrets` and the CI YAML, and each of them passes in isolation while production is still
 * unreachable. This runs them in the order a human would, adds the checks nothing else does (is the *production*
 * triple complete and different from staging, is the workflow that deploys it actually installed and free of a
 * corrupted secret expression, does the SQL an operator is about to paste still execute), and prints one line per
 * gate with the command that fixes a failure.
 *
 * It never writes, never deploys, and never asks for a secret. A FAIL here is always "the repo is not ready" or
 * "the account is not provisioned"; the remaining human steps are listed at the end, and they are the only steps
 * that need the operator's credentials. `docs/GO_LIVE.md` walks them.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const DSN = flag("dsn");
const node = process.execPath;
const TS = ["--import", path.join(REPO, "scripts/lib/ts-loader.mjs")];
const results = [];

/** A gate is pass, fail, warn (needs a credential or a dashboard this sandbox cannot see) or skip. */
function gate(name, kind, detail, fix) {
  results.push({ name, kind, detail, fix });
  const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP", warn: "WARN" }[kind];
  console.log(`[${mark}] ${name}${detail ? `\n        ${detail}` : ""}${kind !== "pass" && fix ? `\n     ->  ${fix}` : ""}`);
}

function run(cmd, cmdArgs, { timeout = 600000 } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, missing: r.error?.code === "ENOENT" };
}
const last = (text, re) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => (re ? re.test(l) : true))
    .pop() ?? "";
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO, rel), "utf8");
  } catch {
    return "";
  }
};

// ── 1 · the SQL an operator is about to paste ───────────────────────────────────────────────────────────────
const bundle = run(node, [...TS, "scripts/build-sql-bundle.mjs", "--check"]);
gate("supabase/SETUP.sql is the current bundle", bundle.ok ? "pass" : "fail", last(bundle.out), "npm run sql:bundle, then commit supabase/SETUP.sql");

if (fs.existsSync(path.join(REPO, "node_modules/@electric-sql/pglite/package.json"))) {
  const exec = run(node, [...TS, "scripts/sql-pglite.mjs"]);
  const line = last(exec.out, /statements executed/);
  const failed = Number(/(\d+) failure\(s\)/.exec(line)?.[1] ?? "1");
  gate(
    "the bundle executes on a real Postgres (PGlite)",
    exec.ok && failed === 0 ? "pass" : "fail",
    line || "(no summary line — the runner itself failed)",
    exec.ok ? "a migration's own verification is failing; read the printed failure, do not relax the assertion" : "a migration cannot be applied at all; fix it before touching the dashboard",
  );
} else {
  gate("the bundle executes on a real Postgres (PGlite)", "skip", "node_modules/@electric-sql/pglite is absent", "npm ci");
}

const adminSql = read("CREATE_ADMIN_PROFILE.sql");
gate(
  "CREATE_ADMIN_PROFILE.sql carries its own preflight",
  /Preflight: refuse loudly/.test(adminSql) && /kicklive_set_user_role\(uuid, text\)'?\) is null/.test(adminSql) ? "pass" : "fail",
  "refuses a project that never got the bundle, names the file that fixes it, and re-verifies the grant",
  "restore the preflight block — see tests/unit/sql-executes.test.mjs for the cases it must refuse",
);
gate(
  "the bootstrap grants admin through the supported RPC only",
  /kicklive_set_user_role\(v_user_id/.test(adminSql) ? "pass" : "warn",
  "role writes go via public.kicklive_set_user_role(); the raw UPDATE exists only for the first-admin case",
  "read tests/unit/sql-executes.test.mjs before changing this file",
);

// ── 2 · the two project triples ─────────────────────────────────────────────────────────────────────────────
const pair = run(node, [...TS, "scripts/check-project-pair.mjs"]);
gate("every Supabase triple agrees (project pair)", pair.ok ? "pass" : "fail", last(pair.out), "the URL / ref / key disagree — fix workers/wrangler.toml, then npm run web:env");
const envCheck = run(node, [...TS, "scripts/build-web-env.mjs", "--check"]);
gate("the Pages mode files match wrangler.toml", envCheck.ok ? "pass" : "fail", last(envCheck.out), "npm run web:env && git add .env.staging .env.production");

const refOf = (text) => /VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/.exec(text)?.[1] ?? null;
const prodEnv = read(".env.production");
const prodRef = refOf(prodEnv);
const stagingRef = refOf(read(".env.staging"));
gate(
  "staging and production point at two *different* projects",
  prodRef && stagingRef && prodRef !== stagingRef ? "pass" : "fail",
  `staging=${stagingRef ?? "?"} production=${prodRef ?? "?"}`,
  prodRef && prodRef === stagingRef ? "one mode file describes the other project — fix workers/wrangler.toml, never the generated file" : "npm run web:env",
);
const expectRef = /VITE_EXPECTED_PROJECT_REF=([a-z0-9]+)/.exec(prodEnv)?.[1] ?? null;
gate(
  "the production bundle pins the ref it must talk to",
  expectRef && expectRef === prodRef ? "pass" : "fail",
  expectRef ? `VITE_EXPECTED_PROJECT_REF=${expectRef}` : "no expected ref in the mode file, so a consistent-but-wrong pair would boot silently",
  "npm run web:env",
);

// ── 3 · the Worker's production configuration ───────────────────────────────────────────────────────────────
const secrets = run(node, [...TS, "scripts/check-secrets.mjs"]);
gate("the Worker secrets and bindings are all declared", secrets.ok ? "pass" : "fail", last(secrets.out), "docs/SETUP_WALKTHROUGH.md step 4");
const cf = run(node, [...TS, "scripts/provision-cloudflare.mjs"]);
// The script indents each delta by two spaces; anchoring on `^` matched nothing and turned a known,
// operator-side gap into a repo-side FAIL — which is exactly the false alarm that makes people ignore a preflight.
const cfMissing = (cf.out.match(/^\s*(production|staging):\s+.*(does not exist|is not readable)/gm) ?? []).length;
gate(
  "Cloudflare resources match the repo config (offline diff)",
  cf.ok ? "pass" : cfMissing ? "warn" : "fail",
  cf.ok ? "queues / buckets / KV ids agree with workers/wrangler.toml" : `${String(cfMissing)} resource(s) the account does not have yet`,
  cf.ok
    ? "npm run cf:provision -- --apply needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported; it creates only what is missing"
    : "npm run cf:check names each one, and docs/GO_LIVE.md section B is the dashboard order",
);
const toml = read("workers/wrangler.toml");
const prodVars = (() => {
  const i = toml.indexOf("[env.production.vars]");
  if (i < 0) return "";
  const j = toml.indexOf("[[", i);
  return toml.slice(i, j > i ? j : undefined);
})();
const needed = ["SUPABASE_URL", "SUPABASE_PROJECT_REF", "SUPABASE_ANON_KEY", "ALLOWED_ORIGINS", "APP_ENV"];
const missingVars = needed.filter((k) => !new RegExp(`^\\s*${k}\\s*=`, "m").test(prodVars));
const secretVars = ["SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "FCM_SERVICE_ACCOUNT"].filter((k) => new RegExp(`^\\s*${k}\\s*=`, "m").test(prodVars));
gate(
  "the production [vars] block declares every non-secret binding",
  !prodVars ? "fail" : missingVars.length === 0 && secretVars.length === 0 ? "pass" : "fail",
  !prodVars
    ? "no [env.production.vars] section at all"
    : missingVars.length
      ? `missing: ${missingVars.join(", ")}`
      : secretVars.length
        ? `${secretVars.join(", ")} is declared under [vars] — a secret belongs in the Worker's encrypted store (wrangler secret put), not in the repo`
        : "URL/ref/anon key/origins are vars; the JWT secret and the FCM key are secrets",
  missingVars.length
    ? "add them to workers/wrangler.toml (the anon key and URL are public by design)"
    : secretVars.length
      ? `move ${secretVars.join(", ")} out of the TOML and re-issue with wrangler secret put`
      : "",
);
for (const secretName of ["SUPABASE_JWT_SECRET", "FCM_SERVICE_ACCOUNT", "TURNSTILE_SECRET_KEY"]) {
  const documented = read("docs/SETUP_WALKTHROUGH.md").includes(secretName) || read("docs/GO_LIVE.md").includes(secretName);
  gate(
    `the "wrangler secret put ${secretName}" step is written down`,
    documented ? "pass" : "warn",
    documented ? "" : "an operator cannot run a step that is not documented",
    "add it to docs/SETUP_WALKTHROUGH.md step 4 with --config workers/wrangler.toml --env <environment>",
  );
}

// ── 4 · the pipeline that ships it ──────────────────────────────────────────────────────────────────────────
const installed = read(".github/workflows/full-stack.yml");
const source = read("ci/workflows/full-stack.yml");
const installedMatches = Boolean(installed && source && installed.replace(/\r/g, "").trim() === source.replace(/\r/g, "").trim());
gate(
  "the deploy pipeline is installed and identical to ci/workflows",
  installedMatches ? "pass" : installed ? "fail" : "fail",
  installedMatches ? "full-stack.yml matches" : installed ? "the installed copy differs from ci/workflows/full-stack.yml" : "no full-stack workflow in .github/workflows, so nothing deploys",
  "npm run ci:install && git add -f .github/workflows",
);
const corrupt = [...(source + installed).matchAll(/\$\{\{[^}]*\}\}\}+/g)].length;
gate(
  "no workflow expression carries an extra closing brace",
  corrupt === 0 ? "pass" : "fail",
  corrupt === 0
    ? "a `${{ … }}}` line is YAML-legal and appends `}` to the substituted secret (a corrupt token/password at run time)"
    : `${String(corrupt)} line(s) end in a doubled-then-some closing brace`,
  "strip the stray brace from ci/workflows/full-stack.yml and re-run npm run ci:install",
);
const prodGate = /deploy_production/.test(source) && /if:.*deploy_production.*==.*true/.test(source);
gate(
  "production stays behind an explicit input",
  prodGate ? "pass" : "warn",
  prodGate ? "deploy_production=true is the only way a push reaches production" : "no deploy_production gate found: a push could deploy production by accident",
  "keep the manual gate in ci/workflows/full-stack.yml",
);

const gh = spawnSync("gh", ["--version"], { encoding: "utf8", timeout: 20000 });
if (gh.status === 0) {
  const envs = run("gh", ["api", "repos/{owner}/{repo}/environments", "--jq", ".[].name"], { timeout: 60000 });
  const names = envs.ok
    ? envs.out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  gate(
    "the GitHub environments CI needs exist",
    !envs.ok ? "warn" : names.includes("staging") && names.includes("production") ? "pass" : "fail",
    envs.ok ? (names.length ? `found: ${names.join(", ")}` : "the repo has no environments at all") : "this token cannot read environments; run the gh command yourself",
    envs.ok ? "gh api repos/{owner}/{repo}/environments/staging -X PUT -f wait_timer=0   (once per missing name)" : "create both environments and their secrets per docs/GO_LIVE.md section D",
  );
  const prodSecrets = run("gh", ["api", "repos/{owner}/{repo}/environments/production/secrets", "--jq", ".secrets[].name"], { timeout: 60000 });
  const want = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
  const have = prodSecrets.ok
    ? prodSecrets.out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const miss = want.filter((s) => !have.includes(s));
  gate(
    "the production environment secrets are named",
    !prodSecrets.ok ? "warn" : miss.length === 0 ? "pass" : "fail",
    prodSecrets.ok ? (have.length ? `present: ${have.join(", ")}` : "the production environment has no secrets yet") : "cannot list environment secrets here (needs repo admin)",
    miss.length ? `gh secret set ${miss[0]} --env production --body '…'` : "",
  );
} else {
  gate("GitHub side (environments, secrets)", "skip", "gh is not installed/authenticated here", "run the gh commands in docs/GO_LIVE.md section D on your own machine");
}

// ── 5 · the app's own proof ─────────────────────────────────────────────────────────────────────────────────
const verify = run(node, [...TS, "scripts/verify.mjs", "check"], { timeout: 1800000 });
gate(
  "`npm run verify` (every static gate in the repo)",
  verify.ok ? "pass" : "fail",
  last(verify.out, /checks passed|check failed/),
  verify.ok ? "" : "fix these before a deploy; they exist because a bad bundle once reached staging green",
);

if (DSN) {
  const sql = run(node, [...TS, "scripts/check-sql.mjs", `--dsn=${DSN}`, "--allow-any-database"]);
  gate("the shipped schema behaves against the live database", sql.ok ? "pass" : "fail", last(sql.out), sql.ok ? "" : "a runFlow failure is a data bug, not a test bug — fix the migration");
} else {
  gate(
    "the shipped schema against a live database",
    "skip",
    "no --dsn given (correct: production credentials do not belong in a shell history)",
    'npm run preflight:production -- --dsn="postgresql://postgres.<prod-ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"',
  );
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.kind === "fail");
const waits = results.filter((r) => r.kind === "skip" || r.kind === "warn");
console.log(`\npreflight: ${String(results.filter((r) => r.kind === "pass").length)}/${String(results.length)} green, ${String(fails.length)} red, ${String(waits.length)} needing an operator`);
if (fails.length) {
  console.log("fix these first (all repo-side, no credentials needed):");
  for (const f of fails) console.log(`  - ${f.name}${f.fix ? `\n      -> ${f.fix}` : ""}`);
}
console.log(
  "\nStill only ever a human's job, in order (docs/GO_LIVE.md walks each one):\n" +
    "  1. paste supabase/SETUP.sql into the PRODUCTION project, then run supabase/DB_CHECK.sql in the same editor.\n" +
    "  2. export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, run npm run cf:provision -- --apply, then deploy the Worker:\n" +
    "       npx wrangler deploy --config workers/wrangler.toml --env production\n" +
    "  3. the five `wrangler secret put` lines for --env production — Cloudflare secrets are write-only, so nothing here can check them.\n" +
    "  4. the GitHub production environment secrets (docs section D), then push and dispatch with deploy_production=true.\n" +
    "  5. sign up in the app, run CREATE_ADMIN_PROFILE.sql with your own address typed in, then delete the file from your working copy.\n" +
    "A green run means: the repo is ready. It never means production was deployed — nothing in this script can reach\nCloudflare or Supabase, by design.\n",
);
process.exit(fails.length ? 1 : 0);
