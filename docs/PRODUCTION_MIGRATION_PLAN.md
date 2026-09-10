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

> **Media, as written here, was superseded before it was ever built.** The media plane became Phase 6 and
> took a different shape on three points — no signed uploads, no `media_key` columns, no resize-on-read —
> for the reasons in `docs/R2_MEDIA_ARCHITECTURE.md` §3, §5 and §10. The queue half of this phase moved to
> Phase 5. Read this paragraph as history; read Phase 6 as the present.

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

## Phase 6 — media on R2 🟡 code done, ⚠ migration not applied, ⚠ R2 buckets not created

Design, decisions and honest status: **`docs/R2_MEDIA_ARCHITECTURE.md`**. That document, not this
paragraph, is what to read before touching the media plane; this entry exists so the phase order and
the numbering collision are recorded.

The plan above changed in one place: **the media plane moves out of Phase 4** (Phase 4 as written was
"data architecture, caching and performance" plus a queue that Phase 5 then claimed) **and becomes its
own phase**, because the storage change is the one that touches every portal's write path and deserves
its own rollback. What shipped, in order:

- **Schema (additive only)** — `media_assets` (the registry: key, version, digest, sniffed type,
  dimensions, visibility, status, `source_url` for migration lineage, one timestamp per transition) and
  insert-only `media_operations`; `public.can_manage_team(int)` so ownership is answerable in SQL; 16
  `kicklive_*` functions holding authorization, quota, versioning and retention. RLS enabled with **no
  policies and no client grant** — the functions are the interface. The eight existing `*_url` columns
  are untouched, which is what keeps ~35 read sites and every legacy absolute URL working.
- **Worker** — nine routes (`POST /media/uploads`, `GET /media/assets/*`, `GET /media/config`,
  `GET /media/entities/:kind/:id`, `DELETE /media/assets/:id[?purge=true]`, `POST /media/assets/:id/restore`,
  `GET /media/diagnostics`, `POST /media/sweep`, `POST /media/migration`), a read-through with per-object
  cache policy, and `mediaStore.ts` as the only module that touches a bucket. `POST /uploads/sign` and
  `GET /uploads/:key` deleted: a signature the client holds cannot carry a registry row, a quota or a
  format check, and it splits "publish" into two failure windows (architecture note §3).
- **No media credential exists** — R2 is bound (`[[r2_buckets]]` → `MEDIA_BUCKET`) once per environment
  with three distinct buckets, so there is no access key to store, leak or rotate. `scripts/check-secrets.mjs`
  now also fails on PEM/service-account/AWS/Supabase-token shapes and scans `.pem|.key|.p12|.pfx`, with the
  comment-line exemption disabled inside key files.
- **Write path** — magic-byte sniffing (the declared MIME is never believed), markup refused outright (no
  SVG, at any size, for any role), per-kind size caps, a per-role 24 h quota enforced in the reservation,
  content-hash dedupe, an entity row predicate for authorization (own club / own article / self / staff),
  and publish-or-don't: the entity's URL moves only in the transaction that marks the object ready.
- **Retention** — a version never overwrites a key, so replacement needs no cache purge; superseded and
  soft-deleted objects stay restorable for 30 days; `?purge=true` is admin-only and marks the row before
  the object is deleted so a failure becomes a reportable orphan; an hourly sweep expires stale
  reservations and names what it would delete before deleting it. SQL computes the difference, the
  Worker lists and deletes — neither can do it alone, and both halves are testable that way.
- **Frontend** — `MediaPublisher` now saves first and uploads second (an interrupted upload leaves an
  editable article, not an ownerless object), with real progress, cancel and retry; `assetUrl()` resolves
  stored relative paths at render time and passes external URLs through; six render sites wrapped; no
  `supabase.storage` call remains anywhere in `src/` (a test census enforces it).
