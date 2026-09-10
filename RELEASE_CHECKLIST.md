# Kick Live — release checklist

Status vocabulary, used literally and nowhere softened:

| mark                     | meaning                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `READY`                  | implemented, checked in this repository, and the check is named next to it                         |
| `REQUIRES CONFIGURATION` | code is done; an environment is not (a secret, a binding, a bucket, a var)                         |
| `REQUIRES TESTING`       | code is done and static-checked; the check that would prove it needs Postgres/Cloudflare/a browser |
| `BLOCKED`                | cannot be verified from this workspace at all, and nothing here pretends otherwise                 |
| `NOT IMPLEMENTED`        | the capability does not exist; see the named "deliberately not done" section that explains why     |

Verified in this workspace on 2026-09-10 with no Postgres, no Cloudflare login and no browser:
`npm run typecheck` (all three `tsc` projects) 0 errors — re-run with exit codes preserved, after it emerged that
an earlier pass had been piping `tsc` into `tail` and reading `tail`'s status; a claim that rested on a broken
command is not a verification · `npm run build:web` succeeds (fan boot 529.8 KiB raw /
156.6 KiB gzipped over 5 chunks; 74 files, 7.31 MiB total) · `npm run build:desktop` bundles main+preload ·
`npm run test:unit` 577 pass / 0 fail · `npm run test:integration` 99 pass / 0 fail ·
`node scripts/worker-routes.mjs --check` 101/101 · `node scripts/check-secrets.mjs` finds no committed secret
and reports the 2 required CI secrets as unset here (correct — this sandbox has none) · `npm run format:check`
clean · `npm run gates` 21 pass / 1 fail / 4 skip (the one failure is `_github/workflows` not installed here:
run `npm run ci:install`). **`npm run check:sql` did not run: there is no Postgres binary, no container runtime
and no root in this environment, so `initdb` is impossible.** That single fact is why five rows below say
`REQUIRES TESTING` rather than `READY`.

---

## 1. SECURITY

- `READY` — RLS enabled on every app table, and a repo-wide scan for `with check (true)` returns **0 hits**
  across `KICKLIVE_FINAL_SCHEMA.sql` + all nine migrations.
- `READY` — the six `using (true)` policies that remain are all `for select`: the public competition catalogue
  (phase 1's whitelist loop), `profiles` for `authenticated`, and `kicklive_match_transitions` (phase 3).
- `READY` — **Phase 10 narrowing:** `profiles.email` / `profiles.phone` are no longer projectable by
  `authenticated` at all (`revoke select` + `grant select (…)`), so a fan's JWT cannot dump the directory;
  `kicklive_profile_self()` and `kicklive_profile_contacts()` are the only doors, both definer, both gated
  (`auth.uid()` / `is_admin()`). Asserted by the migration's own `$verify$` block and by
  `tests/unit/phase10-hardening.test.ts`.
- `READY` — `role` on `profiles` is not writable by a client (`revoke update (role)`, phase 1 F-01), and the
  guard trigger refuses an email/role change from a non-admin.
- `READY` — service-role key never shipped to a browser: `supabaseAdmin()` exists only under `workers/`,
  `scripts/check-secrets.mjs` fails a build on a JWT-shaped literal in source, and the SPA refuses to boot when
  the URL's project ref and the anon key's `ref` claim disagree.
- `READY` — CORS: `ALLOWED_ORIGINS` is an explicit list, `*` is rejected in `workers/src/env.ts`, a `null`
  origin is refused by middleware; CSP comes from `shared/branding.ts` and the error page carries its own
  `default-src 'none'`.
- `READY` — CSRF: the API is bearer-token-only (no ambient cookies), so a cross-site form post has no
  credentials to ride; the auth exchange routes are Turnstile-guarded where configured.
- `REQUIRES TESTING` — Turnstile on signup/write routes degrades to "skipped" when `TURNSTILE_SECRET_KEY` is
  unset. That is right for dev and **must be confirmed as enforced in production** (`POST /auth/...` without a
  token should fail there).
- `REQUIRES TESTING` — path traversal / upload validation (phase 6): keys are
  `<kind>/<uuid>/<slot>/v<n>-<sha8>.<ext>` built server-side from a whitelist, with mime/extension/size checks
  and no SVG. Prove it with a real `wrangler dev` + a browser upload before release; the unit tests only read
  the policy table.
- `READY` — idempotency and replay: phase 3's event chain is `(match_id, sequence)` with an idempotency window,
  and phase 9's metric writer folds a replayed flush into the same row (`scripts/sql-flow.mjs` asserts both —
  see `BLOCKED` in §2).
