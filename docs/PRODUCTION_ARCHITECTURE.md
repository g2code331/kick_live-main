# Kick Live — production architecture (Phase 1)

Written 2026-09-09. This is the as-built + target reference; findings and their status live in
[`SECURITY_AUDIT_PHASE1.md`](SECURITY_AUDIT_PHASE1.md), the ordered change plan in
[`PRODUCTION_MIGRATION_PLAN.md`](PRODUCTION_MIGRATION_PLAN.md), and the release/packaging contract in
[`RELEASE-PIPELINE.md`](RELEASE-PIPELINE.md). Where this document describes something as "today", it
was read out of this repository, not out of a design intention.

## 1. Purpose, scope, current state

Kick Live is a tournament platform for a Ghanaian football ecosystem: public fixtures, live scores,
league/cup tables, news, club pages, and privileged portals for admins, club managers and media
outlets. It ships as one React SPA in three shells — web (Vite → static host/Pages), PWA (own service
worker), and an Electron desktop app — plus a release pipeline that builds, verifies and publishes all
three (see `RELEASE-PIPELINE.md`).

As built, the SPA _is_ the application server:

```
React pages/portals  ──►  @supabase/supabase-js (anon key + user JWT)  ──►  PostgREST  ──►  Postgres (+ RLS)
        │
        ├── 19 setInterval polling loops for "live" data
        ├── 27 files issue writes directly (matches, match_events, media, teams, players, …)
        ├── one global cache singleton (src/lib/DataLoader.ts) that loads whole tables
        └── "automation" (standings, notifications) running in whoever's browser clicked Finalize
```

There is no API tier, no queue, no object storage, no push channel, no edge configuration in the
repository. Auth is Supabase Auth. The database is the only authority — which is the good part, and
the reason the RLS findings were rated critical rather than cosmetic.

Numbers, measured rather than estimated: 15 business tables in one authoritative schema file (plus
`access_requests` added by Phase 1); 37 RLS policies; 5 SQL files at the root, 4 of them superseded;
32 portal components of which 12 are unreachable from `App.tsx`; ~13.7k lines under `src/pages`.

## 2. Target architecture

```
                        ┌──────────────────────────── Cloudflare ─────────────────────────────┐
  browser / PWA /       │  Pages: static SPA (web + PWA shells, same bundle as today)          │
  desktop renderer ─────▶  WAF rules · Turnstile · cache rules · rate limits · custom hostnames │
                        └───────────────┬───────────────────────────────┬──────────────────────┘
                                        │ /v1/*  (JWT bearer)           │ media (signed URLs)
                                        ▼                               ▼
                        ┌─────────────────────────── Cloudflare Workers ──────────────────────┐
                        │  kicklive-api            (validation, authz, audit, orchestration)   │
                        │  MatchRoom Durable Object(s)   one per match_id: clock + event stream  │
                        │  Queues  kicklive-jobs         standings, fan-out, media optimize      │
                        │  KV      rate-limit counters, idempotency keys                        │
                        └───────┬───────────────────────────────┬───────────────────────────────┘
                                │ service_role (RLS still on for anon paths)
                                ▼                               ▼
                   ┌───────────────────────────┐    ┌──────────────────────┐   ┌──────────────────┐
                   │ Supabase Postgres (truth)  │    │ Supabase Auth        │   │ R2 bucket        │
                   │ + RLS + definer functions │    │ (unchanged provider) │   │ images, video     │
                   └───────────────────────────┘    └──────────────────────┘   └──────────────────┘
                                ▲
                                │ FCM / APNs delivery (Phase 5, from a Worker, never from a client)
```

Fixed decisions, so they stop being renegotiated per feature:

- **Supabase stays the source of truth.** No D1 mirror of business tables; `workers/wrangler.toml`
  documents why next to the commented-out binding.
- **Supabase Auth stays the identity provider.** The Worker verifies the same JWT the SPA already
  holds; no cookie session store, no second user table.
- **The frontend stays the frontend.** React pages are migrated to the API route by route, not by
  rewrite. The desktop and PWA shells keep working from the same `src/`.
- **Media leaves `public/` and leaves inline URLs**, into R2 with signed uploads (today: 3 files in
  `public/`, plus remote `images.unsplash.com` literals in components).

