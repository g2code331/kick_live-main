-- ============================================================================
-- Phase 9 — analytics, monitoring and observability
-- ============================================================================
--
-- WHAT THIS FILE IS
--   The place the system writes down what it *did*: request counts and latency, live-match activity,
--   notification delivery, advertising measurement, the health of each dependency, and an audit trail of
--   privileged actions. Four tables, thirty-five functions, and one hardening pass on `activity_logs`, which
--   already existed and already had a hole (§7).
--
-- WHY ROLLUPS AND NOT RAW EVENTS
--   The alternative design — an `observable_events` table with one row per request, aggregated later — is
--   what Phase 7 legitimately does for ad impressions, because an impression is a *billable* fact and a
--   billable fact must be re-countable from its raw record. A request is not billable. One row per request
--   in a football app means the table that answers "is the system healthy?" becomes the largest table in
--   the database, and the first thing that needs an archive job. So the fixed-interval rollup *is* the
--   record: counters and a latency histogram per (minute, subsystem, metric, route, dimension), aggregated
--   in SQL, with day-level rollups for anything a month-long chart needs.
--
--   This is a decision with a cost, and the cost is stated rather than buried: a rollup cannot answer a
--   question nobody thought to count in advance. There is no way to reconstruct "which request ids hit
--   /matches/47 between 14:02 and 14:05" from these tables — that lives in the Worker's structured log
--   stream, which is where it belongs (it is operator text, not application state), and per §12 of
--   docs/OBSERVABILITY_ARCHITECTURE.md nothing in this migration copies it into the database.
--
-- WHAT IS DELIBERATELY ABSENT
--   * No IP address, no user agent, no user id, no device token, no fan identity of any kind in any metric
--     row. Dimensions are the route *pattern* (never a path with ids in it), a status class, an outcome and
--     a cache class. A metric that can be sliced by person is not a metric, it is a surveillance log, and
--     this phase's headline requirement is the opposite of that.
--   * No secrets, ever. `kicklive_observability_refuses` runs on every free-text field this file accepts,
--     and it refuses the shapes that leak: `bearer …`, a JWT three-part token, `service_role`,
--     `serviceKey`, `sk_…`, `AKIA…`, a PEM header, `password=`, `token=`, `secret=`. The refusal is a
--     *named* answer, so the Worker can tell "the redactor caught this" apart from "the write failed", and
--     `scripts/sql-flow.mjs` executes both halves of that (§13).
--   * No stack traces. Nothing here has a column for one, which is stronger than a rule about not filling
--     one in.
--   * No external platform. No Prometheus scrape target, no Logtail, no paid dashboard: the Admin Portal
--     reads these functions, and alert *readiness* means the thresholds live in a row that a cron or a
--     human can read (§11), not that this file phones anybody.
--   * No retention job that touches the audit trail. `kicklive_metrics_purge` prunes metrics and nothing
--     else; there is no function in this file that can delete an `activity_logs` row, and §13 asserts it.
--
-- HOW TO RUN IT
--   node scripts/check-sql.mjs --dsn "postgres://…/kicklive_scratch" --fresh
--   It is `create or replace` / `if not exists` throughout and re-runs cleanly. The `-- 14 · verification`
--   block at the bottom is part of the apply: a migration that installs and then lies is worse than one
--   that fails to install.

-- ----------------------------------------------------------------------------
-- 1 · shared validators
-- ----------------------------------------------------------------------------

-- The one redactor. Every free-text field a caller can hand this migration passes through it, and a hit is
-- a refusal of the whole sample rather than a silent scrub: a metric that quietly swallowed a token would
-- leave no evidence that a token was ever in the path, which is the situation an operator needs to know
-- about. Returns the name of the shape it caught, or null when the value is clean.
create or replace function public.kicklive_observability_refuses(p_value text)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_value is null or p_value = '' then null
    when p_value ~* '(^|[^a-z])bearer[[:space:]]+[a-z0-9._-]{8,}' then 'BEARER_TOKEN'
    when p_value ~* 'eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}'          then 'JWT_SHAPE'
    when p_value ~* 'service_role|servicekey|supabase_service'    then 'SERVICE_KEY_NAME'
    when p_value ~* '\bsk_[a-z0-9_]{12,}|\bAKIA[0-9a-z]{12,}'     then 'CLOUD_CREDENTIAL'
    when p_value ~* 'BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY'       then 'PEM_KEY'
    when p_value ~* '(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|fcm_token)[[:space:]]*[:=]' then 'CREDENTIAL_ASSIGNMENT'
    else null
  end
$fn$;

-- Same question, asked of every value inside a jsonb document, keyed by where it was found. A `details`
-- object is the one place a caller can smuggle arbitrary text, so it is scanned rather than trusted.
create or replace function public.kicklive_observability_document_refuses(p_doc jsonb)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    public.kicklive_observability_refuses(k.x),
    public.kicklive_observability_refuses(case when jsonb_typeof(p_doc -> k.x) = 'string' then p_doc #>> '{' || k.x || '}' end)
  )
    from unnest(coalesce((select array_agg(e.key) from jsonb_object_keys(p_doc) e(key)), array[]::text[])) k(x)
   limit 1
$fn$;

