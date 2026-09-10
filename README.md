# Kick Live

A tournament platform for a Ghanaian football ecosystem: public fixtures, live scores, league and cup tables,
news, club pages, push notifications, advertising and sponsorship — plus privileged portals for admins, club
managers, media outlets and match officials.

It ships as **one React SPA in three shells** (web, PWA, Electron desktop) and **one Cloudflare Worker** that is
the application tier. Postgres is the only authority for state; the Worker is the only place writes are decided;
the browser never holds a privileged key.

```
React 19 SPA (Vite 7, Tailwind 4)          Cloudflare Worker "kicklive-api"           Supabase / Cloudflare
┌───────────────────────────────┐   fetch    ┌───────────────────────────────┐  REST   ┌─────────────────────────┐
│ public pages · portals        │ ─────────► │ router.ts: 101 declared routes │ ──────► │ PostgREST → Postgres    │
│ src/lib/data (one query spec) │  /api/*    │ middleware: auth · capability │         │  · RLS on every table   │
│ MatchRoom via WebSocket + DO  │ ◄───────── │ · ratelimit · cache · audit    │ ──────► │  · kicklive_* functions │
└───────────────────────────────┘            │ queues: notifications, ad-events│  R2/KV  └─────────────────────────┘
        ▲                                    │ cron: 5-minute sweep + hourly   │ ──────► R2 MEDIA_BUCKET, KV, Queues
        └── Supabase Auth (user JWT) ───────►│ structured logs + metric buffer │         (FCM v1 for push)
                                             └───────────────────────────────┘
```

Everything in that diagram is described as-built — including what is _not_ wired yet — in
[`docs/PRODUCTION_ARCHITECTURE.md`](docs/PRODUCTION_ARCHITECTURE.md).

## Where to read, in what order

| If you want to…                                      | Read                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| understand the system as built                       | [`docs/PRODUCTION_ARCHITECTURE.md`](docs/PRODUCTION_ARCHITECTURE.md)                                                                                                                           |
| know what is left before a release                   | [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)                                                                                                                                                 |
| know what was found and fixed in security            | [`docs/SECURITY_AUDIT_PHASE1.md`](docs/SECURITY_AUDIT_PHASE1.md)                                                                                                                               |
| apply or change the database                         | [`supabase/README.md`](supabase/README.md), then `docs/PRODUCTION_MIGRATION_PLAN.md`                                                                                                           |
| deploy web + Worker                                  | [`DEPLOYMENT.md`](DEPLOYMENT.md), [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md)                                                                                                         |
| work on the API tier                                 | [`workers/README.md`](workers/README.md) — the route catalogue, per route                                                                                                                      |
| push notifications / media / ads / sponsor / metrics | `docs/NOTIFICATIONS_ARCHITECTURE.md`, `docs/R2_MEDIA_ARCHITECTURE.md`, `docs/PRODUCTION_MIGRATION_PLAN.md` (Phase 7), `docs/SPONSORSHIP_ARCHITECTURE.md`, `docs/OBSERVABILITY_ARCHITECTURE.md` |
| build or ship the desktop app                        | [`docs/RELEASE-PIPELINE.md`](docs/RELEASE-PIPELINE.md)                                                                                                                                         |

## Run it

```bash
npm ci                                  # web + worker toolchain
cp .env.example .env.local              # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
cp workers/.dev.vars.example workers/.dev.vars   # local-only, git-ignored, never committed
npm run dev                             # SPA on :5173, /api proxied to wrangler dev on 127.0.0.1:8787
```

`npm run dev` starts the SPA only. The Worker needs `npm run worker:dev` (or `npm run worker:local`) in a second
terminal, and the database needs the migrations applied to whatever `SUPABASE_URL` points at — see
[`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md) step 3 for the exact order. Without `workers/.dev.vars` the
Worker refuses to boot by design; without FCM credentials the notification transport is a mock and no message
leaves the account, which is the intended laptop state.

## Check it

```bash
npm run typecheck        # both tsconfig projects: the SPA and workers/
npm run test:unit        # node scripts/run-tests.mjs unit  — the whole point of `node --test tests/unit` is that it finds nothing
npm run format:check     # prettier, and one violation fails the run
npm run check:sql        # applies every migration to a scratch database and runs the flows (needs Postgres)
npm run gates          # the aggregate: branding, version lockstep, verify, route catalogue, query ratchet, packaging
```

There is no lint step and no `.eslintrc`: `tsc` with `strict` plus the checks above are the enforcement, and the
repo has not acquired a linter since Phase 1 (adding one is a decision, not a default).

## The rules that keep this thing honest

- **The database decides.** No client sets a role, a score, a sponsor status or an ad state directly; each goes
  through a `kicklive_*` function that re-reads the caller from `auth.uid()`. Privileges are checked before RLS,
  which is why Phase 10 narrowed _columns_ as well as rows.
- **A service-role key never reaches a browser.** `VITE_*` carries only the publishable/anon key; the source scan
  in `scripts/check-secrets.mjs` fails the build on a JWT-shaped literal, and `supabaseAdmin()` exists only in
  `workers/`.
- **Migrations are additive.** No `drop`, no `truncate`, no `delete from` in a phase migration; destructive work
  is a separate reviewed migration with a backup plan. Every phase migration ends with a `do $verify$` block
  that **raises** rather than installing quietly.
- **A documented gap beats a polished lie.** `RELEASE_CHECKLIST.md` marks items
  `READY / REQUIRES CONFIGURATION / REQUIRES TESTING / BLOCKED / NOT IMPLEMENTED`, and the architecture notes each
  have a "what is deliberately not done" section. This sandbox has no Postgres and no Cloudflare credentials, so
  anything that needs them is recorded as unverified rather than assumed.

## Repository layout

```
src/                      React SPA: pages/, pages/portals/{admin,shared}/, lib/data/ (query specs), lib/api/ (client)
workers/                  Cloudflare Worker: src/{routes,middleware,queues,do,lib,services}, wrangler.toml
supabase/migrations/      nine additive migrations, filename order == apply order
docs/                     architecture notes per phase, the security audit, the release pipeline
scripts/                  gates, verify, check-sql, query-audit (the ratchet), worker-routes, install-ci
tests/unit/               node:test suites, run through scripts/run-tests.mjs
KICKLIVE_FINAL_SCHEMA.sql authoritative base schema; the other four root *.sql files are superseded (see supabase/README.md)
```