## 3. Component boundaries

| Layer              | Owns                                                                                  | Must not own                                                              |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| React SPA (`src/`) | rendering, forms, optimistic UI, route UX guards                                      | authorisation decisions, credentials, aggregate math that must be trusted |
| Cloudflare edge    | TLS, WAF, cache, Turnstile, limits per IP/route                                       | business rules                                                            |
| Worker API         | input validation, identity→capability check, orchestration, audit writes, idempotency | storing a second copy of match state                                      |
| Durable Object     | the live room: clock, sequence, presence, fan-out                                     | durable record of results (that is Postgres)                              |
| Supabase Postgres  | all business data, RLS, definer functions, constraints, triggers                      | trusting a client-provided role                                           |
| Supabase Auth      | credentials, sessions, email flows, password policy                                   | the application role (it lives in `profiles.role`)                        |
| R2                 | bytes                                                                                 | metadata that belongs in `media`/`players` rows                           |
| Queues             | anything that must outlive the click                                                  | the write the user is waiting on                                          |

One rule sits on top: a browser is an _untrusted_ caller. It asserts nothing about itself; identity
comes from a verified token, capability from the table in `workers/src/lib/capabilities.ts`, and the
row-level answer from RLS. "React route guards are UX protection, not security" — `src/App.tsx` says
exactly that above the `/admin` route.

## 4. Frontend architecture today

`src/main.tsx` (boot, service-worker registration, config guard) → `App.tsx` (HashRouter + providers)
→ `AuthProvider` (session + profile) → public pages under `src/pages/*` and role portals under
`src/pages/portals/*`. `HashRouter` is load-bearing for the desktop shell (`file://` origin) and is
kept until the shells are re-planned; it also means edge path routing must be prefix-agnostic.

Shared surfaces: `src/lib/supabase.ts` (one client), `env.ts` (config), `log.ts` (dev-gated console),
`app-shell.ts` (asset URLs + shell detection), `db.ts` (bounded reads for public pages), `DataLoader`
(global cache, §7), `formations.ts`, `MatchAutomation.ts`, `CompetitionEngine.ts`, `access.ts`
(privileged identity operations, Phase 1).

Two conventions the portals mostly follow and the API phase must enforce: name the columns you read,
and cap the read (`limit()`). Whole-table `select('*')` is what turned 5-minute polling into a
multi-megabyte fetch on slow connections.

## 5. Authentication and roles

Provider: Supabase Auth, email (+ phone) password, plus `ForgotPasswordPage`. `AuthContext` holds
`{ user, session, profile, loading }` and re-reads the profile on every `onAuthStateChange`, so a
revoked role takes effect on the next load rather than when the JWT expires.

Roles (`public.profiles.role`, CHECK-constrained to exactly these four):

| Role           | Self-service?                        | Granted by                                                                                    | Purpose                                     |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `fan`          | **yes — the only outcome of signup** | the signup trigger `handle_new_user()`                                                        | follow, predict, comment                    |
| `team_manager` | by request only                      | admin, via `kicklive_decide_access_request`                                                   | one club: squad, lineup, gallery, team news |
| `media`        | by request only                      | admin, via the same                                                                           | publish/edit articles                       |
| `admin`        | **never**                            | an existing admin (`kicklive_set_user_role`), or a superuser session for first-boot bootstrap | everything, including granting roles        |

Requests are queued in `access_requests` (one open per user, enforced by a partial unique index);
`admin` is excluded by a CHECK constraint, so it is not "hidden in the UI" but impossible.

What the client may assert about itself: `username`, `phone`, avatar. Nothing else. The previous
design — a `rolePasswords` map in `SignupPage.tsx` and `options.data.role` at signup — is gone (audit
F-02/F-04). Password policy: 8 characters minimum at signup; the Supabase dashboard's own
`min length` + leak-password check must be set to match (it is a project setting, not a repo file).

## 6. Authorization model

Three rings, and each must be able to fail alone without opening the others:

1. **Postgres grants** — column/table level. `profiles.role` and `.email` are not updatable by client
   roles at all; `anon` has no DML anywhere (revoked, plus default-privileges for future tables).