-- Identifier shapes. A metric name is written by code, not typed by a person, so it is allowed to be strict:
-- `^[a-z][a-z0-9_.]{1,39}$`. A route is a *pattern* from the catalogue, so it starts with `/` and its
-- parameters stay parameters — the Worker is trusted to send `/matches/:matchId/stream`, and this is the
-- half that catches the moment it starts sending `/matches/47/stream`, because an id in a dimension is a
-- per-match row that turns a bounded table into an unbounded one.
create or replace function public.kicklive_observability_metric_ok(p_metric text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_metric ~ '^[a-z][a-z0-9_.]{1,39}$'
$fn$;

create or replace function public.kicklive_observability_route_ok(p_route text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_route = '*' or (p_route ~ '^/[a-z0-9/_.:-]{0,118}$' and p_route !~ '[0-9]{3,}')
$fn$;

-- Two defensive casts, because `p_samples` arrives as JSON from a Worker buffer and a `::bigint` on
-- `"high"` would raise `invalid input syntax` out of a definer function — which the caller can only report as
-- a 502 for a telemetry write. A metric that answers 502 is a metric that gets switched off, so a value that
-- is not a number is simply absent, and the entry is still counted with its defaults.
create or replace function public.kicklive_observability_bigint(p_value text)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $fn$
  select case when p_value ~ '^-?[0-9]{1,15}$' then p_value::bigint end
$fn$;

create or replace function public.kicklive_observability_number(p_value text)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $fn$
  select case when p_value ~ '^-?[0-9]{1,12}(\.[0-9]{1,3})?$' then p_value::numeric end
$fn$;

-- A dimension is an enum-ish label (a status class, an outcome, a cache class, a reason code). Uppercase
-- categories are the house style for refusal codes, so both spellings are legal and markup is not.
create or replace function public.kicklive_observability_dimension_ok(p_dimension text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_dimension is null or p_dimension = '' or p_dimension ~ '^[A-Za-z][A-Za-z0-9_.:|*-]{0,62}$'
$fn$;

-- Latency, in milliseconds, as the Worker measured it. A negative duration is a client bug (a clock moved
-- backwards between two readings) and it must not poison a rollup's `min_ms`, so it is clamped to zero
-- rather than refused: an unusable sample is worse for an operator than a slightly flattering one.
create or replace function public.kicklive_observability_ms(p_value numeric)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $fn$
  select case
    when p_value is null then null
    when p_value < 0 then 0
    when p_value > 3600000 then 3600000
    else round(p_value::numeric, 3)
  end
$fn$;

-- The histogram edges, one row of configuration rather than a constant duplicated between two files. Ten
-- edges plus the implicit "+Inf" bucket the last array element holds, so a histogram is always 11 wide.
-- `workers/src/lib/observability.ts` keeps a matching `LATENCY_BUCKETS_MS`, and a unit test compares the two
-- literals: if the code's buckets and the database's stop agreeing, a percentile silently becomes a lie,
-- which is the specific failure this line exists to prevent.
create table if not exists public.observability_config (
  id                       smallint primary key default 1 check (id = 1),
  latency_buckets_ms       integer[] not null default '{5,10,25,50,100,250,500,1000,2500,5000}'
                           check (array_length(latency_buckets_ms, 1) = 10 and (latency_buckets_ms[1]) > 0),
  rollup_retention_days    integer not null default 14  check (rollup_retention_days    between 1 and 90),
  daily_retention_days     integer not null default 400 check (daily_retention_days     between 7 and 2000),
  audit_retention_days     integer not null default 0   check (audit_retention_days >= 0),
  flush_interval_seconds   integer not null default 20  check (flush_interval_seconds   between 5 and 3600),
  max_samples_per_call     integer not null default 400 check (max_samples_per_call     between 1 and 2000),
  error_rate_alert         numeric(6,4) not null default 0.05 check (error_rate_alert between 0 and 1),
  p95_alert_ms             integer not null default 1500 check (p95_alert_ms between 50 and 600000),
  staleness_alert_seconds  integer not null default 900 check (staleness_alert_seconds between 60 and 86400),
  health_ttl_seconds       integer not null default 180 check (health_ttl_seconds between 30 and 3600),
  updated_at               timestamptz not null default now(),
  -- Sortedness, spelled out. The obvious `= (select array_agg(b order by b) from unnest(...))` is a cleaner
  -- thing to write and Postgres refuses to prepare it: a CHECK constraint may not contain a subquery. Naming
  -- the ten comparisons is what survives `create table`, and the length CHECK above means the indices are all
  -- in range, so a null cannot hide in the gaps.
  constraint observability_config_buckets_sorted check (
       latency_buckets_ms[1] <  latency_buckets_ms[2]
   and latency_buckets_ms[2] <  latency_buckets_ms[3]
   and latency_buckets_ms[3] <  latency_buckets_ms[4]
   and latency_buckets_ms[4] <  latency_buckets_ms[5]
   and latency_buckets_ms[5] <  latency_buckets_ms[6]
   and latency_buckets_ms[6] <  latency_buckets_ms[7]
   and latency_buckets_ms[7] <  latency_buckets_ms[8]
   and latency_buckets_ms[8] <  latency_buckets_ms[9]
   and latency_buckets_ms[9] <  latency_buckets_ms[10]
  )
);

comment on column public.observability_config.audit_retention_days is
  '0 means forever, and it is the default on purpose: the audit trail is evidence, and an evidence store whose retention is a tunable number is not evidence. A non-zero value here changes nothing on its own — there is deliberately no function in this file that deletes from activity_logs, so pruning it is a reviewed migration, not a config edit.';

insert into public.observability_config (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 2 · the rollup table
-- ----------------------------------------------------------------------------

-- One row per (aligned bucket, granularity, subsystem, metric, route, dimension). `unique (…)` is what
-- makes the write an upsert rather than an append, and it is the reason a replayed flush from a Worker
-- that died mid-request costs nothing: the same counter arrives twice and the answer is the same.
create table if not exists public.metric_rollups (
  id            bigint generated always as identity primary key,
  bucket        timestamptz not null,
  granularity   text not null default 'minute' check (granularity in ('minute', 'hour')),
  subsystem     text not null check (subsystem in ('api', 'live', 'notifications', 'advertising', 'media', 'storage', 'queue', 'system')),
  metric        text not null,
  route         text not null default '*',
  dimension     text not null default '',
  samples       bigint not null default 0 check (samples >= 0),
  errors        bigint not null default 0 check (errors >= 0),
  sum_ms        numeric(18,3) not null default 0 check (sum_ms >= 0),
  min_ms        numeric(12,3) check (min_ms is null or min_ms >= 0),
  max_ms        numeric(12,3) check (max_ms is null or max_ms >= 0),
  histogram     bigint[] not null default array[0,0,0,0,0,0,0,0,0,0,0],
  value_sum     numeric(18,3) not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint metric_rollups_errors_within_samples check (errors <= samples),
  -- No "a row with samples must have latency" constraint, and the reason is worth keeping in words: half of
  -- what is counted here is a gauge (open sockets, queue depth) that has no duration at all, and a CHECK that
  -- is only discovered at insert time in a `security definer` function arrives as a 502 instead of a field
  -- error. `sum_ms >= 0` on the column is the whole of what can be said about it generically.
  constraint metric_rollups_histogram_shape check (histogram is not null and array_length(histogram, 1) = 11),
  -- Ten element tests rather than `not exists (select 1 from unnest(histogram) …)`, because a CHECK constraint
  -- may not contain a subquery at all: the `unnest` version reads better and fails at `create table`. The
  -- length constraint above is what makes the indices safe to name.
  constraint metric_rollups_histogram_nonneg check (
        histogram[1] >= 0 and histogram[2] >= 0 and histogram[3] >= 0 and histogram[4] >= 0 and histogram[5] >= 0
    and histogram[6] >= 0 and histogram[7] >= 0 and histogram[8] >= 0 and histogram[9] >= 0 and histogram[10] >= 0
    and histogram[11] >= 0
  ),
  constraint metric_rollups_bucket_aligned check (
    bucket = case when granularity = 'hour' then date_trunc('hour', bucket) else date_trunc('minute', bucket) end
  ),
  constraint metric_rollups_one_dimension_per_row check (dimension is not null),
  constraint metric_rollups_unique unique (bucket, granularity, subsystem, metric, route, dimension)
);

create index if not exists metric_rollups_window_idx on public.metric_rollups (subsystem, metric, bucket);
create index if not exists metric_rollups_route_idx  on public.metric_rollups (route, bucket);
create index if not exists metric_rollups_bucket_idx  on public.metric_rollups (bucket);

comment on table public.metric_rollups is
  'Operational metrics, fixed-interval rollups only. Retention: observability_config.rollup_retention_days (14 by default), pruned by kicklive_metrics_purge. Contains no identity data: the columns are a bucket, a subsystem, a metric name, a route pattern, a label, and counts.';

-- Day granularity, computed rather than trusted: `kicklive_metrics_rollup_daily` aggregates the minute rows
-- into this, and the admin charts read this for any window longer than a day, so a 400-day chart costs one
-- indexed scan instead of 576 000 minute rows.
create table if not exists public.metric_daily (
  day         date not null,
  subsystem   text not null,
  metric      text not null,
  route       text not null default '*',
  dimension   text not null default '',
  samples     bigint not null default 0,
  errors      bigint not null default 0,
  sum_ms      numeric(18,3) not null default 0,
  min_ms      numeric(12,3),
  max_ms      numeric(12,3),
  histogram   bigint[] not null default array[0,0,0,0,0,0,0,0,0,0,0],
  value_sum   numeric(18,3) not null default 0,
  source_rows integer not null default 1 check (source_rows >= 1),
  updated_at  timestamptz not null default now(),
  primary key (day, subsystem, metric, route, dimension),
  constraint metric_daily_histogram_shape check (array_length(histogram, 1) = 11),
  constraint metric_daily_errors_within_samples check (errors <= samples)
);

comment on table public.metric_daily is
  'Analytics: the day-level view of metric_rollups. Retention: observability_config.daily_retention_days (400). Written only by kicklive_metrics_rollup_daily, which is idempotent, so re-running a day is a recompute rather than a double count. source_rows counts the minute buckets that fed the row, so a day that was half-telemetry reads as half-telemetry instead of looking like a quiet day.';

-- ----------------------------------------------------------------------------
-- 3 · health
-- ----------------------------------------------------------------------------

-- The last observed state of each dependency, written by the Worker's scheduled pass. `GET /health` answers
-- from here rather than probing on request: a health endpoint that fans hit becomes a load generator, and
-- the second it does that it stops measuring what it claims to.
create table if not exists public.system_health (
  component            text primary key check (component in ('worker', 'supabase', 'durable_objects', 'queues', 'fcm', 'r2', 'metrics', 'cron', 'database_size')),
  status               text not null check (status in ('ok', 'degraded', 'unavailable', 'unknown')),
  reason               text,
  detail               jsonb not null default '{}'::jsonb,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  checked_at           timestamptz not null default now(),
  constraint system_health_detail_object check (jsonb_typeof(detail) = 'object'),
  -- A reason is a code the Worker chose, not a message it pasted: the CHECK keeps it shaped like one, so a
  -- future edit that starts writing `err.message` in here fails at insert instead of shipping prose to a
  -- public endpoint.
  constraint system_health_reason_shape check (reason is null or reason ~ '^[A-Z][A-Z0-9_]{2,47}$')
);

comment on table public.system_health is
  'High-level dependency status, one row per component. The public read (kicklive_health_read) exposes component, status and age and nothing else; detail and reason are admin-only.';

insert into public.system_health (component, status)
values ('worker','unknown'), ('supabase','unknown'), ('durable_objects','unknown'), ('queues','unknown'),
       ('fcm','unknown'), ('r2','unknown'), ('metrics','unknown'), ('cron','unknown'), ('database_size','unknown')
on conflict (component) do nothing;

-- ----------------------------------------------------------------------------
-- 4 · bucket and histogram helpers
-- ----------------------------------------------------------------------------

create or replace function public.kicklive_observability_bucket(p_at timestamptz, p_granularity text)
returns timestamptz
language sql immutable
set search_path = public, pg_temp
as $fn$
  select date_trunc(case when p_granularity = 'hour' then 'hour' else 'minute' end, p_at)
$fn$;

-- Which histogram bucket a duration falls in, 1-based, with 11 reserved for "above the last edge".
create or replace function public.kicklive_observability_histogram_index(p_ms numeric)
returns integer
language plpgsql stable
set search_path = public, pg_temp
as $fn$
declare
  v_buckets integer[];
  i integer;
begin
  select c.latency_buckets_ms into v_buckets from public.observability_config c where c.id = 1;
  if p_ms is null then
    return null;
  end if;
  for i in 1 .. coalesce(array_length(v_buckets, 1), 0) loop
    if p_ms <= v_buckets[i] then
      return i;
    end if;
  end loop;
  return array_length(v_buckets, 1) + 1;
end
$fn$;

-- The upper bound of a bucket index, used for percentiles. `null` means "the open-ended top bucket", and a
-- caller that reports that percentile as a number has to say so honestly, which is why this returns null
-- rather than the largest edge.
create or replace function public.kicklive_observability_bound(p_index integer)
returns numeric
language plpgsql stable
set search_path = public, pg_temp
as $fn$
declare
  v_buckets integer[];
begin
  select c.latency_buckets_ms into v_buckets from public.observability_config c where c.id = 1;
  if p_index is null or p_index < 1 then
    return null;
  end if;
  if p_index > coalesce(array_length(v_buckets, 1), 0) then
    return null;
  end if;
  return v_buckets[p_index]::numeric;
end
$fn$;

-- Percentile from a summed histogram, by walking to the first bucket whose cumulative count reaches the
-- rank. This returns a bucket *bound*: a P95 of 250 means "95% of requests were at or under 250ms", and it
-- never claims 231ms, which is the fabricated precision an interpolated percentile would invent out of a
-- counter that does not know the individual values. §10 of the architecture note records that trade-off.
create or replace function public.kicklive_observability_percentile_index(p_histogram bigint[], p_quantile numeric)
returns integer
language plpgsql stable
set search_path = public, pg_temp
as $fn$
declare
  v_length integer := coalesce(array_length(p_histogram, 1), 0);
  v_total  numeric := 0;
  v_cum    numeric := 0;
  v_target numeric;
  v_index  integer := null;
  i        integer;
begin
  if v_length = 0 then
    return null;
  end if;
  for i in 1 .. v_length loop
    v_total := v_total + coalesce(p_histogram[i], 0);
  end loop;
  if v_total <= 0 then
    return null;
  end if;
  -- Nearest-rank, clamped into (0,1]: with 20 samples and p95 the answer is the 19th, not an
  -- extrapolation, and an empty window answers null rather than 0ms, because "0ms" on a chart is a claim
  -- that something was fast when in fact nothing happened.
  v_target := ceil(v_total * least(greatest(coalesce(p_quantile, 0.95), 0.0001), 1));
  for i in 1 .. v_length loop
    v_cum := v_cum + coalesce(p_histogram[i], 0);
    if v_cum >= v_target then
      v_index := i;
      exit;
    end if;
  end loop;
  return v_index;
end
$fn$;

create or replace function public.kicklive_observability_percentile(p_histogram bigint[], p_quantile numeric)
returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $fn$
declare
  v_index integer;
  v_bound numeric;
begin
  v_index := public.kicklive_observability_percentile_index(p_histogram, p_quantile);
  if v_index is null then
    return jsonb_build_object('samples', 0);
  end if;
  v_bound := public.kicklive_observability_bound(v_index);
  return jsonb_build_object(
    'boundMs', v_bound,
    'bucket', v_index,
    -- `open` is the honest half of the answer: the sample exceeded every configured edge, so there is no
    -- upper bound to report and a chart that shows 5000ms here would be inventing a ceiling.
    'open', v_bound is null
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 5 · the writer
-- ----------------------------------------------------------------------------

-- The only door into the rollups, and it is deliberately not grantable to a client role: the samples are
-- measurements the *Worker* made, and letting a browser report its own latency would turn the dashboard into
-- a wish. Batch semantics matter here: a bad sample is reported in `refused` and skipped rather than
-- failing the flush, because telemetry that can break a request is a worse instrument than telemetry that
-- drops a point and says so.
create or replace function public.kicklive_metrics_record(p_samples jsonb, p_at timestamptz default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_now       timestamptz := coalesce(p_at, now());
  v_config    public.observability_config;
  v_hist      bigint[];
  v_list      jsonb;
  v_entry     jsonb;
  v_samples   bigint;
  v_errors    bigint;
  v_ms        numeric;
  v_value     numeric;
  v_subsystem text;
  v_metric    text;
  v_route     text;
  v_dimension text;
  v_gran      text;
  v_bucket    timestamptz;
  v_index     integer;
  v_refused   jsonb := '[]'::jsonb;
  v_rows      integer := 0;
  i           integer;
begin
  select * into v_config from public.observability_config where id = 1;
  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'SAMPLES_MUST_BE_ARRAY');
  end if;
  v_list := p_samples;
  if jsonb_array_length(v_list) > v_config.max_samples_per_call then
    -- A refusal rather than a truncation: a caller whose buffer is bigger than the batch cap has a bug in
    -- its flush cadence, and silently writing the first N samples would hide exactly the burst that bug
    -- causes.
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'BATCH_TOO_LARGE',
                              'detail', jsonb_build_object('sent', jsonb_array_length(v_list), 'cap', v_config.max_samples_per_call));
  end if;

  for i in 0 .. jsonb_array_length(v_list) - 1 loop
    v_entry := v_list -> i;
    if jsonb_typeof(v_entry) <> 'object' then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'ENTRY_NOT_OBJECT'), true);
      continue;
    end if;
    v_subsystem := nullif(btrim(coalesce(v_entry ->> 'subsystem', '')), '');
    v_metric    := nullif(btrim(coalesce(v_entry ->> 'metric', '')), '');
    v_route     := coalesce(nullif(btrim(coalesce(v_entry ->> 'route', '')), ''), '*');
    v_dimension := coalesce(nullif(btrim(coalesce(v_entry ->> 'dimension', '')), ''), '');
    v_gran      := case when coalesce(v_entry ->> 'granularity', 'minute') = 'hour' then 'hour' else 'minute' end;
    v_samples   := greatest(0, coalesce(public.kicklive_observability_bigint(v_entry ->> 'samples'), 1));
    v_errors    := greatest(0, coalesce(public.kicklive_observability_bigint(v_entry ->> 'errors'), 0));
    v_ms        := public.kicklive_observability_ms(public.kicklive_observability_number(v_entry ->> 'durationMs'));
    v_value     := coalesce(public.kicklive_observability_number(v_entry ->> 'value'), 0);

    if v_samples < v_errors then
      -- A caller that counted 3 errors out of 2 requests has an off-by-one in its accumulator, and this is
      -- the one place that can see it. Clamp rather than refuse: the count of requests is the more useful
      -- half of a broken pair.
      v_samples := v_errors;
    end if;

    if v_subsystem is null or v_metric is null then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'SUBSYSTEM_AND_METRIC_REQUIRED'), true);
      continue;
    end if;
    if v_subsystem not in ('api', 'live', 'notifications', 'advertising', 'media', 'storage', 'queue', 'system') then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'UNKNOWN_SUBSYSTEM', 'subsystem', v_subsystem), true);
      continue;
    end if;
    if not public.kicklive_observability_metric_ok(v_metric) then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'MALFORMED_METRIC', 'metric', v_metric), true);
      continue;
    end if;
    if not public.kicklive_observability_route_ok(v_route) then
      -- Almost always `matches/47` where `/matches/:matchId` was meant. The refusal names the value because
      -- the fix is in the caller's source, not in the data.
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'ROUTE_MUST_BE_PATTERN', 'route', v_route), true);
      continue;
    end if;
    if not public.kicklive_observability_dimension_ok(v_dimension) then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'MALFORMED_DIMENSION', 'dimension', v_dimension), true);
      continue;
    end if;
    if public.kicklive_observability_refuses(v_metric) is not null
       or public.kicklive_observability_refuses(v_dimension) is not null
       or public.kicklive_observability_refuses(v_route) is not null then
      v_refused := jsonb_set(v_refused, array[i::text], jsonb_build_object('reason', 'SECRET_SHAPE_REFUSED'), true);
      continue;
    end if;

    v_bucket := public.kicklive_observability_bucket(v_now, v_gran);
    v_index  := public.kicklive_observability_histogram_index(v_ms);
    -- Built as a local array rather than in the insert's value list: `histogram[11]` is the open bucket, and
    -- an assignment reads as what it is, where a `generate_series` subquery in a VALUES clause is the kind of
    -- clever that a reviewer has to think about at 3 a.m.
    v_hist := array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[];
    if v_index is not null then
      v_hist[v_index] := 1;
    end if;

    insert into public.metric_rollups as m (
      bucket, granularity, subsystem, metric, route, dimension,
      samples, errors, sum_ms, min_ms, max_ms, histogram, value_sum, first_seen_at, last_seen_at
    )
    values (
      v_bucket, v_gran, v_subsystem, v_metric, v_route, v_dimension,
      v_samples, v_errors, coalesce(v_ms, 0), v_ms, v_ms,
      v_hist,
      v_value, now(), now()
    )
    on conflict (bucket, granularity, subsystem, metric, route, dimension) do update
      set samples   = m.samples + excluded.samples,
          errors    = m.errors + excluded.errors,
          sum_ms    = m.sum_ms + excluded.sum_ms,
          min_ms    = least(coalesce(m.min_ms, excluded.min_ms), excluded.min_ms),
          max_ms    = greatest(coalesce(m.max_ms, excluded.max_ms), excluded.max_ms),
          histogram = array[
            m.histogram[1] + excluded.histogram[1],   m.histogram[2] + excluded.histogram[2],
            m.histogram[3] + excluded.histogram[3],   m.histogram[4] + excluded.histogram[4],
            m.histogram[5] + excluded.histogram[5],   m.histogram[6] + excluded.histogram[6],
            m.histogram[7] + excluded.histogram[7],   m.histogram[8] + excluded.histogram[8],
            m.histogram[9] + excluded.histogram[9],   m.histogram[10] + excluded.histogram[10],
            m.histogram[11] + excluded.histogram[11]
          ],
          value_sum    = m.value_sum + excluded.value_sum,
          last_seen_at = now();
    v_rows := v_rows + 1;
  end loop;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'refused', v_refused,
                            'bucket', to_char(v_bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end
$fn$;

-- Health is written the same way: one function, service-role only, and the detail is validated rather than
-- trusted. `reason` is a code by CHECK, `detail` is a flat object of primitives, and the redactor runs on
-- both — so the component status a fan can see cannot become a place to write prose.
create or replace function public.kicklive_health_write(
  p_component text,
  p_status text,
  p_reason text default null,
  p_detail jsonb default '{}'::jsonb,
  p_success boolean default true
)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_detail jsonb := coalesce(nullif(p_detail, 'null'::jsonb), '{}'::jsonb);
  v_failures integer;
begin
  if p_component is null or p_component not in ('worker','supabase','durable_objects','queues','fcm','r2','metrics','cron','database_size') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'UNKNOWN_COMPONENT', 'component', p_component);
  end if;
  if p_status is null or p_status not in ('ok','degraded','unavailable','unknown') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'UNKNOWN_STATUS', 'status', p_status);
  end if;
  if jsonb_typeof(v_detail) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'DETAIL_MUST_BE_OBJECT');
  end if;
  -- Flat, primitive, short, and never a value that looks like a credential. `latency_ms` and `age_seconds`
  -- are the only numbers anyone is asked for, so anything else that shows up is a caller changing the
  -- contract without saying so in a migration.
  if exists (
    select 1
      from jsonb_each(v_detail) e(key, value)
     where length(e.key) > 32
        or jsonb_typeof(e.value) not in ('string','number','boolean','null')
        or (jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') > 96)
  ) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'DETAIL_NOT_FLAT');
  end if;
  if public.kicklive_observability_refuses(p_reason) is not null
     or public.kicklive_observability_document_refuses(v_detail) is not null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'SECRET_SHAPE_REFUSED');
  end if;

  select consecutive_failures into v_failures from public.system_health where component = p_component;
  v_failures := coalesce(v_failures, 0);
  update public.system_health
     set status = p_status,
         reason = case when p_reason ~ '^[A-Z][A-Z0-9_]{2,47}$' then upper(p_reason) else null end,
         detail = v_detail,
         consecutive_failures = case when p_success then 0 else v_failures + 1 end,
         checked_at = now()
   where component = p_component;

  return jsonb_build_object('ok', true, 'component', p_component, 'status', p_status,
                            'consecutiveFailures', case when p_success then 0 else v_failures + 1 end);
