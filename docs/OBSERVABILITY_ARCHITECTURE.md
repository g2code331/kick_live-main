# Phase 9 — Analytics, monitoring and observability: architecture, decisions and status

This note is the record of what Phase 9 measured, what it deliberately refused to record, and what is still
not done. It is written for the person who has to operate this in a year, and for the reviewer who has to
decide whether "we have observability" is a true claim. Both of them should leave knowing which file to read
next and which shortcut is available — the shortcuts are named, because an undocumented shortcut gets taken.

Related: `docs/PRODUCTION_MIGRATION_PLAN.md` (phase order and status), `docs/SECURITY_AUDIT_PHASE1.md`
(the identity model this phase inherits), `docs/NOTIFICATIONS_ARCHITECTURE.md` and
`docs/R2_MEDIA_ARCHITECTURE.md` (the two subsystems whose queues and jobs are measured here),
`workers/README.md` (the route catalogue, including the 13 rows this phase added).

## 1. What was already there, and what was not rebuilt

Before this phase the Worker had `logError(requestId, error)` writing one line per failure to stdout,
`activity_logs` written from SQL by phase migrations and from the browser by `AdminPortal.logActivity`,
`ad_analytics_daily` from Phase 7, `GET /health` returning a Supabase round-trip, and a five-minute cron sweep
that logged its own exceptions. That was not nothing, and rebuilding it would have produced two systems with
different answers to the same question — the classic first failure of an observability phase. So:

- `GET /health` still exists and still answers `ok` / `degraded`. The new `system_health` table is what it
  reads from conceptually, but `/health` was not moved onto the new machinery, because uptime probes are
  already wired to it and a monitoring endpoint that changes shape during a monitoring rollout is how you
  lose visibility exactly when you need it. The new reads sit beside it.
- `activity_logs` was hardened in place (§9), not replaced. There is no `audit_events` table, and every
  already-written `insert into activity_logs` in the phase migrations keeps working.
- Phase 7's `ad_analytics` measurement is not duplicated: the admin advertising panel reads Phase 7's own
  function for delivery truth and this phase's rollups for operational truth, side by side (§12).
- `logError` was kept and given a sibling. `lib/errors.ts` now classifies, `lib/observability.ts` writes the
  structured line; the old call sites keep working because `logError`'s signature did not change.

## 2. The shape: a buffer, a rollup table, a daily table, and read functions

```
  Worker isolate (in-memory, per-cpu-burst)
    observe({subsystem, metric, route, dimension, samples, …})   →  Map<key, accumulator>
    20s flush / 400 samples per call                            →  kicklive_metrics_record(jsonb)
                                                                     ↓ upsert, minute bucket
                                                             metric_rollups   (14 days)
                                                        kicklive_metrics_rollup_daily  ↓ delete+insert
                                                             metric_daily    (400 days)
    log line → stdout (LOG_MODE) → whatever platform sink the operator configures
  Postgres definer reads (kicklive_metrics_summary / _daily / *_metrics / alerts)
    ↓ Worker handlers, cache: none
  Admin Portal "Monitoring" section + public GET /observability/health
```

Four tables, one migration
(`supabase/migrations/20260915120000_phase9_observability.sql`, 35 functions + one aggregate):

| table                  | role                                                                   | retention                             |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `metric_rollups`       | the working set: fixed-interval counters, latency histogram, gauge sum | 14 days (config)                      |
| `metric_daily`         | the long view: one row per (day, subsystem, metric, route, dimension)  | 400 days (config)                     |
| `system_health`        | latest state per component; the thing the public endpoint summarises   | overwritten in place, 1 row/component |
| `observability_config` | one row: buckets, retention, flush interval, alert thresholds, caps    | never purged                          |

There is **no raw request table**, and no plan for one. Every design question in this file follows from that:
a request is a _number in a bucket_ plus, if it failed or was slow, _one log line_. A reviewer looking for the
request log will not find it, and that is the intended answer.

## 3. What a log line is allowed to contain

The field set is fixed in `lib/observability.ts` (`emit`, documented at the top of the file), and it is the
whole list:

```
ts · level · subsystem · requestId · clientRequestId? · correlation? · method · route ·
status · durationMs · category? · size? · cache? · role? · cacheClass? · rateClass? ·
error? · message? · extra? (a small object, always redacted before it is written)
```