2. **RLS policies** — row level, `TO authenticated` on every write policy, `WITH CHECK` explicit, and
   every role test going through `SECURITY DEFINER` helpers with a pinned `search_path`.
3. **The Worker** (Phase 2) — capability check per route (`lib/capabilities.ts`), body validation,
   ownership predicates that RLS cannot express well (e.g. "you may only write events for a match
   assigned to you"), and the audit row.

Today rings 1–2 are the only ones that exist, which is why Phase 1 hardened them before any endpoint
work. The capability matrix is intentionally not a hierarchy (`admin ⊃ media ⊃ …`): each capability
names the roles that hold it, so adding a role cannot inherit silently. `team_manager` is absent from
row-scoped capabilities on purpose — ownership is a join (`teams.owner_id = auth.uid()`), not a role.

## 7. Data access layer and the DataLoader migration path

`src/lib/DataLoader.ts` is a singleton: `loadAll()` fires six-to-seven bounded whole-table selects in
`Promise.all`, caches for 5 minutes, subscribes components to the cached snapshot, and
`startAutoRefresh()` repeats every 5 minutes (an earlier 2-minute interval was already reduced for
egress). It also loads `profiles` (`id, email, username, role, created_at`, 50 rows) for admin screens,
i.e. **user data is fetched for anonymous visitors too** — a second reason it cannot stay as-is.

Consumers, from an import-graph traversal: `src/App.tsx` is the only file that imports it — it starts
the load + auto-refresh in an effect. No page calls `dataLoader.getTeams()` etc. directly; the portals
each re-query Supabase per mount. So the cache today is _written and subscribed by nobody but the
shell_.

Phase 1 changed only what was safe and local: the busy-wait (`while (isLoading) await sleep(100)`)
became a shared in-flight promise; polling pauses on `visibilitychange` and catches up once if stale;
all logging goes through `log.ts`. `loadUsers()` still runs in `loadAll()`.

Safe removal path, in order (each step independently shippable, nothing to "big bang"):

1. Delete the `loadUsers()` branch from `loadAll()` and give `AdminPortal`/`UserManagement` their own
   explicit fetch (they already do their own loading — this only removes the duplicate).
2. Move each public page to `db.ts`-style bounded helpers (or the Phase 2 `GET /v1/*` routes) and
   prove the page no longer reads `dataLoader`.
3. Replace `subscribe()` consumers with either TanStack-style per-page fetches (no new dependency
   today: the pages already fetch per mount) or the SSE stream for live screens (Phase 3).
4. When the import graph shows only `App.tsx` → delete the file, and with it the 5-minute global loop.

`db.ts` (column-named, `limit()`-bounded, `log.error` on failure, mock data dev-only) is the shape the
helpers converge on; it is deliberately not renamed or merged, so the diff stays reviewable.

## 8. Database: schema, RLS, migrations

Authoritative base: `KICKLIVE_FINAL_SCHEMA.sql` (15 tables; every other root SQL file is a subset of
it and is marked superseded). New deltas: `supabase/migrations/`, first entry
`20260909120000_phase1_security_hardening.sql`. `supabase/README.md` records which file wins, the full
policy-name list, and the rules for new migrations (additive, idempotent, self-checking, no destructive
statements, `notify pgrst` after catalogue changes).

Domain shape: `profiles · teams · players · seasons · competitions · matches · match_events ·
match_commentary · match_statistics · media · team_news · notifications · activity_logs · standings ·
team_staff` + `access_requests`. Notable invariants already in the base schema: `matches`
(`home_score/away_score/minute/status/is_locked/elapsed_seconds_before_pause`), `match_events` with a
29-value `event_type` CHECK and `minute/extra_minute/goal_type/card_reason`, `media.published`,
`teams.status ∈ (pending, active, rejected)`.

Missing and needed (not invented here, listed because the UI expects them): a `predictions` table
(F-21), `match_events.client_event_id` for idempotency, `media.author_id` actually populated,
`notifications.user_id`/recipient + `device_tokens`, and the monetization tables (§13–14).

Constraints to preserve while endpoints land: every write path from the browser stays subject to RLS;
the service-role client is used only where an owner check is impossible from the row, and each such
call site is greppable (`grep -rn supabaseAdmin( workers/src`).

## 9. Live match architecture

Today: an operator's tab owns the clock. `MatchControl*` components `setInterval` a minute counter
(60 s in `Complete`, 1 s in `Pro`), write `matches.home_score/away_score/minute/status` on button press,
insert `match_events`/`match_commentary` rows, and optionally run `MatchAutomation` (standings,
notifications) **in that browser**. If the tab closes mid-match the clock stops, the score on disk is
whatever was last saved, and no other operator can tell.

Target:

- **Event-sourced truth, aggregate in Postgres.** `match_events` is the record of what happened;
  `matches.score/minute` are a derived cache. The write path (`POST /v1/matches/:id/events`) validates
  the event (`event_type` in the CHECK list, minute in range, substitution pairs complete, penalty
  sequencing), applies derived effects server-side, and returns the new aggregate — so the client
  cannot post a score that disagrees with its own events.
- **Idempotency + ordering.** `client_event_id` (uuid, unique per match) makes retries safe; the DO
  assigns a monotonic `seq` so subscribers converge on one order.
- **Per-match Durable Object.** One `MatchRoom` per `match_id`: authoritative clock (start/pause/resume
  with `elapsed_seconds_before_pause` semantics), fan-out to all connected viewers (SSE first, WebSocket
  if presence is needed), write-behind batching into Postgres (one write per N seconds instead of per
  click), and a `lock`/`confirm` state machine so `is_locked` — which exists in the schema and is
  written by nobody today — finally means something.
- **Public read path.** `GET /v1/matches` (ETag, edge cache 30–60 s) for lists and `…/stream` for live;
  this retires the 19 `setInterval` sites (`HomePage`, `MatchesPage`, `MatchDetails`, `FanPortal`,
  `MultiMatchQueue`, every MatchControl variant) which currently multiply by open tabs and by devices.

## 10. Match Control implementations — audit

Ten variants plus a shared event editor. Verified by import-graph traversal from `src/App.tsx`
(32 portal components, 12 unreachable):

| File                        | Lines | Reachable                                            | Writes                                                   | Notable                                                                          |
| --------------------------- | ----- | ---------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `MatchControlComplete.tsx`  | 212   | **yes — AdminPortal "matches" tab + FixturesViewer** | `matches` update only                                    | score ± buttons, 60 s minute tick, `alert()` feedback                            |
| `MatchControlFull.tsx`      | 880   | yes — via `MultiMatchQueue`                          | events, commentary, statistics, `matches` (13 write ops) | the richest live: EventModal, extra time, lock (28 refs), confirm, elapsed timer |
| `MatchControlPro.tsx`       | 677   | no (only imported by dead `Organized`)               | + players, MatchAutomation calls                         | VAR, formations, lineup (13 refs), penalty shootout, 1 s tick                    |
| `MatchControlDashboard.tsx` | 568   | no                                                   | events, commentary, statistics, matches                  | extra time, shootout, elapsed                                                    |
| `MatchDashboard.tsx`        | 501   | no                                                   | events, commentary, statistics, matches, players         | automation calls ×2, its own timer                                               |
| `MatchControlCenter.tsx`    | 375   | no                                                   | events, commentary, matches                              | VAR, lineup, cards (8)                                                           |
| `MatchControlRoom.tsx`      | 370   | no                                                   | events, commentary, matches, players                     | formation + lineup views                                                         |
| `MatchControlNew.tsx`       | 288   | no                                                   | events, commentary, matches                              | —                                                                                |
| `MatchControl.tsx`          | 276   | no                                                   | events, commentary, matches                              | —                                                                                |
| `MatchControlOrganized.tsx` | 210   | no                                                   | none (wrapper)                                           | renders `Pro` inside a competition/match picker                                  |
| `MatchControlSimple.tsx`    | 172   | no                                                   | `matches` update                                         | score only                                                                       |
| `EventModal.tsx`            | —     | yes (via `Full`)                                     | —                                                        | typed event form: the only real event editor in the app                          |

Consequence worth acting on: **the screen admins actually open is the weakest one.** Event recording,
statistics and lock/confirm exist in `Full`/`Pro` but are reachable only through the multi-match queue,
so the primary path loses the data that the target architecture depends on.

Consolidation plan (Phase 2/3, and why nothing was deleted in Phase 1):

1. Extract the _behaviours_, not the components: from `Pro` (event validation, lineup/formation, VAR,
   shootout), from `Full` (lock/confirm + timer semantics), from `EventModal` (the event form), from
   `MatchAutomation` (finalization side effects → the queue).
2. Build one `LiveMatchConsole` whose state comes from the DO and whose writes go to
   `POST /v1/matches/:id/events` — no component in the tree may call `supabase.from('match_events')`.
3. Point `AdminPortal` at it, keep the old files untouched for one release so a rollback is a route
   change, then delete the 8 unreachable ones + the 2 superseded reachable ones in a single
   "remove match control variants" PR with `docs/` updated. Deleting them now would destroy nothing
   at runtime but would erase the reference implementations the extraction depends on.

## 11. Notifications and automation

`src/lib/MatchAutomation.ts` (332 lines) runs in the browser: on finalize it recomputes league/group
tables, advances knockouts, updates player/team statistics, checks qualifications, generates a summary,
and inserts a row into `notifications` (`title, body, match_id, event_type`) — with no recipient.
`notifications` has no `user_id`, nothing in the app selects from it, and `Header.tsx`'s bell is built
from recent _match results_, not from the table. So today's "notification system" is an append-only log
of one admin's click, and the standings math runs in whichever browser pressed the button (it is
`try/catch`-wrapped, so a failure is invisible).