end
$fn$;

-- The three components SQL can measure better than the Worker can guess.
--
-- `queues`, `metrics` and `database_size` are all facts about rows, and a Worker that reports them would be
-- reporting what it last *tried* rather than what the database knows: a queue with no producer traffic looks
-- healthy from the outside and is stuck from the inside. So this function is what the cron calls, and the
-- Worker only writes the components it is the sole witness to (its own boot, R2, FCM, the DO heartbeat).
--
-- `durable_objects` is deliberately included here as the *staleness* half: a room that is alive renews the
-- row from its own alarm, and this function is what turns "nothing has renewed it in an hour" into
-- `unknown` rather than letting a stale `ok` sit there forever, which is the failure mode every heartbeat
-- design has if nobody writes the expiry down.
create or replace function public.kicklive_health_recompute_derived()
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_stuck integer := 0;
  v_pending integer := 0;
  v_lag integer;
  v_age integer;
  v_size bigint;
  v_ttl integer;
  c public.observability_config;
  v_updated integer := 0;
begin
  select * into c from public.observability_config where id = 1;

  -- Queue pressure, read off the jobs table rather than the transport: a job whose `next_attempt_at` is in
  -- the past by minutes is the definition of a backlog, and it is the same number a human would ask for.
  select count(1) into v_pending from public.notification_jobs j where j.status in ('queued', 'in_progress');
  select count(1) into v_stuck from public.notification_jobs j
    where j.status in ('queued', 'in_progress') and j.next_attempt_at < now() - interval '5 minutes';
  select round(coalesce(max(extract(epoch from (now() - j.next_attempt_at))), 0))::integer into v_lag
    from public.notification_jobs j where j.status in ('queued', 'in_progress');
  v_lag := greatest(coalesce(v_lag, 0), 0);

  if v_stuck > 20 then
    perform public.kicklive_health_write('queues', 'unavailable', 'QUEUE_BACKLOG',
      jsonb_build_object('pending', v_pending, 'stuck', v_stuck, 'lagSeconds', v_lag), false);
  elsif v_stuck > 0 then
    perform public.kicklive_health_write('queues', 'degraded', 'QUEUE_DELAYED',
      jsonb_build_object('pending', v_pending, 'stuck', v_stuck, 'lagSeconds', v_lag), true);
  else
    perform public.kicklive_health_write('queues', 'ok', null,
      jsonb_build_object('pending', v_pending, 'lagSeconds', v_lag), true);
  end if;
  v_updated := v_updated + 1;

  select round(extract(epoch from (now() - max(r.bucket))))::integer into v_age from public.metric_rollups r;
  v_ttl := coalesce(c.staleness_alert_seconds, 900);
  if v_age is null then
    perform public.kicklive_health_write('metrics', 'unknown', 'TELEMETRY_EMPTY', '{}'::jsonb, false);
  elsif v_age > v_ttl then
    perform public.kicklive_health_write('metrics', 'degraded', 'TELEMETRY_STALE',
      jsonb_build_object('ageSeconds', v_age, 'thresholdSeconds', v_ttl), false);
  else
    perform public.kicklive_health_write('metrics', 'ok', null, jsonb_build_object('ageSeconds', v_age), true);
  end if;
  v_updated := v_updated + 1;

  -- A size figure with no threshold would be a number on a page, so the threshold is a constant written down
  -- where a reviewer can disagree with it. 8 GiB is where a Supabase project starts needing an attention
  -- conversation, and `degraded` here means "look at the retention", never "refuse a write".
  v_size := pg_database_size(current_database());
  if v_size > 8589934592 then
    perform public.kicklive_health_write('database_size', 'degraded', 'DATABASE_LARGE',
      jsonb_build_object('bytes', v_size), false);
  else
    perform public.kicklive_health_write('database_size', 'ok', null, jsonb_build_object('bytes', v_size), true);
  end if;
  v_updated := v_updated + 1;

  select coalesce(min(health_ttl_seconds), 180) into v_ttl from public.observability_config where id = 1;
  if exists (select 1 from public.system_health h
              where h.component = 'durable_objects'
                and (h.checked_at is null or h.checked_at < now() - make_interval(secs => v_ttl * 20))) then
    perform public.kicklive_health_write('durable_objects', 'unknown', 'NO_ROOM_HEARTBEAT', '{}'::jsonb, false);
    v_updated := v_updated + 1;
  end if;

  return jsonb_build_object('ok', true, 'componentsUpdated', v_updated,
                            'queue', jsonb_build_object('pending', v_pending, 'stuck', v_stuck, 'lagSeconds', v_lag),
                            'metricsAgeSeconds', v_age, 'databaseBytes', v_size);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6 · the catalogue
-- ----------------------------------------------------------------------------

