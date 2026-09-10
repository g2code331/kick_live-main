# Production migration plan

From where this repository stands today (§1 of `PRODUCTION_ARCHITECTURE.md`) to the target in §2.
One phase is one shippable state: each ends with the app working end-to-end, a gate that proves it,
and a rollback that is a config or route change rather than a restore.

Ordering rule throughout: **a capability is moved to the Worker only in the same commit that removes
the browser's direct write for it.** Two paths to the same table is the state to avoid, so "add the
endpoint, keep the old call, clean up later" is not an option here.

## Phase 0 — release pipeline ✅ done

Desktop + PWA + web build, verification gates, update feed, CI. See `RELEASE-PIPELINE.md`.
Still outstanding from that phase: the `ci/workflows/*` copies are not installed on GitHub from this
sandbox (`gh` token expired), and `scripts/package-linux.mjs` still invokes electron-builder through
the same `npx --no` form that made the prettier gate a false pass (the prettier line was fixed during
Phase 1; the packaging one is left alone because it cannot be exercised here — fix it in CI where the
artifact check can prove it).

## Phase 1 — foundation and security ✅ code done, ⚠ migration not applied

**Done in this phase**

- No client-controlled roles, no client-held role passwords, no client role writes
  (`SignupPage.tsx`, `AuthContext.tsx`, `lib/access.ts`, `UserManagement.tsx`).
- No hardcoded backend config, boot-time validation with a mismatch check between URL and key, and a
  CI-visible source scan (`lib/env.ts`, `main.tsx`, `scripts/check-secrets.mjs`).
- Dev-gated logging, no mock data in production reads, bounded/less-wasteful loading
  (`lib/log.ts`, `lib/db.ts`, `lib/DataLoader.ts`, `App.tsx`).
- Schema authority decided, four legacy files marked superseded, `supabase/migrations/` opened with
  the hardening migration, first-admin bootstrap rewritten without personal identities
  (`supabase/README.md`, root `*.sql` headers, `CREATE_ADMIN_PROFILE.sql`).
- `workers/` architecture, boundaries, route map, config/secrets shape (no endpoints).
- Audits: 24 findings with evidence and status (`SECURITY_AUDIT_PHASE1.md`), match-control and
  notification inventories (`PRODUCTION_ARCHITECTURE.md` §10–§11).

**The remaining Phase 1 work is a person, not a patch**

1. Review `supabase/migrations/20260909120000_phase1_security_hardening.sql` line by line against the
   live project, then `supabase db push --dry-run` and apply on **staging first**.
2. Run the six runtime checks listed at the end of the audit doc (the fan-token escalation probe, the
   anon `profiles` read, media view increments, ProfilePage save, approve/reject, last-admin refusal).
3. Rotate nothing yet; decide separately whether to delete `repomix-output.xml` and untrack `.vercel/`.
4. Then apply to production, in the same window as a deploy of this code (the app no longer needs the
   old behaviour, and the migration does not depend on the new app — either order is survivable, but
   the hole stays open until the SQL runs).

Exit criteria: the F-01 probe returns `42501` in production; `pg_policies` matches the name list in
`supabase/README.md`; signup as a new account is a fan; User Control's role dropdown works through the
RPC and writes an `activity_logs` row.

Rollback: the commented block at the end of the migration. It restores the permissive read policy and
the column grants deliberately, so treat it as incident handling, not a retry button.

## Phase 2 — the API tier carries the writes

**Goal:** the browser stops being able to write anything it is not entitled to write, and the
entitlement is evaluated server-side.

> **Progress (Phase 2, first increment — this is a status note, not a completion note).**
>
> Done and tested in the tree: one `kicklive-api` Worker with the route/middleware/service/lib split;
> `GET /api/health`, `GET /api/me` and `GET /api/teams/mine`; JWT verification with the authoritative
> role read from `profiles`; the capability matrix with `requireAuth`/`authorizeForRoute`;
> resource-level ownership (`services/teamAccess.ts`); the dependency-free validation library; the
> `{ success, data | error }` envelope with production sanitisation; exact-origin CORS; named
> rate-limit budget classes wired into the pipeline for every declared route; the route table for the
> remaining 29 endpoints, answering `501` **after** authentication and authorization; `src/lib/api/` as
> the frontend client; env separation enforced on both sides; `workers/wrangler.toml` with
> development/staging/production blocks and no committed secrets.
>
> Not done, and still the content of this phase: **every write route below**, the caller migrations,
> the auth routes, the KV namespace, the CI Postgres job, and any actual deployment (no `wrangler`
> binary was installed and no Cloudflare account was touched in the increment that produced the above).
> Paths below are spelled `/v1/…`; they are implemented and matched under `/api/…` with `/v1` kept as an
> alias, so read them interchangeably until the docs are consolidated.

- Deploy `kicklive-api` with `GET /v1/health` and implement, in this order: `auth/sign-up` (Turnstile),
  `auth/access-requests`, `admin/access-requests*`, `admin/users/:id/role`, `media` create/publish,
  `matches/:id/events`, `matches/:id/state`, `matches/:id/finalize`, `teams/:id`, `players`.
- Migrate the callers in the same commits, most-isolated first: `UserManagement` → `MediaPublisher` →
  `TeamOwnerPortal` → `MatchControlComplete` → the `match_events` writers.
- Retire `DataLoader.loadUsers()`, then the singleton (§7 of the architecture doc).
- Add `client_event_id` + a unique index for event idempotency, `media.author_id` backfill, and
  `predictions` (F-21) as their own migration.
- Provision the KV namespace for shared rate limits; set `ALLOWED_ORIGINS`; put the WAF rules and the
  auth rate limits on the Supabase side as interim cover.