`src/lib/CompetitionEngine.ts` (511 lines) is pure computation over plain objects — no Supabase import
at all — which makes it directly reusable inside a Worker/Queue consumer; that is the one piece of the
automation that needs no rewrite, only relocation.

Target: `POST /v1/matches/:id/finalize` → transaction (lock row, write result) → `JOB_QUEUE`
(`standings.recompute`, `notifications.fanout`) → consumer writes `standings` and per-user
notification rows → delivery worker posts to FCM/APNs (`device_tokens` table, Phase 5) with a
per-user, per-event-type preference on `profiles`. Duplicate suppression on `(match_id, event_type)`
belongs in the consumer, since retries are the normal case. Fan-out must never again depend on an
operator's tab staying open.

## 12. Media and storage

`media` holds articles (title/content/excerpt/category CHECK/`image_url`/`video_url`/`published`/
`views`/`featured`/`tags`); images are remote URLs (including `images.unsplash.com` literals in
components — which is why the desktop shell shows broken art offline, and why the CSP needs
`img-src` exceptions). Player/team photos are `photo_url`/`logo_url` columns on the rows.

Target: R2 bucket `kicklive-media`, `POST /v1/uploads/sign` returning a short-lived PUT (size + MIME
bounds, key prefix by kind), public reads through `GET /v1/uploads/:key` with immutable cache keys and
on-the-fly resizing, and rows storing `media_key` rather than an absolute URL so a bucket move is a
config change. Until then, the R2 columns keep whatever the publisher pasted, and the Phase 1 policy
change (`TO authenticated`) at least stops anonymous write attempts.