- `BLOCKED` — no independent secret rotation has been exercised: `AD_VIEWER_KEY_SECRET`, `SUPABASE_JWT_SECRET`
  and `FCM_SERVICE_ACCOUNT` each have a documented rotation story, none has been performed here.
- `REQUIRES CONFIGURATION` — `npm run ci:install` to place the two workflow files in `.github/workflows/`,
  otherwise the security/branding gates never run on a push (`gates` fails here on exactly that).

## 2. DATABASE

- `READY` — nine additive migrations; filenames are timestamps and `tests/unit/phase10-hardening.test.ts`
  asserts the ordering and that the phase numbers are `[1,3,4,5,6,7,8,9,10]` (phase 2 is Worker-only, so the
  gap is intentional and a renumber is what would be wrong).
- `READY` — no destructive statement in any phase migration: no `drop table`, `truncate`, `drop schema`,
  `alter table … drop column`, or `delete from public.…` (asserted for the phase 10 file; the phases 1–9 files
  carry their own rollback sections where they are documented as comments).
- `READY` — every phase migration ends with a `do $verify$` block that raises rather than installing quietly;
  phase 9's checks both new constraints and the grant loop's coverage, because that loop is `like`-pattern
  scoped and a function outside the pattern is invisible to it.
- `READY` — `KICKLIVE_FINAL_SCHEMA.sql` is the labelled base; `SUPABASE_COMPLETE_SCHEMA.sql`,
  `SUPABASE_NEW_PROJECT_SETUP.sql` and `supabase_migrations.sql` carry "SUPERSEDED — DO NOT RUN" banners, and
  `supabase/README.md` is the index. **The deployment documents contradicted this until Phase 10**; both
  `DEPLOYMENT_CHECKLIST.md` and `DEPLOYMENT_GUIDE.md` told an operator to paste a superseded file (which
  re-opens privilege escalation). Fixed, and a test now fails if any deployment doc mentions those files without
  a `do not / never / superseded` context.
- `REQUIRES TESTING` — apply order on staging: base schema, then the nine files, then
  `node scripts/check-sql.mjs --dsn … --fresh` and require `runFlow`, `runSponsorshipFlow`,
  `runObservabilityFlow` to print `ALL PASS`. The last two have never been executed by anyone.
- `REQUIRES TESTING` — phase 8/9/10 seed data: rate-card prices in `sponsorship_packages` must be reviewed
  against the real contracts, and `observability_config`'s buckets/thresholds (`p95_alert 1500 ms`,
  `error_rate_alert 0.05`, `rollup 14 d`, `daily 400 d`, `audit_retention 0`) are engineering defaults, not a
  policy decision somebody signed.
- `READY` — audit trail: `activity_logs` is append-only (delete refused; update refused except the profile FK's
  `on delete set null`), written by `kicklive_audit_record` with the subject from `auth.uid()`. A `delete`/
  `update` from `service_role` is refused — asserted in the (unexecuted) flow, and by trigger-text assertions in
  the unit suite.

## 3. CLOUDFLARE (Worker, Queues, Durable Objects, KV)