- **Tests** — 38 unit (`tests/unit/phase6-media.test.ts`: the refusal table, key derivation, cache-class
  rules, policy↔SQL agreement on kinds/columns/quotas/ceilings, the migration read as a document, route and
  browser-bundle censuses, the secret scanner against a fixture tree) and 30 integration
  (`tests/integration/media-upload.test.ts`, driving the real Worker entry with a Map-backed fake bucket and a
  fake PostgREST so the assertions are about what the Worker _asked the database_). None needs cloud
  credentials.

**Not done, and said so rather than hidden**: derived variants (no producer yet), resize-on-read, video
uploads (external links stay, on purpose), an avatar UI (nothing renders `avatar_url` today), the
`teams.gallery` upload path, and deleting legacy Supabase Storage objects (they are the rollback). The
numbering collision this creates with the advertising phase below is resolved in favour of history:
advertising becomes **Phase 7** (and sponsorship its own Phase 8), with their prefixes reserved in the key
space rather than present-but-empty in the schema.

**The remaining Phase 6 work is a person, not a patch**: create the three R2 buckets, apply
`supabase/migrations/20260912120000_phase6_r2_media.sql` to staging, deploy, then run the migration route
dry-run → real, per kind, until `still_url_pointing_at_storage` is zero. Steps in architecture note §16.

## Phase 7 — advertising 🟡 code done, ⚠ migration not applied

The heading here used to read "(was Phase 6; nothing implemented)". That is stale, and correcting it is the
point of this entry: advertising shipped as **Phase 7**, sponsorship split off into its own phase (below),
and neither has been applied to a hosted database yet.

- **Schema** — `supabase/migrations/20260913120000_phase7_advertising.sql`: eight tables
  (`advertisers`, `advertisement_campaigns`, `advertisements`, `ad_placements`, `advertisement_placements`,
  `ad_events`, `advertisement_analytics`, `ad_status_transitions`) and 32 `kicklive_*` functions. RLS with
  no policies and no client grant, as in Phase 6: the functions are the interface.
- **Worker** — 19 routes: serving (rotation + targeting + frequency), the advertiser/campaign/creative
  desks, event ingestion and the analytics rollups. Slots are declared in the UI rather than in a
  migration, and a slot that is not servable refuses to count.
- **Counters nobody can influence** — `viewer_key = ^[0-9a-f]{16}$` is an HMAC of the subject plus the UTC
  day, impressions deduplicate on `'imp|<ad>|<slot>|<key>|<day>'` with `on conflict do nothing`, so an
  impression count is a distinct-viewer-day floor and never an invoice. `ad_events` stores no IP, no user
  agent and no user id; `advertisement_analytics` is the rollup the dashboards read.
- **Rotation** — `priority`, then `min(md5(id || ':' || bucket || ':' || ticket))` over 30-second buckets:
  deterministic within a bucket, varied between them, and no per-viewer state anywhere.