## 13. Advertising (future, deliberately separate)

Nothing exists: no table, no component, no slot concept, no `advertisers` mention anywhere in `src/`.
The plan reserves attachment points rather than inventing a schema now:

- **New tables, not new columns on `media`.** `advertisers`, `ad_campaigns` (flight dates, budget,
  status, target competition/team/region), `ad_placements` (slot id, format, frequency cap),
  `ad_placement_events` (impression/click, deduped by `event_id`).
- **Slots are declared in the UI layer, priced in the API.** Candidate surfaces from the current tree:
  home hero (`HomePage`), the list gap in `MatchesPage`, the article rail in `NewsPage`,
  `MatchDetails` sidebar, and the desktop shell (a slot per shell is a package, so `placement` needs
  a `shell` dimension).
- **Counters are server-written.** The `media.views` fix in Phase 1 is the template: a client read-
  modify-write on a billable number is not a metric, so impressions are recorded by
  `POST /v1/advertising/events` with dedupe and rate limits, and aggregated by a queue consumer.
- **Separate capability families** (`advertiser.manage`, `campaign.manage`, `placement.manage`,
  `placement_event.record`) already declared in `workers/src/lib/capabilities.ts`, so the authorisation
  surface is reviewed before the tables exist.

## 14. Sponsorship (future, not advertising)