- CI: add a Postgres step that applies `KICKLIVE_FINAL_SCHEMA.sql` + `supabase/migrations/*` to an
  empty database and runs the probes. That converts every "fixed in migration, unverified" line in the
  audit into an enforced gate — the highest-value pipeline change available right now.

Exit criteria: `grep -rn "supabase.from(.*\.\(insert\|update\|delete\|upsert\)" src/pages/portals`
returns nothing for the migrated tables; the RLS policy set can drop its client-facing write policies
to `service_role`-only; a load test against `/v1/matches/:id/events` shows the limiter rejecting rather
than the database absorbing.

## Phase 3 — live match state

One `MatchRoom` Durable Object per `match_id`: authoritative clock, monotonic `seq`, SSE fan-out,
write-behind batching to Postgres, `is_locked`/confirm semantics finally used. `GET /v1/matches/:id/stream`
replaces the 19 `setInterval` sites; the operator console becomes `LiveMatchConsole`, built from the
extracted behaviours of `Pro` + `Full` + `EventModal`, and the 10 → 2 match-control files collapse to
1 (see architecture §10). Exit: a closed operator tab cannot freeze a match, and two operators editing
the same match converge.

## Phase 4 — media plane and background jobs

R2 with signed uploads (`POST /v1/uploads/sign`), image resizing on read, `media_key` columns replacing
pasted URLs; `kicklive-jobs` queue for standings recompute, media optimisation and fixture imports,
with a dead-letter queue. `MatchAutomation` and `CompetitionEngine` move into the consumer — the
engine needs no rewrite (it is pure), `MatchAutomation` needs the `supabase` client swapped for the
Worker's admin client and its `try/catch`-swallowed errors turned into failed jobs. Exit: finalize
returns before the work is done, and the work visibly retries.

## Phase 5 — push notifications 🟡 code in progress, ⚠ migration not applied, ⚠ FCM not configured

The plan above changed in one place: **the queue belongs here, not in Phase 4** (Phase 4 became the data
architecture/caching/performance phase, so `kicklive-jobs` and the notification fan-out landed together in
this one). Design and audit: `docs/NOTIFICATIONS_ARCHITECTURE.md`.

- **Supabase** — `notifications` gains `user_id/kind/dedupe_key/read_at/metadata/priority/expires_at`
  (extended, not recreated: the 217-day-old broadcast rows stay, and `notifications: public read` becomes
  owner-scoped-or-broadcast); new `notification_preferences` (row per user per category, per-kind defaults,
  `channels[]` ready for a second delivery medium), `notification_devices` (token as a credential,
  `unique (provider, token)` so a re-registration moves rather than duplicates), `notification_jobs` (the
  durable wake-up), `notification_deliveries` (per-device outcome), `match_interest` (the one relationship
  table, because no follow model exists yet and the audience needs a seam). All new tables: RLS enabled +
  forced, `revoke all` + narrow grants, self-verifying migration.
- **Worker** — 8 routes (devices, preferences, inbox, read, read-all, public config, diagnostics, admin
  broadcast), the capability matrix unchanged (`profile.read_own` + `notifications.broadcast` are already
  there and neither is widened), a policy module as the only place event→audience→copy is decided, an FCM
  HTTP v1 adapter with a mock used by every test, and no Firebase credential anywhere near the browser.
- **Queue** — `kicklive-notifications` + DLQ with the settings `wrangler.toml:138` reserved, consumer that
  claims jobs under `for update skip locked`, and a `*/5` cron sweep, because the queue is a wake-up and the
  job table is the truth.
- **Idempotency** — three constraints, not one: `dedupe_key = match:<id>|seq:<sequence>|kind:<kind>` on the
  job, `(user_id, dedupe_key)` on the inbox row, `(job_id, device_id)` on the delivery. The sequence is
  Phase 3's server-assigned per-match number, which is what makes reconnects, refreshes and replays
  harmless rather than merely unlikely.
- **Jobs are created inside the event RPC**, in the same transaction as the goal, guarded by
  `to_regclass('public.notification_jobs')` so an unapplied migration costs no notification and never a lost
  event. `ctx.waitUntil(queue.send(…))` after commit; the referee never waits for FCM.
- **Frontend** — the three decorative "Notification Prefs" toggles in `ProfilePage`/`ProfileDashboard`
  become real; the bell gains an unread badge from the inbox while keeping its results list; Web Push opt-in
  asks for permission only inside a click on a meaningful affordance, registers through the API, and
  retries offline.

Exit criterion, restated honestly: the **code** path from an authoritative goal to an FCM request exists and
is tested against a mock delivery adapter. "A goal reaches a phone" additionally needs the §20 manual setup
(Firebase project, service-account secret, queue ids, migration applied) and has **not** been verified here —
no Postgres, no Cloudflare queue and no browser in this environment. Not configured ≠ working.

## Phase 6 — advertising and sponsorship

Separate concepts, separate tables, separate capability families (architecture §13–§14):
`advertisers/ad_campaigns/ad_placements/ad_placement_events` and
`sponsor_packages/sponsorships`, each with its own migration, route group and admin surface; slots
declared in the UI, counters server-written, sponsor packages able to generate campaigns. Exit: a
campaign can be paused without a deploy, and a billable number exists that no client can influence.

## Standing constraints for every phase

Additive SQL only; no destructive statement without a reviewed, backed-up, separately scheduled
migration. No new dependency without a reason in the PR. `npm run gates` green before a push;
`npm run typecheck` covers `workers/` so the skeleton cannot rot. Never put a `service_role` key in a
`VITE_*` variable — the source scan now fails the build job if a JWT-shaped literal appears in shipped
source.