-- Every (subsystem, metric) pair the Worker is allowed to report, and what it is for. This exists so that
-- "what do we measure?" has one answer in the repository, and so `scripts/sql-flow.mjs` and
-- `tests/unit/phase9-observability.test.ts` can both check the Worker against it — the first by writing
-- samples for each name and reading them back, the second by scanning the source for a name that is not
-- here. A metric nobody documented is a metric nobody will be able to interpret at 3 a.m.
--
-- The rule the Worker follows and this table mirrors: a metric is a *count of things that happened*, with an
-- optional duration, and its `dimension` is always a closed vocabulary (a status class, an outcome, a cache
-- class, a reason code). Nothing here is keyed by match, by team, by user or by device — a per-entity
-- dimension would make this table grow with the population rather than with the surface area, and it would
-- turn operational metrics into a record of who did what.
create or replace function public.kicklive_observability_catalogue()
returns table (subsystem text, metric text, dimensions text, purpose text)
language sql stable
set search_path = public, pg_temp
as $fn$
  select * from (values
    ('api',           'requests',        '2xx|3xx|4xx|5xx',            'one row per request, counted at the edge; the histogram carries the latency'),
    ('api',           'errors',          'AUTHENTICATION_ERROR|AUTHORIZATION_ERROR|VALIDATION_ERROR|DATABASE_ERROR|R2_ERROR|QUEUE_ERROR|FCM_ERROR|WEBSOCKET_ERROR|NOT_FOUND_ERROR|INTERNAL_ERROR|RATE_LIMITED', 'the standardized category, never a stack trace'),
    ('api',           'cache',           'hit|miss|bypass|stale|revalid', 'how the read classes behaved, including 304 answers'),
    ('api',           'rate_limited',    'public|authenticated|mutation|auth-exchange|admin-blast', 'budget class of the refused request'),
    ('api',           'payload',         's_lt_1kb|s_1_10kb|s_10_100kb|s_gt_100kb|rejected', 'response size, bucketed; `rejected` is a body refused before it was parsed — never a byte count of a request somebody made'),
    ('live',          'connections',     'room',                        'open sockets per room, as a gauge sample (value = connections)'),
    ('live',          'reconnects',      'resume|snapshot',             'a socket coming back, and whether it recovered by sequence or had to take a snapshot'),
    ('live',          'event_failures',  'DATABASE_ERROR|WEBSOCKET_ERROR|VALIDATION_ERROR|INTERNAL_ERROR', 'an event that did not land, by category'),
    ('live',          'snapshots',       'push|poll',                   'snapshot frames issued, split by who asked'),
    ('live',          'rejected',        'SEQUENCE_GAP|UNAUTHORISED|MATCH_LOCKED|RATE_LIMITED', 'frames the room refused to apply'),
    ('live',          'lag',             'write_tail',                  'seconds a mutation waited behind the per-match write tail'),
    ('notifications', 'jobs',            'sent|partial|failed|retry|not_claimable', 'one sample per job the consumer finished, by the status it finished as'),
    ('notifications', 'attempts',        'first|retry',                 'delivery attempts, so a retry storm is visible as a rate'),
    ('notifications', 'deliveries',      'delivered|invalid_token|failure|throttled', 'per-device outcomes, counted in the consumer'),
    ('notifications', 'queue',           'published|refused|dlq',       'what the queue itself did, including the dead-letter path'),
    ('notifications', 'devices',         'registered|pruned|invalidated', 'token table movement; never a token value'),
    ('advertising',   'served',          'ok|no_fill|all_paused|slot_off|expired', 'what serve decided, per request'),
    ('advertising',   'events',          'impression|click',            'how many events the ingestion path accepted, not which ones'),
    ('advertising',   'ingest',          'queued|written|refused',      'the queue-to-table path, so a backlog is visible before the count is wrong'),
    ('media',         'uploads',         'ok|refused|failed|superseded', 'per publish, by outcome'),
    ('media',         'sweep',           'expired|deleted|error',        'the retention job, so a sweep that stops running is noticed'),
    ('media',         'bucket',          'get|put|head|delete|error',   'object operations, counted without keys'),
    ('queue',         'depth',           'notifications|ad-events|dlq', 'messages handed to a consumer and how long the batch took, per queue — the only view of a consumer that has quietly stopped draining'),
    ('system',        'health',          'worker|supabase|durable_objects|queues|fcm|r2|metrics|cron|database_size', 'a component reported non-ok, counted so a flap shows up as a rate'),
    ('system',        'cron',            'notification-sweep|media-sweep|observability|ad-maintenance', 'a scheduled pass, and whether it threw'),
    ('system',        'metrics',         'dropped|overflow|flush_failed', 'what the telemetry itself could not keep — the meta-metric that makes the rest trustworthy')
  ) as c(subsystem, metric, dimensions, purpose)
$fn$;

-- Whether a (subsystem, metric) pair is in the catalogue. `kicklive_metrics_record` does **not** refuse an
-- unlisted name — losing a measurement because a constant was added on one side is the worse failure — but
-- `kicklive_observability_diagnostics` reports the ones seen in the last day, which is how a new metric
-- becomes a review item instead of an anonymous row.
create or replace function public.kicklive_observability_metric_known(p_subsystem text, p_metric text)
returns boolean
language sql stable
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.kicklive_observability_catalogue() c
     where c.subsystem = p_subsystem and c.metric = p_metric
  )
$fn$;

-- ----------------------------------------------------------------------------
-- 7 · the audit trail: harden what exists, add the door
-- ----------------------------------------------------------------------------

-- `activity_logs` predates every phase in this directory: the baseline schema created it, Phase 1 stopped
-- any signed-in user from writing a row attributed to somebody else, and Phase 3 writes it for every
-- privileged match action. What Phase 1 left open is the other half of the problem. Its admin policy was
-- `for all`, which on an audit table means *an admin can rewrite or delete the record of what an admin did*.
-- Evidence that the subject of the investigation can edit is not evidence.
--
-- So: the admin policy becomes select-only, insert keeps Phase 1's own-subject rule, and a trigger refuses
-- update and delete even for the table owner — with one exception, spelled out below, because the foreign key
-- from `user_id` to `profiles` is `on delete set null` and deleting an account therefore *must* be allowed to
-- touch this table. Naming that exception is the whole point: an unconditional immutability trigger would
-- have broken account deletion, which is a real feature, and an exception nobody wrote down would be a hole.
drop policy if exists "activity_logs: admin all" on public.activity_logs;
drop policy if exists "activity_logs: admin select" on public.activity_logs;
create policy "activity_logs: admin select"
  on public.activity_logs for select to authenticated
  using (public.is_admin());

create or replace function public.kicklive_audit_guard_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'activity_logs is append-only: a delete would be a cover-up'
      using errcode = '42501';
  end if;
  if to_jsonb(new) - 'user_id' is distinct from to_jsonb(old) - 'user_id' then
    raise exception 'activity_logs is append-only: correct an entry by writing a new one that cites it'
      using errcode = '42501';
  end if;
  if new.user_id is not null then
    raise exception 'the only permitted update to activity_logs is clearing user_id, which the on-delete-set-null foreign key does'
      using errcode = '42501';
  end if;
  return new;
end
$fn$;

drop trigger if exists activity_logs_append_only on public.activity_logs;
create trigger activity_logs_append_only
  before update or delete on public.activity_logs
  for each row execute function public.kicklive_audit_guard_immutable();

-- The one writer the Worker uses. Shaped like the rows Phase 3 already writes, so the existing admin feed
-- (which joins `profiles(username)` and reads `action`/`entity_type`/`details`) needs no migration, and
-- `details` always carries `via` plus the request id when there is one — the correlation is not optional,
-- which is why it is built here rather than passed in.
--
-- `p_actor_id` is only consulted when the call carries no user subject of its own (a cron, a queue
-- consumer). For a call made with an admin's token, `auth.uid()` wins, so a Worker bug cannot forge an actor
-- into the record: the same property Phase 1 established for the policy, now enforced by the only function
-- that writes the table.
create or replace function public.kicklive_audit_record(
  p_action text,
  p_entity_type text,
  p_entity_id integer default null,
  p_entity_name text default null,
  p_details jsonb default '{}'::jsonb,
  p_request_id text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_subject uuid := coalesce(auth.uid(), p_actor_id);
  v_details jsonb := coalesce(nullif(p_details, 'null'::jsonb), '{}'::jsonb);
  v_id bigint;
begin
  if p_action is null or p_action !~ '^[a-z][a-z0-9_.]{2,63}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'ACTION_MALFORMED', 'field', 'action');
  end if;
  if p_entity_type is null or p_entity_type !~ '^[a-z][a-z0-9_]{1,39}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'ENTITY_TYPE_MALFORMED', 'field', 'entityType');
  end if;
  if jsonb_typeof(v_details) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'DETAILS_MUST_BE_OBJECT');
  end if;
  if p_request_id is not null and p_request_id !~ '^[A-Za-z0-9._-]{8,64}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'REQUEST_ID_MALFORMED');
  end if;
  if public.kicklive_observability_refuses(p_entity_name) is not null
     or public.kicklive_observability_document_refuses(v_details) is not null then
    -- The audit trail is the one table where somebody reaches for the message of an error, and an error
    -- message can contain a token somebody pasted into a form. Refusing is correct: the caller is the Worker,
    -- and the Worker is supposed to send a code.
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'SECRET_SHAPE_REFUSED');
  end if;

  insert into public.activity_logs as a (user_id, action, entity_type, entity_id, entity_name, details)
  values (
    v_subject,
    p_action,
    p_entity_type,
    p_entity_id,
    left(nullif(btrim(coalesce(p_entity_name, '')), ''), 200),
    v_details || jsonb_build_object(
      'via', case when auth.uid() is null then 'worker-system' else 'worker' end,
      'actor_role', (select p.role from public.profiles p where p.id = v_subject),
      'request_id', nullif(p_request_id, '')
    )
  )
  returning a.id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'action', p_action, 'actor', v_subject);
end
$fn$;

-- The read, for the desk. Admin-only inside the function rather than by a policy, because the policy is
-- select-whole-table and an unbounded audit read is how a trail becomes a performance problem.
create or replace function public.kicklive_audit_list(
  p_action text default null,
  p_entity_type text default null,
  p_actor_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows jsonb;
  v_total bigint;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'LIMIT_OUT_OF_RANGE', 'detail', '1..200');
  end if;

  select count(1) into v_total
    from public.activity_logs a
   where (p_action is null or a.action = p_action or a.action like p_action || '.%')
     and (p_entity_type is null or a.entity_type = p_entity_type)
     and (p_actor_id is null or a.user_id = p_actor_id)
     and (p_from is null or a.created_at >= p_from)
     and (p_to is null or a.created_at < p_to);

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.occurred_at desc, x.id desc), '[]'::jsonb) into v_rows
    from (
      select a.id,
             a.created_at as occurred_at,
             a.action,
             a.entity_type,
             a.entity_id,
             a.entity_name,
             a.user_id as actor_id,
             pr.username as actor_username,
             coalesce(a.details - 'request_id', '{}'::jsonb) as details,
             a.details ->> 'request_id' as request_id
        from public.activity_logs a
        left join public.profiles pr on pr.id = a.user_id
       where (p_action is null or a.action = p_action or a.action like p_action || '.%')
         and (p_entity_type is null or a.entity_type = p_entity_type)
         and (p_actor_id is null or a.user_id = p_actor_id)
         and (p_from is null or a.created_at >= p_from)
         and (p_to is null or a.created_at < p_to)
       order by a.created_at desc, a.id desc
       limit p_limit offset greatest(coalesce(p_offset, 0), 0)
    ) x;

  return jsonb_build_object('ok', true, 'total', v_total, 'entries', v_rows,
                            'retention', 'audit rows are never pruned by this API');
end
$fn$;

-- ----------------------------------------------------------------------------
-- 8 · the reads
-- ----------------------------------------------------------------------------

-- The one aggregation primitive: elementwise histogram addition. Declared once as a real aggregate so every
-- read that needs a percentile asks the same question the same way, and so `metric_daily` and the summary
-- cannot disagree about how two histograms combine.
create or replace function public.kicklive_observability_hist_add(p_a bigint[], p_b bigint[])
returns bigint[]
language sql immutable
set search_path = public, pg_temp
as $fn$
  select array[
    coalesce(p_a[1], 0) + coalesce(p_b[1], 0),  coalesce(p_a[2], 0) + coalesce(p_b[2], 0),
    coalesce(p_a[3], 0) + coalesce(p_b[3], 0),  coalesce(p_a[4], 0) + coalesce(p_b[4], 0),
    coalesce(p_a[5], 0) + coalesce(p_b[5], 0),  coalesce(p_a[6], 0) + coalesce(p_b[6], 0),
    coalesce(p_a[7], 0) + coalesce(p_b[7], 0),  coalesce(p_a[8], 0) + coalesce(p_b[8], 0),
    coalesce(p_a[9], 0) + coalesce(p_b[9], 0),  coalesce(p_a[10], 0) + coalesce(p_b[10], 0),
    coalesce(p_a[11], 0) + coalesce(p_b[11], 0)
  ]
$fn$;

drop aggregate if exists public.kicklive_observability_histogram_sum(bigint[]);
create aggregate public.kicklive_observability_histogram_sum(bigint[]) (
  sfunc = public.kicklive_observability_hist_add,
  stype = bigint[],
  initcond = '{0,0,0,0,0,0,0,0,0,0,0}'
);

