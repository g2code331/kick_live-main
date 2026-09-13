/**
 * The rules that would have caught this week's two deployment failures, kept executable.
 *
 *   1. A staging project was renamed and the bundle was rebuilt with the new URL while the anon key stayed the
 *      previous project's. Every existing check called that valid — the URL and the key "agreed" only because
 *      nothing compared the key's `ref` claim to the URL at build time — and the symptom was a bare 401 from
 *      GoTrue on the login page, for sign-in *and* sign-up.
 *   2. A push had no path from "the repo is green" to "staging is running it": provisioning, migrations and the
 *      Worker deploy were all manual, so an account missing a queue and a Pages bundle without its pair were
 *      both discovered after the fact, by a human.
 *
 * These tests do not call wrangler or Supabase (this sandbox has neither network nor credentials). They pin the
 * *shape* of the fix: one source of truth per project triple, a check that reads all three values and compares
 * them, a workflow that runs it before anything is deployed, and no retired ref left anywhere that a build reads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// The two scripts are ESM in `scripts/` and export their pure halves for exactly this purpose.
import { checkRepo } from "../../scripts/check-project-pair.mjs";
import { desiredState } from "../../scripts/provision-cloudflare.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO, rel));

/** The staging project as of 2026-09-13, and the one it replaced. */
const STAGING = "opvkvbabryuipzwcanrv";
const RETIRED_STAGING = "fnefpcjeebawsebxjhcf";
const PRODUCTION = "xvksxqrmdbbinlrjctri";

