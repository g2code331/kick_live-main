# 🚀 KICKLIVE - DEPLOYMENT CHECKLIST (Cloudflare)

The production architecture is **Cloudflare Pages (frontend host) + a Cloudflare Worker (API) + Supabase
(database and auth)**. There is no Vercel step; there has not been since 2026-09-12. `DEPLOYMENT.md` is the
prose version of this list, `docs/ENVIRONMENT_SETUP.md` is the full per-resource runbook, and
[`docs/SETUP_WALKTHROUGH.md`](docs/SETUP_WALKTHROUGH.md) is the numbered order of operations for a fresh setup.

## 🗄️ STEP 0: THE DATABASE — ONE FILE, PER ENVIRONMENT

The project's SQL editor gets **one paste**: `supabase/SETUP.sql` (generated from the sources; see
`supabase/README.md`). Equivalent CLI reading, for anyone verifying by hand: the base schema
`KICKLIVE_FINAL_SCHEMA.sql`, then `supabase/migrations/` in filename order —

1. `20260909120000_phase1_security_hardening.sql`
2. `20260909210000_phase3_live_match_engine.sql`
3. `20260910120000_phase4_read_aggregates.sql`
4. `20260911120000_phase5_notifications.sql`
5. `20260912120000_phase6_r2_media.sql`
6. `20260913120000_phase7_advertising.sql`
7. `20260914120000_phase8_sponsorship.sql`
8. `20260915120000_phase9_observability.sql`
9. `20260916120000_phase10_privilege_tightening.sql`

- [ ] `supabase/SETUP.sql` run on **staging** (stops at the first error; every section self-verifies)
- [ ] same file run on **production**
- [ ] `CREATE_ADMIN_PROFILE.sql` once per environment, after creating the admin's auth user (it is not
      part of the bundle — it names a real user)
- [ ] Optional belt-and-braces: `node scripts/check-sql.mjs --dsn "<pooler string>" --allow-any-database`
      on staging (needs `npm i --no-save pg`). **Never `--fresh` against a Supabase project** — that flag
      recreates a scratch database.
- [ ] **Never** paste `SUPABASE_NEW_PROJECT_SETUP.sql` / `SUPABASE_COMPLETE_SCHEMA.sql` /
      `supabase_migrations.sql` — superseded, weaker than Phase 1, and deleted from the tree anyway.

## ☁️ STEP 1: CLOUDFLARE (both halves are one account)

- [ ] Queues created per environment (`docs/ENVIRONMENT_SETUP.md` §1 has the six names)
- [ ] R2 enabled in the dashboard, then `kicklive-media` + `kicklive-media-staging` created
- [ ] `RATE_LIMIT_KV` namespaces — already created (2026-09-10) and already wired into
      `workers/wrangler.toml`; the phase-2 test fails if the ids drift
- [ ] Worker vars per `[env.staging.vars]` / `[env.production.vars]` filled with **that project's**
      Supabase URL + ref + anon key (staging↔production cross-check: `docs/DEPLOYMENT_VERIFICATION.md` #14/#15)
- [ ] Secrets, per environment: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`,
      `TURNSTILE_SECRET_KEY`, `FCM_SERVICE_ACCOUNT` (+ `FCM_PROJECT_ID` as a var once Firebase exists)
- [ ] `npx wrangler secret list --env production` shows every one of them
- [ ] `npm run typecheck && npm run test:unit && npm run test:integration && npm run format:check` green
- [ ] `(cd workers && npx wrangler deploy --dry-run --outdir /tmp/wd --env staging)` exit 0, no warnings

## 🌐 STEP 2: PAGES (the frontend host)

- [ ] Projects exist: `kicklive-web`, `kicklive-web-staging` (`npx wrangler pages project create …`)
- [ ] Custom domains attached: `kicklive.football` (+`www`) and `staging.kicklive.football`; `/api/*`
      routed to the `kicklive-api` Worker on the same zones — the app uses same-origin `/api`, so no
      wildcard CORS and no `VITE_API_BASE_URL`
- [ ] GitHub environments `production` / `staging` hold `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
      `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- [ ] Deploy: push `main` (or Actions → *Deploy web* → target) — it builds with the environment's vars,
      uploads, and `scripts/ci/probe-deploy.sh` proves the live host (routes→shell, missing hashed
      asset→404, JS MIME, no traversal). A green deploy means all four.

## ✅ STEP 3: SMOKE — THE SHORT LIST

`docs/DEPLOYMENT_VERIFICATION.md` is the full 16-check version with the exact command per check. The core:

- [ ] `GET /api/health` ok, correct `"env"`; `x-ratelimit-store: kv` on any rate-limited response
- [ ] sign in as fan (RLS-shaped reads) and as admin; `/api/admin/users` with a fan token → 403
- [ ] one upload lands in R2; one live match streams (websocket, and kill it to watch the fallback)
- [ ] after a `:17` cron, `metric_daily` grew while `metric_rollups` did not
- [ ] rollback rehearsal: `npx wrangler pages deployment list --project-name kicklive-web` →
      `npx wrangler pages rollback <id> --project-name kicklive-web` — one command, old app served

## If something looks wrong

- [ ] Deep link 404s on Pages → the SPA fallback files must ship in `dist/web` (`public/functions/`,
      `public/_routes.json`); `npm run verify` checks the contract pre-build
- [ ] App boots against the wrong data → the `VITE_SUPABASE_URL`/`SUPABASE_ANON_KEY` pair in that GitHub
      environment belongs to the other project; the boot guard says so in the console
- [ ] Queue/cron paths throw "missing secret" → STEP 1's secret list, per environment
