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
import { describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(REPO, rel));

describe("the web host is Cloudflare Pages, not Vercel", () => {
  it("the Vercel host files are gone", () => {
    for (const gone of ["vercel.json", ".vercel", ".vercel/project.json"]) {
      assert.ok(!exists(gone), `${gone} came back: the host is Pages; its contract is public/functions + public/_routes.json + public/_headers`);
    }
  });

  it("the Pages contract files exist, with the semantics that matter", () => {
    const routes = JSON.parse(read("public/_routes.json")) as { version: number; include: string[]; exclude: string[] };
    assert.equal(routes.version, 1, "_routes.json keeps its version field or Pages ignores it");
    assert.ok(routes.include.includes("/*"), "routes must reach the fallback");
    assert.ok(routes.exclude.includes("/assets/*"), "/assets/* must bypass the function: immutable content served by Pages itself, misses answered 404 by Pages, never wrapped in HTML");

    const fn = read("public/functions/[[catchall]].js");
    assert.match(fn, /export function onRequest|export async function onRequest/, "the catch-all must be a Pages Functions handler");
    assert.match(fn, /ASSETS\.fetch/, "the shell comes from the deployed bundle's own static storage");
    assert.ok(fn.includes(String.raw`\.[A-Za-z0-9]+$`), "dotted misses must stay 404 (the PWA-pinning rule)");

    const headers = read("public/_headers");
    assert.match(headers, /\/assets\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/, "hashed assets are immutable");
    assert.match(headers, /\/sw\.js\s*\n\s*Cache-Control: no-store/, "a cached service worker pins the app past its own updates");
    assert.match(headers, /Service-Worker-Allowed: \//, "the worker keeps root scope");

    assert.ok(!exists("public/_redirects"), "a blanket /* /index.html 200 redirect is how a stale asset hash becomes HTML-with-200; the function owns the fallback");
  });

  it("deploy-web.yml deploys Pages through wrangler, per GitHub environment, and probes afterwards", () => {
    for (const rel of ["ci/workflows/deploy-web.yml", ".github/workflows/deploy-web.yml"]) {
      const yml = read(rel);
      assert.ok(!/vercel/i.test(yml), `${rel}: no Vercel step survives in the web deploy`);
      assert.match(yml, /pages deploy dist\/web --project-name/, "deploy is `wrangler pages deploy` against a named project");
      assert.match(yml, /kicklive-web-staging/, "staging is its own Pages project (its own domains, its own VITE pair)");
      assert.match(yml, /CLOUDFLARE_API_TOKEN/, "auth is the API token, with a named ::error:: when missing");
      assert.match(yml, /probe-deploy\.sh/, "every deploy ends by probing the live URL — 404s stay 404s on the real host");
      assert.match(
        yml,
        /environment: \$\{\{ github\.event\.inputs\.environment \|\| 'production' \}\}/,
        "the VITE pair is scoped per GitHub environment so staging can never ship with prod keys by copy-paste",
      );
    }
  });

  it("the tooling registry and docs point at the same host", () => {
    const secrets = read("scripts/check-secrets.mjs");
    assert.ok(!/VERCEL_/.test(secrets), "the secrets registry must not list a host we do not deploy to");
    assert.match(secrets, /CLOUDFLARE_API_TOKEN/);
    for (const rel of ["DEPLOYMENT.md", "docs/ENVIRONMENT_SETUP.md", "docs/DEPLOYMENT_VERIFICATION.md"]) {
      assert.match(read(rel), /Cloudflare Pages|pages deploy/, `${rel} documents the Pages path`);
    }
  });

  it("a bare `node scripts/run-tests.mjs` self-heals onto the TS loader", () => {
    const s = read("scripts/run-tests.mjs");
    assert.match(s, /process\.features\.typescript/, "the guard keys off the Node build feature the npm scripts paper over");
    assert.match(s, /NODE_OPTIONS/, "the loader rides NODE_OPTIONS so the spawned `node --test` children inherit it");
    assert.match(s, /ts-loader\.mjs/);
  });
});