-- ----------------------------------------------------------------------------
-- 9 · the metric reads
-- ----------------------------------------------------------------------------

-- The dashboard read. One function, one query path, and a window limit that matches the retention the table
-- actually has: asking a 14-day rollup for a year is not slow, it is *wrong*, and a wrong dashboard is worse
-- than an error. The error names the function that can answer the question.
create or replace function public.kicklive_metrics_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_subsystem text default null,
  p_route text default null,
  p_metric text default null,
  p_limit integer default 40
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from   timestamptz := coalesce(p_from, now() - interval '1 hour');
  v_to     timestamptz := coalesce(p_to, now());
  v_limit  integer := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_trunc  text;
  v_days   numeric;
  v_hist   bigint[];
  v_total  bigint := 0;
  v_errors bigint := 0;
  v_sum_ms numeric := 0;
  v_max_ms numeric;
  v_latency jsonb;
  v_groups  jsonb;
  v_series  jsonb;
  v_cache   jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if v_to <= v_from then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'WINDOW_INVERTED');
  end if;
  v_days := extract(epoch from (v_to - v_from)) / 86400.0;
  if v_days > (select c.rollup_retention_days from public.observability_config c where c.id = 1) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'WINDOW_BEYOND_ROLLUP_RETENTION',
                              'detail', 'ask kicklive_metrics_daily for a window longer than the rollups are kept');
  end if;
  v_trunc := case when v_days > 7 then 'day' when v_days > 0.25 then 'hour' else 'minute' end;

  -- Latency and percentiles are computed only over rows that measured a duration. A gauge row (open sockets,
  -- queue depth) has no latency, and folding it into the mean would pull the number toward zero and make the
  -- P95 meaningless: the filter is part of the definition, not a detail.
  select coalesce(sum(r.samples), 0), coalesce(sum(r.errors), 0), coalesce(sum(r.sum_ms), 0), max(r.max_ms),
         public.kicklive_observability_histogram_sum(r.histogram)
    into v_total, v_errors, v_sum_ms, v_max_ms, v_hist
    from public.metric_rollups r
   where r.bucket >= v_from and r.bucket < v_to
     and r.sum_ms > 0
     and (p_subsystem is null or r.subsystem = p_subsystem)
     and (p_route is null or r.route = p_route)
     and (p_metric is null or r.metric = p_metric);

  select jsonb_build_object(
           'p50', (public.kicklive_observability_percentile(v_hist, 0.50) -> 'boundMs'),
           'p95', (public.kicklive_observability_percentile(v_hist, 0.95) -> 'boundMs'),
           'p99', (public.kicklive_observability_percentile(v_hist, 0.99) -> 'boundMs'),
           'p95AboveTopBucket', coalesce((public.kicklive_observability_percentile(v_hist, 0.95) ->> 'open')::boolean, false),
           'meanMs', case when v_total > 0 then round(v_sum_ms / v_total, 2) else null end,
           'maxMs', v_max_ms,
           'latencySamples', (select coalesce(sum(e.v), 0) from unnest(coalesce(v_hist, array[0,0,0,0,0,0,0,0,0,0,0])) e(v)),
           'bucketsMs', (select c.latency_buckets_ms from public.observability_config c where c.id = 1)
         )
    into v_latency;

  select coalesce(jsonb_agg(jsonb_build_object(
           'subsystem', g.subsystem,
           'metric', g.metric,
           'route', g.route,
           'samples', g.samples,
           'errors', g.errors,
           'errorRate', case when g.samples > 0 then round(g.errors::numeric / g.samples::numeric, 4) else 0 end,
           'meanMs', case when g.latency_samples > 0 then round(g.sum_ms / g.latency_samples, 2) else null end,
           'maxMs', g.max_ms,
           'value', round(g.value_sum, 3),
           'p95', (public.kicklive_observability_percentile(g.histogram, 0.95) -> 'boundMs'),
           'dimensions', g.dimensions
         ) order by g.samples desc, g.subsystem, g.metric), '[]'::jsonb)
    into v_groups
    from (
      select s.subsystem as subsystem,
             s.metric as metric,
             s.route as route,
             sum(s.samples) as samples,
             sum(s.errors) as errors,
             sum(s.sum_ms) as sum_ms,
             sum(case when s.sum_ms > 0 then s.samples else 0 end) as latency_samples,
             max(s.max_ms) as max_ms,
             sum(s.value_sum) as value_sum,
             public.kicklive_observability_histogram_sum(s.histogram) as histogram,
             jsonb_object_agg(s.dimension, s.samples order by s.dimension) as dimensions
        from (
          select r.subsystem as subsystem, r.metric as metric, r.route as route, r.dimension as dimension,
                 sum(r.samples) as samples, sum(r.errors) as errors, sum(r.sum_ms) as sum_ms,
                 max(r.max_ms) as max_ms, sum(r.value_sum) as value_sum,
                 public.kicklive_observability_histogram_sum(r.histogram) as histogram
            from public.metric_rollups r
           where r.bucket >= v_from and r.bucket < v_to
             and (p_subsystem is null or r.subsystem = p_subsystem)
             and (p_route is null or r.route = p_route)
             and (p_metric is null or r.metric = p_metric)
           group by 1, 2, 3, 4
        ) s
       group by 1, 2, 3
       limit v_limit
    ) g;

  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'samples', b.samples,
           'errors', b.errors,
           'meanMs', case when b.latency_samples > 0 then round(b.sum_ms / b.latency_samples, 2) else null end,
           'p95', (public.kicklive_observability_percentile(b.histogram, 0.95) -> 'boundMs')
         ) order by b.bucket), '[]'::jsonb)
    into v_series
    from (
      select public.kicklive_observability_bucket(r.bucket, v_trunc) as bucket,
             sum(r.samples) as samples,
             sum(r.errors) as errors,
             sum(r.sum_ms) as sum_ms,
             sum(case when r.sum_ms > 0 then r.samples else 0 end) as latency_samples,
             public.kicklive_observability_histogram_sum(r.histogram) as histogram
        from public.metric_rollups r
       where r.bucket >= v_from and r.bucket < v_to
         and (p_subsystem is null or r.subsystem = p_subsystem)
         and (p_route is null or r.route = p_route)
       group by 1
    ) b;

  select coalesce(jsonb_object_agg(c.dimension, c.n), '{}'::jsonb)
    into v_cache
    from (
      select r.dimension as dimension, sum(r.samples) as n
        from public.metric_rollups r
       where r.subsystem = 'api' and r.metric = 'cache'
         and r.bucket >= v_from and r.bucket < v_to
         and (p_route is null or r.route = p_route)
       group by 1
    ) c;

  return jsonb_build_object(
    'ok', true,
    'window', jsonb_build_object(
      'from', to_char(v_from, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'to', to_char(v_to, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'seconds', round(extract(epoch from (v_to - v_from)))::bigint,
      'granularity', v_trunc,
      'source', 'rollups'
    ),
    'totals', jsonb_build_object('samples', v_total, 'errors', v_errors,
      'errorRate', case when v_total > 0 then round(v_errors::numeric / v_total::numeric, 4) else 0 end),
    'latency', v_latency,
    'cache', coalesce(v_cache, '{}'::jsonb),
    'groups', coalesce(v_groups, '[]'::jsonb),
    'series', coalesce(v_series, '[]'::jsonb)
  );
end
$fn$;

-- The long-window read. Same shape as the above, one table down, so a "how did the season final go" chart is
-- answered by an indexed scan of ~400 rows per series rather than 576 000 minute ones.
create or replace function public.kicklive_metrics_daily(
  p_from date default null,
  p_to date default null,
  p_subsystem text default null,
  p_route text default null,
  p_limit integer default 60
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from date := coalesce(p_from, ((now() at time zone 'utc')::date - 29));
  v_to   date := coalesce(p_to, (now() at time zone 'utc')::date);
  v_rows jsonb;
  v_days integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if v_to < v_from then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'WINDOW_INVERTED');
  end if;
  v_days := (v_to - v_from) + 1;
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', to_char(d.day, 'YYYY-MM-DD'),
           'subsystem', d.subsystem,
           'metric', d.metric,
           'route', d.route,
           'samples', d.samples,
           'errors', d.errors,
           'errorRate', case when d.samples > 0 then round(d.errors::numeric / d.samples::numeric, 4) else 0 end,
           'meanMs', case when d.latency_samples > 0 then round(d.sum_ms / d.latency_samples, 2) else null end,
           'p95', (public.kicklive_observability_percentile(d.histogram, 0.95) -> 'boundMs'),
           'maxMs', d.max_ms,
           'value', round(d.value_sum, 3)
         ) order by d.day desc, d.samples desc), '[]'::jsonb)
    into v_rows
    from (
      select y.day as day, y.subsystem as subsystem, y.metric as metric, y.route as route,
             sum(y.samples) as samples, sum(y.errors) as errors, sum(y.sum_ms) as sum_ms,
             sum(case when y.sum_ms > 0 then y.samples else 0 end) as latency_samples,
             max(y.max_ms) as max_ms, sum(y.value_sum) as value_sum,
             public.kicklive_observability_histogram_sum(y.histogram) as histogram
        from public.metric_daily y
       where y.day >= v_from and y.day <= v_to
         and (p_subsystem is null or y.subsystem = p_subsystem)
         and (p_route is null or y.route = p_route)
       group by 1, 2, 3, 4
       order by y.day desc, sum(y.samples) desc
       limit least(greatest(coalesce(p_limit, 60), 1), 500)
    ) d;
  return jsonb_build_object('ok', true, 'rows', coalesce(v_rows, '[]'::jsonb),
                            'window', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_days));
end
$fn$;

create or replace function public.kicklive_metrics_top_routes(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 15
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '1 hour');
  v_to   timestamptz := coalesce(p_to, now());
  v_rows jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'route', r.route,
           'samples', r.samples,
           'errors', r.errors,
           'errorRate', case when r.samples > 0 then round(r.errors::numeric / r.samples::numeric, 4) else 0 end,
           'meanMs', case when r.sum_ms > 0 then round(r.sum_ms / r.samples, 2) else null end,
           'p95', (public.kicklive_observability_percentile(r.histogram, 0.95) -> 'boundMs'),
           'maxMs', r.max_ms
         ) order by r.samples desc), '[]'::jsonb)
    into v_rows
    from (
      select m.route as route, sum(m.samples) as samples, sum(m.errors) as errors, sum(m.sum_ms) as sum_ms,
             max(m.max_ms) as max_ms,
             public.kicklive_observability_histogram_sum(m.histogram) as histogram
        from public.metric_rollups m
       where m.subsystem = 'api' and m.metric = 'requests'
         and m.bucket >= v_from and m.bucket < v_to
       group by 1
       order by sum(m.samples) desc
       limit least(greatest(coalesce(p_limit, 15), 1), 100)
    ) r;
  return jsonb_build_object('ok', true, 'routes', v_rows,
                            'window', jsonb_build_object('from', v_from, 'to', v_to));
end
$fn$;

-- ----------------------------------------------------------------------------
-- 10 · the subsystem reads
-- ----------------------------------------------------------------------------

