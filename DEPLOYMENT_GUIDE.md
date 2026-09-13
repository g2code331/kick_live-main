# 🚀 KICKLIVE - DEPLOYMENT GUIDE (Cloudflare)

**What each part is.** Pages hosts the frontend bundle; a Worker is the entire API (no Vercel, no Node
server in production — `server/cli.ts` is the local reference host with the same contract); Supabase is
Postgres + RLS + auth, nothing else. The Pages app calls `/api` **same-origin**, and Cloudflare routes
`kicklive.football/api/*` to the Worker — that is why the browser never needs the Worker's URL and why no
wildcard CORS exists anywhere.

## Step 1 — The cloud pieces once per environment

If you are setting the account up from zero, `docs/SETUP_WALKTHROUGH.md` is the numbered version of these steps; read that, then
come back here for the detail. Work through `docs/ENVIRONMENT_SETUP.md` §1–§4. It is one page per provider and lists every var, every
secret, the six queue names, both buckets, and the (already-done) KV wiring. Short form: queues → R2
(enable in dashboard, then create) → `supabase/SETUP.sql` into the project's SQL editor → Worker vars and
secrets with `wrangler secret put`, per `--env`.

## Step 2 — Deploy the Worker

```bash
npm run worker:deploy:staging       # then curl https://staging.kicklive.football/api/health
npm run worker:deploy:production    # then curl https://kicklive.football/api/health
```

Both scripts are `cd workers && npx wrangler deploy --env …`. The deploy reads `workers/wrangler.toml`;
named environments do **not** inherit top-level `[vars]`, which is why the staging/production blocks each
carry their own `MEDIA_MAX_BYTES`, queue names, and Supabase triple.

## Step 3 — The Pages project exists once

```bash
npx wrangler pages project create kicklive-web --production-branch main
npx wrangler pages project create kicklive-web-staging --production-branch main
```

Attach `kicklive.football`/`www` to the first project and `staging.kicklive.football` to the second
(Pages → Custom domains — the zone is already on Cloudflare so DNS is automatic). Then add the Worker
route `<host>/api/*` → `kicklive-api` for each hostname.

## Step 4 — Deploy the frontend

Normal path: the **Deploy web** GitHub Action (push to `main` or workflow_dispatch with
`preview|staging|production`). It builds `dist/web` using the GitHub environment's
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, runs `verify-packaging.mjs`, deploys via
`wrangler pages deploy`, and finishes by running `scripts/ci/probe-deploy.sh` against the live URL.

Manual/emergency path:

```bash
npm run build:web
npx wrangler pages deploy dist/web --project-name kicklive-web --branch main
bash scripts/ci/probe-deploy.sh https://kicklive-web.pages.dev
```

Never paste a superseded schema file as part of "setting the database" — `SUPABASE_NEW_PROJECT_SETUP.sql`
and `SUPABASE_COMPLETE_SCHEMA.sql` were removed from the tree on 2026-09-12 for exactly this reason;
`supabase/SETUP.sql` is the only file that runs.

## Step 5 — Verify and, if needed, roll back

`docs/DEPLOYMENT_VERIFICATION.md` — sixteen checks with one command each. Rollback:

```bash
npx wrangler pages deployment list --project-name kicklive-web
npx wrangler pages rollback <DEPLOYMENT_ID> --project-name kicklive-web
```

Frontend and API roll back independently (Worker: `npx wrangler rollback --env …`). Database migrations
are additive-only; there is nothing to un-run when shipping a bundle.

## CI note

`.github/workflows/*` are installed copies of `ci/workflows/*` (`npm run ci:install`, `npm run ci:check`
fails on drift). `Deploy web` runs typecheck-independent gates already covered by `npm run gates`; a push
that is green locally is green in CI. If the runner cannot push `.github/workflows` (a repository push
rule), that rule lives in Settings → Rules — you own the repo, relax it or commit with `git add -f`.