describe("every Supabase triple in the tree names one project", () => {
  it("the checker itself reports the retired-ref case it was written for", () => {
    // A synthetic tree, so the rule is proven by a *failing* case rather than by the current tree being clean:
    // a check that has only ever been observed passing is not evidence.
    const tmp = fs.mkdtempSync(path.join("/tmp", "pair-probe-"));
    try {
      fs.mkdirSync(path.join(tmp, "workers"), { recursive: true });
      const jwt = (ref: string): string => {
        const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
        return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role: "anon" })}.sig-not-checked`;
      };
      // new URL, old key: the exact state that produced the 401
      fs.writeFileSync(
        path.join(tmp, "workers/wrangler.toml"),
        `[env.staging.vars]\nSUPABASE_URL = "https://${STAGING}.supabase.co"\nSUPABASE_PROJECT_REF = "${STAGING}"\nSUPABASE_ANON_KEY = "${jwt(RETIRED_STAGING)}"\n`,
      );
      const { problems } = checkRepo(tmp);
      const keyProblem = problems.find((pr: string) => /issued for project/.test(pr));
      assert.ok(keyProblem, `the stale-key case must be reported, got ${JSON.stringify(problems)}`);
      assert.match(keyProblem!, /issued for project "fnefpcjeebawsebxjhcf"/);
      assert.match(keyProblem!, /401 on \/auth\/v1\/signup/, "and it must name the symptom the operator actually saw");
      assert.match(keyProblem!, /npm run web:env/, "and the command that propagates the fix");

      // and the same tree, corrected, is clean — the check is satisfiable, not merely loud
      fs.writeFileSync(
        path.join(tmp, "workers/wrangler.toml"),
        `[env.staging.vars]\nSUPABASE_URL = "https://${STAGING}.supabase.co"\nSUPABASE_PROJECT_REF = "${STAGING}"\nSUPABASE_ANON_KEY = "${jwt(STAGING)}"\n`,
      );
      assert.deepEqual(
        checkRepo(tmp).problems.filter((p: string) => /issued for project/.test(p)),
        [],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the real tree reports only the one honest problem: staging's key is still the retired project's", () => {
    const { problems } = checkRepo(REPO) as { problems: string[] };
    // Either zero problems (the operator has pasted the new key) or exactly the stale-key lines for the two
    // staging blocks — which is the state this repository is in today, and the reason the login page 401s.
    for (const p of problems) {
      // The whole set of messages this migration can legitimately produce, and nothing else:
      // the retired key, a mode file that has not caught up, and a mode file that has not been generated.
      assert.match(p, /issued for|differs from|is missing|out of step/, `unexpected problem: ${p}`);
    }
    const onlyStagingKey = problems.every((p: string) => p.includes("env.staging.vars") || p.includes("[vars]") || p.includes(".env.staging"));
    if (problems.length) assert.ok(onlyStagingKey, `problems outside the staging pair must not be tolerated: ${problems.join(" | ")}`);
  });

  it("no build input still names the retired project", () => {
    // `.env.staging` is allowed to be the *whole* old triple (self-consistent, so it builds and runs against the
    // old project) until the key arrives; anything that mixes halves is what breaks. Docs and tests may mention
    // the retired ref only in prose that says it is retired.
    // Assignments only: a comment explaining *why* the ref changed is documentation, and a rule that fires on
    // it teaches people to delete the explanation rather than fix the value.
    for (const file of ["workers/wrangler.toml", ".env.production", ".env.staging"]) {
      const live = read(file)
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      const refs = [...live.matchAll(/(?:SUPABASE_PROJECT_REF|VITE_EXPECTED_PROJECT_REF)[^A-Za-z0-9]*([a-z0-9]{15,})/g)].map((m) => m[1]);
      assert.ok(!refs.includes(RETIRED_STAGING) || file === ".env.staging", `${file}: a declared ref still points at the retired project`);
    }
    const stagingEnv = read(".env.staging");
    const url = /VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\./.exec(stagingEnv)?.[1];
    const expected = /VITE_EXPECTED_PROJECT_REF=([a-z0-9]+)/.exec(stagingEnv)?.[1];
    const key = /VITE_SUPABASE_ANON_KEY=(\S+)/.exec(stagingEnv)?.[1] ?? "";
    const keyRef = (() => {
      try {
        return JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString("utf8")).ref as string;
      } catch {
        return null;
      }
    })();
    assert.ok(url, ".env.staging must name a project URL");
    assert.equal(url, expected, `.env.staging: URL (${url}) and VITE_EXPECTED_PROJECT_REF (${expected}) must agree`);
    assert.ok(!keyRef || keyRef === url, `.env.staging: the anon key is issued for ${keyRef}, not ${url} — that pair is what returns 401`);
  });

  it("the retired ref survives only where it is explained", () => {
    for (const [file, text] of [
      ["docs/SETUP_WALKTHROUGH.md", read("docs/SETUP_WALKTHROUGH.md")],
      ["docs/ENV-AND-KEYS.md", read("docs/ENV-AND-KEYS.md")],
      ["docs/DEPLOYMENT_VERIFICATION.md", read("docs/DEPLOYMENT_VERIFICATION.md")],
    ] as const) {
      for (const line of text.split("\n")) {
        if (!line.includes(RETIRED_STAGING)) continue;
        assert.match(line, /retire|replac|was |moved|previous|old|no longer|→|—/, `${file}: a bare retired ref in the docs is a stale instruction: ${line.trim().slice(0, 90)}`);
      }
    }
  });
});

describe("the full-stack pipeline is real, not prose", () => {
  const wf = "ci/workflows/full-stack.yml";

  it("exists, parses, and is installed as .github/workflows/", () => {
    assert.ok(exists(wf), `${wf} must exist — the repo's convention is that ci/workflows is the source of truth`);
    const installed = ".github/workflows/full-stack.yml";
    assert.ok(exists(installed), `${installed} is missing — run npm run ci:install`);
    assert.equal(read(installed), read(wf), `${installed} must be a byte-identical copy of ${wf}`);
    const doc = read(wf);
    // A parser cannot assert intent: which trigger reaches which job. That is what this checks.
    assert.match(doc, /^on:\n  push:\n    branches: \[main\]/m, "a push to main must be the trigger");
    for (const job of ["config", "test", "provision", "migrate", "deploy-staging", "verify", "deploy-production"]) {
      assert.ok(doc.includes(`  ${job}:`), `job ${job} is missing from ${wf}`);
    }
  });

  it("nothing deploys before the config is coherent and the migrations have been executed", () => {
    const doc = read(wf);
    const needs = (job: string): string[] => {
      const at = doc.indexOf(`  ${job}:`);
      assert.ok(at >= 0, `job ${job} not found`);
      const m = /needs:\s*\[([^\]]*)\]/.exec(doc.slice(at, at + 1200));
      return (m?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    };
    for (const job of ["provision", "migrate", "deploy-staging", "deploy-production"]) {
      const n = needs(job);
      assert.ok(n.includes("config"), `${job} must depend on config (the pair check) — got [${n.join(", ")}]`);
    }
    assert.ok(needs("migrate").includes("test"), "migrations must not run before the executed-bundle test has passed");
    assert.ok(needs("deploy-production").includes("verify"), "production must wait for staging to verify");
    assert.match(doc, /deploy_production == 'true'/, "production deploy must require an explicit opt-in, not a push");
  });

  it("a missing credential skips loudly and never silently passes", () => {
    const doc = read(wf);
    // Every gated step must `exit 1` after saying why: the alternative, an `if: secrets != ''` guard, reports a
    // green check for "nothing happened", which is the exact shape that hid the unprovisioned queues.
    const errors = doc.match(/::error::[^\n]+/g) ?? [];
    assert.ok(errors.length >= 2, `expected the gated steps to name their missing secrets, found ${String(errors.length)}`);
    for (const block of doc.split("\n")) {
      if (/::error::.*(not set|are required)/.test(block)) {
        const after = doc.slice(doc.indexOf(block), doc.indexOf(block) + 900);
        assert.match(after, /exit 1/, "a loud skip must still fail the job");
      }
    }
    assert.ok(!/if:\s*\$\{\{[^}]*secrets\./.test(doc), "no step may be conditionally skipped on a secret's presence — that is a silent pass");
  });

  it("the Pages workflow builds by mode, and a push lands on staging", () => {
    const doc = read("ci/workflows/deploy-web.yml");
    assert.match(doc, /github\.event\.inputs\.environment \|\| 'staging'/, "a push (no input) must target staging");
    assert.match(doc, /npm run "build:web:\$mode"/, "the build must be mode-scoped rather than depend on exported vars");
    assert.match(doc, /npm run "web:env:check"/, "and must prove the mode file still matches the Worker's config");
    assert.match(doc, /supabase\/\*\*/s, "docs-only and SQL-only pushes should not rebuild the SPA");
  });

  it("the provisioning script reads the config instead of restating it", () => {
    const src = read("scripts/provision-cloudflare.mjs");
    const state = desiredState(REPO) as unknown as Record<string, { kv: unknown[]; r2: string[]; queues: string[]; crons: string[] }>;
    for (const env of ["staging", "production"]) {
      const want = state[env];
      assert.ok(want, `no ${env} state parsed from workers/wrangler.toml`);
      assert.ok(want.r2.length >= 1, `${env}: expected an R2 bucket`);
      assert.ok(want.queues.includes(env === "staging" ? "kicklive-notifications-staging" : "kicklive-notifications"), `${env}: the notification queue must be derived`);
      // The dead-letter queue is collected from the *consumer*, which is where it is declared; a list that
      // forgets it provisions a Worker whose poison messages go nowhere.
      assert.ok(
        want.queues.some((q: string) => q.includes("failed")),
        `${env}: the DLQ must be in the desired state`,
      );
      assert.equal(want.kv.length, 1, `${env}: exactly one KV namespace is bound`);
      assert.deepEqual(want.crons, ["*/5 * * * *", "17 * * * *"], `${env}: both crons must be reported`);
    }
    assert.match(src, /--apply/, "creation must be opt-in");
    assert.match(src, /never deletes|It never deletes/, "and the script must say that it never deletes");
  });

  it("verify runs the pair check and refuses a mangled workflow expression", () => {
    const verify = read("scripts/verify.mjs");
    assert.match(verify, /checkWorkflowExpressions/, "the workflow-mangling check must run in `npm run verify`");
    assert.match(verify, /web env files/, "and the mode files' sync must too");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts["pair:check"]?.includes("check-project-pair"), "npm run pair:check must exist, or nobody runs it");
    assert.ok(pkg.scripts["cf:check"]?.includes("provision-cloudflare"), "npm run cf:check must exist");
  });
});