-- Live matches. `activeMatches` uses the engine's own vocabulary rather than inventing a fourth one: the
-- baseline's `live` and Phase 3's halves are both included, because a match in extra time with four thousand
-- sockets open is precisely what an operator wants counted. No socket, viewer or identity appears anywhere in
-- this response — the counts are per room, and the room list carries the match id and nothing about a fan.
create or replace function public.kicklive_live_match_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '1 hour');
  v_to   timestamptz := coalesce(p_to, now());
  v_rooms bigint := 0;
  v_peak  numeric := 0;
  v_live  jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;

  select count(1) into v_rooms from public.matches m
   where m.status in ('live', 'first_half', 'second_half', 'extra_time', 'half_time', 'suspended');

  select coalesce(jsonb_object_agg(l.metric, l.value), '{}'::jsonb) into v_live
    from (
      select r.metric || '.' || r.dimension as metric, sum(r.value_sum) as value
        from public.metric_rollups r
       where r.subsystem = 'live'
         and r.bucket >= v_from and r.bucket < v_to
       group by 1
    ) l;

  select coalesce(max(peak.n), 0) into v_peak
    from (
      select sum(r.value_sum) as n
        from public.metric_rollups r
       where r.subsystem = 'live' and r.metric = 'connections'
         and r.bucket >= v_from and r.bucket < v_to
       group by r.bucket
    ) peak;

  return jsonb_build_object(
    'ok', true,
    'activeMatches', v_rooms,
    'peakConnectionsPerMinute', round(v_peak, 0),
    'counters', coalesce(v_live, '{}'::jsonb),
    'window', jsonb_build_object('from', v_from, 'to', v_to),
    'rooms', coalesce((select jsonb_agg(x) from (
        select m.id as match_id, m.status as status, m.live_updated_at as live_updated_at,
               round(extract(epoch from (now() - m.live_updated_at)))::bigint as seconds_since_update
          from public.matches m
         where m.status in ('live', 'first_half', 'second_half', 'extra_time', 'half_time', 'suspended')
         order by m.live_updated_at desc nulls last
         limit 20
      ) x), '[]'::jsonb),
    'note', 'connections and snapshots are counted per room; no socket, viewer or identity is recorded here'
  );
end
$fn$;

-- Notifications: the queue's counters and the truth in the tables, side by side. A counter claiming 12 000
-- delivered next to a `notification_deliveries` count of 11 800 is the discrepancy an operator needs to see,
-- and it is only visible when both are on the same screen.
create or replace function public.kicklive_notification_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '1 hour');
  v_to   timestamptz := coalesce(p_to, now());
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  return jsonb_build_object(
    'ok', true,
    'window', jsonb_build_object('from', v_from, 'to', v_to),
    'counters', coalesce((select jsonb_object_agg(l.metric, l.value) from (
        select r.metric || '.' || r.dimension as metric, sum(r.value_sum) + sum(r.samples) as value
          from public.metric_rollups r
         where r.subsystem = 'notifications'
           and r.bucket >= v_from and r.bucket < v_to
         group by 1
      ) l), '{}'::jsonb),
    'jobs', coalesce((select jsonb_object_agg(j.status, j.n) from (
        select s.status as status, count(1) as n
          from public.notification_jobs s
         where s.created_at >= v_from and s.created_at < v_to
         group by 1
      ) j), '{}'::jsonb),
    'jobsPending', (select count(1) from public.notification_jobs s where s.status in ('queued', 'in_progress')),
    'jobsStuck', (select count(1) from public.notification_jobs s
                   where s.status in ('queued', 'in_progress')
                     and s.next_attempt_at < now() - interval '15 minutes'),
    'devices', jsonb_build_object(
      'active', (select count(1) from public.notification_devices d where d.active),
      'failing', (select count(1) from public.notification_devices d where d.active and d.failure_count > 0),
      'invalidatedLastDay', (select count(1) from public.notification_devices d
                              where not d.active and d.updated_at >= now() - interval '1 day'),
      'topErrorCode', (select x.code from (
          select coalesce(d.last_error_code, 'UNKNOWN') as code, count(1) as n
            from public.notification_devices d
           where d.active
           group by 1
           order by count(1) desc
           limit 1
        ) x)
    ),
    'deliveries', coalesce((select jsonb_object_agg(s.status, s.n) from (
        select d.status as status, count(1) as n
          from public.notification_deliveries d
         where d.created_at >= v_from and d.created_at < v_to
         group by 1
      ) s), '{}'::jsonb),
    'note', 'no token, device identifier or recipient appears in this response'
  );
end
$fn$;

-- Advertising: Phase 7's numbers, asked of Phase 7's function. Re-implementing impression counting here
-- would create a second number to reconcile, and the two would drift the first time either side changed its
-- dedupe key. What this adds on top is the *operational* rate — what serve decided, what ingestion accepted
-- — which is the part Phase 7 deliberately does not measure.
create or replace function public.kicklive_advertising_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '24 hours');
  v_to   timestamptz := coalesce(p_to, now());
  v_ad   jsonb;
  v_rows jsonb;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_OR_MEDIA_ONLY');
  end if;
  v_ad := public.kicklive_ad_analytics(
    (v_from at time zone 'utc')::date,
    (v_to at time zone 'utc')::date,
    null, null, null, 'campaign'
  );
  if jsonb_typeof(v_ad) = 'object' then
    v_rows := coalesce(v_ad -> 'rows', v_ad -> 'campaigns', v_ad -> 'groups', '[]'::jsonb);
  else
    v_rows := coalesce(v_ad, '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'ok', true,
    'measurement', v_rows,
    'measurementRaw', case when jsonb_typeof(v_ad) = 'object' then v_ad - 'rows' - 'campaigns' - 'groups' else '{}'::jsonb end,
    'operational', coalesce((select jsonb_object_agg(l.metric, l.value) from (
        select r.metric || '.' || r.dimension as metric, sum(r.samples) + sum(r.value_sum) as value
          from public.metric_rollups r
         where r.subsystem = 'advertising'
           and r.bucket >= v_from and r.bucket < v_to
         group by 1
      ) l), '{}'::jsonb),
    'window', jsonb_build_object('from', v_from, 'to', v_to),
    'note', 'impressions are distinct-viewer-day floors owned by Phase 7; the counts here are operational rates'
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 11 · health
-- ----------------------------------------------------------------------------

-- The public door. Component, status, and how old the observation is — nothing else. No latency, no counts,
-- no reasons, no versions: a caller with no credentials is told whether Kick Live thinks it is working, not
-- how it knows. The reason the answer comes from a table rather than from live probes is that fans hit
-- `/health` too, and a health endpoint that probes on request turns a monitoring page into a load test.
create or replace function public.kicklive_health_read()
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ttl integer := 180;
  v_overall text;
begin
  select coalesce(c.health_ttl_seconds, 180) into v_ttl from public.observability_config c where c.id = 1;

  select case
           when bool_or(h.status = 'unavailable') then 'unavailable'
           when bool_or(h.status = 'degraded') then 'degraded'
           when bool_or(h.checked_at < now() - make_interval(secs => v_ttl * 3)) then 'stale'
           when bool_or(h.status = 'unknown') then 'unknown'
           else 'ok'
         end
    into v_overall from public.system_health h;

  return jsonb_build_object(
    'status', coalesce(v_overall, 'unknown'),
    'observedAt', to_char((select max(h.checked_at) from public.system_health h), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'components', coalesce((select jsonb_agg(jsonb_build_object(
                       'component', h.component,
                       'status', h.status,
                       'ageSeconds', greatest(round(extract(epoch from (now() - h.checked_at)))::bigint, 0)
                     ) order by h.component) from public.system_health h), '[]'::jsonb)
  );
end
$fn$;

-- The staff door: the same rows with what is behind each status, plus whether the telemetry itself is
-- reporting. "everything is fine" and "nobody has written a sample in forty minutes" must not look alike,
-- and only this function can tell them apart.
create or replace function public.kicklive_health_read_admin()
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ttl integer := 180;
  v_last timestamptz;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select coalesce(c.health_ttl_seconds, 180) into v_ttl from public.observability_config c where c.id = 1;
  select max(r.bucket) into v_last from public.metric_rollups r;

  return jsonb_build_object(
    'ok', true,
    'ttlSeconds', v_ttl,
    'public', public.kicklive_health_read(),
    'components', coalesce((select jsonb_agg(jsonb_build_object(
                       'component', h.component,
                       'status', h.status,
                       'reason', h.reason,
                       'detail', h.detail,
                       'consecutiveFailures', h.consecutive_failures,
                       'checkedAt', to_char(h.checked_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'stale', h.checked_at < now() - make_interval(secs => v_ttl * 3)
                     ) order by h.component) from public.system_health h), '[]'::jsonb),
    'telemetry', jsonb_build_object(
      'lastBucket', to_char(v_last, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'ageSeconds', case when v_last is null then null else round(extract(epoch from (now() - v_last)))::bigint end,
      'reporting', v_last is not null and v_last > now() - make_interval(secs => v_ttl * 3)
    ),
    'alerts', coalesce(public.kicklive_observability_alerts() -> 'alerts', '[]'::jsonb)
  );
end
$fn$;

-- ----------------------------------------------------------------------------
-- 12 · alert readiness
-- ----------------------------------------------------------------------------

-- Thresholds against observations, evaluated on demand. There is no pager and no webhook in this file, and
-- that is the design: who gets told what is an operational decision outside the repository, while the part
-- that is easy to get wrong from the outside — a rule that fires on a single 500 at 3 a.m. — is enforced
-- here by requiring enough samples for the rate to mean something. `severity` is machine-usable so a poller
-- can act without parsing prose, and the message is built from codes and numbers for the same reason.
create or replace function public.kicklive_observability_alerts(p_window_seconds integer default 900)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_window integer := least(greatest(coalesce(p_window_seconds, 900), 60), 86400);
  v_from   timestamptz := now() - make_interval(secs => v_window);
  c        public.observability_config;
  a        jsonb := '[]'::jsonb;
  v_samples bigint := 0;
  v_errors  bigint := 0;
  v_p95     numeric;
  v_last    timestamptz;
  v_count   bigint := 0;
  v_live    bigint := 0;
  v_conns   numeric := 0;
begin
  select * into c from public.observability_config where id = 1;

  select coalesce(sum(r.samples), 0), coalesce(sum(r.errors), 0),
         (public.kicklive_observability_percentile(
            public.kicklive_observability_histogram_sum(r.histogram), 0.95) ->> 'boundMs')::numeric
    into v_samples, v_errors, v_p95
    from public.metric_rollups r
   where r.subsystem = 'api' and r.metric = 'requests' and r.bucket >= v_from;

  if v_samples >= 20 and v_errors::numeric / greatest(v_samples, 1) > c.error_rate_alert then
    a := a || jsonb_build_array(jsonb_build_object('code', 'API_ERROR_RATE', 'severity', 'critical', 'subsystem', 'api',
      'observed', round(v_errors::numeric / v_samples, 4), 'threshold', c.error_rate_alert, 'samples', v_samples));
  end if;

  -- A null bound means "above every configured edge", which is a stronger signal than a number over the
  -- threshold, so it is reported rather than skipped.
  if v_samples >= 20 and (v_p95 is null or v_p95 > c.p95_alert_ms) then
    a := a || jsonb_build_array(jsonb_build_object('code', 'API_P95', 'severity', 'warn', 'subsystem', 'api',
      'observedMs', v_p95, 'thresholdMs', c.p95_alert_ms, 'aboveConfiguredBuckets', v_p95 is null));
  end if;

  select max(r.bucket) into v_last from public.metric_rollups r;
  if v_last is null or v_last < now() - make_interval(secs => c.staleness_alert_seconds) then
    a := a || jsonb_build_array(jsonb_build_object('code', 'TELEMETRY_STALE', 'severity', 'critical', 'subsystem', 'system',
      'lastBucket', to_char(v_last, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'thresholdSeconds', c.staleness_alert_seconds));
  end if;

  select count(1) into v_count from public.system_health h where h.status in ('unavailable', 'degraded');
  if v_count > 0 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY_UNWELL', 'severity', 'critical', 'subsystem', 'system',
      'count', v_count,
      'components', coalesce((select jsonb_agg(h.component) from public.system_health h
                               where h.status in ('unavailable', 'degraded')), '[]'::jsonb)));
  end if;

  select count(1) into v_count from public.system_health h
   where h.checked_at < now() - make_interval(secs => c.health_ttl_seconds * 3);
  if v_count > 0 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'HEARTBEAT_MISSING', 'severity', 'warn', 'subsystem', 'cron',
      'count', v_count, 'thresholdSeconds', c.health_ttl_seconds * 3));
  end if;

  select coalesce(sum(r.samples), 0) into v_count from public.metric_rollups r
   where r.subsystem = 'notifications' and r.metric = 'queue' and r.dimension = 'dlq' and r.bucket >= v_from;
  if v_count > 0 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'NOTIFICATION_DLQ', 'severity', 'critical',
      'subsystem', 'notifications', 'count', v_count));
  end if;

  select coalesce(sum(r.samples), 0) into v_count from public.metric_rollups r
   where r.subsystem = 'notifications' and r.metric = 'deliveries' and r.dimension = 'invalid_token' and r.bucket >= v_from;
  if v_count > 100 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'INVALID_TOKEN_RATE', 'severity', 'warn',
      'subsystem', 'notifications', 'count', v_count, 'threshold', 100));
  end if;

  -- The one alert that only means something with two sources: the engine thinks matches are live, and no
  -- socket is attached to any of them. Either half alone is normal.
  select count(1) into v_live from public.matches m
   where m.status in ('live', 'first_half', 'second_half', 'extra_time');
  select coalesce(sum(r.value_sum), 0) into v_conns from public.metric_rollups r
   where r.subsystem = 'live' and r.metric = 'connections' and r.bucket >= v_from;
  if v_live > 0 and coalesce(v_conns, 0) = 0 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'LIVE_ROOMS_WITHOUT_SOCKETS', 'severity', 'warn',
      'subsystem', 'live', 'matches', v_live, 'connections', v_conns));
  end if;

  select count(1) into v_count from public.system_health h where h.consecutive_failures >= 3;
  if v_count > 0 then
    a := a || jsonb_build_array(jsonb_build_object('code', 'REPEATED_PROBE_FAILURE', 'severity', 'warn',
      'subsystem', 'system', 'count', v_count));
  end if;

  return jsonb_build_object('ok', true,
    'evaluatedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'windowSeconds', v_window,
    'alerts', a,
    'thresholds', to_jsonb(c) - 'id' - 'updated_at');