Not in the list, and therefore never in a log line: the request path with real ids in it, the query string,
the body, the headers, an IP address, a user agent, a device token, a token-shaped anything. `route` is the
**pattern** from the router catalogue (`/matches/:matchId/events`), never the concrete URL, so a log line
cannot name a match by accident; `status` is a number; `error` is `safeMessage(err)` — first line, flattened,
truncated, no stack. `size` is a byte count, not the payload.

`LOG_MODE` picks the volume: `off` (errors only, for the queue consumer too), `errors` (**default** — every
failure and every slow request, no healthy 200s), `slow`, `all`. The default is the phase requirement read
literally: "structured logs with request ids, status codes and durations, without excessive raw request logs".
A healthy request is a counter, not a line.

Two guards make that stick rather than relying on care:

- `redact(value)` / `redactText(value)` walk objects and strings and drop secret-shaped keys and values before
  they reach stdout. The rules are shared with SQL (§5) in shape, not in code.
- `kicklive_metrics_record` refuses any field of an incoming sample whose key or string value is secret-shaped
  (`SECRET_SHAPE_REFUSED`). The metrics path cannot be used as a smuggled log.

## 4. Correlation: one id, three hops, and nothing trusted

The client mints an id per attempt — `src/lib/api/client.ts:177` — and sends it as `x-request-id`. The Worker
either adopts it or mints its own: `requestIdFrom` in `lib/headers.ts` accepts `/^[A-Za-z0-9._-]{8,64}$/` and
otherwise calls `newRequestId()`. The result is echoed back as `requestId` in the response body and, for
errors, in the failure the client surfaces (`onUnauthorized` carries it; a support ticket that contains one is
enough to find the log line).

From the Worker the same id travels two further hops:

- **into the log stream** as `requestId`, with the client's raw header kept separately as `clientRequestId`
  (which is why an id can be _carried_ without being _believed_: the two fields let you see a client that is
  reusing ids).
- **into a queue message** as `payload.trace = { requestId, origin, at }` — `traceFor` builds it, `traceFrom`
  re-reads it without trusting any field, dropping the whole trace rather than sanitising one piece of it.
  `origin` is the route pattern that produced the job, which turns "the queue is behind" into "the queue is
  behind since match finals started firing". No user id, no payload copy, no token, ever.
- **into Supabase** as an argument to the audit writer (§9), so an `activity_logs` row names the request that
  caused it.

There is no W3C `traceparent` and no distributed-tracing vendor. With one Worker, one Postgres and two queues,
a single id string answered the requirement; the cost of a real tracer is a dependency and a retention policy
this phase explicitly does not want. If a third service ever joins, this is the section to re-read.

## 5. The catalogue is the join key, and parity is a test

Both sides list the same names, and each side states them in its own language: `METRIC_CATALOGUE`
(`"subsystem.metric" -> the closed dimension list`) in `workers/src/lib/observability.ts`, and the 26
`values` rows inside `kicklive_observability_catalogue()`
(`(subsystem, metric, dimensions, purpose)`) in §6 of the migration. They must agree on every pair and on the
dimension vocabulary of each. `tests/unit/phase9-observability.test.ts` asserts that
in **both directions**, with the set difference printed before the assertion fails — because a
one-directional test is how you ship a Worker that writes metrics nobody reads, and an empty catalogue that
makes the read endpoints look fine.

