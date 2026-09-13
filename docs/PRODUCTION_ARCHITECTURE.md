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
                                        │ /api/* (JWT bearer;           │ media (signed URLs)
                                        │  /v1/* alias)  LIVE           │ planned, Phase 4
                                        ▼                               ▼
                        ┌─────────────────────────── Cloudflare Workers ──────────────────────┐
                        │  kicklive-api  ✅ LIVE (Phase 2)                                       │
                        │    · pipeline: cors → match → authenticate → authorize → limit → route │
                        │    · live routes: GET /health, /me, /teams/mine                        │
                        │    · declared routes answer 501 *after* authn + authz (32 total)      │
                        │    · validation library, capability matrix, error envelope, audit hook │
                        │  MatchRoom Durable Object(s)   one per match_id: clock + event stream  │
                        │    ⏳ Phase 3 — NOT configured in wrangler.toml yet                     │
                        │  Queues  kicklive-jobs         standings, fan-out, media optimize      │
                        │    ⏳ Phase 4 — NOT configured                                         │
                        │  KV      rate-limit counters (optional: dev falls back to per-isolate) │
                        └───────┬───────────────────────────────┬───────────────────────────────┘
                                │ caller's JWT where RLS suffices;│
                                │ service_role only for cross-row  │
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

| Layer                 | Owns                                                                         | Must not own                                                              |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| React SPA (`src/`)    | rendering, forms, optimistic UI, route UX guards                             | authorisation decisions, credentials, aggregate math that must be trusted |
| `src/lib/api/` (LIVE) | base URL, bearer token, JSON, error envelope, timeouts for Worker calls      | caching, retry loops, authorisation logic, a second auth implementation   |
| Cloudflare edge       | TLS, WAF, cache, Turnstile, limits per IP/route                              | business rules                                                            |
| Worker API (LIVE)     | identity→capability→ownership, input validation, orchestration, audit writes | storing a second copy of match state; a role claim from the client        |
| Durable Object        | the live room: clock, sequence, presence, fan-out                            | durable record of results (that is Postgres)                              |
| Supabase Postgres     | all business data, RLS, definer functions, constraints, triggers             | trusting a client-provided role                                           |
| Supabase Auth         | credentials, sessions, email flows, password policy                          | the application role (it lives in `profiles.role`)                        |
| R2                    | bytes                                                                        | metadata that belongs in `media`/`players` rows                           |
| Queues                | anything that must outlive the click                                         | the write the user is waiting on                                          |

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

**The Worker verifies the same credentials, independently of React** (`workers/src/middleware/auth.ts`,
live in Phase 2): HS256 signature against `SUPABASE_JWT_SECRET`, then `exp`/`iat` skew, then `aud`,
then a read of `profiles.role` by `sub` — with the caller's own token, so RLS applies to the identity
read. A valid token whose profile row is gone is a 401, not an anonymous fallback. No endpoint accepts
a role from a body, query string or cookie, and the JWT's own `role` claim (the Postgres role) is never
treated as the application role.

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
3. **The Worker** (live since Phase 2) — capability check per route (`workers/src/lib/capabilities.ts`
   via `middleware/authorization.ts`), body validation (`lib/validation.ts`), ownership predicates that
   RLS cannot express well (`services/teamAccess.ts`), and the audit row (`middleware/audit.ts`).

Rings 1–2 are what protects every feature that has **not** moved behind a route yet — which is still
almost all of them. Ring 3 currently guards the three implemented routes, and guards the other 29
_declared_ routes too: authentication and authorization run before the `501` stub, so a fan already
gets 403 on `POST /api/admin/users/:userId/role` even though nothing there is writable yet. That
ordering is why Phase 1 hardened rings 1–2 first: a route table is not enforcement, a route handler
behind the checks is. The capability matrix is intentionally not a hierarchy (`admin ⊃ media ⊃ …`): each capability
names the roles that hold it, so adding a role cannot inherit silently. `team_manager` is absent from
row-scoped capabilities on purpose — ownership is a join (`teams.owner_id = auth.uid()`), not a role.

## 7. Data access layer — `DataLoader`, then `src/lib/data`

`src/lib/DataLoader.ts` was a singleton that loaded six tables at startup and refreshed them every five
minutes. Phase 4 (audit `docs/PHASE4_DATA_ARCHITECTURE.md` F-01) established that **nothing read it**: no
component called `getTeams()`, `getMatches()` or `subscribe()`. Its queries were column-named and limited, so
the module was never a correctness problem — it was six round trips per cold start per visible tab buying a
cache with no readers.

Today: the boot effect calls `initDataLayer()` instead, `DataLoader.ts` remains on disk unreferenced and
documented (deleting a component because a grep found no readers is how a phase like this acquires a silent
regression), and the reads the app actually needs live in `src/lib/data/queries.ts` — 22 specs, one place per
question, each with a cache key, a tag set, a bound and a freshness class, served by
`src/lib/data/cache.ts` and `useQuery`. Pages may read; pages may not query.

## 8. Database: schema, RLS, migrations

Authoritative base: `KICKLIVE_FINAL_SCHEMA.sql` (15 tables; every other root SQL file is a subset of
it and is marked superseded). New deltas: `supabase/migrations/` — `…phase1_security_hardening`,
`…phase3_live_match_engine`, and (Phase 4) `20260910120000_phase4_read_aggregates.sql`, which adds three
read aggregates and **no** indexes: the index block in that file is commented, because the rule is a plan
before an index and this repository has never run one (`scripts/query-audit.mjs --explain`). `supabase/README.md` records which file wins, the full
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

> **Status: built in Phase 3.** §9.1 describes what ships; the "Today:" block that follows is the
> pre-Phase-3 state, kept because §10's audit and the migration notes refer to it.

### 9.1 As built (Phase 3)

```
controller's browser ── POST /api/matches/:id/events ──▶ Cloudflare Worker route
   (no score, no status,     (authn → authz → validation)          │
    no minute of the clock,                                        ▼
    no sequence)                                          MatchRoom Durable Object
   ▲                                                       (per match: state + sockets)
   │  snapshot / frames                                          │  one writer, in order
   │  (MATCH_SNAPSHOT, MATCH_EVENT,                              ▼
   │   MATCH_STATUS, MATCH_CLOCK,                        POST /rpc/kicklive_record_match_event
   │   SYNC_CONFLICT, CONTROLLERS, PING/PONG)                    │  Postgres: allocate live_seq,
   │                                                              │  insert the row, recompute the
  Fans ── WebSocket (ticket) ─┐                                   │  score, write matches.minute,
   └──── SSE fallback ────────┴──── the same frames ◀── broadcast ─┘  audit
              │                                     │
              │                                     ▼
              └── reducer: src/lib/live/machine.ts   Supabase PostgreSQL = the permanent record
```

Decisions that define it:

- **Postgres is the authority for everything a match means.** `kicklive_record_match_event` allocates the
  per-match `sequence` from `matches.live_seq`, inserts the row, recomputes the score from the surviving
  active events (`kicklive_match_score`), writes `matches.minute`, and audits. The Durable Object holds the
  live state and the sockets; it is _not_ the database, and it never acks an event the database refused.
- **A client cannot send an authoritative number.** `POST /events` accepts an event's own minute, team,
  players and optional metadata; score, status, the match clock, the sequence and "who recorded this" are
  all server-derived. `kicklive_guard_match_result_columns` makes a browser-role `UPDATE` of
  `home_score/away_score/minute/status/is_locked/live_seq` fail with `42501` for any match the engine has
  written (a fixture the engine never touched keeps the legacy behaviour — the ratchet that made this safe
  to apply to a live database).
- **The vocabulary is the schema's.** 14 statuses from `matches.status`'s CHECK list, 27 event types from
  `match_events.event_type`, `goal_type` as declared. Legal moves live in one seeded table,
  `kicklive_match_transitions` (49 rows, with `requires_admin`/`reason_required`), which both the SQL
  functions and `workers/src/lib/matchLifecycle.ts` are pinned against by `tests/unit/live-match-engine.test.ts`.
- **Corrections, never deletions.** An event is `active` or `corrected`; a correction records who, when,
  why, links to the original (`corrects_event_id`) and re-derives the score. `match_events` has
  `revoke update, delete` from client roles plus a trigger, so no client can rewrite history — including
  the ~27 legacy screens that still insert rows.
- **Ordering, idempotency and reconnect.** Every frame carries `sequence`; a client only ever says "I have
  seen N". Reconnect sends `{type:"resume", after_sequence:N}`; the room answers with the ≤60 retained
  events or, if it cannot bridge the hole, a fresh `MATCH_SNAPSHOT`. Idempotency is
  `unique (match_id, client_event_id)`, so a retry is a no-op that returns `{duplicate:true}`.
- **Offline is a first-class state.** A controller's tap is written to a durable local queue _before_ the
  fetch, is stamped with its idempotency key at send time, is retried with backoff, and is never discarded
  silently: a refusal becomes a visible `refused` row with the server's words. Status changes and
  finalization are deliberately **not** queueable — half time must happen when the referee taps it, not when
  the signal returns.
- **Fans never end up silently wrong.** WS → SSE → polling in that order, with the same reducer and the same
  sequences on every rung, a 20 s staleness budget while the clock runs, and a self-repair that fetches the
  authoritative snapshot. A degraded pipe is labelled on screen, not hidden.

Notifications and standings recalculation stay in Phase 5: finalizing freezes the result and writes
`confirmed_at`; it does not fan out to `match_notifications` or the league table yet.

Today: an operator's tab owns the clock. `MatchControl*` components `setInterval` a minute counter
(60 s in `Complete`, 1 s in `Pro`), write `matches.home_score/away_score/minute/status` on button press,
insert `match_events`/`match_commentary` rows, and optionally run `MatchAutomation` (standings,
notifications) **in that browser**. If the tab closes mid-match the clock stops, the score on disk is
whatever was last saved, and no other operator can tell.

Pre-Phase-3 target (kept for the record — §9.1 says what actually shipped, and where it differs):

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

**Consolidation outcome (Phase 3).** Step 1 and 2 happened, and step 3 happened except for the deletion:

- `MatchControlCenter.tsx` was rewritten as the canonical console (`useMatchRoom` + `eventCatalog`), and
  `FixturesViewer` and `MultiMatchQueue` — the only two live entry points in the table — now render it.
  `AdminPortal`'s dead import of `MatchControlComplete` was removed. No component in the tree calls
  `supabase.from('match_events')` or `supabase.from('matches').update(...)` for a live match any more, which
  is what step 2 required; `tests/unit/live-client.test.ts` pins it (the console must contain no
  `.update(`/`.insert(`/`setInterval`, and the fan page must not read `match_events` directly).
- The 10 superseded files and `EventModal.tsx` are **still on disk with a `SUPERSEDED` header** naming this
  section. They are unreachable from routing and from every portal, so a rollback is a one-line import
  change, and the deletion decision (with the answer to "is anything still owed from `Pro`?") is left to a
  human rather than taken on the strength of a grep.
- The pad's vocabulary is not a copy: `src/lib/live/eventCatalog.ts` mirrors
  `workers/src/lib/matchEvents.ts` field for field (`team`, `players`, `goalType`, `cardReason`, `group`)
  and is checked against it by test, so the console cannot offer an event the database refuses, and a
  future edit to the spec that skips the browser shows up as a failing build.

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

**Superseded by Phase 6 — this paragraph is the original plan, kept so the change is auditable.** What
was actually built differs in three ways, each for a reason (`docs/R2_MEDIA_ARCHITECTURE.md` is the
current document):

- **No signed uploads.** A presigned PUT cannot create a registry row, count against a quota, dedupe a
  duplicate, or sniff a format, and it splits publish-and-record into two failure windows. The browser
  posts the file to the Worker (`POST /api/media/uploads`, capability `profile.read_own`) and Postgres
  decides the key, the version, the ownership and the visibility _before_ a byte moves. `POST
/v1/uploads/sign` and `GET /v1/uploads/:key` were deleted as designs, not left as 501 stubs.
- **No `media_key` column.** Rows keep storing a URL in the eight `*_url` columns they already have; what
  changed is that the value is now the _relative_ path `/api/media/assets/<kind>/<id>/original/v<n>-<hash8>.<ext>`,
  resolved at render time by `assetUrl()`. A bucket move is still a config change (and a legacy absolute
  Supabase or unsplash URL still renders, which is why no row had to be migrated to keep working).
- **No on-the-fly resizing.** An unbounded CPU-bound transform behind a public URL is a denial-of-service
  invitation; derived variants are a producer's job (`thumbnail/`, `og/` exist in the key space and the
  registry refuses them until one exists). Reads are a Worker read-through with the immutable cache key
  the plan wanted, ranges and ETags included.

R2 is reached through a binding (`MEDIA_BUCKET`), so no media credential exists anywhere in the app.

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
Since Phase 2 also: `VITE_API_BASE_URL` (**empty by default** = same-origin `/api`, which the Vite dev
server proxies to `wrangler dev` on 127.0.0.1:8787) and `VITE_API_ALLOW_REMOTE=1` (the only way a dev
build may name a remote API). `resolveApiBaseUrl()` refuses dev→remote and prod→localhost, which is
what makes "local development cannot touch production data" a check rather than a convention.
`.replit` carries the project's public URL + anon key so the Replit environment boots; that pair is
what the bundle ships anyway, so it is not a secret — but nothing else may be added there.

**Env vars (server).** Documented in `.env.example` and `workers/.dev.vars.example`; consumed by
`workers/src/env.ts`: `APP_ENV`, `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_ANON_KEY`,
`ALLOWED_ORIGINS` as `[vars]` (all three environments declared in `workers/wrangler.toml`:
development at the top level, `[env.staging]`, `[env.production]`), and `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_JWT_SECRET`, `TURNSTILE_SECRET_KEY` as `wrangler secret put … --env <name>` only.
`ALLOWED_ORIGINS` is an exact-origin list; `*` is rejected by `allowedOrigins()`, and an unset list
means "no cross-origin access at all". `SUPABASE_PROJECT_REF` is not a secret: it pins which project ref
the environment may address, and `assertSupabaseUrl()` fails the request (500, loudly) if
`SUPABASE_URL` disagrees — the failure mode the SPA had in Phase 1 (a silent fallback to another
project) is not repeated server-side.

**Secrets already in history.** The anon key + project URL appeared in `repomix-output.xml` (a stale
1.9 MB dump of the whole tree), in `.replit`, and in git history of the deployment guides; all three
were public-by-design values, so no rotation is forced. **Closed 2026-09-13:** `repomix-output.xml`,
`output.md`, `.replit`, `replit.md` and `replit.nix` are deleted and gitignored — the dump was a
source-of-truth imposter and it also carried a real personal address copied out of the old admin
bootstrap script, which is the kind of thing a `git grep` turns up for anyone who looks. Deleting a
file does not delete a blob from history, so a committed _private_ value still has to be rotated first;
`git log -p` still contains the removed `rolePasswords` map, which is irrelevant only because that
"secret" never protected anything.

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
2. Direct browser writes (F-10) mean any future policy mistake is directly exploitable; the Phase 2
   route table and client (`src/lib/api/`) now exist, but **no write route is implemented**, so this gap
   is still open until each table's route is built and its callers moved.
3. No rate limiting or bot gate on `signup`/`forgot-password`/`/rest/v1/rpc/*` (F-15) **as long as those
   calls go straight to Supabase**. The Worker's budget classes (`middleware/ratelimit.ts`) and Turnstile
   verification exist and are tested, and every declared write route names a class — but they can only
   protect traffic that actually goes through the Worker.
4. Live state depends on an operator's tab (§9): a closed tab silently freezes a match.
5. Standings can be recomputed by whoever clicks finalize (§11), with errors swallowed.
6. `profiles.email` is still readable by any authenticated user (`profiles: authenticated read`) —
   the next narrowing is switching those reads to `profiles_public` and then restricting the base
   table to own-row-or-admin. Deferred because two admin screens and one join (`activity_logs →
profiles(username)`) depend on it today.
7. Predictions are browser-local (F-21): the feature is demonstrably "working" and is not.
8. The 10 Match Control variants (§10) keep diverging while all 10 remain in the tree.

## 16. The API boundary as built (Phase 2)

Sections 2–15 describe the target; this section records what is now in the tree, so "planned" and
"implemented" stay distinguishable. Operational detail (every flag, the route map, the add-a-route
checklist) lives in `workers/README.md`; this section is the architecture view.

### 16.1 Two paths, one rule

```
                         read (public, cacheable)             privileged mutation / per-user read
                        ┌──────────────────────────┐        ┌──────────────────────────────────────┐
  React page ── Supabase SDK ─▶ Supabase (RLS)      │        │ page ─▶ src/lib/api ─▶ Worker ─▶ Postgres │
                        └──────────────────────────┘        └──────────────────────────────────────┘
                              unchanged today                    LIVE for /health, /me, /teams/mine;
                                                                 declared (501) for the other 29
```

The rule that decides which side a call belongs on is not "sensitive or sensitive-looking" — it is
**who must be trusted to make it**:

| Call                                                               | Path                                                         | Why                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| fixture list, standings, published articles                        | browser → Supabase (RLS)                                     | `anon` + `public.read`; a Worker hop adds latency and no trust                |
| my own profile fields                                              | browser → Supabase today                                     | RLS `USING (auth.uid() = id)` already restricts it correctly                  |
| who I am, per the API (`GET /api/me`, `GET /api/teams/mine`)       | **Worker**                                                   | needs capability + ownership resolution, and is the probe for the whole chain |
| role change, access-request decision, match event, publish, lineup | browser → Supabase **today**; Worker when the route is built | ring 3 must be in place before the client stops being the authority           |

Moving a call behind the Worker is a per-route decision with a per-route migration in
`docs/PRODUCTION_MIGRATION_PLAN.md` §Phase 2; it is not a bulk rewrite, and it is not "everything must
now go through the Worker" — public reads through an API tier would add a failure domain for nothing.

### 16.2 Request flows, as implemented

```
GET /api/health                     (no token, no DB)
  matchRoute → capability: null → rate class "public" → routes/health.ts
  200 { success:true, data:{ service, status, version, environment, routes, time } }
      cache-control: public, max-age=30, s-maxage=60     ← the only edge-cacheable per-deployment route

GET /api/me                         (token, one primary-key read)
  authenticate(): HS256 verify → sub → profiles read WITH THE CALLER'S TOKEN → role
  authorizeForRoute("profile.read_own")
  200 { data:{ userId, email, username, role, capabilities[] } }   ← capabilities are a display hint,
      never a grant; cache-control: no-store (a per-user response at the edge is a cross-account leak)

GET /api/teams/mine                 (token, role predicate + row predicate)
  authorizeForRoute("team.read_own")
  role gate in the handler → owner_id filter in SQL → read issued with the caller's token
  200 { data:{ teams[], reason } }   ← a fan gets [] with reason "role_has_no_clubs", not an error

POST /api/admin/users/:userId/role  (declared, not built)
  authenticate → authorizeForRoute("identity.grant_role")
    fan / media / team_manager → 403 FORBIDDEN            (never reaches the stub)
    no token                   → 401 UNAUTHENTICATED      (never reaches the stub)
    admin                      → 501 NOT_IMPLEMENTED "…planned for phase 2"
```

Every response — including errors and including the 501 — carries the same envelope, `x-request-id`,
`no-store` unless the route is declared edge-cacheable, the security header set, and a CORS echo only
for an exact origin in `ALLOWED_ORIGINS`.

### 16.3 What Phase 2 did **not** do

Honesty list, because each line below is a thing a reader might otherwise assume exists:

- No write route is implemented. The validation library is tested on its own, not through a route.
- No auth route (`/api/auth/*`), so signup and login still run in the browser against Supabase.
- No FCM/APNs code, no Firebase dependency, no push table.
- No Durable Object, Queue, R2 or D1 binding in `wrangler.toml` (only the KV one, and it is optional).
- Nothing was deleted: the 8 Match Control variants, `TeamPortal`, `DataLoader`, the mock screens and the
  27 files that write from the browser are all still in place and still how the app works.
- The Worker has not been executed against Cloudflare from this working session: `wrangler` is not
  installed here, so `GET /api/health` has been proven against the real handler in tests, not against a
  deployed Worker. Treat "deployed and probed" as a Phase 2 exit task, not as done.

## 17. The live match engine as built (Phase 3)

Same purpose as §16: separate "in the tree and tested" from "planned". Route-by-route detail lives in
`workers/README.md`; the event/state rules are pinned by `tests/unit/live-match-engine.test.ts` (SQL ↔ TS)
and `tests/unit/live-client.test.ts` (the browser mirror, the reducer, the draft queue).

### 17.1 One chain, two transports, one reducer

```
fan / console  ──▶  src/lib/live/useMatchRoom.ts
                        │  REST (auth, rate limits, envelope)      WS/SSE (read-only frames)
                        ▼                                            ▼
              workers/src/routes/live.ts  ──serialise──▶  MatchRoom Durable Object
                        │                                        │  writer queue, one at a time
                        ▼                                        ▼
              services/matchAccess.ts (assignment proof)   services/matchPersistence.ts
                        │                                        │  rpc
                        └────────────────────────────────────────▶ Supabase Postgres
                                                                   kicklive_* functions (the decision-maker)
                                                                   match_events = the ledger
                                                                   matches = the derived cache + clock
```

The socket never writes, by construction: `handleLiveSocket` accepts an upgrade only after verifying a
short-lived HS256 ticket (`liveTicket.ts`, `aud: "kicklive-live"`, 6 h for a viewer / 15 min for a
controller), and the only client frames the room reads are `{type:"resume"|"ping"|"snapshot"}`. A controller
writes with REST, where `authenticate → authorizeForRoute → resolveMatchAccess → the SQL function` all run
again. The ticket is not a credential with privileges; it names an audience.

### 17.2 Durability model, stated exactly

| Step                                           | Where                         | If it fails                                                                      |
| ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| tap                                            | `useMatchRoom` → `DraftQueue` | persisted locally first; the UI shows it as queued                               |
| authn + authz + shape validation               | Worker route                  | 4xx to the console, entry marked `refused`, never dropped                        |
| ordering, `expected_sequence` race check       | MatchRoom DO                  | 409 + `SYNC_CONFLICT` to controllers only; fans see nothing                      |
| `live_seq` allocation, insert, score recompute | Postgres function             | 503 `DEPENDENCY_FAILED`, **nothing broadcast**, client retries with the same key |
| broadcast + ack                                | DO → sockets → `MutationAck`  | an ack implies a durable row; a lost ack is a re-send, not a lost event          |

There is no write-behind batching and no local-first commit: the database is the durability point, so an
accepted event is a committed row. The DO's retained buffer (60 events) exists to serve resumes, not to
stand in for the ledger — after eviction the room rehydrates from `kicklive_match_live_state` and every
client that reconnects gets a snapshot instead of a hole.

### 17.3 Commands that work here

```bash
npm ci
node scripts/worker-local.mjs          # :8787, real MatchRoom in-process, DO storage in memory
npm run dev                            # :5000, proxies /api (ws:true) to the Worker
curl -s localhost:8787/api/health
node scripts/run-tests.mjs all         # 431 tests, incl. the Phase 3 and Phase 4 pins
npx tsc -p tsconfig.workers.json --noEmit
node scripts/gates.mjs                 # release gates
npm run build                          # web + renderer + desktop
```

Against `worker-local` with no `workers/.dev.vars`, live routes answer `503 DEPENDENCY_FAILED` with
`MIGRATION_HINT` — that is the intended failure (no Postgres to be authoritative), not a crash. To exercise
the room end-to-end you need a Supabase project with `20260909210000_phase3_live_match_engine.sql` applied;
the SSE route (`GET /api/matches/:id/stream`) is the way to watch frames without a Cloudflare runtime, and
`scripts/worker-routes.mjs` prints the route/capability table the router holds.

### 17.4 What Phase 3 did **not** do

- **The migration has never been executed.** This sandbox has no `psql`/`postgres`/`initdb`; the SQL layer is
  parsed by `libpg-query` (118 statements, clean) but plpgsql bodies are opaque to it and were reviewed by
  reading, not running. `supabase db push` against a throwaway project is a hard prerequisite for anything
  live. The migration is additive-only by design and ends with a verification `DO` block that raises
  `hardening failed:` rather than half-applying.
- **No WebSocket transport test.** `worker-local`'s Node http server cannot complete an upgrade handshake,
  and `wrangler` cannot be installed here, so the socket path is proven by unit tests of the room's
  handlers and by the SSE route carrying the same frames — not by a real browser socket. The dev proxy now
  sets `ws:true` so that first real test is one `wrangler dev` away.
- **`useMatchRoom` has not run in a browser.** Its inputs (the ladder, the reducer, the queue) are unit
  tested; React-level behaviour, ticket expiry mid-match, and a real iOS background-tab resume are not.
- No notifications or standings recalculation on finalize (Phase 5), no `match_commentary` write path
  (still legacy), no R2 for media, no FCM, no D1, no ads or sponsorships.
- Squad reads in the console (`supabase.from('players')`) still use the legacy read path: the Worker has no
  squad route, and adding one was outside this phase's goal. Same for the fan page's commentary/statistics/
  lineups reads, which are now event-driven instead of on a timer but still Supabase-direct.
- `recorded_by_name` is visible to an admin only (`kicklive_event_frame` gates it on `is_admin()`); the REST
  timeline leaves it `null` rather than leaking a username to fans.

## 18. The data layer as built (Phase 4)

The audit and the design are `docs/PHASE4_DATA_ARCHITECTURE.md` — including the measured before/after table,
which is generated by `node scripts/query-audit.mjs` and ratcheted by `scripts/query-audit.baseline.json`
(`--check` fails if unbounded reads, refetching pollers or whole-row reads go **up**).

### 18.1 Shape

```
page ──▶ useQuery(spec, args, {poll})                 src/lib/data/useResource.ts
            │  key = spec.key(args)      ← the question, not the caller
            ▼
        queryCache.read({key, ttl, tags, minInterval})  src/lib/data/cache.ts
            │   hit · coalesced · stale-while-revalidate · persisted · error
            ▼
        spec.fetch(DataCtx, args)                       src/lib/data/queries.ts
            │
            ▼
        Supabase (anon + RLS)   ·   the Worker (`src/lib/api`), per-key in §4.7
```

Rules worth stating in the architecture doc, because each one is a decision somebody could otherwise
conveniently undo:

- **A cache entry is bound to an identity.** Supabase answers with what RLS allows _that_ token to see, so
  `noteAuthIdentity(userId)` clears the cache — memory and `sessionStorage` mirror — on any change. Signing
  out as an admin and in as a fan must not be able to read the admin's rows.
- **Stale is a visible state, not an absence.** `useQuery` returns `{data, error, loading, stale, ageMs,
source}`; a refresh that fails keeps the previous value _and_ reports the error, and `/matches` and the
  fan portal say "showing the last list that loaded" in the copy rather than rendering a confident old
  number silently. `staleServes` in `perf.summary()` counts how often anything was shown past its TTL.
- **The room outranks the cache.** Nothing in `src/lib/data` may be the source of a live match's score,
  minute or status; `matchFixture`/`matchList` carry the fixture, `useMatchRoom` carries the state. The
  console's sequence advance calls `invalidate(`match:${id}`, "matches")` so the lists converge immediately
  instead of aging out — invalidation is by tag, which is why a squad edit cannot clear the news cache.
- **One ticker.** `poll: true` arms a key; `createTicker` owns the only `setInterval` (1 s sweep, paused
  while the tab is hidden, one catch-up on return), so three live surfaces on one screen are three
  subscriptions and one timer. A key is dispatched at most once per interval bucket, which is what stops a
  visibility catch-up and a cadence tick from double-firing the same read.
- **Reads are declared, not improvised.** A page cannot add a query; adding one means a spec with a key,
  tags, a TTL and a bound, and `tests/unit/data-layer.test.ts` runs _every_ exported spec against a fake
  PostgREST that throws on an unbounded read — a new read without bounds fails the build, and a new spec
  without sample args in the test fails too.
- **Standings are one rule.** `src/lib/data/standings.ts` (browser) and `kicklive_competition_standings`
  (Postgres) are checked against the same table of cases; the old three copies disagreed about what
  "finished" means, and one of them could not name the teams, which is why `/team/:id`'s table had a blank
  column.

### 18.2 What Phase 4 did **not** do

- 92 write sites still call Supabase from the browser, `AdminPortal`'s seven-read dashboard is still seven
  reads, and the legacy admin screens keep their unbounded `select('*')` squad reads. All three are listed
  with reasons in `docs/PHASE4_DATA_ARCHITECTURE.md` §5 rather than left implied.
- No IndexedDB. The only body of data that wants an offline store is the live draft queue, and it has one
  already (`src/lib/live/draftQueue.ts`); a second persistence mechanism for read caching would have been
  architecture for its own sake.
- No measurement against a real database. `scripts/query-audit.mjs --live` and `--explain` exist and are
  runnable with credentials, but this sandbox has no Postgres, so the index list in §4.8 is a proposal with
  the commands to justify or reject it, not a decision.
- No browser-level verification: like the Phase 3 client, `useQuery` and the ticker are unit-tested against
  the same primitives they use in production and have not been driven in a real tab here.

---

## 19. Frontend load as built (Phase 4)

The data layer (§18) is about how many questions a page asks. This is about how many bytes it must download
before it can ask them, and it is the half of Phase 4 with the larger measured effect.

**Brand art.** `public/kicklive-icon.png` is the master `branding.mjs` derives installer and PWA icons from
(1254², 2.34 MiB) and it was also, at once, the tab favicon, the header mark, the boot spinner, the auth-screen
logo and the tiled background — ~4.9 MB of PNG fetched before first paint and then scaled down 6–40×.
`scripts/brand-assets.mjs` now derives `public/brand/*` at the sizes actually drawn, with the repository's
existing pure-JS codec (`scripts/lib/png.mjs`, which gained colour-type selection and Paeth filtering), and
`npm run brand:assets:check` gates that the committed bytes are what the pipeline writes. 85 KiB of brand art
per cold visit instead of 4.7 MiB, with a per-file ceiling and a first-paint budget in the script itself. The
masters are untouched, still in `public/`, and referenced by no page.

**Route split.** `React.lazy` on every route but `HomePage`, one `<Suspense>` boundary with `AppBackground`
above it, and `kickliveManualChunks` giving React and the Supabase client their own stable chunks. A visitor to
`/` downloads 514 KiB of JS (152 KiB gzipped) where the build used to require 917 KiB in two files, and 408
KiB of portal and live-room code is now a set of files a fan never requests. `scripts/bundle-budget.mjs`
enforces that from inside `npm run build:web`, and counts `Symbol.for("react.element")` to prove the vendor
split did not create a second React. `tests/unit/bundle-split.test.ts` pins the source-level shapes that make
it work, so a re-merged portal fails a unit test rather than only a build.

Full tables, the reasoning behind each `bits`/size choice, and the four things this unit did not do (no browser
measurement, the Supabase client is still the largest boot chunk, the masters still ship inside `public/`, and
no WebP/AVIF because the sandbox has no encoder): `docs/PHASE4_DATA_ARCHITECTURE.md` §7.

```bash
npm run brand:assets            # regenerate public/brand/* and public/favicon.svg from the masters
npm run brand:assets:check      # what gate 5 runs: committed bytes must equal what the pipeline writes
node scripts/bundle-budget.mjs  # measure dist/web against scripts/bundle-budget.json
node scripts/bundle-budget.mjs --write   # move the ceilings, and read the diff in review
```

## 20. Privileges and documents as built (Phase 10)

Phase 10 is the audit phase, so this section is written as findings rather than as features: what was looked at,
what was found, what changed, and what is left standing on purpose. The status of every item below, with the
commands that would close it, is [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

### 20.1 The one leak that had a code fix: contact columns on `profiles`

Phase 1's audit closed the anonymous half of `profiles` (F-05: `profiles: public read USING (true)` → the same
policy narrowed to `to authenticated`, plus the `profiles_public` view for public pages). The authenticated half
survived, because a row policy can only answer _which rows_: any signed-in account could still run
`GET /rest/v1/profiles?select=email,phone` and read the directory. Nothing in the app needed that shape — six
surfaces read those two columns, and all six are either an owner reading their own row or an admin desk listing
users — so the correct mechanism was never a policy:

- `20260916120000_phase10_privilege_tightening.sql` revokes table-wide `select` for `authenticated` and grants an
  explicit column list (`id, username, role, avatar_url, team_id, created_at, updated_at`). Postgres checks
  column privileges before RLS and per column, which is the only place in the database that can say "these two
  columns, not this row". `service_role` is untouched, so `supabaseAdmin()`, Phase 5's addressing and Phase 7's
  referee-contact projection keep working.
- Two definer functions carry the legitimate reads: `kicklive_profile_self()` (owner-only, **no argument**,
  selector `auth.uid()`) and `kicklive_profile_contacts(p_ids, p_limit)` (`is_admin()` on the caller's own token,
  limit clamped 1..200, projection stops short of `phone`). Same idiom as every phase since 6 — pinned
  `search_path`, `security definer`, decision inside the function, grant to `authenticated` and not to the
  service key, because a service-role call has no subject and would answer `ADMIN_ONLY` forever.
- The SPA moved accordingly: `AuthContext.fetchProfile` calls the self function; the access-request desk dropped
  its embedded `profiles(username, email)` join (an embed is a select, and a select a fan can write by hand) and
  reads the same two fields for the ids it is already rendering; `AdminPortal`, `UserManagement` and
  `TeamDashboard` use the contacts function. `workers/src/services/profiles.ts` dropped `email` from
  `PROFILE_COLUMNS`, so `authenticate()` reads `id, username, role` and `/me` answers `email: null` — the shape
  is stable, the field is simply no longer the API's to know. The SPA has the address from its own session.
- The migration's `do $verify$` block asserts `has_column_privilege(...)` for `email` (false), `phone` (false),
  `username` (true), `service_role`/`email` (true), `anon` (false), that the read policy still exists, and that a
  stranger cannot execute either function. `tests/unit/phase10-hardening.test.ts` asserts the same properties from
  the other side — including that no client file projects a contact column, by scanning them.

### 20.2 The one leak that had a documentation fix

`DEPLOYMENT_CHECKLIST.md` step 3 and `DEPLOYMENT_GUIDE.md` step 4 both instructed an operator to paste
`SUPABASE_NEW_PROJECT_SETUP.sql` into a fresh project. That file carries a "SUPERSEDED — DO NOT RUN" banner
written in Phase 1, and `SUPABASE_COMPLETE_SCHEMA.sql` — which the guide's sibling documents also mentioned — has
an `UPDATE` policy with `USING` and no `WITH CHECK`, i.e. the exact privilege escalation Phase 1 closed. So the
only way to follow the deployment documents on a new project was to undo the security work. Both documents now
name the authoritative path (`KICKLIVE_FINAL_SCHEMA.sql`, then `supabase/migrations/*` in filename order, then
`supabase db push` as the equivalent), explain why the four root files are kept-but-forbidden, and a test fails
if any deployment document mentions them without a `do not / never / superseded` context.

This is the pattern worth naming: **a repository can be correct and still ship a vulnerability through its run
book.** The audit that mattered this phase was of the documents, not of the SQL.

### 20.3 What was reviewed and found already sound

- **Wide-open policies.** `with check (true)` appears **zero times** across the base schema and all nine
  migrations. The six remaining `using (true)` are all `for select`: the public competition catalogue (Phase 1's
  whitelist loop), `profiles` for `authenticated` (now column-narrowed above), and `kicklive_match_transitions`
  (Phase 3's public replay log). Each is a deliberate public read with a named policy.
- **Public-API field exposure.** Every phase since 6 has read through an explicit projection rather than a
  `select *`, and the phases' own tests compare the SQL `select` lists against the frontend types. The
  Phase 9 metric path holds no identity at all; `kicklive_live_match_metrics` emits `match_id/status/
live_updated_at/seconds_since_update`; `sponsorship`'s projection has no contact or money columns;
  the ad viewer-key route mints a hash and stores nothing. `profiles`/`device_tokens` were the remaining
  direct-read surfaces and §20.1 closes the first; the second was already write-only from the client.
- **The route/privilege matrix.** `workers/src/lib/capabilities.ts` is the single matrix, every route in
  `router.ts` names a capability and a cache class, `scripts/worker-routes.mjs --check` proves the catalogue,
  the README table and the handler map agree at **101 routes with zero `implemented: false`**, and no browser
  role can reach an admin capability: `roleHasCapability(null, …)` permits only `public.read`, so an anonymous
  caller cannot pass a single gate anywhere.
- **Retries, replay, idempotency.** Phase 3's `(match_id, sequence)` chain with a refusal on a gap, Phase 5's
  per-(user, campaign) dedupe and DLQ, Phase 7's event ingest that counts rather than logs, and Phase 9's
  fold-on-replay upsert are the four places a retried write could double-apply; all four are covered by unit
  tests, and three of them by rows in `scripts/sql-flow.mjs`.
- **Ads cannot touch the match.** `POST /advertising/events` writes to `ad_events`/`ad_analytics_daily` and
  nothing else; there is no ad route that writes a match, a score, or a referee-visible state, and the serve path
  is read-only with `cache: edge`. Sponsorship is separately entitled (Phase 8) with `auto_flight` accepted-and-
  ignored rather than half-built.

### 20.4 Findings left open, with the reason each is still open

Recorded here because "we could not get to it" is only honest when it names the thing and the cost.

1. **CLOSED 2026-09-10 — `RATE_LIMIT_KV` is bound in `env.staging` and `env.production`.** (Was: commented
   out, so the limiter shaped traffic per isolate while the ceiling in `middleware/ratelimit.ts` read as global.)
   Both namespaces exist with their ids in `workers/wrangler.toml`, `tests/unit/phase2-api-boundary.test.ts`
   fails if either block regresses, and the post-deploy proof is `x-ratelimit-store: kv` on any rate-limited
   response. Kept in this list so the closure has a date; the live statement is `RELEASE_CHECKLIST.md` §3.
2. **The match desk has three surfaces** (`MatchControlPro.tsx`, `MatchDashboard.tsx`, the AdminPortal match
   tab) sharing `src/lib/MatchAutomation.ts`. Phase 10 step 9 asked for one canonical control center; merging
   them is a product decision about which desk an operator actually opens on a match night, and the state model
   underneath is already single-authority, so the risk of a wrong guess is workflow, not correctness.
3. **`src/lib/MatchAutomation.ts` (5 × `select('*')`) and `src/lib/CompetitionEngine.ts` (whole-table reads,
   `console.log` on every refresh)** are pre-Phase-4 admin code with no query spec. The ratchet in
   `docs/data/phase4-query-inventory.md` counts them so they cannot grow; narrowing them needs the screens
   rendered, because the honest way to know a `select('*')` may become a column list is to look at what the table
   uses it for.
4. **`AdminPortal.tsx` still reads the legacy `media` table** for its recent-media card, so that card shows
   pre-Phase-6 rows while the media desk shows `media_assets`. Left as-is: Phase 6's own notes list the legacy
   read as its follow-up, and rewiring a table in an admin card with no database to test against is how you
   trade a cosmetic inconsistency for a broken desk.
5. **407 `<button>` elements, 344 without a `type` attribute**; 56 `<div onClick>`; 8 `aria-label`, 1
   `aria-modal`, 1 `aria-live` across 59 `tsx` files. All 19 `<img>` carry `alt`. In React a `button` inside a
   `form` defaults to `submit`, so an unlabelled control on the referee desk can fire a signup form — a real
   event, not a lint preference. A codemod (`react/button-has-type`, or a scripted `type="button"` insertion) is
   the fix, plus a keyboard pass on the five screens named in the mandate; both need the browser.
6. **No root `README.md` existed.** `DEPLOYMENT*.md`, five root SQL files and `docs/` were all reachable only by
   knowing the names. Written now, pointing at `docs/PRODUCTION_ARCHITECTURE.md` and `RELEASE_CHECKLIST.md`,
   because a new contributor's first question should not be answered by `replit.md`.
7. **Stray generated files at the root — CLOSED 2026-09-13.** `output.md`, `repomix-output.xml`, `replit.md`,
   `replit.nix` and `.replit` were left alone for as long as the mandate was "without deleting anything that may be
   useful"; they are now deleted and gitignored. The one that mattered was `repomix-output.xml`: a whole-tree dump is
   a snapshot of every mistake the tree ever made, and this one still contained the pre-hardening admin script with
   its personal address in it.
8. **The last three phases have never been applied to a database.** `node scripts/check-sql.mjs` needs
   `initdb`/`psql`, and this sandbox has neither, no container runtime, and no root. The paren linter, the
   catalog-level `do $verify$` blocks and the flows in `scripts/sql-flow.mjs` are what a real install will run
   first; until they pass, phases 8–10 are written-and-linted, not proven.