Also absent. It is a _rights_ domain, not a delivery domain, and merging the two is how a `media`-style
30-column table appears:

- `sponsor_packages` (tier, rights list, price, season, exclusivity) and `sponsorships`
  (sponsor × package × season, start/end, renewal terms, invoice reference) — a sponsor of the
  tournament is not an advertiser buying placements, though a package may _include_ placements:
  the link is `sponsorship_id` → generated campaign rows, not shared columns.
- Rights that the existing data can honour: shirt/partner logo on `teams.logo_url` renders,
  competition naming (`competitions.name`/`title_sponsor`), the `featured` flag on `media`, and
  match-day slots on `matches`.
- Route families `sponsor_package.manage` / `sponsorship.manage`, admin-only until a sponsor portal
  role exists — and if that role appears, it is a fifth `profiles.role` value with its own row-scoped
  ownership predicate, not an escalation of `media`.

## 15. Environments, configuration, deploy topology, residual risk

**Env vars (browser).** `.env.example` is the template; `src/lib/env.ts` is the only reader; nothing is
defaulted. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required — a missing one is a boot error, not
a fallback), `VITE_UPDATE_MANIFEST_URL`, `VITE_UPDATE_CHANNEL` (optional, desktop/PWA feed).
`.replit` carries the project's public URL + anon key so the Replit environment boots; that pair is
what the bundle ships anyway, so it is not a secret — but nothing else may be added there.

**Env vars (server).** Documented in `.env.example` and `workers/.dev.vars.example`; consumed by
`workers/src/env.ts`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` as `[vars]`, and
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `TURNSTILE_SECRET_KEY` as `wrangler secret put`
only. `ALLOWED_ORIGINS` is an exact-origin list; `*` is rejected by `allowedOrigins()`.

**Secrets already in history.** The anon key + project URL appear in `repomix-output.xml` (a stale
1.9 MB dump of the whole tree) and in git history of the deployment guides; both were public-by-design
values, so no rotation is forced, but `repomix-output.xml` should be deleted or gitignored — it is a
source-of-truth imposter. `git log -p` still contains the removed `rolePasswords` map, which is
irrelevant only because that "secret" never protected anything; if a real credential is ever committed
here, rotate it first and treat history rewriting as the second step.

**Deploy topology.** Web/PWA: `dist/web` → Cloudflare Pages (or Vercel today, per
`ci/workflows/deploy-web.yml`), immutable hashed assets + `sw.js` at `max-age=0`. API:
`npx wrangler deploy` for `kicklive-api` on `api.<apex>/v1/*`. DB: Supabase project, migrations via
`supabase db push` gated by a review step. Desktop: unchanged (`RELEASE-PIPELINE.md` §10-13), reading
`VITE_*` at build time, which is why a config change is a _release_, not a config edit.

**Environments.** `development` (local Vite + `wrangler dev` + a disposable Supabase project),
`staging` (preview Pages deploy + staging project; migrations applied here first), `production`. The
split is meaningful only when the _database_ is separated too; a shared staging DB would make every
load test a production write, so a project per environment is a prerequisite for Phase 2, not a nicety.

**Residual risk after Phase 1, in order of how much it should worry an operator:**

1. The hardening migration is **prepared, not applied**. Until it runs, F-01/F-05/F-06/F-07/F-08 are
   open in production regardless of the app changes.
2. Direct browser writes (F-10) mean any future policy mistake is directly exploitable; only the
   Phase 2 route moves close that gap.
3. No rate limiting or bot gate on `signup`/`forgot-password`/`/rest/v1/rpc/*` (F-15).
4. Live state depends on an operator's tab (§9): a closed tab silently freezes a match.
5. Standings can be recomputed by whoever clicks finalize (§11), with errors swallowed.
6. `profiles.email` is still readable by any authenticated user (`profiles: authenticated read`) —
   the next narrowing is switching those reads to `profiles_public` and then restricting the base
   table to own-row-or-admin. Deferred because two admin screens and one join (`activity_logs →
profiles(username)`) depend on it today.
7. Predictions are browser-local (F-21): the feature is demonstrably "working" and is not.
8. The 10 Match Control variants (§10) keep diverging while all 10 remain in the tree.