- `READY` — one Worker (`kicklive-api`, `src/index.ts`, `nodejs_compat`, `compatibility_date = 2026-09-01`),
  101 declared routes, **0 of them `implemented: false`**; `scripts/worker-routes.mjs --check` keeps
  `workers/README.md`, the router catalogue and the handler table in agreement.
- `READY` — staging/production are `env.staging` / `env.production` blocks with per-environment names, because
  named environments inherit no top-level bindings — the reason notifications working in dev and silently
  missing in prod is structurally hard to do by accident.
- `REQUIRES CONFIGURATION` — queues: `npx wrangler queues create kicklive-notifications-<env>`,
  `kicklive-ad-events-<env>` and the notification dead-letter queue, then `wrangler deploy`. Until then the
  producer throws and `/api` still serves reads (fail-safe by design).
- `REQUIRES CONFIGURATION` — **`RATE_LIMIT_KV` is commented out in both `env.staging` and `env.production`**
  (`workers/wrangler.toml:195`, `:293`). With no namespace the limiter is per-isolate in-memory: real ceilings
  are looser than the config implies, and a burst across isolates will not be shaped. Create it with the command
  in the comment and uncomment — do not ship "rate limiting" while that block is inert.
- `REQUIRES CONFIGURATION` — `LIVE_MATCH_ROOM` Durable Object is declared; confirm the `new_sqlite` class
  binding in the deployed version and that `wrangler tail` shows alarm activity during a friendly match.
- `REQUIRES TESTING` — `cron` lines: five-minute sweep + hourly media/ad/observability maintenance. Verify in
  the dashboard that both fired after deploy; a `TELEMETRY_STALE` alert on a fresh install usually means the
  cron was not deployed rather than that the app is broken.
- `BLOCKED` — no `wrangler deploy` has run from this workspace (no Cloudflare credential), so nothing about the
  deployed shape — bindings, env names, DO class, queue consumers — has been observed rather than read.

## 4. R2 (media)

- `READY` — bucket is a binding (`MEDIA_BUCKET`), never an access key: no R2 credential exists in a browser
  bundle or in `.dev.vars.example` (the file says so and `check-secrets.mjs` would fail it).
- `READY` — server-side key shape, per-kind caps in `workers/src/lib/mediaPolicy.ts`, no SVG, `MEDIA_MAX_BYTES`
  as the outer bound; uploads are reserve → put → publish, so an abandoned upload cannot become visible.
- `REQUIRES CONFIGURATION` — create the buckets for staging and production, decide the public bucket policy (a
  custom domain / `token`-less public access is what `urlColumn` assumes) and set `MEDIA_MAX_BYTES` per env.
- `REQUIRES TESTING` — phase 6's deferred work is still open: no thumbnail/`og:` variants, no resize, no video
  handling, no avatar upload UI, `teams.gallery` has no upload path, and legacy `media`-table objects are not
  deleted. `AdminPortal.tsx` still reads the legacy `media` table for its recent-media card, which is why that
  card shows pre-phase-6 rows — recorded, not fixed, because Phase 6's own doc marks it as a follow-up.
- `REQUIRES TESTING` — migration of pre-phase-6 rows into `media_assets` (the SQL keeps both; a cutover plan is
  in `docs/R2_MEDIA_ARCHITECTURE.md`) has never been rehearsed.

## 5. FCM (push)

- `READY` — server-side-only credentials: `FCM_PROJECT_ID` (var) + `FCM_SERVICE_ACCOUNT` (secret), signed
  HS256 JWT against `fcm.googleapis.com/v1/projects/<id>/messages:send`, `FCM_TIMEOUT_MS` bounding one send.
  No client ever holds a credential, and no route echoes the account JSON.
- `READY` — token storage is device-token-in, never-out: `POST /notifications/tokens` writes, and no read
  endpoint returns a token (asserted in the phase-5 tests and by the projection lists in `workers/src/routes`).
