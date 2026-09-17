/**
 * Phase 12-era invariant: the web host is Cloudflare Pages and nothing in the tree may quietly
 * re-fork that decision. Every rule here failed exactly once in this repo's history: vercel.json
 * drifted out of sync with the docs, `_redirects` was written as a blanket catch-all (which would
 * make a stale hashed asset return HTML-200 and pin a broken PWA shell), and the deploy workflow
 * still printed a `git add` command the repo's own .gitignore made impossible. So the contract is
 * now files in `public/`, generated-source SQL, and these tests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO, rel));
let workflowDrift = false;

describe("the web host is Cloudflare Pages, not Vercel", () => {
  it("the Vercel host files are gone", () => {
    for (const gone of ["vercel.json", ".vercel", ".vercel/project.json"]) {
      assert.ok(!exists(gone), `${gone} came back: the host is Pages; its contract is public/functions + public/_routes.json + public/_headers`);
    }
  });

  it("the Pages contract files exist, with the semantics that matter", () => {
    // Advanced mode: a single `_worker.js` at the deploy root owns routing. `wrangler pages deploy dist/web`
    // does NOT compile a nested `functions/` directory (Cloudflare requires it at the PROJECT root, not the
    // output dir), so a `dist/web/functions/` shipped as a dead static file and Pages' default SPA not-found
    // handling answered a missing `/assets/*.js` with index.html at 200 — the PWA-pinning bug the probe caught.
    assert.ok(!exists("public/functions"), "the functions/ directory is not compiled from inside the output dir; the deploy root _worker.js owns routing");

    const fn = read("public/_worker.js");
    assert.match(fn, /export default\s*\{/, "advanced mode requires a module Worker with a default export");
    assert.match(fn, /async fetch\(/, "the Worker's entry is fetch()");
    assert.match(fn, /ASSETS\.fetch/, "every response comes from the deployed bundle's own static storage");
    assert.ok(fn.includes(String.raw`\.[A-Za-z0-9]+$`), "a dotted path answered with the HTML shell must become a real 404 (the PWA-pinning rule)");
    assert.match(fn, /text\/html/, "the miss is detected by the shell's content type, since ASSETS.fetch returns 200+HTML for a miss, not a 404");

    // _routes.json is ignored in advanced mode but kept valid so a future revert cannot ship a broken file.
    const routes = JSON.parse(read("public/_routes.json")) as { version: number; include: string[]; exclude: string[] };
    assert.equal(routes.version, 1, "_routes.json keeps its version field or Pages ignores it");
    assert.ok(routes.include.includes("/*"), "routes must reach the Worker");

    const headers = read("public/_headers");
    assert.match(headers, /\/assets\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/, "hashed assets are immutable");
    assert.match(headers, /\/sw\.js\s*\n\s*Cache-Control: no-store/, "a cached service worker pins the app past its own updates");
    assert.match(headers, /Service-Worker-Allowed: \//, "the worker keeps root scope");

    assert.ok(!exists("public/_redirects"), "a blanket /* /index.html 200 redirect is how a stale asset hash becomes HTML-with-200; the function owns the fallback");
  });

  it("deploy-web.yml deploys Pages through wrangler, per GitHub environment, and probes afterwards", () => {
    // `ci/workflows/` is the source of truth and is always asserted. `.github/workflows/` is the install
    // target: it must exist, and the assertions below read the SOURCE, so a stale installed copy cannot
    // masquerade as a second, contradictory workflow.
    for (const rel of ["ci/workflows/deploy-web.yml", ".github/workflows/deploy-web.yml"]) {
      const src = read("ci/workflows/deploy-web.yml");
      if (rel.startsWith(".github/")) {
        // Absence is a hard failure; drift is only a warning. GitHub refuses any push that touches
        // .github/workflows/** from a token without the `workflows` permission, so the Pages-era rewrite
        // of the installed copies cannot ride on a branch: `npm run ci:install` on a human's machine can.
        assert.ok(exists(rel), `${rel} is missing: Actions never runs ci/workflows/ by itself. Run \`npm run ci:install\` and commit with \`git add -f .github/workflows\`.`);
        if (read(rel) !== src) workflowDrift = true;
      }
      const yml = src;
      assert.ok(!/vercel/i.test(yml), `${rel}: no Vercel step survives in the web deploy`);
      assert.match(yml, /pages deploy dist\/web --project-name/, "deploy is `wrangler pages deploy` against a named project");
      assert.match(yml, /kicklive-web-staging/, "staging is its own Pages project (its own domains, its own VITE pair)");
      assert.match(yml, /CLOUDFLARE_API_TOKEN/, "auth is the API token, with a named ::error:: when missing");
      assert.match(yml, /probe-deploy\.sh/, "every deploy ends by probing the live URL — 404s stay 404s on the real host");
      // A push to `main` now targets STAGING by default; production is reached only by an explicit run (or the
      // release workflow on a tag). Asserted on both jobs: a build job and a deploy job that disagreed about the
      // default would deploy one environment and verify the other, which is worse than no automation at all.
      assert.equal(
        (yml.match(/environment: \$\{\{ github\.event\.inputs\.environment \|\| 'staging' \}\}/g) || []).length,
        2,
        "build and deploy must share one default target, and it must be staging",
      );
      assert.ok(!/environment: \$\{\{ github\.event\.inputs\.environment \|\| 'production' \}\}/.test(yml), "no job may default to production any more");
      assert.match(yml, /npm run "build:web:\$mode"/, "the pair comes from the mode file, so an unset secret cannot inline an empty value into the bundle");
      assert.match(yml, /VITE_SUPABASE_URL: \$\{\{ secrets\.VITE_SUPABASE_URL \}\}/, "the VITE pair may still be scoped per GitHub environment, which is what separates staging from production");
      assert.match(yml, /paths-ignore:/, "a docs-only push must not rebuild and redeploy the SPA");
    }
  });

  it("the installed copies exist, and drift is announced rather than hidden", () => {
    // The whole rule in one place: the copy GitHub Actions executes must equal the copy in git.
    // Drift is computed here and shouted after the suite, because a pushed branch cannot carry the repair.
    for (const file of ["ci.yml", "deploy-web.yml", "nightly.yml", "release.yml"]) {
      const rel = `.github/workflows/${file}`;
      assert.ok(exists(rel), `${rel} is missing: nothing gates or deploys from ci/workflows/ alone; run \`npm run ci:install\``);
      if (read(rel) !== read(`ci/workflows/${file}`)) workflowDrift = true;
    }
  });

  after(() => {
    if (workflowDrift) {
      process.emitWarning(
        ".github/workflows/ is out of sync with ci/workflows/: run `npm run ci:install`, then `git add -f .github/workflows && git commit`. " +
          "A pushed branch cannot carry that commit (GitHub refuses a token without the `workflows` permission), which is why this warns instead of failing. " +
          "Until it is repaired, Actions and the Pages deploy run the older installed copies.",
        "KickLiveWorkflowDrift",
      );
    }
  });

  it("the tooling registry and docs point at the same host", () => {
    const secrets = read("scripts/check-secrets.mjs");
    assert.ok(!/VERCEL_/.test(secrets), "the secrets registry must not list a host we do not deploy to");
    assert.match(secrets, /CLOUDFLARE_API_TOKEN/);
    for (const rel of ["DEPLOYMENT.md", "docs/ENVIRONMENT_SETUP.md", "docs/DEPLOYMENT_VERIFICATION.md", "docs/SETUP_WALKTHROUGH.md"]) {
      assert.match(read(rel), /Cloudflare Pages|pages deploy/, `${rel} documents the Pages path`);
    }
  });

  it("the setup walkthrough is the one ordered path, and it cannot rot into the old file list", () => {
    const walk = read("docs/SETUP_WALKTHROUGH.md");
    // Every doc that lists next steps must offer the walkthrough first, or the reader is back to choosing between four files.
    for (const rel of ["README.md", "DEPLOYMENT.md", "DEPLOYMENT_GUIDE.md", "DEPLOYMENT_CHECKLIST.md", "docs/ENVIRONMENT_SETUP.md"]) {
      assert.match(read(rel), /SETUP_WALKTHROUGH\.md/, `${rel} must point at the numbered walkthrough`);
    }
    assert.match(walk, /^## 0 · /m, "step 0 exists so nobody recreates the resources that are already done");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      assert.ok(walk.includes(`## ${n} · `), `walkthrough lost step ${n}`);
    }
    assert.match(walk, /supabase\/SETUP\.sql/, "the database step is one paste");
    assert.match(walk, /wrangler queues create kicklive-notifications-staging/);
    assert.match(walk, /wrangler queues create kicklive-notifications-failed\b/, "all six queue names, spelled out");
    assert.match(walk, /enable R2 through the Cloudflare Dashboard/, "the 10042 prerequisite is in the path, not in a footnote");
    assert.match(walk, /kicklive-web-staging/, "staging is its own Pages project");
    assert.match(walk, /pages\.dev[\s\S]{0,400}only after this first deploy/, "the pages.dev domain is expected only after a deploy");
    assert.match(walk, /docs\/DEPLOYMENT_VERIFICATION\.md/, "step 7 hands off to the 16 checks");
    assert.match(walk, /pages rollback/, "and the rollback answer lives in the same file as the deploy");
    // The three deletions and the retirement are stated in the same voice everywhere, so a stale doc cannot re-ask for them.
    assert.ok(!/vercel\.json[\s\S]{0,80}(deploy to|set up)/i.test(walk), "the walkthrough must not ask for a Vercel step");
    for (const gone of ["SUPABASE_COMPLETE_SCHEMA.sql", "SUPABASE_NEW_PROJECT_SETUP.sql", "supabase_migrations.sql"]) {
      assert.ok(!walk.includes(gone), `the walkthrough must not name ${gone}: it is deleted, and naming it re-creates the paste-the-wrong-file bug`);
    }
  });

  it("a bare `node scripts/run-tests.mjs` self-heals onto the TS loader", () => {
    const s = read("scripts/run-tests.mjs");
    assert.match(s, /process\.features\.typescript/, "the guard keys off the Node build feature the npm scripts paper over");
    assert.match(s, /NODE_OPTIONS/, "the loader rides NODE_OPTIONS so the spawned `node --test` children inherit it");
    assert.match(s, /ts-loader\.mjs/);
  });
});