Subsystem vocabulary is shared with the health table's CHECK (`api, live, notifications, advertising, media,
storage, queue, system`) and is also asserted equal to the Worker's `OBSERVABILITY_SUBSYSTEMS`.

The catalogue is documentation, not a whitelist, and that is a deliberate loss of strictness:
`kicklive_observability_metric_ok` accepts any name matching `^[a-z][a-z0-9_]{1,47}$`, so a metric added in a
hurry on a Friday is _stored_ rather than dropped, and `kicklive_observability_diagnostics` reports the names
in the last day that are absent from the catalogue. A system that discards the unexpected measurement to keep
a tidy list has optimised for the wrong thing.

## 6. Cardinality is a budget, spent once, in the open

A metrics table becomes a raw log the moment a dimension can hold an unbounded value. Three rules, all tested:

1. **Route or fold.** `kicklive_observability_route_ok` accepts `*` or `/^[a-z0-9/_.:-]{0,118}$/` and refuses
   anything containing a run of 3+ digits. The Worker's `observe` applies the same rule as a _fold_ — a
   concrete path becomes `*` on the way in — so a buggy caller loses its route granularity, not its numbers.
   Ids in metrics are impossible in both directions: the Worker will not send them and the database will not
   store them.
2. **The buffer has a hard key cap.** `MAX_KEYS = 400` series per isolate; past that, writes fold into the
   `(subsystem, metric, *)` series and `bufferStats().overflowed` counts the writes that took the detour. The
   fold key is allowed _past_ the cap on purpose — refusing it would drop counts, and a metrics buffer's first
   duty is that the totals add up, so the true bound is 400 series plus one fold per overflowing
   (subsystem, metric). The unit test asserts both halves: bounded keys and `samples` summing to exactly the
   1200 writes that were made.
3. **A gauge is sampled once per bucket.** `value_sum` is a sum over the bucket, so `live.connections` is
   emitted at most once a minute per room (`MatchRoom.lastGaugeAt`, from `alarm()`), not on every broadcast —
   sampling per emit would make "busiest minute" mean "busiest broadcast", which is a number that is wrong in a
   way nobody notices.

Dimensions are `[a-z0-9_.:-]{1,32}`, lower-case only, so `2xx`/`5xx` and `sent`/`failed` are fine and
`status=500&user=7` is refused (`MALFORMED_DIMENSION`).

## 7. P50/P95/P99 from a ten-wide histogram, without a percentile engine

`observability_config.buckets_ms` is `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]`. `kicklive_ms` →
`kicklive_observability_histogram_index` puts a duration in a bucket; `metric_rollups.histogram bigint[]` is
upserted by adding element-wise through the `kicklive_observability_histogram_sum` aggregate
(`kicklive_observability_hist_add` as the transition function), which is why there is no
`jsonb_array_append`-shaped hack and no per-row loop in SQL. Percentiles walk the cumulative counts
(`kicklive_observability_percentile_index`, nearest-rank) and are reported as **bucket bounds with an `open`
flag**: p99 = `≥ 5000ms`, `open: true`, rather than a number that implies a precision the histogram does not
have. An empty window returns `null`, never `0ms` — "0ms" on a chart is a claim that something was fast when in
fact nothing happened.

Latency columns are only populated by rows that measured a duration (`sum_ms > 0`): folding a gauge row (open
sockets, queue depth) into the mean pulls it toward zero and makes the p95 meaningless. That filter is part of
the definition, and `metric_rollups_latency_within_samples` used to have a companion CHECK asserting
`sum_ms >= samples * min_ms` — deleted, because gauge rows legitimately have `samples > 0, sum_ms = 0` and a
CHECK discovered at insert time inside a `security definer` function surfaces as a 502.

Window granularity is chosen from the span: `> 7 days` → day rows, `> 6 hours` → hour, else minute. **No
function writes `granularity = 'hour'` rows**, so an hour-granular read of `metric_rollups` currently returns
nothing (see §18); the accepted alternative is the day table plus minute rows, and `kicklive_metrics_summary`
does exactly that by reading minute rows and grouping up to the hour itself. The `'hour'` literal stays in the
CHECK because the day rollup writes `'day'` and the live path writes `'minute'`, and removing the arm would be
a migration for no benefit. `kicklive_observability_diagnostics` reports `hourlyRows`, and the flow asserts it
is zero, so if that ever changes it changes on purpose.

## 8. Health: nine components, two reads, one derived writer

`system_health` is keyed on `component text primary key`, so there are exactly nine rows and no way to grow a
second opinion about the same dependency: `worker`, `supabase`, `durable_objects` (the DO state plane, judged by
how recently a room heartbeated rather than by a control-plane query Cloudflare does not answer), `queues`,
`fcm`, `r2`, `metrics`, `cron`, `database_size`. The CHECK and the Worker's `HealthComponent` union are asserted
equal in a unit test, which is the only thing keeping the two vocabularies honest. Status is
`ok|degraded|unavailable|unknown`, with a
**reason code** matching `^[A-Z][A-Z0-9_]{2,47}$`, a **flat** jsonb detail, `consecutive_failures` and
`checked_at`. A reason code, not a sentence: a code can be alerted on, translated and kept stable across a
deploy, and it cannot leak a stack trace, a SQLSTATE or a file path by being pasted from an exception.

Writers are the cron probe (`probeDependencies`, every five minutes: an R2 `head` — a `null` answer is a
successful probe, only a throw means the binding is broken — and a Supabase round-trip, then
`kicklive_health_recompute_derived` for everything that is computed rather than probed: queue backlog, metric
staleness, DO heartbeat age, `database_size`) plus `reportHealth` calls at the places that know something the
probe cannot, such as a queue consumer noticing FCM refused a token. The admin
`POST /observability/admin/probe` runs the same probes on demand, which is what makes the panel testable without
waiting five minutes for a schedule.

The **reads are two functions, not one function and a field list in a handler**:

- `kicklive_health_read()` → `{ status, observedAt, components: [{ component, status, ageSeconds }] }`,
  granted to `anon` and `authenticated`. `GET /observability/health` — a status page, an uptime probe, a
  support macro.
- `kicklive_health_read_admin()` → the same rows plus `reason`, `detail`, `consecutiveFailures`, `stale`, and
  the currently-evaluated alert list. Gated on `is_admin()` **on the caller's own token**.

The difference between them is a grant and a projection, so "somebody adds a column to `system_health`" cannot
leak through the public endpoint — the leak would require also editing the definer function, which is reviewed.
Both are `cache: "none"`: a stale health answer is a worse lie than a slow one, and this is the one place where
Phase 8's epoch/edge-cache pattern is deliberately not reused.

## 9. Audit: hardening the table that existed

`public.activity_logs` (baseline `KICKLIVE_FINAL_SCHEMA.sql:325`) records privileged actions today, and Phase
1 left it world-writable to admins (`activity_logs: admin all`). Phase 9's §7 closes that with three pieces,
in place, additive only:

1. **A select-only admin policy.** Admins read the trail; they do not write it through the table. Direct
   inserts from the browser keep working only where RLS still allows the insert — see §10 for the honest
   statement about that.
2. **An append-only trigger.** `activity_logs_append_only` refuses every `DELETE` outright, and refuses any
   `UPDATE` that changes anything other than clearing `user_id`. That exception is not a hole, it is
   `on delete set null` on the profile foreign key firing as an update — a narrow carve-out asserted in the
   flow (`to_jsonb(new) - 'user_id' is distinct from to_jsonb(old) - 'user_id'`, then
   `if new.user_id is not null then raise`). Correction is by writing a new entry that cites the old one,
   which is also how a reviewer can tell the trail was not edited: nothing in it changes shape.
3. **A definer writer, `kicklive_audit_record`.** Validates `action` (`^[a-z][a-z0-9_.]{2,63}$`) and
   `entity_type`, refuses secret-shaped `entity_name`/`details`, sets `user_id := coalesce(auth.uid(),
p_actor_id)` — the subject comes from the JWT, and an `p_actor_id` argument is a fallback for a trusted
   caller, never an override — and injects `via`, `actor_role` and `request_id` into `details`.
   `kicklive_audit_list` is the read, with `limit` clamped to 1..200.

The Worker's `middleware/audit.ts` covers exactly the privileged routes the database does not already write for
itself. `AUDIT_ROUTES` is derived from the router catalogue and `AUDITED_IN_SQL` subtracts the ten routes whose
migration SQL already inserts a row, so there is **one audit row per action**, not two, and the set difference
is asserted in a unit test rather than maintained by hope. Writes are best-effort: a refusal or a network
failure is logged once and never surfaces to the user, because a failed audit write must not turn a successful
privileged action into a 500 the operator then has to reason about — that trade is stated here so it can be
argued with.

## 10. The one thing audit is not

`src/pages/portals/AdminPortal.tsx` (three call sites) still inserts into `activity_logs` from the browser.
Those rows are a **record, not evidence**: they carry no `request_id`, no `via`, no server-observed
`actor_role`, and `user_id` is whatever the caller's token maps to. They satisfy the old UI's expectation and
they are honest enough to be read as "someone says they did this". Anything that must survive a dispute is
written by the definer path (§9), from the Worker or from a phase function.

Two consequences, both accepted rather than glossed: `metrics_purge` cannot delete audit rows (no function in
the migration can delete from `activity_logs` at all, and `auditTouched` is always `false`), so audit
retention is a reviewed migration and not a scheduled job; and `observability_config.audit_retention_days = 0`
means "we do not prune", which `kicklive_observability_diagnostics` reports as age and row count so growth is
visible before it is a problem.

## 11. Errors: a taxonomy, a header, and an envelope nobody was allowed to edit

`workers/src/lib/errors.ts` maps every `ApiCode` in `lib/response.ts` to one of the required categories —
`AUTHENTICATION · AUTHORIZATION · VALIDATION · DATABASE · R2 · QUEUE · FCM · WEBSOCKET · INTERNAL` — via a
`classify(err)` that is **total over the union** (a unit test iterates `ApiCode` and fails if any member maps
to `INTERNAL` by accident rather than by decision). `failWithCategory` adds one response header,
`x-error-category`, and nothing else.

The error envelope is untouched, on purpose. The 100 pre-existing routes and the frontend's `failure()` parser
in `src/lib/api/client.ts` both depend on its exact shape; adding a `category` field would have meant touching
both, and would have made every client that guesses at the shape guess differently. A header is
observability-shaped: present for tooling, ignorable by users, and cheap to add. Users see the same short,
human message they saw before; nothing anywhere in the taxonomy reaches a user as a stack trace, a SQLSTATE or
an internal path — `safeMessage` is used for logs, and responses use the pre-existing `message` fields.

## 12. Live matches, notifications and advertising — what is safe to know

- **Live** (`live.*`): `activeMatches`, `connections` (gauge), `reconnects` (dimensions `join|resume`),
  `event_failures` (dimensions are error categories), `snapshots` (`poll|push`), `rejected` (a refused
  subscription or a rejected write), `lag` (gauge, seconds since the applied sequence). The read
  (`kicklive_live_match_metrics`) emits only `match_id`, `status`, `live_updated_at`, `seconds_since_update`
  per room plus a `note` — **no fan, no user id, no socket count per viewer, no IP**. `note` is surfaced in
  the admin panel rather than hidden, because a caveat nobody reads is a caveat nobody applies.
- **Notifications** (`notifications.*`): `jobs` (dimensions are Phase 5's real `FinishStatus` values),
  `attempts`, `deliveries`, `errors` (classified), `queue` (depth gauge), `devices` (`invalid|pruned`). The
  queue consumer calls `observeDelivery` once per message, which is what makes "delivered" mean "FCM accepted",
  not "we sent". Alert codes `NOTIFICATION_DLQ` and `INVALID_TOKEN_RATE` read the same rollups.
- **Advertising** (`advertising.*`): `served` (by placement), `events` (impression/click, counted, deduped by
  the existing server-side key), `ingest` (the queue's own health). The admin panel shows Phase 7's
  `kicklive_ad_analytics` figures as the measurement of record and this phase's counters as the operational
  view, labelled `measurement` vs `operational`, with `measurementRaw` when the two disagree — an ad number
  and a metrics number that differ is a bug in one of them, and a reviewer should be able to see that without
  running anything.
- **Media/storage/queue** (`media.uploads|sweep|bucket`, `queue.depth`, `system.health|cron|metrics`) are
  counted where the work already happens — Phase 6's sweep, the ad consumer, the DO alarm — so there is no
  second code path that could disagree with the first.

## 13. Retention: what the database sweeps, and what a human reviews

| data                           | kept                  | swept by                                                    |
| ------------------------------ | --------------------- | ----------------------------------------------------------- |
| `metric_rollups` (minute/hour) | 14 days               | `kicklive_metrics_purge`, hourly cron on the media sweep    |
| `metric_daily`                 | 400 days              | same                                                        |
| `system_health`                | latest per component  | overwritten in place                                        |
| log lines                      | platform's own policy | nothing here — they go to stdout and the platform owns them |
| `activity_logs`                | forever, by design    | **nothing**, and no function can (see §10)                  |

`p_rollup_days` / `p_daily_days` are clamped to at least a day, so a tired operator cannot type `0` and lose
the working set; the day rollup is delete-then-insert over one finished day, which makes it idempotent and is
also the reason no hourly tier exists. Alerts are **evaluated at read time** against
`observability_config` (error rate, p95, staleness, dependency status, heartbeat, DLQ, invalid-token rate,
rooms without sockets, repeated probe failures) rather than stored: nine rules over a bounded window is not a
rule engine, and an alert that is computed cannot be stale in the way a stored one can.

## 14. Admin Portal: five panels, one chart-free page

`src/pages/portals/admin/SystemMonitoring.tsx`, reached from the `monitoring` tab of `AdminPortal.tsx`, renders
SYSTEM HEALTH / API / LIVE MATCHES / NOTIFICATIONS / ADVERTISING plus an alerts strip and the privileged-action
list. Data comes from `src/lib/data/observability.ts`, whose types mirror the SQL projections field by field —
a drift test in `tests/unit/phase9-observability.test.ts` compares those shapes against the migration's return
blocks, which is the only kind of drift check that works when the API is a set of Postgres functions.

Each section fetches on its own (`useSection`), so a slow panel cannot grey out the page, and there is no
chart library: latency is presented as bucket bounds, which is exactly the precision the histogram has. Alert
rows render `code` + `evidence` and **never** `row.message`; a `note` from the server is rendered rather than
dropped. Nothing on this page is public: every read is `authenticated` + `admin.audit_read` +
`cache: "none"`.

## 15. Privacy review, in the form of a list of what is not recorded

No email, no phone, no IP, no user agent, no device token, no push payload, no query string, no request body,
no concrete path, no socket identity, no per-viewer ad record, no stack trace, no Supabase key, no
`authorization` header. Correlation ids are random UUIDs with no relationship to a person, and they expire out
of the rollups in 14 days (they are not stored there at all — only `request_id` inside `activity_logs.details`
lives as long as the audit row does, which is forever by design). `media_assets`/`profiles` are not joined by
any read in this migration. The public surface is exactly one endpoint with three fields per component.

The risk this section is really about is the log aggregator: whatever collects stdout decides how long the
`requestId`/`route`/`status` lines live, and `LOG_MODE = "all"` widens that stream. That is why `errors` is the
default, why the field set is closed, and why `workers/README.md` says so at the deployment section rather than
only here.

## 16. Testing: what runs, and what cannot run here

- **Unit (in CI, `node scripts/run-tests.mjs unit`, 563 tests, 0 failures)** — catalogue parity in both
  directions; subsystem and health-component CHECK parity; bucket-literal parity between Worker and SQL;
  `classify` totality over `ApiCode`; every redaction rule with its SQL counterpart marker; buffer fold/cap/
  gauge behaviour including "1200 writes, 1200 counted"; correlation-id acceptance and refusal; audit coverage
  against the router catalogue (one row per action, SQL-audited routes excluded); route gating, cache class and
  handler wiring for all 13 routes; `flushObservations` against a fake `fetch` for success, refusal, overload
  and re-buffering; frontend-shape and AdminPortal-tab assertions.
- **SQL flow (`scripts/sql-flow.mjs` → `runObservabilityFlow`, run by `scripts/check-sql.mjs`)** — 30-odd
  assertions that only a real Postgres can answer: the upsert folding a replayed flush, one refusal per rule
  with the good rows still written, `BATCH_TOO_LARGE` refusing the batch whole, the errors/samples clamp,
  percentile bounds and `null` for an empty window, zero `hour` rows, the public health projection's exact key
  set, `anon` refused the admin snapshot, the audit subject coming from the JWT and an `actor_id` override
  ignored, a JWT in an audit payload refused, `DELETE`/`UPDATE` on `activity_logs` refused even for
  `service_role`, the cascade carve-out still working, the day rollup idempotent, retention never touching the
  trail, and the redaction probe explaining both a bearer token and an ordinary sentence.
- **`node scripts/sql-paren-check.mjs`** (this repo) — 35 function bodies, none unbalanced. A migration that
  cannot parse is not a migration.
- **Typecheck/build**: `tsc -p tsconfig.json` and `tsc -p tsconfig.workers.json` clean;
  `scripts/worker-routes.mjs --check` agrees (101 routes); `prettier` clean; `scripts/gates.mjs` and
  `scripts/verify.mjs check` green.

**Not executed here, and that matters**: this sandbox has no Postgres (`initdb`/`psql` absent, no container
runtime, no root), so `runObservabilityFlow` has never run. Phase 8 landed the same way and the pattern of what
it found — a grant loop whose `like` pattern never saw the function it was supposed to cover, a CHECK containing
a subquery — is exactly what this flow is written to catch. Before this migration is applied anywhere:

```
node scripts/check-sql.mjs --dsn "postgres://kicklive@127.0.0.1:55432/kicklive_scratch" --fresh
```

and require `runFlow`, `runSponsorshipFlow` **and** `runObservabilityFlow` to print `ALL PASS`.

## 17. Manual setup, in the order that works

1. Apply the migration on staging: `supabase db push` (or `psql -f` the single file). Its §16 `do $verify$`
   block raises rather than installing silently — that is the intended failure mode.
2. Deploy the Worker. No new bindings, no new secrets: metrics use the existing Supabase key, logs use stdout.
   Optional var: `LOG_MODE` (`off|errors|slow|all`, default `errors`). The environment name is the existing
   `APP_ENV` (`development|staging|production`), which is what `isProduction(env)` reads — there is no
   `ENVIRONMENT` variable in this Worker, and `workers/src/env.ts` is the only list worth trusting.
3. Confirm the five-minute cron is live (`wrangler tail` should show `observability` heartbeats within the
   staleness window, 900s). A `TELEMETRY_STALE` alert on a fresh install usually means the cron line was not
   deployed rather than that the app is broken.
4. Open Admin Portal → Monitoring → `POST /observability/admin/probe`, and check `system_health` rows age by
   less than 300s afterwards.
5. Wire the platform's log drain to the structured line format (§3), **before** turning `LOG_MODE` to `all`.
   The field set is fixed; a drain configured against a guess will drop exactly the fields that matter.
6. Only then, production.

## 18. What is deliberately not done

- **No external metrics vendor** (Prometheus remote-write, OpenTelemetry, Grafana). The rollups answer the
  questions the phase asked; a dashboard product answers questions nobody has asked yet, at the price of a
  second retention policy and a second credential store.
- **No request log, no per-user analytics, no session replay, no funnel tables, no A/B machinery.** The
  requirement was P50/P95/P99 without over-engineering, and a raw request store is over-engineering with a
  privacy bill attached.
- **No hourly rollup writer** (§7), no `metric_rollups` read path for un-rolled minutes beyond 14 days, and no
  retention job for `activity_logs` — all three are documented limits rather than silent gaps.
- **No `system.diagnostics` capability** — reads ride `admin.audit_read`, because a capability nobody can grant
  by accident is better than a new row in a matrix nobody reviews.
- **No change to the error envelope** (§11), no `error_category` column in `activity_logs`, no alert
  notifications to anyone (alerts are _read_; delivering them is a paging product, not a metrics product).
- **No DO-based fanout counters per fan**, no per-socket identity in any log line, and no client-side
  performance-beacon ingestion: the browser's timing data would need a new public write path, and Phase 9 was
  not going to open one to learn something DevTools already says.

## 19. One paragraph for the release note

Phase 9 gives the app a metrics plane and nothing else: the Worker folds every request into a bounded set of
per-minute counters and a ten-wide latency histogram that land in `metric_rollups` through a database function
which refuses secret-shaped input; failures and slow requests additionally produce one structured log line whose
field list is closed and contains no path, no body and no identity; the same `requestId` rides from the
browser's `x-request-id` through that line, into queue messages as a trace, and into `activity_logs`, whose
append-only trigger and definer writer now make a privileged action traceable and un-editable; nine components
report health into `system_health`, of which the public may read status and age and staff may read everything;
and the Admin Portal has a Monitoring page with the five panels, an alert list computed against one config row,
and the audit trail behind the same grant as the metrics. It adds 13 routes, one migration, no dependencies, no
bindings, no raw request log, and no way for any of it to record who was watching.