**Known defect, recorded rather than fixed here**: `workers/src/routes/ads.ts` builds its staff writes with
`asCaller = false`, which sends them on the service-role key, while `kicklive_ad_save_*` and
`kicklive_ad_explain` gate on `is_admin()`/`is_admin_or_media()`. On a hosted project PostgREST forwards
only the bearer key, so `auth.uid()` is `NULL`, `is_admin()` is false and those admin writes answer
`ADMIN_ONLY`. It survived because the Worker tests stub `fetch` and the SQL flow calls the functions
directly. Fix as an additive migration (grant those functions to `authenticated`, flip those route calls to
carry the caller's token) and keep the service client for queue/cron/maintenance paths, which have no user
token to forward. Phase 8 does not copy this: see the sponsorship note in `docs/SPONSORSHIP_ARCHITECTURE.md` §9.
No `docs/ADVERTISING_ARCHITECTURE.md` exists yet either; `docs/SECURITY_AUDIT_PHASE1.md` and this file are
what the phase was reviewed against, which is a documentation gap and not a claim that one does not exist.

## Phase 8 — sponsorship 🟡 code done, ⚠ migration not applied, ⚠ SQL flow not re-run in this sandbox

Design, decisions and honest status: **`docs/SPONSORSHIP_ARCHITECTURE.md`**. Sponsorship is _rights, not
delivery_: Phase 7 decides what to show in a slot per request, this decides who is entitled to appear on a
competition, season, team, match, award or event, for how long, in what order — with no rotation, no
bidding and no per-viewer state. What shipped:

- **Schema** — `supabase/migrations/20260914120000_phase8_sponsorship.sql`: five tables
  (`sponsors`, `sponsorship_packages` with six seeded rows, `sponsorships`,
  `sponsorship_status_transitions`, `sponsorship_config`) and 28 functions, additive only, RLS with no
  policies and no client grant. `sponsorships` is keyed `(target_kind, target_id text)` and given meaning
  by `kicklive_sponsor_target_exists` (numeric ids must exist as rows; award/event are slugs), which is one
  index and one trigger set instead of six nullable foreign keys — the cost (`text`, so validated in SQL)
  is stated in the architecture note §3.
- **Eligibility in one place** — `kicklive_sponsorship_for` is the only public read and the only thing that
  decides visibility (active status _and_ the display switch, today inside the window, an approved sponsor,
  an active package); `kicklive_sponsorship_explain` runs the same predicates so the desk's preview and the
  fan's page cannot disagree. The projection is an explicit column list with no contact and no money
  fields, and the published rate card omits `price_*` from its select list — unreachable, not filtered.
- **Order and exclusivity as named refusals** — `priority, display_order, starts_at desc, id`;
  `EXCLUSIVITY_TAKEN`, `PACKAGE_LIMIT_FOR_TARGET`, `SLUG_IMMUTABLE`, `KIND_NOT_IN_PACKAGE`,
  `STATUS_VIA_SET_STATUS_ONLY`, `BRANDING_IS_UPLOADED_NOT_TYPED`, `DISPLAY_SWITCH_VIA_SET_STATUS_ONLY`; and
  a `double_title` count that is not zero fails the install rather than shipping.
- **Media** — sponsor artwork reuses Phase 6's pipeline with the reservation swapped
  (`kicklive_sponsor_reserve_asset` → `publishAsset` → `kicklive_sponsor_attach_asset`), 5 MiB logo /
  10 MiB banner, no SVG, keys under `sponsors/<uuid>/<slot>/v<n>-<sha8>.<ext>`, and `sponsors` is
  **registry-only** in `mediaPolicy.ts` (`MEDIA_KINDS` yes, `UPLOADABLE_KINDS` no, `urlColumn: ""`) so the
  generic publish path physically cannot repoint a logo.
- **Caching** — the band's `max-age` comes from `sponsorship_config`, its `ETag` carries the epoch, a
  conditional request is answered before any SQL runs, and every viewer-visible write bumps that epoch in
  the same transaction. Admin reads are `private, no-store`. No CDN purge is wired, and the note says why.
- **Privileges** — staff routes forward the caller's own bearer token, because the functions decide the
  caller from `auth.uid()` and a service-role call has no subject at all. Exactly three functions are
  anon-executable; `touch_epoch` and `kicklive_asset_url_for_asset` are service-role-only, the latter
  revoked **by name** because the grant loop's `like 'kicklive_sponsor%'` never saw it.
- **Frontend** — one query spec, `SponsorBadge` + `SponsorBand` (renders nothing at all when the band is
  empty; no sponsor name appears in either file), hosted on `MatchDetails` and `TeamProfile`, and an admin
  _Sponsorship_ tab with three desks, real status arcs from the transition table, an eligibility preview and
  a branding uploader with progress, cancel and retry.
- **Tests** — 25 unit cases in `tests/unit/phase8-sponsorship.test.ts` (route↔SQL field drift in both
  directions, the projection's privacy boundary against the frontend type, the grant matrix, the media seam,
  the fifteen routes' cache/capability shape, client endpoints against the route table, the expiry rule) plus
  the sponsorship flow in `scripts/sql-flow.mjs`. Suite: 517 unit tests, 0 failures.

**Not done, and said so rather than hidden**: no billing (money columns exist so a human can reconcile an
invoice; there is no ledger, no tax, no PDF, no rails), no `auto_flight` (the argument is accepted and
ignored — generating a campaign needs budget and slot decisions this phase must not invent), no sponsor
self-service portal, no badge impressions (that is Phase 7's `ad_events` with a target kind added), no CDN
purge, no automatic expiry caller (the desk route exists; a schedule belongs to Phase 9), and bands on two
pages only — `award`/`event` targets are supported by SQL with no page to hang them on yet. There is also
**no `tests/integration/sponsorship-api.test.ts`**, which is the file that would have to assert §9's
caller-token rule against a fake PostgREST.

**Blocking verification**: this sandbox has no Postgres (`initdb`/`psql` absent, no container runtime), so
`node scripts/check-sql.mjs` skipped, and the `isActive` refusal plus the field-refusal edits landed after
the last green run of the flow. Before this migration is applied anywhere, run
`node scripts/check-sql.mjs --dsn "postgres://kicklive@127.0.0.1:55432/kicklive_scratch" --fresh` and
require both flows to print `ALL PASS`. Deploy order is staging → seeded rate card → production → desk
smoke test with devtools open, in architecture note §16.

## Phase 9 — analytics, monitoring and observability 🟢 code done, tests green, ⚠ migration not applied, ⚠ SQL flow never executed here

Design, decisions and honest status: **`docs/OBSERVABILITY_ARCHITECTURE.md`**. The one sentence that explains
every other decision: **a request is a number in a bucket, plus one log line if it failed or was slow — there is
no raw request table and none is planned.** What shipped:

- **Schema** — `supabase/migrations/20260915120000_phase9_observability.sql`, additive only: `metric_rollups`
  (minute buckets, fixed-interval counters, a ten-wide latency histogram, 14-day retention), `metric_daily`
  (400 days), `system_health` (nine components keyed by primary key so a second opinion cannot grow),
  `observability_config` (one row: buckets, retentions, flush interval, alert thresholds, caps) and a 26-row
  metric catalogue exposed as the `kicklive_observability_catalogue()` function rather than a table, so it
  cannot drift into a second source of truth that needs its own grants. RLS on with **no policies**; table DML to `service_role` only. §16 `do $verify$`
  raises instead of installing silently — a CHECK that never fires, a policy that says `for all` where it should
  say `for select`, and a grant loop whose `like` pattern misses a function are the three ways a migration
  written without a database lands wrong, and each one is asserted here.
- **Worker pipeline** — `lib/observability.ts`: a bounded per-isolate buffer (`MAX_KEYS = 400` series, excess
  folds into `*` and `bufferStats().overflowed` says how much), flushed every 20s / 400 samples through
  `kicklive_metrics_record`, which refuses per entry (nine named reasons) instead of refusing the batch, clamps
  `errors ≤ samples`, rejects a run of 3+ digits in a route and rejects any secret-shaped key or value.
  `observeGauge` samples a gauge **at most once per bucket**, because `value_sum` is a sum over the bucket.
- **Logs** — the same file writes one JSON line per notable request with a closed field set
  (`ts, level, subsystem, requestId, clientRequestId, method, route, status, durationMs, category, cache, …`):
  no path, no query, no body, no headers, no IP, no user agent, no stack. `LOG_MODE` (`off|errors|slow|all`)
  defaults to **`errors`** — every failure and every slow request, no healthy 200s.
- **Correlation** — the client's `x-request-id` (`src/lib/api/client.ts:177`) is adopted when it matches
  `/^[A-Za-z0-9._-]{8,64}$/` and minted otherwise; it rides into queue messages as
  `payload.trace = { requestId, origin, at }`, re-read without trusting any field, and into
  `activity_logs.details.request_id`. No `traceparent`, no vendor tracer: the argument is in architecture note §4.
- **Errors** — `lib/errors.ts` classifies every `ApiCode` into
  `AUTHENTICATION|AUTHORIZATION|VALIDATION|DATABASE|R2|QUEUE|FCM|WEBSOCKET|INTERNAL` (`classify` is total over
  the union, and a test proves it) and `failWithCategory` adds one response header, `x-error-category`.
  **The error envelope was not edited**: 100 routes and the frontend's `failure()` parser depend on its shape,
  and a header is present for tooling while being ignorable by users.
- **Audit hardening, in place** — §7: the admin policy on `activity_logs` becomes **select-only**; the
  `activity_logs_append_only` trigger refuses every delete and every update except the profile FK's own
  `on delete set null`; a `security definer` writer `kicklive_audit_record` takes the subject from the JWT
  (`user_id := coalesce(auth.uid(), p_actor_id)` — an argument never overrides), validates the action and
  entity-type shapes, refuses credentials in `details`, and injects `via` / `actor_role` / `request_id`.
  `kicklive_audit_list` clamps `limit` to 1..200. No parallel audit table, no edits to committed phase SQL.
  `middleware/audit.ts` audits exactly the privileged routes whose SQL does not already (the ten in
  `AUDITED_IN_SQL` are excluded, set-difference asserted), and a failed audit write is logged once and never
  surfaces — a recorded trade, in architecture note §9.
- **Health** — `probeDependencies` on the five-minute beat plus `kicklive_health_recompute_derived` for the
  computed components; `GET /observability/health` reads `kicklive_health_read()` (granted to `anon`,
  projection = `component/status/ageSeconds`, nothing else) and the admin panel reads
  `kicklive_health_read_admin()` (+ reason code, flat detail, streak, staleness, live alerts). The difference
  is a grant and two functions rather than a field list in a handler, so a new column cannot leak.
- **Routes** — 13 new (`/observability/{health,metrics,metrics/daily,live-matches,notifications,advertising,alerts,audit}`
  plus `admin/{health,diagnostics,catalogue,probe,maintenance}`), all `cache: "none"`, reads gated on
  `admin.audit_read` + `authenticated`, the two POSTs on `admin.settings_write` + `admin-blast`. Router
  catalogue: **101 routes**. Metrics are also emitted from inside `MatchRoom` (lag, reconnects, snapshot
  poll/push, rejects, broadcast failures, connections gauge) and from both queue consumers — no fan identity
  anywhere in it.
- **Frontend** — `src/lib/data/observability.ts` mirrors the SQL projections field by field and a test compares
  those types against the migration's `return jsonb_build_object` blocks; `SystemMonitoring.tsx` renders
  SYSTEM HEALTH / API / LIVE MATCHES / NOTIFICATIONS / ADVERTISING, an alerts strip (code + evidence, never
  `message`) and the privileged-action list, per-section fetches, **no chart library** — percentiles are shown
  as bucket bounds with the `open` flag, which is the precision the histogram actually has.
- **Retention** — `kicklive_metrics_rollup_daily` (delete-then-insert one finished day, idempotent, and the
  reason no hourly writer exists) and `kicklive_metrics_purge` (ages clamped to ≥ 1 day, `auditTouched: false`
  always — no function in this migration can delete from `activity_logs`) both ride the existing hourly media
  sweep rather than adding a cron line. Alerts are computed at read time against the config row; nine codes.

**Not done, and said so rather than hidden**: no external metrics vendor or dashboard product; no hourly rollup
writer (an hour-granular read of `metric_rollups` returns nothing today — the summary function groups minute
rows itself); no audit retention job, by design, with `diagnostics` reporting age instead; no alert _delivery_
(paging is a product, not a metric); no client-side performance-beacon ingestion, which would have needed a new
public write path; no `system.diagnostics` capability (reads ride `admin.audit_read`); and
`AdminPortal.logActivity`'s three browser inserts into `activity_logs` are left alone and documented as **a
record, not evidence** (architecture note §10). `activity_logs` has no `error_category` column — the category
lives on the response header and in the log line only.

**Blocking verification**: this sandbox has no Postgres (`initdb`/`psql` absent, no container runtime, not
root), so `node scripts/check-sql.mjs` could not run and **`runObservabilityFlow` — 30-odd assertions against a
real database — has never been executed.** The unit suite (563 tests, 0 failures) cannot see whether a CHECK
fires, so the migration is _written and linted_ (35 function bodies paren-balanced; both `tsc` projects clean;
`prettier` clean; `worker-routes --check` agrees at 101; `gates.mjs` and `verify.mjs check` green) rather than
_proven_. Before applying anywhere:
`node scripts/check-sql.mjs --dsn "postgres://kicklive@127.0.0.1:55432/kicklive_scratch" --fresh` and require
`runFlow`, `runSponsorshipFlow` **and** `runObservabilityFlow` to print `ALL PASS`.

## Phase 10 — final production hardening 🟡 audit done, one fix shipped, ⚠ nothing executed against Postgres

The mandate was thirty steps before an external audit: architecture, security, authorization, RLS, privacy, the
match engine, the notification/R2/cache/ad/sponsorship surfaces, performance, mobile, accessibility, errors,
env config, SQL, deployment, then builds/tests, E2E, failure testing, integrity, docs, cleanup, a release
checklist and an honest rating. **The audit ran; the fixing was limited to what could be verified without a
browser, a database or a Cloudflare login.** What shipped:

- **`supabase/migrations/20260916120000_phase10_privilege_tightening.sql`** — the contact columns on `profiles`
  are no longer projectable by `authenticated` (`revoke select` + `grant select (…)`), with two definer doors for
  the legitimate reads: `kicklive_profile_self()` (owner, no argument) and
  `kicklive_profile_contacts(p_ids, p_limit)` (`is_admin()`, clamped 1..200). Additive, `$verify$`-gated, no
  destructive statement, and the first migration in this repository to narrow **columns** rather than rows —
  because a policy cannot, and Phase 1's `using (true)` for `authenticated` had survived for exactly that reason.
- **Six call sites moved** — `AuthContext`, `src/lib/access.ts` (its `profiles(username, email)` embed deleted,
  the two fields now read for the visible ids only), `AdminPortal`, `UserManagement`, `TeamDashboard`, and the
  dead `DataLoader` so it cannot return with a query the database now refuses. `workers/src/services/profiles.ts`
  dropped `email` from `PROFILE_COLUMNS`; `/me` answers `email: null` with the key kept.
- **The deployment documents no longer instruct a privilege-escalating install** — `DEPLOYMENT_CHECKLIST.md`
  step 3 and `DEPLOYMENT_GUIDE.md` step 4 said "paste `SUPABASE_NEW_PROJECT_SETUP.sql`", a file banner-labelled
  SUPERSEDED whose sibling (`SUPABASE_COMPLETE_SCHEMA.sql`) has an `UPDATE` policy with no `WITH CHECK`. Both now
  name the base schema + the nine migrations in filename order, and `supabase db push` as the equivalent.
- **`docs/OBSERVABILITY_ARCHITECTURE.md`** (Phase 9's note, written this phase) ·
  **`RELEASE_CHECKLIST.md`** (14 sections, every item READY / REQUIRES CONFIGURATION / REQUIRES TESTING / BLOCKED
  / NOT IMPLEMENTED, with the commands that close them) · **`README.md`**, which did not exist ·
  `docs/PRODUCTION_ARCHITECTURE.md` §20 (findings, fixes, and the eight items left open with reasons) ·
  `supabase/README.md` (what `authenticated` may project) · `workers/.dev.vars.example` completed through
  Phase 7 and Phase 9 (`AD_VIEWER_KEY_SECRET`, `LOG_MODE`, and the note that there is no `ENVIRONMENT` var).
- **The toolchain stopped assuming Node can strip TypeScript.** `process.features.typescript` is a build-time
  feature, and a repackaged `nodejs` (Debian/Ubuntu) ships without it — the whole test suite then fails 23 files
  at once with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`, which is indistinguishable from a
  broken checkout. Every `node …` script now runs through `scripts/lib/ts-loader.mjs`, which transpiles `.ts`
  through the pinned `typescript` package and re-exports itself into `NODE_OPTIONS` so `node --test` children and
  `scripts/gates.mjs` spawn chains inherit it (deduped, absolute-URL, and a no-op where stripping works).
  `tests/unit/toolchain-ts-loader.test.ts` (5 cases) proves the hook owns the load with an `enum` probe that
  erasure cannot satisfy.
- **`tests/unit/phase10-hardening.test.ts`** — 14 cases: the migration is additive and contains no drop; the
  column list excludes `email`/`phone` and keeps what public surfaces need; the self function takes no argument;
  the contacts function refuses with a value and clamps; the `$verify$` block checks every privilege the change
  depends on; no client file projects a contact column; the Worker's projection is `id, username, role`; the
  migration set is nine files in filename order with phases `[1,3,4,5,6,7,8,9,10]`; and no deployment doc names a
  superseded SQL file without a warning.

Measured findings, recorded rather than fixed: `with check (true)` appears **0 times** in the repository; the six
remaining `using (true)` are all `for select`; 101 routes with **0 `implemented: false`**; no committed secret
(`scripts/check-secrets.mjs` runs and reports only this sandbox's unset CI secrets); 21 `console.log` left in
`src/lib/MatchAutomation.ts`, `src/lib/CompetitionEngine.ts` and the log module itself; 5 `select('*')` in
`MatchAutomation.ts`; `RATE_LIMIT_KV` commented out in staging and production; three overlapping match-desk
surfaces; `AdminPortal` still reading the legacy `media` table; 407 `<button>`, 344 of them without `type`, 56
`<div onClick>`, 8 `aria-label` / 1 `aria-modal` / 1 `aria-live` across 59 `tsx` files, 19 `<img>` all with
`alt`. Each has a paragraph in architecture note §20.4 saying why it is still open.

Verified here (no fabrication): `npm run typecheck` both projects 0 errors · `npm run build:web` succeeds, fan
boot 529.8 KiB raw / 156.6 KiB gzipped over 5 chunks, 74 files 7.31 MiB · `npm run build:desktop` bundles
main+preload · `npm run test:unit` **577 pass, 0 fail** · `npm run test:integration` **99 pass, 0 fail** ·
`worker-routes --check` 101/101 · `check-secrets.mjs` clean · `prettier --check` clean · `gates` 21 pass /
1 fail / 4 skip (the failure is the known un-installed `_github/workflows`; `npm run ci:install`). The query
ratchet caught this change set's five query moves and `docs/data/phase4-query-inventory.md` was regenerated,
which is the only end-to-end proof the repo can offer that a privacy fix did not silently add a read.

**Cannot be verified here, and no result is claimed for it:** `npm run check:sql` (no `initdb`/`psql`, no
container runtime, not root) — so phases 8, 9 and 10 migrations, all three `sql-flow` scripts and the
`$verify$` blocks are **unexecuted**; `wrangler deploy` (no Cloudflare credential); E2E and failure-injection
steps 24–25 (no browser, no Supabase project): the state model, the WS/poll fallback and the queue retry paths
are covered by unit tests and by `scripts/sql-flow.mjs` assertions that have never run, and are marked
`REQUIRES TESTING` in the checklist rather than assumed.

**Final rating: PRODUCTION READY AFTER CONFIGURATION, AND REQUIRES FIXES IN ONE NAMED AREA** — the
configuration list and the four things to fix before shipping are §"Final rating" in `RELEASE_CHECKLIST.md`, and
the first line of it is "apply the nine migrations on staging and require `ALL PASS`".

Additive SQL only; no destructive statement without a reviewed, backed-up, separately scheduled
migration. No new dependency without a reason in the PR. `npm run gates` green before a push;
`npm run typecheck` covers `workers/` so the skeleton cannot rot. Never put a `service_role` key in a
`VITE_*` variable — the source scan now fails the build job if a JWT-shaped literal appears in shipped
source.