- `READY` — invalid tokens are deactivated on `UNREGISTERED`/`INVALID_ARGUMENT`, dedupe per (user, campaign),
  retries with backoff, DLQ for the poison messages, and `notifications/devices` metrics count
  `registered|pruned|invalidated`.
- `REQUIRES CONFIGURATION` — a real Firebase project: enable Cloud Messaging, download the service account,
  `npx wrangler secret put FCM_SERVICE_ACCOUNT`, and set `FCM_PROJECT_ID` to the **Cloudflare-side** project id
  (not the SPA's `projectId`, which is a different string when anything has been renamed).
- `REQUIRES TESTING` — one real device, one real match, one push. Unset credentials give the mock transport, so
  everything up to the wire is green without a single message leaving the account; that is a deliberate laptop
  default and also the exact thing a release must not mistake for proof.

## 6. AUTH

- `READY` — the SPA's session is the single source of identity; the Worker verifies the access token
  (`SUPABASE_JWT_SECRET`, HS256, `aud = authenticated`, exp) and re-reads `profiles` per request, so a role
  change lands on the next call rather than at the token's expiry.
- `READY` — `authenticate()` fails closed on a valid token with no profile row, and `Principal.role` is never
  inferred from anything but that row.
- `READY` — capabilities are server-side: `workers/src/lib/capabilities.ts` is the matrix, every route names one,
  and the frontend's `capabilities` field from `/api/me` is documented and asserted as _a hint, never a grant_.
  A browser cannot grant itself admin/media/team-manager/league-official: the role lives in `profiles.role`,
  `update (role)` is revoked, and every privileged route re-checks it.
- `READY` — role requests are a queue with an admin decision inside one definer transaction
  (`kicklive_request_access` → `kicklive_decide_access_request`), and Phase 10's contact-column narrowing moved
  that desk's applicant-email read onto `kicklive_profile_contacts`.
- `REQUIRES TESTING` — expired-session and refresh behaviour in the SPA (the 401 retry path in
  `src/lib/api/client.ts` and `onUnauthorized`), Turnstile on the exchange routes, and rate-limit behaviour for
  `auth-exchange` under a real burst.
- `NOT IMPLEMENTED` — no 2FA, no session revocation list, no row-level "who else is logged in as me". Accepted
  for a v1 with one admin class of user; recorded so nobody believes otherwise.

## 7. LIVE MATCH

- `READY` — one authoritative state: `kicklive_live_state` derived from validated `match_events`; the client
  sends commands, never scores. A body claiming `home_score = 8` is refused by field validation and there is no
  code path that writes `matches.home_score` outside the phase-3 functions (`tests/unit/phase3-live-match.test.ts`
  and the SQL flow in `scripts/sql-flow.mjs` both assert the derived-score rule).
- `READY` — sequence + gaps: `(match_id, sequence)` monotone, a gap is refused with `SEQUENCE_GAP` and the room
  falls back to a snapshot; reconnect resumes by sequence and takes a snapshot only when it must — counted as
  `live.reconnects{resume|snapshot}` since phase 9.
- `READY` — clock, pause/resume/halftime/fulltime via explicit commands and alarms; `live.lag` measures the
  write tail; `MatchRoom` emits `connections` at most once a minute so the gauge's `value_sum` stays honest.
- `READY` — transports: WebSocket with polling fallback (`GET /live/matches` snapshot + `?since=`), plus the
  offline queue in the app; conflicts resolve in the database, not in the browser.
- `REQUIRES TESTING` — the canonical Match Control Center (phase 10 step 9) is **not** finished: three surfaces
  exist (`MatchControlPro.tsx`, `MatchDashboard.tsx`, `AdminPortal`'s match control tab) and they share
  `src/lib/MatchAutomation.ts`. Consolidating them needs a human choosing one; the underlying state model is
  already single-authority, so this is UI debt, not correctness debt.
- `REQUIRES TESTING` — a real match: kickoff → goal → correction/reversal → halftime → fulltime, with a
  deliberate network drop and a duplicate event, on `wrangler dev` with Redis-free DO state. No browser or
  deployment here means the flow has not been run end to end by this change set.
- `NOT IMPLEMENTED` — no automatic fixture ingestion, no provider sync; `CompetitionEngine` computes standings
  and phase 4's `kicklive_competition_standings` is the read (both use `select('*')` in places — §10).

## 8. NOTIFICATIONS (beyond FCM)

- `READY` — triggers are server events only (phase 3 emits into the queue; there is no client path that
  "sends a push"), fan-out is capped by `NOTIFICATIONS_MAX_AUDIENCE` (refused, not truncated), preferences are
  honoured per user, and history is a table rather than a log line.
- `READY` — retries with backoff, DLQ, and `notifications.*` metrics for jobs/attempts/deliveries/errors/queue
  so a stalled consumer is visible as a rate rather than as silence; `NOTIFICATION_DLQ` and `INVALID_TOKEN_RATE`
  are alerts on the same numbers.
- `REQUIRES CONFIGURATION` — `NOTIFICATIONS_LINK_BASE` when a tap may land outside the SPA's origin;
  `NOTIFICATIONS_REMINDER_LEAD_MINUTES` to the value the operators want.
- `REQUIRES TESTING` — a reminder actually arriving at kick-off minus N, twice for one match (dedupe), and once
  to a user who disabled reminders.
- `NOT IMPLEMENTED` — in-app notification centre, email digest, per-device mute. Phase 5's doc records the choice.

## 9. MONITORING

- `READY` — `GET /api/observability/health` (public, three fields per component), the admin panel
  (Admin Portal → Monitoring: system health, API, live matches, notifications, advertising, alerts, privileged
  actions), 13 routes, `cache: none`, all gated on `admin.audit_read`/`admin.settings_write`.
- `READY` — P50/P95/P99 from a ten-bucket histogram, reported as bounds with an `open` flag; error rates,
  cache classes, rate-limit classes, upload outcomes, queue depth, live-room gauges; nothing keyed by user,
  device, socket or match _identity_ in the metric path.
- `READY` — `LOG_MODE` default `errors`, closed field set, `redact()` + the database's `SECRET_SHAPE_REFUSED`
  guard, `x-error-category` on every failure response, and the error envelope unchanged.
- `REQUIRES CONFIGURATION` — a log drain for stdout (the field list is fixed; configure the drain to it), and
  whatever alert delivery the operators want: alerts are **read**, not pushed — no paging is wired (`NOT IMPLEMENTED`).
- `REQUIRES TESTING` — retention: `kicklive_metrics_rollup_daily` / `kicklive_metrics_purge` ride the hourly
  sweep; watch one day roll over in staging and confirm `metric_daily` grew while `metric_rollups` did not.
- `REQUIRES TESTING` — the public health endpoint under a real degraded dependency (pull the R2 binding or the
  JWT secret in staging and watch the panel, not the logs).

## 10. PERFORMANCE

- `READY` — the query ratchet: `scripts/query-audit.mjs` + `docs/data/phase4-query-inventory.md` are asserted
  current by `tests/unit/query-ratchet.test.ts`, which is how this change set's five query moves got caught in
  seconds rather than in review. Per-file counts for unbounded reads are in that table.
- `READY` — data layer: one query spec per surface (`src/lib/data/*`), `limit()` + named columns in the reads the
  phases own, ETag/`Cache-Control` classes per route (`edge|private|none|handler`), stale-while-revalidate for
  public catalogues, live state never edge-cached, and the SPA's boot path measured by the build script at
  156.6 KiB gzipped.
- `READY` — 19 poll loops replaced by the phase-4/5 architecture; the remaining intervals are per-page and
  documented, and phase 9's `system.cron` metric makes a dead schedule visible.
- `REQUIRES TESTING` — the N+1 candidates: `src/lib/MatchAutomation.ts` (5 × `select('*')`) and
  `src/lib/CompetitionEngine.ts` (whole-table reads, console logging) are used by `MatchControlPro`,
  `MatchDashboard`, `CompetitionWizard` and `FixturesViewer`. They are pre-phase-4 admin surfaces; narrowing
  them is a named follow-up rather than a blind edit, because the only way to know a `select('*')` is safe to
  narrow is to render the screen.
- `REQUIRES TESTING` — index confirmation for the phase 5–9 reads on real volumes (`pg_stat_user_tables` after
  a week of staging), and `kicklive_observability_diagnostics`' own read cost.

## 11. MOBILE

- `READY` — responsive: 40 of 59 `tsx` files carry breakpoint classes; the pages named in the mandate
  (fixtures, match detail + live, standings, team/player profiles, news, portal desks, profile/auth) are the same
  React components at every width, and the PWA build (`npm run build:pwa`) ships a service worker + manifest.
- `READY` — desktop app builds main/preload (`npm run build:desktop`), packaging is
  `electron-builder` + the release pipeline's own gates.
- `REQUIRES TESTING` — a real device pass: safe-area insets on notched phones, 44px targets, no horizontal
  scroll at 360px, WebSocket reconnect on a network switch, and low-bandwidth behaviour of the live page. None of
  that is expressible in this workspace.
- `NOT IMPLEMENTED` — no native app, no offline-first cache beyond the queued writes and the service worker, no
  push from the desktop shell (mock transport unless `FCM_*` is set).

## 12. BACKUPS

- `READY` — the app is additive-only by construction, so a restore is "replay migrations from a base backup":
  no migration in the nine drops or rewrites anything, and each has a commented rollback section.
- `REQUIRES CONFIGURATION` — Supabase PITR or a scheduled `pg_dump` + a tested restore, off-box, with the
  retention the club can defend. Nothing in this repository does backups.
- `REQUIRES TESTING` — one restore rehearsal into a scratch project, then `npm run check:sql -- --dsn <scratch>`
  against it. A backup nobody has restored is a hypothesis.
- `READY` — R2 objects are never deleted by an app path except the documented retention sweep, which prunes
  `expired` rows only after `expires_at`, so a bad deploy cannot orphan the bucket.
- `BLOCKED` — no DR runbook exercise (RTO/RPO numbers are not measured anywhere in this repo).

## 13. DEPLOYMENT

- `READY` — the toolchain no longer assumes Node's built-in TypeScript stripping: every `node …` npm script
  imports `scripts/lib/ts-loader.mjs`, which transpiles `.ts` sources through the pinned `typescript` package and
  propagates itself to `node --test` children through `NODE_OPTIONS`. A repackaged Node (Debian/Ubuntu
  `nodejs`, `process.features.typescript === false`) previously turned 577 green tests into 23 identical
  `ERR_UNKNOWN_FILE_EXTENSION` failures, which reads exactly like a broken repository. Covered by
  `tests/unit/toolchain-ts-loader.test.ts`, including a probe that only a real `enum` compile can satisfy.

- `READY` — every resource, variable and secret is listed with its command in
  [`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md), including the names that must match each other across
  files (`NOTIFICATION_QUEUE_NAME` vs the `[[env.*.queues]]` blocks, and the KV id after you create it).
- `READY` — documented order: migrations (base + nine, filename order) → Worker (`wrangler deploy`, then
  `--env staging|production` per `workers/README.md`) → web (`npm run build:web` → Vercel/static host,
  `vercel.json` for SPA + `/api` rewrite) → smoke (`GET /api/health`, the Monitoring panel, one upload, one
  push). `DEPLOYMENT.md`, `DEPLOYMENT_GUIDE.md` and `DEPLOYMENT_CHECKLIST.md` describe this repository, and
  their schema steps were corrected in Phase 10 to stop naming a superseded file.
- `REQUIRES CONFIGURATION` — every var and secret listed in `.env.example` and `workers/.dev.vars.example`
  (which is now complete through phase 9, including `AD_VIEWER_KEY_SECRET` and `LOG_MODE`); the Vite build
  refuses a mismatched ref/key pair, so a half-configured deploy fails loudly.
- `REQUIRES CONFIGURATION` — `npm run ci:install` (workflows live in `ci/` and are copied into
  `.github/workflows/`, because this repository's push rules reject commits that touch that directory).
- `REQUIRES TESTING` — `verify.mjs check` (17 checks) and `gates` in CI on the pushed branch, plus a staging
  deploy observed through one live match.
- `BLOCKED` — nothing in this checklist has been deployed; no claim below is based on a successful deploy.

## 14. ROLLBACK

- `READY` — web: the static host keeps the previous build; roll back by promoting it. The Worker:
  `wrangler deployments list` → `wrangler rollback` (one command, one previous version), and the DO keeps its
  stored sequence so a rolled-back Worker resumes rather than resets.
- `READY` — database: no migration here is destructive, so the rollback of a _deploy_ is not the rollback of a
  _schema_: the nine files stay applied, and each phase's own rollback comment is the surgical alternative.
  Phase 9's and 10's rollback sections are written out for exactly this reason.
- `READY` — feature-level off-switches that do not need a deploy: `LOG_MODE=off` for log volume, an ad slot's
  `display` switch, a sponsor's status, `NOTIFICATIONS_REMINDER_LEAD_MINUTES=0` to stop reminders,
  `MEDIA_MAX_BYTES` to refuse uploads.
- `REQUIRES TESTING` — rehearse `wrangler rollback` on staging with a live match running, and confirm the fan
  page and the referee desk both survive mid-match (the DO is the stateful part; that is what to watch).
- `NOT IMPLEMENTED` — no blue/green database migration tooling, no `pg_dump`-to-restore automation, no
  automatic rollback on alert. `metrics_purge` will not delete audit rows even if someone asks it to, so a
  rollback never erases evidence — that is the intended asymmetry.

---

## Final rating

**PRODUCTION READY AFTER CONFIGURATION, AND REQUIRES FIXES IN ONE NAMED AREA.**

Configurable, verifiable, and honest about its gaps in §1–§6, §8–§14: the security posture, the privilege model,
the database path, the observability plane and the privacy boundary are implemented with tests, and the whole
list of what an operator must still _do_ (queues, KV namespace, R2 buckets, FCM, secrets, CI install, log drain,
backups) is above with commands.

Two things stop this from being an unqualified `READY`:

1. **`REQUIRES TESTING` at the root of it:** nothing in the last three phases has been applied to a Postgres.
   `npm run check:sql` — which is the only check that can see whether a constraint fires — cannot run in this
   workspace, and Phase 8's identical gap is what produced the phase-8 `runSponsorshipFlow`. Ship after the
   `--fresh` run in §2 prints `ALL PASS` on staging.
2. **`REQUIRES FIXES`:** `workers/wrangler.toml`'s commented-out `RATE_LIMIT_KV` (a rate limiter that is not
   global is not the mitigation §1 assumes it is), the three-surface match desk that has not been consolidated
   to one canonical control center, the two admin libraries that still `select('*')` and log to the console, and
   the 344 `<button>` elements without a `type` attribute (in React, a `button` in a form defaults to `submit` —
   an accidental submit on the referee desk is a real event, not a lint nit; `aria` coverage is thin at
   8 `aria-label`/1 `aria-modal`/1 `aria-live`, while all 19 `<img>` carry `alt`).

Full audit trail for this phase: `docs/PRODUCTION_MIGRATION_PLAN.md` (Phase 10 entry),
`docs/OBSERVABILITY_ARCHITECTURE.md`, `supabase/README.md`.