end
$fn$;

-- ----------------------------------------------------------------------------
-- 13 · maintenance
-- ----------------------------------------------------------------------------

-- Minute rows are an operational artifact, day rows are an analytical one, and the difference is why this
-- function deletes before it inserts. Recomputing a derived table is safe; rewriting a source of truth is
-- not, which is exactly the distinction §7 applies to `activity_logs`.
create or replace function public.kicklive_metrics_rollup_daily(p_day date default ((now() at time zone 'utc')::date - 1))
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_deleted integer;
  v_inserted integer;
begin
  if p_day is null or p_day > ((now() at time zone 'utc')::date) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'DAY_IN_FUTURE');
  end if;

  delete from public.metric_daily d where d.day = p_day;
  get diagnostics v_deleted = row_count;

  insert into public.metric_daily (
    day, subsystem, metric, route, dimension, samples, errors, sum_ms, min_ms, max_ms, histogram, value_sum, source_rows
  )
  select p_day, r.subsystem, r.metric, r.route, r.dimension,
         sum(r.samples), sum(r.errors), sum(r.sum_ms), min(r.min_ms), max(r.max_ms),
         public.kicklive_observability_histogram_sum(r.histogram), sum(r.value_sum), count(1)::integer
    from public.metric_rollups r
   where (r.bucket at time zone 'utc')::date = p_day
     and r.granularity = 'minute'
   group by 2, 3, 4, 5;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('ok', true, 'day', p_day, 'replaced', v_deleted, 'rows', v_inserted);
end
$fn$;

-- The retention sweep. Two numbers, both clamped away from zero, because a purge that can be told to keep
-- nothing is a purge that will eventually be told so by a tired person. `activity_logs` is not here, and no
-- function in this file can delete from it: the audit trail's retention is a reviewed migration, and
-- `kicklive_observability_diagnostics` reports how big it has grown rather than pruning it.
create or replace function public.kicklive_metrics_purge(p_rollup_days integer default null, p_daily_days integer default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  c public.observability_config;
  v_rollup integer;
  v_daily integer;
  v_a integer := 0;
  v_b integer := 0;
begin
  select * into c from public.observability_config where id = 1;
  v_rollup := greatest(coalesce(p_rollup_days, c.rollup_retention_days), 1);
  v_daily  := greatest(coalesce(p_daily_days,  c.daily_retention_days),  1);

  delete from public.metric_rollups r where r.bucket < now() - make_interval(days => v_rollup);
  get diagnostics v_a = row_count;
  delete from public.metric_daily d where d.day < ((now() at time zone 'utc')::date - v_daily);
  get diagnostics v_b = row_count;

  return jsonb_build_object('ok', true, 'rollupsDeleted', v_a, 'dailyDeleted', v_b,
                            'kept', jsonb_build_object('rollupDays', v_rollup, 'dailyDays', v_daily),
                            'auditTouched', false);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 14 · meta
-- ----------------------------------------------------------------------------

-- The function that answers "is the observability plane itself working?", which is the question nobody asks
-- until the dashboard has been quietly empty for a week. It reports the shape of what is installed, so a
-- partial apply is visible without a psql session.
create or replace function public.kicklive_observability_diagnostics()
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rollups bigint;
  v_daily bigint;
  v_audit bigint;
  v_last timestamptz;
  v_first timestamptz;
  v_unknown jsonb;
  v_hour bigint := 0;
  v_anon integer := 0;
  f record;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;

  select count(1) into v_rollups from public.metric_rollups;
  select count(1) into v_daily from public.metric_daily;
  select count(1) into v_audit from public.activity_logs;
  select min(r.bucket), max(r.bucket) into v_first, v_last from public.metric_rollups r;
  select count(1) into v_hour from public.metric_rollups r where r.granularity = 'hour';

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_unknown
    from (
      select distinct r.subsystem as subsystem, r.metric as metric
        from public.metric_rollups r
       where r.bucket > now() - interval '1 day'
         and not public.kicklive_observability_metric_known(r.subsystem, r.metric)
       limit 50
    ) x;

  -- Counted from the catalog rather than trusted from this file's own text: an operator wants to know what is
  -- installed, not what the migration intended.
  for f in
    select p.oid::regprocedure::text as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'kicklive_observability%' or p.proname like 'kicklive_metrics%'
            or p.proname like 'kicklive_health%' or p.proname like 'kicklive_audit%')
  loop
    if public.kicklive_has_grant('anon', f.sig, 'X') then
      v_anon := v_anon + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'tables', jsonb_build_object(
      'metric_rollups', v_rollups, 'metric_daily', v_daily, 'activity_logs', v_audit,
      'system_health', (select count(1) from public.system_health),
      'unhealthy', (select count(1) from public.system_health h where h.status <> 'ok')
    ),
    'coverage', jsonb_build_object(
      'firstBucket', to_char(v_first, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'lastBucket', to_char(v_last, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'ageSeconds', case when v_last is null then null else round(extract(epoch from (now() - v_last)))::bigint end,
      'subsystems', (select count(distinct r.subsystem) from public.metric_rollups r),
      'routes', (select count(distinct r.route) from public.metric_rollups r where r.route <> '*'),
      'hourlyRows', v_hour
    ),
    'catalogue', jsonb_build_object(
      'entries', (select count(1) from public.kicklive_observability_catalogue()),
      'unrecognisedLastDay', coalesce(v_unknown, '[]'::jsonb)
    ),
    'audit', jsonb_build_object(
      'last24h', (select count(1) from public.activity_logs a where a.created_at > now() - interval '1 day'),
      'appendOnly', exists (select 1 from pg_trigger t
                             where t.tgname = 'activity_logs_append_only'
                               and not t.tgdropped),
      'editablePolicies', (select count(1) from pg_policies p
                            where p.tablename = 'activity_logs' and p.cmd in ('UPDATE', 'DELETE', 'ALL'))
    ),
    'grants', jsonb_build_object('anonExecutableFunctions', v_anon),
    'retention', jsonb_build_object(
      'rollupDays', (select c.rollup_retention_days from public.observability_config c where c.id = 1),
      'dailyDays', (select c.daily_retention_days from public.observability_config c where c.id = 1),
      'auditDays', 0,
      'note', 'audit rows are pruned by a reviewed migration and never by this API'
    )
  );
end
$fn$;

-- The redactor, made inspectable. The desk can paste a candidate string and see what would happen to it —
-- which is how a rule about redaction turns into something a person can test rather than believe. It reads
-- nothing from the database, so it is safe to expose to a signed-in staff member and useless to anybody else.
create or replace function public.kicklive_observability_explain(p_text text)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'inputLength', coalesce(length(p_text), 0),
    'reason', public.kicklive_observability_refuses(p_text),
    'wouldStore', public.kicklive_observability_refuses(p_text) is null,
    'preview', case
      when p_text is null or p_text = '' then ''
      when public.kicklive_observability_refuses(p_text) is not null then '[redacted]'
      else left(p_text, 120)
    end
  )
$fn$;

-- ----------------------------------------------------------------------------
-- 15 · privileges
-- ----------------------------------------------------------------------------

-- RLS on, no policies, no client grants, as in Phases 6 to 8: a table that answers zero rows to a stranger is
-- a table that cannot be read by a stranger. `kicklive_audit_guard_immutable` is the exception that proves the
-- rule — `activity_logs` predates this convention and already has policies, so §7 edited those instead of
-- adding a second audit table nobody would query.
alter table public.metric_rollups enable row level security;
alter table public.metric_daily   enable row level security;
alter table public.system_health  enable row level security;
alter table public.observability_config enable row level security;

grant select, insert, update, delete on table public.metric_rollups       to service_role;
grant select, insert, update, delete on table public.metric_daily         to service_role;
grant select, update                 on table public.system_health        to service_role;
grant select, update                 on table public.observability_config to service_role;
grant usage, select on sequence public.metric_rollups_id_seq to service_role;
revoke all on table public.metric_rollups       from public, anon, authenticated;
revoke all on table public.metric_daily         from public, anon, authenticated;
revoke all on table public.system_health        from public, anon, authenticated;
revoke all on table public.observability_config from public, anon, authenticated;

-- `kicklive_audit_record` inserts into `activity_logs`, a table this migration does not own. Nothing is
-- granted for it here, and that is the decision rather than an oversight: the function is `security definer`
-- and runs as the role that applied this file, which owns the legacy table on both a hosted project and the
-- scratch database. Granting `service_role` insert on `activity_logs` would hand the Worker a *direct* write
-- it must not use — one that skips the validators, the request id and the subject rule — so the privilege
-- stays implicit, and the verification block asserts the insert works rather than widening the grant.
do $grant$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure::text as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'kicklive_observability%'
            or p.proname like 'kicklive_metrics%'
            or p.proname like 'kicklive_health%'
            or p.proname like 'kicklive_audit%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    -- Exactly one door a stranger may open, and it is the coarse one. That this list is one long rather than
    -- three (as in Phase 8) is the point of the health endpoint: a fan is told whether the app thinks it is
    -- working, and nothing about how it knows.
    if f.proname = 'kicklive_health_read' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname in (
      'kicklive_metrics_summary', 'kicklive_metrics_daily', 'kicklive_metrics_top_routes',
      'kicklive_live_match_metrics', 'kicklive_notification_metrics', 'kicklive_advertising_metrics',
      'kicklive_health_read_admin', 'kicklive_observability_alerts', 'kicklive_observability_diagnostics',
      'kicklive_observability_catalogue', 'kicklive_observability_explain',
      'kicklive_audit_list', 'kicklive_audit_record', 'kicklive_health_recompute_derived'
    ) then
      -- `authenticated`, and the function decides the caller from the JWT — the Phase 8 lesson, applied rather
      -- than relearned: a `service_role` call to PostgREST carries no subject, so `auth.uid()` is NULL and
      -- `is_admin()` is false. An admin reading their own metrics on the admin client would be told they are
      -- not an admin. `kicklive_audit_record` is here for the same reason and because its actor column is
      -- `auth.uid()`; the three writers that take no user decision (record, health_write, rollup/purge) stay
      -- service-role-only.
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end
$grant$;

-- What the functions above call that the loop cannot reach, or reaches without meaning to.
--
-- `is_admin()`, `is_admin_or_media()` and `kicklive_ad_analytics()` belong to Phases 1 and 7. A `security
-- definer` function runs as its owner, and what decides a call is what that *owner* may execute, so a
-- missing grant here installs cleanly and then fails on the first read — the failure Phase 8's §9 records,
-- avoided here by naming each function instead of trusting a pattern.
--
-- The percentile helpers and the histogram aggregate *are* reached by the loop's
-- `like 'kicklive_observability%'`, and are granted again below for a different reason: the loop leaves
-- anything outside its two `if` branches at `service_role` only, which is right for the writers and wrong for
-- pure arithmetic that an admin's read has to call.
grant execute on function public.is_admin() to service_role;
grant execute on function public.is_admin_or_media() to service_role;
grant execute on function public.kicklive_ad_analytics(date, date, uuid, uuid, text, text) to service_role, authenticated;
grant execute on function public.kicklive_observability_percentile(bigint[], numeric) to service_role, authenticated;
grant execute on function public.kicklive_observability_percentile_index(bigint[], numeric) to service_role, authenticated;
grant execute on function public.kicklive_observability_bound(integer) to service_role, authenticated;
grant execute on function public.kicklive_observability_histogram_sum(bigint[]) to service_role, authenticated;
grant execute on function public.kicklive_observability_hist_add(bigint[], bigint[]) to service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 16 · verification
-- ----------------------------------------------------------------------------

-- Everything below runs as part of the apply, on purpose. Phases 6 to 8 each found that the failure mode of a
-- migration written without a database in reach is not a crash but a *quietly wrong* install: a policy that
-- says `for all` where it should say `for select`, a function whose name does not match a grant loop, a
-- CHECK that never fires. So the block asserts the properties this file exists to establish, in the catalog
-- rather than in the comments above them.
do $verify$
declare
  n integer;
  v text;
begin
  foreach v in array array['metric_rollups', 'metric_daily', 'system_health', 'observability_config'] loop
    if to_regclass('public.' || v) is null then
      raise exception 'phase 9 verify: table public.% is missing', v using errcode = '42501';
    end if;
  end loop;

  select count(1) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname in ('metric_rollups', 'metric_daily', 'system_health', 'observability_config')
     and c.relrowsecurity;
  if n <> 4 then
    raise exception 'phase 9 verify: row-level security is enabled on % of the four tables', n using errcode = '42501';
  end if;

  -- The audit trail must not be editable through a policy, whatever the baseline schema did before this file.
  select count(1) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'activity_logs' and p.cmd in ('UPDATE', 'DELETE', 'ALL');
  if n <> 0 then
    raise exception 'phase 9 verify: activity_logs still has % editable polic%s — the point of this section is that it has none',
      n, case when n = 1 then 'y' else 'ies' end using errcode = '42501';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgname = 'activity_logs_append_only' and c.relname = 'activity_logs' and not t.tgdropped
  ) then
    raise exception 'phase 9 verify: the append-only trigger on activity_logs is missing' using errcode = '42501';
  end if;

  -- Exactly one function is executable by an anonymous caller, and it is the coarse health read. A second one
  -- appearing is either a widening or a rename, and both deserve to fail the apply.
  select count(1) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and (p.proname like 'kicklive_observability%' or p.proname like 'kicklive_metrics%'
          or p.proname like 'kicklive_health%' or p.proname like 'kicklive_audit%')
     and public.kicklive_has_grant('anon', p.oid::regprocedure::text, 'X');
  if n <> 1 then
    raise exception 'phase 9 verify: % observability functions are executable by anon, and only kicklive_health_read may be',
      n using errcode = '42501';
  end if;

  if not public.kicklive_has_grant('anon', 'public.kicklive_health_read()', 'X') then
    raise exception 'phase 9 verify: the public health read is not executable by anon' using errcode = '42501';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.kicklive_metrics_record(jsonb,timestamptz)', 'X') then
    raise exception 'phase 9 verify: a client role can write metrics, which is how a dashboard becomes a wish'
      using errcode = '42501';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.kicklive_health_write(text,text,text,jsonb,boolean)', 'X') then
    raise exception 'phase 9 verify: a client role can write component health' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('authenticated', 'public.kicklive_audit_record(text,text,integer,text,jsonb,text,uuid)', 'X') then
    raise exception 'phase 9 verify: kicklive_audit_record is not executable by authenticated, so every audit write made with an admin token will be refused'
      using errcode = '42501';
  end if;

  -- The histogram aggregate, present as an aggregate rather than as a function with the same name — a
  -- `create aggregate` that silently failed would leave the reads asking for a function and getting nothing.
  select count(1) into n from pg_proc p where p.proname = 'kicklive_observability_histogram_sum' and p.prokind = 'a';
  if n <> 1 then
    raise exception 'phase 9 verify: the histogram aggregate is missing or duplicated (% found)', n using errcode = '42501';
  end if;

  -- The two properties the percentile read depends on: an eleven-wide histogram, and ten sorted edges. A
  -- `histogram[11]` that means something else is a percentile that is confidently wrong.
  select count(1) into n from observability_config c
   where c.id = 1 and array_length(c.latency_buckets_ms, 1) = 10
     and c.latency_buckets_ms = (select array_agg(b order by b) from unnest(c.latency_buckets_ms) b);
  if n <> 1 then
    raise exception 'phase 9 verify: the latency buckets are not ten sorted edges' using errcode = '42501';
  end if;
  if public.kicklive_observability_percentile_index(array[10,0,0,0,0,0,0,0,0,0,0], 0.95) is distinct from 1 then
    raise exception 'phase 9 verify: nearest-rank percentile on a single-bucket histogram should be bucket 1'
      using errcode = '42501';
  end if;
  if public.kicklive_observability_bound(11) is not null then
    raise exception 'phase 9 verify: the top bucket must have no bound — reporting one would invent a ceiling'
      using errcode = '42501';
  end if;
  if public.kicklive_observability_percentile(array[0,0,0,0,0,0,0,0,0,0,0], 0.5) ->> 'samples' is distinct from '0' then
    raise exception 'phase 9 verify: an empty histogram should answer with a zero-sample object, not 0ms'
      using errcode = '42501';
  end if;

  -- The redactor, exercised rather than described: it must catch the shapes and leave the sentences alone.
  if public.kicklive_observability_refuses('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.short') is null then
    raise exception 'phase 9 verify: the redactor missed a bearer token' using errcode = '42501';
  end if;
  if public.kicklive_observability_refuses('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig') is null then
    raise exception 'phase 9 verify: the redactor missed a service-role key' using errcode = '42501';
  end if;
  if public.kicklive_observability_refuses('-----BEGIN PRIVATE KEY-----') is null then
    raise exception 'phase 9 verify: the redactor missed a PEM header' using errcode = '42501';
  end if;
  if public.kicklive_observability_refuses('/sponsorship/admin/sponsors/:id/branding') is not null then
    raise exception 'phase 9 verify: the redactor is refusing ordinary text, which will hide every route'
      using errcode = '42501';
  end if;
  if public.kicklive_observability_document_refuses(jsonb_build_object('request_id', 'abc-123', 'outcome', 'ok')) is not null then
    raise exception 'phase 9 verify: the document redactor is refusing a clean detail object' using errcode = '42501';
  end if;
  if public.kicklive_observability_document_refuses(jsonb_build_object('note', 'token=abcdef012345')) is null then
    raise exception 'phase 9 verify: the document redactor missed a credential inside details' using errcode = '42501';
  end if;

  select count(1) into n from public.kicklive_observability_catalogue();
  if n < 20 then
    raise exception 'phase 9 verify: the metric catalogue has % entries, fewer than the surface this phase instruments',
      n using errcode = '42501';
  end if;
  select count(1) into n from public.kicklive_observability_catalogue() c
   where not public.kicklive_observability_metric_ok(c.metric)
      or not public.kicklive_observability_route_ok('/' || c.subsystem)
      or not public.kicklive_observability_dimension_ok(split_part(c.dimensions, '|', 1));
  if n <> 0 then
    raise exception 'phase 9 verify: % catalogue entries would be refused by the validators they are supposed to satisfy',
      n using errcode = '42501';
  end if;

  -- The five components the public endpoint is allowed to name, and no more: a status list that grows in SQL
  -- without the docs and the UI growing with it is how an internal name becomes public API.
  select count(1) into n from public.system_health;
  if n <> 9 then
    raise exception 'phase 9 verify: system_health should be seeded with the nine components, found %', n
      using errcode = '42501';
  end if;
end
$verify$;

-- ----------------------------------------------------------------------------
-- 17 · rollback
-- ----------------------------------------------------------------------------
--
-- Nothing here is executed. It is written out because a rollback that has to be invented at the moment of the
-- incident is a rollback that gets improvised, and because the order matters: the reads depend on the
-- aggregate, and the aggregate depends on the state function.
--
--   drop function if exists public.kicklive_observability_explain(text);
--   drop function if exists public.kicklive_observability_diagnostics();
--   drop function if exists public.kicklive_metrics_purge(integer, integer);
--   drop function if exists public.kicklive_metrics_rollup_daily(date);
--   drop function if exists public.kicklive_observability_alerts(integer);
--   drop function if exists public.kicklive_health_read_admin();
--   drop function if exists public.kicklive_health_read();
--   drop function if exists public.kicklive_advertising_metrics(timestamptz, timestamptz);
--   drop function if exists public.kicklive_notification_metrics(timestamptz, timestamptz);
--   drop function if exists public.kicklive_live_match_metrics(timestamptz, timestamptz);
--   drop function if exists public.kicklive_metrics_top_routes(timestamptz, timestamptz, integer);
--   drop function if exists public.kicklive_metrics_daily(date, date, text, text, integer);
--   drop function if exists public.kicklive_metrics_summary(timestamptz, timestamptz, text, text, text, integer);
--   drop aggregate if exists public.kicklive_observability_histogram_sum(bigint[]);
--   drop function if exists public.kicklive_observability_hist_add(bigint[], bigint[]);
--   drop function if exists public.kicklive_audit_list(text, text, uuid, timestamptz, timestamptz, integer, integer);
--   drop function if exists public.kicklive_audit_record(text, text, integer, text, jsonb, text, uuid);
--   drop trigger   if exists activity_logs_append_only on public.activity_logs;
--   drop function if exists public.kicklive_audit_guard_immutable();
--   -- The activity_logs policies are Phase 1's, and rolling them back means restoring *its* file, not
--   -- dropping these: `supabase/migrations/20260909120000_phase1_security_hardening.sql` re-applied re-creates
--   -- `activity_logs: auth insert` and the `for all` admin policy. Deciding that in a rollback instead of a
--   -- review is how an audit table ends up editable again.
--   drop function if exists public.kicklive_observability_metric_known(text, text);
--   drop function if exists public.kicklive_observability_catalogue();
--   drop function if exists public.kicklive_health_write(text, text, text, jsonb, boolean);
--   drop function if exists public.kicklive_metrics_record(jsonb, timestamptz);
--   drop function if exists public.kicklive_observability_percentile(bigint[], numeric);
--   drop function if exists public.kicklive_observability_percentile_index(bigint[], numeric);
--   drop function if exists public.kicklive_observability_bound(integer);
--   drop function if exists public.kicklive_observability_histogram_index(numeric);
--   drop function if exists public.kicklive_observability_bucket(timestamptz, text);
--   drop function if exists public.kicklive_observability_ms(numeric);
--   drop function if exists public.kicklive_observability_dimension_ok(text);
--   drop function if exists public.kicklive_observability_route_ok(text);
--   drop function if exists public.kicklive_observability_metric_ok(text);
--   drop function if exists public.kicklive_observability_document_refuses(jsonb);
--   drop function if exists public.kicklive_observability_refuses(text);
--   drop table if exists public.metric_daily;
--   drop table if exists public.metric_rollups;
--   drop table if exists public.system_health;
--   drop table if exists public.observability_config;
--
-- The data decision that makes this list short: the metrics tables are disposable by design, so a rollback
-- that drops them costs a week of charts and no truth. `activity_logs` keeps every row it has ever held,
-- including the ones this phase's Worker started writing, and the immutability trigger is the only thing in
-- this file a reviewer should refuse to drop.
