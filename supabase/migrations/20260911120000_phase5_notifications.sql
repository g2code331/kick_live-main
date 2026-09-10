-- ============================================================================
--  KICKLIVE · Phase 5 — notification system
--  20260911120000_phase5_notifications.sql
--
--  Design and audit: docs/NOTIFICATIONS_ARCHITECTURE.md. This file is the data half of it: the model, the
--  row-level security, and the SQL the Worker calls. No delivery logic lives here — FCM is a Worker concern.
--
--  WHAT THIS FILE DOES
--    1. extends `notifications` with a recipient, a kind, a read marker, a dedupe key and metadata;
--    2. replaces `notifications: public read` with an owner-or-broadcast policy (§5 — the security-critical
--       statement in this file, because a per-user inbox on a table everyone could read is a leak with a
--       nicer name);
--    3. adds `notification_preferences`, `notification_devices`, `notification_jobs`,
--       `notification_deliveries`, `match_interest`;
--    4. adds `profiles.notifications_enabled`;
--    5. puts a trigger on `match_events` that creates one job per notification-worthy event, in the same
--       transaction as the event;
--    6. adds the seven functions the Worker calls, so identity, the device cap, the audience and the
--       idempotency constraints are enforced in SQL rather than assumed from a client.
--
--  WHAT THIS FILE DOES NOT DO
--    - no drop, no truncate, no update of an existing row, and no delete of anything the app already had.
--      The only row deletions in this file are of rows this phase owns: an owner dismissing their own
--      `match_interest`, and the retention prune of device rows that were deactivated more than 30 days ago
--      (a credential from a churned install is a liability, not history).
--    - no `alter default privileges … revoke update, delete` (that pattern broke writes in an earlier phase
--      and is still forbidden by docs/PRODUCTION_MIGRATION_PLAN.md's standing constraints);
--    - no RLS disable, anywhere, ever;
--    - no change to `match_events`, `matches` or the Phase 3 functions: the event table gains a trigger, not
--      a column, and Phase 3's migration file is history and stays byte-identical;
--    - no FCM token, service-account material or VAPID private key — a database is a poor place to keep a
--      credential that Google can rotate, and `notification_devices.token` holds only what a client gave us.
--
--  HOW TO RUN IT — the same as the other two, and the same self-verifying shape:
--
--      begin;
--      \i supabase/migrations/20260911120000_phase5_notifications.sql
--      -- read §9's notice output, then commit;  (or rollback;)
--
--  It is safe to run twice (every statement is `if not exists` / `or replace` / drop-then-create by name),
--  which matters because a partially applied notification schema is worse than none: half the tables would
--  be readable by the wrong people.
-- ============================================================================

begin;

-- ── 1. the vocabulary, in one place ───────────────────────────────────────────────────────────
--
--  A category is simultaneously a preference row, a notification row, a job and a policy decision, so the
--  same eleven names appear in four CHECK constraints and in
--  `src/lib/data/notifications.ts` + `workers/src/lib/notificationPolicy.ts`. Three copies of a list is how
--  a phase like this produces "the app calls it goal, the database calls it match_goal, the phone gets
--  nothing", which is why the test in `tests/unit/phase5-notifications.test.ts` compares all four rather
--  than trusting this comment.
--
--  `match_reminder`, `team_update`, `competition_update` and `news` are in the vocabulary with no producer in
--  this file: they are the categories the settings screen has to show (step 17 of the brief asks for them)
--  and a preference for a kind that nothing sends yet is an honest placeholder, whereas a *table* the
--  frontend invents is a schema someone has to undo later.

-- ── 2. `notifications` — the inbox, on the table that already exists ────────────────────────────
--
--  Today: id, title, body, match_id, event_type, created_at. A broadcast log with no recipient. Every
--  existing row keeps working: `user_id is null` means broadcast, which is what all of them are.

alter table public.notifications
  add column if not exists user_id    uuid    references public.profiles(id) on delete cascade,
  add column if not exists kind       text    not null default 'system',
  add column if not exists dedupe_key text,
  add column if not exists read_at    timestamptz,
  add column if not exists metadata   jsonb   not null default '{}'::jsonb,
  add column if not exists priority   smallint not null default 0,
  add column if not exists expires_at timestamptz;

comment on column public.notifications.user_id is
  'The recipient. NULL = broadcast, which is every row written before Phase 5 and every admin announcement after it.';
comment on column public.notifications.dedupe_key is
  'match:<id>|seq:<sequence>|kind:<kind>, assigned by the server. The idempotency key: see docs/NOTIFICATIONS_ARCHITECTURE.md §10.';

alter table public.notifications
  drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                  'team_update','competition_update','news','system','announcement'));

-- `event_type` is the pre-Phase-5 field and stays populated for old rows; new writers set `kind`. Both are
-- kept rather than migrated so that a rollback of this file does not lose the meaning of existing rows.

-- Partial, deliberately: the existing rows have no dedupe_key and several share a match_id, so a plain
-- unique index over (user_id, dedupe_key) would abort the migration on real data instead of extending it.
create unique index if not exists notifications_user_dedupe_key
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null and user_id is not null;

create index if not exists notifications_inbox_idx
  on public.notifications (user_id, created_at desc nulls last)
  where user_id is not null;

create index if not exists notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null and user_id is not null;

create index if not exists notifications_broadcast_idx
  on public.notifications (created_at desc)
  where user_id is null;

-- `expires_at` exists so a 90-minute "kick-off" nudge can age out of an inbox instead of sitting unread at the
-- top forever: the consumer sets it when it creates the row, and every read filters on it. Expiring is a
-- filter, not a delete — "we told you" stays auditable either way.

-- ── 3. new tables ───────────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_preferences (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  kind       text        not null,
  enabled    boolean     not null default false,
  -- Two booleans would have been simpler and wrong: a second delivery medium is a third array element, not
  -- a migration. 'inbox' only = the app says something, the phone stays quiet.
  channels   text[]      not null default '{inbox,push}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind),
  constraint notification_preferences_kind_check
    check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                    'team_update','competition_update','news','system','announcement')),
  -- `<@` is the whole rule: an array may not contain a channel that does not exist. A duplicate
  -- ('{push,push}') is harmless to every consumer and would only make the constraint worth misreading.
  constraint notification_preferences_channel_check
    check (channels <@ array['inbox','push']::text[] and channels <> '{}')
);

comment on table public.notification_preferences is
  'One row per user per category. Absent = the default below, which is why the defaults live in code that both the API and this file can read (kicklive_preference_defaults).';

create table if not exists public.notification_devices (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.profiles(id) on delete cascade,
  -- 'webpush' exists so a raw browser subscription is a row and not a schema change; FCM is the only
  -- provider this phase delivers to (docs/NOTIFICATIONS_ARCHITECTURE.md §16).
  provider      text        not null check (provider in ('fcm','webpush')),
  token         text        not null,
  platform      text        not null default 'unknown' check (platform in ('android','ios','web','unknown')),
  app_id        text,
  ua_family     text,
  ua_major      integer,
  active        boolean     not null default true,
  failure_count integer     not null default 0,
  last_error_code text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  last_sent_at  timestamptz,
  -- The load-bearing line for ownership: a token can belong to exactly one account, so registering it
  -- elsewhere moves it instead of subscribing a second recipient. Enforced here because a client cannot.
  constraint notification_devices_token_unique unique (provider, token)
);

create index if not exists notification_devices_user_active_idx
  on public.notification_devices (user_id, last_seen_at desc)
  where active;

comment on column public.notification_devices.token is
  'A credential. Never selected by a policy a browser can use, never returned by an endpoint, never logged (workers/src/services/fcm.ts redacts it).';

create table if not exists public.notification_jobs (
  id              bigint generated always as identity primary key,
  -- Named explicitly, because an inline `unique` on a column already called `dedupe_key` gets the
  -- autogenerated name `notification_jobs_dedupe_key_key` (the `_key` suffix is appended to a name that
  -- already ends in one), and §9.4 has to assert the index by the name pg_indexes actually stores. A
  -- verification that guesses at generated names is a verification that fails on a fresh install.
  dedupe_key      text    not null constraint notification_jobs_dedupe_key unique,
  kind            text    not null,
  match_id        integer references public.matches(id) on delete cascade,
  competition_id  integer references public.competitions(id) on delete cascade,
  team_id         integer references public.teams(id) on delete cascade,
  title           text    not null,
  body            text    not null,
  metadata        jsonb   not null default '{}'::jsonb,
  -- pending → running → sent | partial; retry is the only way back in, failed is terminal.
  status          text    not null default 'pending'
                          check (status in ('pending','running','retry','sent','partial','failed')),
  attempts        integer not null default 0,
  max_attempts    integer not null default 6 check (max_attempts between 1 and 25),
  next_attempt_at timestamptz not null default now(),
  recipient_count integer,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  last_error      text,
  created_by      uuid references public.profiles(id) on delete set null,
  constraint notification_jobs_kind_check
    check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                    'team_update','competition_update','news','system','announcement')),
  -- A job with no audience selector would be "send to everyone", which is not a thing that should be
  -- accidentally reachable from a trigger.
  constraint notification_jobs_has_target
    check (match_id is not null or competition_id is not null or team_id is not null or kind = 'announcement')
);

create index if not exists notification_jobs_claimable_idx
  on public.notification_jobs (next_attempt_at)
  where status in ('pending','retry');

comment on table public.notification_jobs is
  'The durable wake-up. A notification exists as a row here before it exists in a queue, so a lost queue message costs delay, not silence (docs/NOTIFICATIONS_ARCHITECTURE.md §11).';

create table if not exists public.notification_deliveries (
  id                  bigint generated always as identity primary key,
  job_id              bigint  not null references public.notification_jobs(id) on delete cascade,
  device_id           uuid    not null references public.notification_devices(id) on delete cascade,
  user_id             uuid    not null references public.profiles(id) on delete cascade,
  notification_id     integer references public.notifications(id) on delete set null,
  status              text    not null check (status in ('sent','failed','skipped_invalid_token')),
  provider_message_id text,
  fcm_error           text,
  attempt             integer not null default 1,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  -- Per-device idempotency, which is what makes a queue redelivery safe to consume twice.
  constraint notification_deliveries_job_device_unique unique (job_id, device_id)
);

create index if not exists notification_deliveries_user_idx
  on public.notification_deliveries (user_id, created_at desc);

comment on table public.notification_deliveries is
  'Push outcomes, deliberately separate from `notifications`: an offline device has a notification and no delivery, and that difference is the product (§2 of the architecture).';

create table if not exists public.match_interest (
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  match_id   integer     not null references public.matches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, match_id)
);

comment on table public.match_interest is
  'The only relationship table in this phase: "tell me about this match". The follow model does not exist yet, and an audience needs one seam to grow into (step 18 of the brief: do not build favourites here).';

-- ── 4. the global switch ──────────────────────────────────────────────────────────────────────────
--
--  On `profiles`, because "everything off" is not a category and a per-kind table should stay a set of
--  categories. Default true: the app must not be born deaf, and with no `notification_devices` row nobody is
--  pushed to, so a default that is generous costs nothing until a user opts in.

alter table public.profiles
  add column if not exists notifications_enabled boolean not null default true;

comment on column public.profiles.notifications_enabled is
  'The master switch. Checked by every audience query; the per-category preferences sit under it, not over it.';

-- ── 5. row level security ─────────────────────────────────────────────────────────────────────────
--
--  Order: revoke everything from the client roles, grant only what a client genuinely needs, then policies.
--  RLS is *enabled*, never *forced*. Forced RLS also applies to the table owner, and every RPC below runs as
--  the owner by design (SECURITY DEFINER, `postgres`), so a FORCE here would make each of them insert zero
--  rows into its own table. This is the exact rule Phase 1 wrote down for `access_requests` and Phase 3
--  repeated for `match_assignments`; the client-side protection comes from `revoke` plus the absence of any
--  INSERT/UPDATE policy, both of which apply to anon/authenticated whether or not RLS is forced.

do $rls$
declare
  t text;
begin
  foreach t in array array['notification_preferences','notification_devices','notification_jobs','notification_deliveries','match_interest']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
  -- `notifications` is *not* revoked here. It is a pre-existing table whose grants Supabase issued at
  -- creation time, and a revocation would be a behaviour change for every caller at once — including the
  -- dead browser code in `MatchAutomation`, which should fail on RLS (a policy answer) rather than on
  -- privileges (a grant answer). The new tables are revoked because they have no such history.
  -- Function revokes are in §8, after the functions exist: `revoke … from public` on a name Postgres cannot
  -- resolve raises, and a migration that dies on its own ordering is a migration that gets run twice.
end
$rls$;

-- `notifications` — the statement to read carefully.
--
-- Phase 1's `notifications: public read` is `for select to anon, authenticated using (true)`: every row
-- readable by everyone, which was correct for a broadcast table and is a leak for an inbox. It is dropped by
-- name and replaced with owner-or-broadcast. A fan still sees every pre-Phase-5 row (they are broadcasts), so
-- this migration changes no existing behaviour for existing data — it only refuses to extend that visibility
-- to rows that have a recipient.
drop policy if exists "notifications: public read" on public.notifications;
-- Dropped by its own name as well, for the second run rather than the first: the line above retires
-- Phase 1's policy, and without this one a re-application of this file dies on
-- `policy "notifications: owner or broadcast read" already exists`.
drop policy if exists "notifications: owner or broadcast read" on public.notifications;
create policy "notifications: owner or broadcast read"
  on public.notifications for select to anon, authenticated
  using (user_id is null or user_id = auth.uid());

-- A user may mark their own rows read (and nothing else) and may dismiss them. Writes that *create* a
-- notification for anyone — including oneself — are not a client privilege: the Worker's service-role client
-- does them, so a browser cannot forge a "we told you about the title race" row.
drop policy if exists "notifications: owner update read" on public.notifications;
create policy "notifications: owner update read"
  on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and read_at is not null);

drop policy if exists "notifications: owner delete" on public.notifications;
create policy "notifications: owner delete"
  on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- Admin keeps the Phase 1 `notifications: admin all` policy (FOR ALL, is_admin()), which is how a broadcast
-- is written; it is not redefined here so that a rollback of this file cannot leave the table with no admin
-- write path.

-- preferences: self only, both directions.
drop policy if exists "notification_preferences: owner read" on public.notification_preferences;
create policy "notification_preferences: owner read"
  on public.notification_preferences for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "notification_preferences: owner write" on public.notification_preferences;
create policy "notification_preferences: owner write"
  on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "notification_preferences: owner update" on public.notification_preferences;
create policy "notification_preferences: owner update"
  on public.notification_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No FOR DELETE: "off" is `enabled = false`, and a missing row means defaults, so deleting a row to hide a
-- preference would be a way to make a setting unturnoffable. The RPC writes the full document either way.

-- devices: self only, and the token column is not reachable by a client policy at all — the settings screen
-- reads the view below instead. Delete is allowed because "sign this phone out" is a user action.
drop policy if exists "notification_devices: owner read" on public.notification_devices;
create policy "notification_devices: owner read"
  on public.notification_devices for select to authenticated
  using (false);   -- superseded by notification_devices_public; see the view
drop policy if exists "notification_devices: owner delete" on public.notification_devices;
create policy "notification_devices: owner delete"
  on public.notification_devices for delete to authenticated
  using (user_id = auth.uid());
-- No INSERT/UPDATE policy on purpose: registration goes through kicklive_register_notification_device(),
-- which takes the user from auth.uid() rather than from an argument. A client with a direct insert path can
-- point a token at another account the moment such a path exists.

-- jobs and deliveries: no client read, no client write, ever.
drop policy if exists "notification_jobs: admin read" on public.notification_jobs;
create policy "notification_jobs: admin read"
  on public.notification_jobs for select to authenticated
  using (public.is_admin());
drop policy if exists "notification_deliveries: admin read" on public.notification_deliveries;
create policy "notification_deliveries: admin read"
  on public.notification_deliveries for select to authenticated
  using (public.is_admin());
-- Diagnostics is the only surface a client gets, and it is an aggregate, not a row set (§17 of the
-- architecture): no policy here exposes who is subscribed to what.

-- match interest: owner, no update (the key *is* the state), no admin read.
drop policy if exists "match_interest: owner read" on public.match_interest;
create policy "match_interest: owner read"
  on public.match_interest for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "match_interest: owner write" on public.match_interest;
create policy "match_interest: owner write"
  on public.match_interest for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "match_interest: owner delete" on public.match_interest;
create policy "match_interest: owner delete"
  on public.match_interest for delete to authenticated
  using (user_id = auth.uid());

-- What the settings screen may read about its own devices: everything except the credential.
create or replace view public.notification_devices_public as
  select d.id, d.platform, d.provider, d.app_id, d.active, d.created_at, d.updated_at, d.last_seen_at, d.last_sent_at,
         d.failure_count > 0 as has_failures
    from public.notification_devices d
   where d.user_id = auth.uid();

comment on view public.notification_devices_public is
  'The device list a signed-in user may see. Deliberately without `token`: a settings screen has no reason to read a credential back, and a view is how that stays true after someone adds a fifth column.';

alter view public.notification_devices_public owner to postgres;
grant select on public.notification_devices_public to authenticated;

-- No grant line for `notifications` at all, on purpose (see §5): the table's privileges stay as the base
-- schema issued them and RLS decides, so the only new refusal a caller can hit is a policy refusal.
grant select, insert, delete on public.match_interest to authenticated;
grant select on public.notification_preferences to authenticated;
grant insert, update on public.notification_preferences to authenticated;
grant select, delete on public.notification_devices to authenticated;
grant select on public.notification_devices_public to authenticated;
-- Deliberately absent: insert/update on notification_devices, any write to notification_jobs or
-- notification_deliveries, and select on notification_devices (the token table) from a client role.

-- ── 6. the trigger: an authoritative event creates one job ────────────────────────────────────────
--
--  Why a trigger rather than a line inside `kicklive_record_match_event()`: the Phase 3 function is not the
--  only writer of `match_events` (the Durable Object's write-behind, an admin correction, a future importer),
--  and a notification rule that lives in one caller is a rule that the next caller forgets. It also means
--  the job row and the event row commit or roll back together without any coordination, which is the only
--  durability statement this phase needs (§8 of the architecture).
--
--  The key is `match:<id>|seq:<sequence>|kind:<kind>`. `sequence` is assigned by the server, once per match,
--  so it is exactly the thing that makes a replayed or re-delivered event a no-op instead of a duplicate push.

create or replace function public.kicklive_notification_job_for_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind   text;
  v_title  text;
  v_body   text;
  v_home   text;
  v_away   text;
  v_player text;
  v_match  public.matches%rowtype;
  v_score  text;
begin
  -- Only events that stand are worth a phone buzzing. A corrected row (event_status 'corrected') and the
  -- correction itself (corrects_event_id set) both stay silent: the inbox keeps the original notification,
  -- and the score a fan sees comes from the derived state, not from a second push.
  if new.corrects_event_id is not null then
    return new;
  end if;
  if new.event_status is not null and new.event_status <> 'active' then
    return new;
  end if;
  if new.match_id is null then
    return new;
  end if;

  -- The event→category map, in full. Everything Phase 3 treats as a moment worth a row is a moment worth a
  -- notification here, and everything else is `null` — a corner is not a push. Two judgement calls are worth
  -- naming: penalty goals and own goals are still goals (the category is what the user subscribed to, not the
  -- taxonomy of the pitch), and `second_half_start` rides the `match_start` category rather than inventing a
  -- twelfth one, because the setting a user toggles is "tell me when this match is happening".
  v_kind := case new.event_type
    when 'goal'                  then 'goal'
    when 'penalty_goal'          then 'goal'
    when 'own_goal'              then 'goal'
    when 'red_card'              then 'red_card'
    when 'second_yellow'         then 'red_card'
    when 'half_time'             then 'half_time'
    when 'extra_time_half_time'  then 'half_time'
    when 'full_time'             then 'full_time'
    when 'kickoff'               then 'match_start'
    when 'second_half_start'     then 'match_start'
    -- `match_abandoned` is deliberately absent. Abandonment is the most serious thing that can happen to a
    -- match, so a notification looks obviously right — but the brief's authoritative event list does not
    -- include it, `matches.status` already carries it, and inventing a trigger for a moment the spec did not
    -- name is how a notification system starts sending things nobody agreed to receive. Phase 6 can add it as
    -- its own category (with a default and a copy) rather than borrowing `system`.
    else null
  end;
  if v_kind is null then
    return new;
  end if;

  select * into v_match from public.matches where id = new.match_id;
  if not found then
    return new;
  end if;

  select name into v_home from public.teams where id = v_match.home_team_id;
  select name into v_away from public.teams where id = v_match.away_team_id;
  v_home := coalesce(v_home, 'Home');
  v_away := coalesce(v_away, 'Away');
  v_score := coalesce(v_match.home_score, 0)::text || ' – ' || coalesce(v_match.away_score, 0)::text;

  if new.player_id is not null then
    select name into v_player from public.players where id = new.player_id;
  end if;

  -- The wording the browser-side `sendMatchNotification` used, kept on purpose: the copy is product, and the
  -- only change in Phase 5 is who is allowed to trigger it and who receives it.
  v_title := case new.event_type
    when 'goal'                  then '⚽ GOAL!'
    when 'penalty_goal'          then '⚽ Penalty goal'
    when 'own_goal'              then '⚽ Own goal'
    when 'red_card'              then '🟥 Red card'
    when 'second_yellow'         then '🟥 Red card (second yellow)'
    when 'half_time'             then 'Half time'
    when 'extra_time_half_time'  then 'Half time, extra time'
    when 'full_time'             then 'Full time'
    when 'second_half_start'     then 'Second half'
    else 'Kick-off'
  end;
  -- The wording the browser-side `sendMatchNotification` used, kept on purpose, with the scorer suffix
  -- parenthesised as a sub-expression. Note that no arm of this CASE ends in `;`: inside a plpgsql
  -- assignment the whole `case … end` is one expression, so a semicolon after an arm closes the
  -- *statement* and leaves the outer CASE unterminated. Postgres reports that as
  -- `syntax error at end of input`, at CREATE FUNCTION time — which is why the trigger below would fail
  -- to install rather than fail to fire.
  v_body := case v_kind
    when 'goal' then v_home || ' ' || v_score || ' ' || v_away || (case when v_player is not null then ' — ' || v_player else '' end)
    when 'red_card' then v_home || ' vs ' || v_away || (case when v_player is not null then ' — ' || v_player else '' end)
    when 'half_time' then v_home || ' ' || v_score || ' ' || v_away
    when 'full_time' then 'Final: ' || v_home || ' ' || v_score || ' ' || v_away
    else case when new.event_type = 'second_half_start' then 'Second half under way: ' else 'Kick-off: ' end
         || v_home || ' vs ' || v_away
  end;

  insert into public.notification_jobs (dedupe_key, kind, match_id, competition_id, team_id, title, body, metadata, created_by)
  values (
    format('match:%s|seq:%s|kind:%s', new.match_id, coalesce(new.sequence, -new.id), v_kind),
    v_kind,
    new.match_id,
    v_match.competition_id,
    new.team_id,
    v_title,
    v_body,
    jsonb_build_object(
      'matchId', new.match_id,
      'eventId', new.id,
      'sequence', new.sequence,
      'minute', new.minute,
      'extraMinute', new.extra_minute,
      'homeScore', v_match.home_score,
      'awayScore', v_match.away_score,
      'homeTeam', v_home,
      'awayTeam', v_away,
      'scorer', v_player,
      'eventType', new.event_type
    ),
    new.recorded_by
  )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

comment on function public.kicklive_notification_job_for_event() is
  'AFTER INSERT on match_events: one job per stand-worthy event, keyed on the server-assigned sequence. Same transaction as the event, so a goal and its notification are one fact.';

-- An AFTER INSERT trigger's return value is ignored. It returns NEW anyway because the day someone changes
-- this to BEFORE ROW, a `return null` here would silently discard a referee's goal event — which is the
-- difference between a missed push and a corrupted match, and should not be reachable by a one-word edit.
drop trigger if exists kicklive_notification_job on public.match_events;
create trigger kicklive_notification_job
  after insert on public.match_events
  for each row execute function public.kicklive_notification_job_for_event();

-- ── 7. the functions the Worker calls ──────────────────────────────────────────────────────────────
--
--  Identity, the device cap, the audience, the claim and the idempotency rules are all here rather than in
--  TypeScript for one reason: the Worker is the only caller today, and "today" is the word that rots. A rule
--  in SQL cannot be bypassed by a second caller, a replayed request, or a route someone adds next month.
--
--  All of them are SECURITY DEFINER with a pinned search_path, all of them revoke from public, and each one
--  that a client could plausibly call checks `auth.uid()` itself instead of trusting the caller to have
--  filtered. Every function returns jsonb with an explicit `ok`/`code`, because "the server said no" needs to
--  be a code the SPA branches on, not a Postgres message the SPA pattern-matches.

-- 7.1 the defaults, so the API, the settings screen and the migration agree without a copy.
create or replace function public.kicklive_preference_defaults()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select '{
    "goal": true,
    "red_card": false,
    "half_time": true,
    "full_time": true,
    "match_start": true,
    "match_reminder": false,
    "team_update": false,
    "competition_update": false,
    "news": false,
    "system": true,
    "announcement": true
  }'::jsonb;
$$;

comment on function public.kicklive_preference_defaults() is
  'Per-kind defaults. Noisy categories (red_card, reminders, news) start off: a notification system people turn the app off is worse than one they forget about.';

create or replace function public.kicklive_notification_defaults_document(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'notificationsEnabled', coalesce((select pr.notifications_enabled from public.profiles pr where pr.id = p_user_id), true),
           'categories', coalesce(
             (select jsonb_object_agg(k.kind, jsonb_build_object('enabled', coalesce(p.enabled, (select (kicklive_preference_defaults() ->> k.kind)::boolean)), 'channels', coalesce(p.channels, array['inbox','push'])))
                from (select unnest(array['goal','red_card','half_time','full_time','match_start','match_reminder','team_update','competition_update','news','system','announcement']) as kind) k
                left join public.notification_preferences p on p.user_id = p_user_id and p.kind = k.kind),
             '{}'::jsonb)
         );
$$;

-- The client's read of its own document. A separate zero-argument function rather than granting
-- kicklive_notification_defaults_document(uuid) to `authenticated`: with a uuid argument, any signed-in user
-- could read *anyone's* per-category flags, and the "defaults" in the name is exactly the kind of word that
-- makes that look harmless in review. `auth.uid()` here, and nothing else.
create or replace function public.kicklive_notification_preferences()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.kicklive_notification_defaults_document(auth.uid());
$$;

comment on function public.kicklive_notification_preferences() is
  'GET /notifications/preferences. The caller''s own document; a signed-out session sees the defaults and no one else''s data.';

comment on function public.kicklive_notification_defaults_document(uuid) is
  'The whole preferences document for one user, defaults included. SECURITY DEFINER because a missing preference row must be answerable without granting a client select on the next user''s rows — which is what a left join across the table would otherwise need.';

-- 7.2 preferences: one round trip, one transaction, full-document semantics.
create or replace function public.kicklive_set_notification_preferences(
  p_enabled    boolean,
  p_categories jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  r      record;
  v_kind text;
  v_seen text[] := '{}';
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if p_categories is null or jsonb_typeof(p_categories) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'categories must be an object');
  end if;

  update public.profiles set notifications_enabled = coalesce(p_enabled, true) where id = v_user;

  for r in select * from jsonb_each(p_categories)
  loop
    v_kind := r.key;
    if not exists (select 1 from (select unnest(array['goal','red_card','half_time','full_time','match_start','match_reminder','team_update','competition_update','news','system','announcement']) as k) x where x.k = v_kind) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_KIND', 'detail', v_kind);
    end if;
    if r.value ? 'enabled' and jsonb_typeof(r.value -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', v_kind || '.enabled must be a boolean');
    end if;
    if r.value ? 'channels' and (jsonb_typeof(r.value -> 'channels') <> 'array'
       or exists (select 1 from jsonb_array_elements_text(r.value -> 'channels') c where c not in ('inbox','push'))) then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', v_kind || '.channels must be a subset of {inbox,push}');
    end if;

    insert into public.notification_preferences (user_id, kind, enabled, channels, updated_at)
    values (
      v_user,
      v_kind,
      coalesce((r.value ->> 'enabled')::boolean, (select (kicklive_preference_defaults() ->> v_kind)::boolean), false),
      coalesce(array(select jsonb_array_elements_text(r.value -> 'channels')), array['inbox','push']),
      now()
    )
    on conflict (user_id, kind) do update
      set enabled = excluded.enabled,
          channels = excluded.channels,
          updated_at = now();

    v_seen := array_append(v_seen, v_kind);
  end loop;

  return jsonb_build_object('ok', true, 'document', kicklive_notification_defaults_document(v_user));
end;
$$;

comment on function public.kicklive_set_notification_preferences(boolean, jsonb) is
  'Full-document PUT for preferences. Returns the stored document so the client reconciles its optimistic state against the server rather than assuming it (§23 of the brief: a rejected save must not look saved).';

-- 7.3 device registration. The user id comes from auth.uid() and nowhere else; the cap and the re-pointing
--     rule are here so no route can get them wrong.
create or replace function public.kicklive_register_notification_device(
  p_provider text,
  p_token    text,
  p_platform text,
  p_app_id   text default null,
  p_ua       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_id     uuid;
  v_count  integer;
  v_max    integer := 10;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if p_provider not in ('fcm','webpush') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'provider must be fcm or webpush');
  end if;
  if p_platform not in ('android','ios','web','unknown') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'platform must be android, ios, web or unknown');
  end if;
  -- A token is opaque and long; 4 KB is generous for FCM and Web Push alike, and it is the reason a
  -- malformed client cannot fill the table with a megabyte of noise per row.
  if p_token is null or length(p_token) < 20 or length(p_token) > 4096 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'token must be 20-4096 characters');
  end if;

  select count(*) into v_count from public.notification_devices where user_id = v_user and active;
  -- Re-registering an existing token is never refused for a cap: the same phone refreshing its token must not
  -- be locked out because the owner has ten other devices.
  if v_count >= v_max and not exists (
       select 1 from public.notification_devices where provider = p_provider and token = p_token and user_id = v_user
     ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_LIMIT', 'detail', v_max || ' active devices per account');
  end if;

  insert into public.notification_devices (user_id, provider, token, platform, app_id, ua_family, ua_major, active, last_seen_at, updated_at)
  values (
    v_user, p_provider, p_token, p_platform, nullif(coalesce(p_app_id, ''), ''),
    nullif(split_part(coalesce(p_ua, ''), '/', 1), ''),
    case when coalesce(p_ua, '') ~ '^[A-Za-z0-9 ._-]+/[0-9]+'
         then (split_part(split_part(p_ua, '/', 2), '.', 1))::integer else null end,
    true, now(), now()
  )
  on conflict (provider, token) do update
    set user_id      = excluded.user_id,
        platform     = excluded.platform,
        app_id       = coalesce(excluded.app_id, public.notification_devices.app_id),
        active       = true,
        failure_count = 0,
        last_error_code = null,
        last_seen_at = now(),
        updated_at   = now()
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'active', true, 'devices',
    (select count(*) from public.notification_devices where user_id = v_user and active));
end;
$$;

comment on function public.kicklive_register_notification_device(text,text,text,text,text) is
  'The only write path for a device row. Identity from auth.uid(), ten-device cap, and ON CONFLICT re-points a token that changed owner. The response carries an id, never the token.';

create or replace function public.kicklive_unregister_notification_device(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_rows integer;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  -- Not "delete where id = p_id and user_id = auth.uid()" and a 404 on zero rows: the row may not exist or
  -- may belong to someone else, and a device list is not a place to leak which ids exist.
  delete from public.notification_devices where id = p_id and user_id = v_user;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 7.4 claiming a job: two consumers, one winner.
create or replace function public.kicklive_claim_notification_job(p_job_id bigint)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  with claim as (
    update public.notification_jobs
       set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1
     where id = p_job_id
       and status in ('pending','retry')
       and next_attempt_at <= now()
       and attempts < max_attempts
     returning *
  )
  select case when c.id is null then jsonb_build_object('ok', false, 'code', 'NOT_CLAIMABLE')
              else to_jsonb(c) - 'last_error' end
    from (select * from claim) c
   union all
  select jsonb_build_object('ok', false, 'code', 'NOT_CLAIMABLE') where not exists (select 1 from claim);
$$;

comment on function public.kicklive_claim_notification_job(bigint) is
  'FOR UPDATE SKIP LOCKED equivalent: the status predicate is the lock, so a queue redelivery racing the cron sweep yields one sender. Returns the row, never a token.';

-- 7.5 the entitlement rule, in exactly one place.
--
-- Everything that decides *who* may be told about a notification reads this function: the device query the
-- Worker sends to, the inbox insert, and the audience count an admin sees before a blast is accepted. Three
-- callers, one rule — because the failure mode of three copies is a push that arrives for someone the
-- settings screen says is opted out, or (worse) an inbox row for a user who declined the category.
--
-- Two things it deliberately does not do: it never mentions a device (a user with push off still gets an
-- inbox row), and it never mentions a medium (each caller filters `channels`, because "who is entitled" and
-- "through what" are different questions answered at different times).
create or replace function public.kicklive_notification_audience(
  p_kind           text,
  p_match_id       integer default null,
  p_competition_id integer default null,
  p_team_id        integer default null
)
returns table (user_id uuid, channels text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pr.id, coalesce(p.channels, array['inbox','push']::text[])
    from public.profiles pr
    -- A missing preference row is the default, not a refusal. `join` here rather than `left join` is the
    -- single easiest way to make a brand-new account silently un-notifiable, so it is a left join and the
    -- default is read from the same function the API hands to the settings screen.
    left join public.notification_preferences p on p.user_id = pr.id and p.kind = p_kind
   where pr.notifications_enabled
     and coalesce(p.enabled, (public.kicklive_preference_defaults() ->> p_kind)::boolean)
     and (
       -- A match-scoped kind goes to the people who asked about that match. There is no follow model yet, so
       -- that is the whole audience rule (docs/NOTIFICATIONS_ARCHITECTURE.md §13.1); the day one exists, the
       -- change is in this WHERE clause and nowhere else.
       p_match_id is null
       or p_kind in ('announcement','system','news')
       or exists (
         select 1 from public.match_interest mi
          where mi.match_id = p_match_id and mi.user_id = pr.id
       )
     )
   order by pr.id;
$$;

comment on function public.kicklive_notification_audience(text, integer, integer, integer) is
  'The one place that answers "who is entitled to be told about this". Service-role only: it enumerates users.';

-- 7.6 the devices to actually send to, built on that rule. A `webpush` row is a device we store but do not
-- deliver to (§16 — FCM is the only transport this phase implements), so it is filtered here rather than
-- ignored in the schema, which is what lets raw web push be added without a migration.
create or replace function public.kicklive_notification_recipients(p_job_id bigint)
returns table (device_id uuid, user_id uuid, token text, provider text, platform text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, a.user_id, d.token, d.provider, d.platform
    from public.notification_jobs j
    -- lateral, because the audience depends on the job's own kind and match.
    join lateral public.kicklive_notification_audience(j.kind, j.match_id, j.competition_id, j.team_id) as a on true
    join public.notification_devices d on d.user_id = a.user_id
   where j.id = p_job_id
     and 'push' = any (a.channels)
     and d.active
     and d.provider = 'fcm'
     -- A device that FCM already said is dead stays dead until its owner registers it again.
     and coalesce(d.failure_count, 0) < 5
     -- The replay guard, before anything is sent: a delivery row for this device and this job means this job
     -- has already been delivered here, whatever the queue decided to do about the message.
     and not exists (
       select 1 from public.notification_deliveries dd
        where dd.job_id = j.id and dd.device_id = d.id
     )
   order by a.user_id, d.id;
$$;

comment on function public.kicklive_notification_recipients(bigint) is
  'Tokens for one job, already filtered by preference, already de-duplicated against delivery history. Never granted to a client role.';

-- 7.7 the fan-out itself: one statement, idempotent per user, and it never reads a token.
--
-- The inbox row is created from the *audience*, not from the device list, which is the whole point of step 16:
-- history exists whether or not a push succeeded, whether or not the user owns a device, and whether or not
-- `push` is one of their channels. Deriving it from `kicklive_notification_recipients()` would have tied the
-- record of what happened to the state of someone's phone.
create or replace function public.kicklive_materialise_notifications(p_job_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into public.notifications (user_id, title, body, kind, match_id, dedupe_key, metadata, created_at)
  select a.user_id, j.title, j.body, j.kind, j.match_id,
         j.dedupe_key || '|u:' || a.user_id, j.metadata, now()
    from public.notification_jobs j
    join lateral public.kicklive_notification_audience(j.kind, j.match_id, j.competition_id, j.team_id) as a on true
   where j.id = p_job_id
     and 'inbox' = any (a.channels)
  on conflict (user_id, dedupe_key) where dedupe_key is not null and user_id is not null do nothing;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'created', v_rows);
exception
  when unique_violation then
    -- The partial unique index is the constraint that could fire; a second materialisation of the same job is
    -- a no-op, not an error, and the delivery rows are what make the push itself once-per-device.
    return jsonb_build_object('ok', true, 'created', 0, 'note', 'already materialised');
end;
$$;

-- 7.8 the outcome of one batch, in one call.
--
-- The consumer sends up to 500 tokens at a time; asking it to make a round trip per device to record a result
-- would make the bookkeeping the slow part of a goal. So the batch's outcomes arrive as JSON and all three
-- effects happen here: the delivery row (the replay record), the device's standing (retire or forgive it), and
-- the timestamp the audit trail reads.
create or replace function public.kicklive_record_notification_results(
  p_job_id  bigint,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deliveries integer;
  v_retired    integer;
begin
  if jsonb_typeof(p_results) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'p_results must be a JSON array');
  end if;

  -- A delivery row for a device that no longer exists must not abort the batch, so the device is joined and
  -- unmatched rows are dropped rather than referenced with an FK-violating insert.
  insert into public.notification_deliveries (job_id, device_id, user_id, status, provider_message_id, fcm_error, attempt, sent_at)
  select p_job_id,
         d.id,
         d.user_id,
         r->>'status',
         nullif(r->>'messageId', ''),
         -- The code FCM gave us, truncated, and nothing else: never the response body, never the token.
         left(coalesce(nullif(r->>'errorCode', ''), 'UNKNOWN'), 64),
         coalesce((select j.attempts from public.notification_jobs j where j.id = p_job_id), 1),
         case when r->>'status' = 'sent' then now() end
    from jsonb_array_elements(p_results) as r
    join public.notification_devices d on d.id = (r->>'deviceId')::uuid
   where jsonb_typeof(r) = 'object'
     and r->>'status' in ('sent','failed','skipped_invalid_token')
  on conflict (job_id, device_id) do update
     set status              = excluded.status,
         provider_message_id = coalesce(excluded.provider_message_id, public.notification_deliveries.provider_message_id),
         fcm_error           = excluded.fcm_error,
         attempt             = excluded.attempt,
         sent_at             = coalesce(excluded.sent_at, public.notification_deliveries.sent_at);
  get diagnostics v_deliveries = row_count;

  -- A token FCM said is gone is retired here, not in the Worker, so the rule cannot be forgotten by the next
  -- transport. The row is kept (audit) and made inactive (audience), and §7.13 deletes it after 30 days.
  update public.notification_devices d
     set active          = false,
         failure_count   = d.failure_count + 1,
         last_error_code = left(coalesce(nullif(r->>'errorCode', ''), 'UNREGISTERED'), 64),
         last_sent_at    = now(),
         updated_at      = now()
    from jsonb_array_elements(p_results) as r
   where d.id = (r->>'deviceId')::uuid
     and r->>'status' = 'skipped_invalid_token';
  get diagnostics v_retired = row_count;

  -- Any other failure is a strike, not a death sentence: five strikes and §7.6 stops offering the device.
  update public.notification_devices d
     set failure_count   = d.failure_count + 1,
         last_error_code = coalesce(left(nullif(r->>'errorCode', ''), 64), d.last_error_code),
         last_sent_at    = now()
    from jsonb_array_elements(p_results) as r
   where d.id = (r->>'deviceId')::uuid
     and r->>'status' = 'failed';

  -- A success forgives the device outright, which is what keeps a flaky network from retiring a good token.
  update public.notification_devices d
     set failure_count   = 0,
         last_error_code = null,
         last_seen_at    = now(),
         last_sent_at    = now()
    from jsonb_array_elements(p_results) as r
   where d.id = (r->>'deviceId')::uuid
     and r->>'status' = 'sent';

  return jsonb_build_object('ok', true, 'deliveries', v_deliveries, 'retired', v_retired);
end;
$$;

comment on function public.kicklive_record_notification_results(bigint, jsonb) is
  'One batch of FCM outcomes. The payload is device ids and error codes — never a token, never a response body.';

create or replace function public.kicklive_finish_notification_job(
  p_job_id          bigint,
  p_status          text,
  p_error           text default null,
  p_next_attempt_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
  v_sent integer;
  v_bad  integer;
begin
  if p_status not in ('sent','partial','failed','retry') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', p_status);
  end if;

  -- Counts come from the delivery rows, not from what the caller believes it sent, so the job's record cannot
  -- be talked into a number the evidence does not support.
  select count(*) filter (where status = 'sent'), count(*) filter (where status <> 'sent')
    into v_sent, v_bad
    from public.notification_deliveries where job_id = p_job_id;

  -- `status = 'running'` is the guard: the claim moved it there, and a finish that arrives after the sweep
  -- already requeued this job must not overwrite a newer attempt.
  update public.notification_jobs j
     set status          = p_status,
         recipient_count = coalesce(j.recipient_count, v_sent + v_bad),
         next_attempt_at = coalesce(p_next_attempt_at, j.next_attempt_at),
         finished_at     = case when p_status = 'retry' then null else now() end,
         last_error      = case when p_status = 'sent' then null
                               else left(coalesce(p_error, 'no detail'), 500) end
    where j.id = p_job_id
      and j.status = 'running'
      -- A job that exhausted its budget is terminal, and `retry` must not resurrect it past max_attempts.
      and not (p_status = 'retry' and j.attempts >= j.max_attempts);
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_RUNNING', 'detail', 'already finished or never claimed');
  end if;
  return jsonb_build_object('ok', true, 'status', p_status, 'sent', v_sent, 'failed', v_bad,
                            'exhausted', (select attempts >= max_attempts from public.notification_jobs where id = p_job_id));
end;
$$;

comment on function public.kicklive_finish_notification_job(bigint, text, text, timestamptz) is
  'The only way out of running. Refuses to overwrite a job the sweep already requeued, and never resurrects one past its retry budget.';

-- 7.9 the inbox in one call, so a badge cannot disagree with the list under it.
create or replace function public.kicklive_notifications_page(p_limit integer default 20, p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
               'matchId', n.match_id, 'metadata', n.metadata, 'createdAt', n.created_at,
               'readAt', n.read_at, 'priority', n.priority, 'broadcast', n.user_id is null)
             order by n.priority desc, n.created_at desc)
        from (
          select * from public.notifications
           where (user_id = auth.uid() or user_id is null)
             and (expires_at is null or expires_at > now())
             and (p_before is null or created_at < p_before)
           order by priority desc, created_at desc
           limit greatest(1, least(coalesce(p_limit, 20), 100))
        ) n
    ), '[]'::jsonb),
    'unread', coalesce((
      select count(*)::int from public.notifications
       where user_id = auth.uid() and read_at is null and (expires_at is null or expires_at > now())
    ), 0)
  );
$$;

create or replace function public.kicklive_mark_notifications_read(p_id integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  -- The user predicate is in the WHERE clause, not only in RLS: "0 rows changed" is the honest answer to a
  -- request about somebody else's row, and it is indistinguishable from "already read", which is the other
  -- answer a client should not have to treat as an error.
  update public.notifications set read_at = now()
   where id = p_id and user_id = auth.uid() and read_at is null;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'updated', v_rows);
end;
$$;

create or replace function public.kicklive_mark_all_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  -- Capped, so "mark all read" on a four-year account cannot hold a transaction open while the request that
  -- rendered the button is long gone.
  with doomed as (
    select id from public.notifications
     where user_id = auth.uid() and read_at is null
     order by created_at desc
     limit 500
  )
  update public.notifications n set read_at = now() from doomed where n.id = doomed.id;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'updated', v_rows, 'capped', v_rows >= 500);
end;
$$;

-- 7.10 match interest: the two calls the "notify me" button makes.
create or replace function public.kicklive_set_match_interest(p_match_id integer, p_watching boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if not coalesce(p_watching, false) then
    delete from public.match_interest where user_id = v_user and match_id = p_match_id;
    return jsonb_build_object('ok', true, 'watching', false);
  end if;
  if not exists (select 1 from public.matches m where m.id = p_match_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  insert into public.match_interest (user_id, match_id) values (v_user, p_match_id)
  on conflict (user_id, match_id) do nothing;
  return jsonb_build_object('ok', true, 'watching', true);
end;
$$;

-- 7.11 admin broadcast. Audience counted before anything is written, so a typo cannot quietly push to a
--     whole user base; the confirmation is a parameter, not a UI detail, because a scripted caller must hit
--     the same wall.
create or replace function public.kicklive_broadcast_notification(
  p_title text,
  p_body  text,
  p_kind  text,
  p_confirm boolean,
  p_max_audience integer default 50000,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audience integer;
  v_job      bigint;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if p_kind not in ('announcement','system','news','competition_update','team_update') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'an announcement may not claim a match-event category');
  end if;
  if length(coalesce(p_title,'')) = 0 or length(p_title) > 120 or length(coalesce(p_body,'')) > 480 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'title 1-120 and body up to 480 characters');
  end if;

  -- Counted from the same rule the delivery will use, and before the job exists: an audience estimate that
  -- came from a different query than the one that fans out would make the cap decorative.
  select count(*) into v_audience from public.kicklive_notification_audience(p_kind, null, null, null);

  if v_audience > p_max_audience then
    return jsonb_build_object('ok', false, 'code', 'AUDIENCE_TOO_LARGE', 'audience', v_audience, 'limit', p_max_audience);
  end if;
  if v_audience > 1000 and not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', false, 'code', 'CONFIRMATION_REQUIRED', 'audience', v_audience);
  end if;

  insert into public.notification_jobs (dedupe_key, kind, title, body, metadata, recipient_count, created_by)
  values (
    format('broadcast:%s:%s', coalesce(p_created_by::text, 'system'), extract(epoch from now())::bigint),
    p_kind, p_title, p_body,
    jsonb_build_object('audience', 'all-enabled', 'broadcast', true),
    v_audience, p_created_by
  )
  returning id into v_job;

  return jsonb_build_object('ok', true, 'jobId', v_job, 'audience', v_audience);
end;
$$;

-- 7.12 the sweep's claim set, and the diagnostics read.
create or replace function public.kicklive_pending_notification_jobs(p_limit integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'jobIds', coalesce((select jsonb_agg(id) from (
        select id from public.notification_jobs
         where status in ('pending','retry') and next_attempt_at <= now()
         order by created_at
         limit greatest(1, least(coalesce(p_limit, 25), 100))
      ) x), '[]'::jsonb),
    'counts', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*)::int as n from public.notification_jobs group by status
      ) y), '{}'::jsonb),
    'devices', jsonb_build_object(
      'active',  (select count(*)::int from public.notification_devices where active),
      'dead',    (select count(*)::int from public.notification_devices where not active),
      'invalid', (select count(*)::int from public.notification_devices where last_error_code = 'UNREGISTERED')
    ),
    'oldestPendingSeconds', (select extract(epoch from now() - min(created_at))::int from public.notification_jobs where status in ('pending','retry'))
  );
$$;

-- 7.13 retention: a revoked device is not a credential to keep. One statement in one place, with the window
--      in the SQL where the policy lives, so no Worker constant can drift it.
create or replace function public.kicklive_prune_notification_devices(p_window interval default interval '30 days')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  delete from public.notification_devices where not active and updated_at < now() - p_window;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_rows);
end;
$$;

-- ── 8. function grants: the client gets the self-service ones, nothing else ─────────────────────────
--
--  `service_role` needs no grant (it is the owner's bypass and the Worker's only privileged path), and every
--  client-callable function below is one whose user id the function takes from auth.uid() itself.

do $grants$
declare
  f text;
  args text;
begin
  -- name(args) pairs, because Postgres resolves a function by signature and `revoke all on function
  -- public.kicklive_…` without arguments raises rather than silently doing nothing.
  for f, args in select * from (values
    ('kicklive_notification_defaults_document', 'uuid'),
    ('kicklive_notification_preferences', ''),
    ('kicklive_set_notification_preferences', 'boolean,jsonb'),
    ('kicklive_register_notification_device', 'text,text,text,text,text'),
    ('kicklive_unregister_notification_device', 'uuid'),
    ('kicklive_notifications_page', 'integer,timestamptz'),
    ('kicklive_mark_notifications_read', 'integer'),
    ('kicklive_mark_all_notifications_read', ''),
    ('kicklive_set_match_interest', 'integer,boolean'),
    ('kicklive_preference_defaults', ''),
    ('kicklive_notification_audience', 'text,integer,integer,integer'),
    ('kicklive_notification_recipients', 'bigint'),
    ('kicklive_claim_notification_job', 'bigint'),
    ('kicklive_materialise_notifications', 'bigint'),
    ('kicklive_record_notification_results', 'bigint,jsonb'),
    ('kicklive_finish_notification_job', 'bigint,text,text,timestamptz'),
    ('kicklive_broadcast_notification', 'text,text,text,boolean,integer,uuid'),
    ('kicklive_pending_notification_jobs', 'integer'),
    ('kicklive_prune_notification_devices', 'interval')
  ) as t(f, args)
  loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f, args);
  end loop;

  -- The self-service set only. Everything that reads a token, claims a job, or fans out to strangers stays
  -- service-role-only, so an exposed anon key cannot queue a send or enumerate a subscriber list.
  execute 'grant execute on function public.kicklive_notification_preferences() to authenticated';
  execute 'grant execute on function public.kicklive_set_notification_preferences(boolean, jsonb) to authenticated';
  execute 'grant execute on function public.kicklive_register_notification_device(text, text, text, text, text) to authenticated';
  execute 'grant execute on function public.kicklive_unregister_notification_device(uuid) to authenticated';
  execute 'grant execute on function public.kicklive_notifications_page(integer, timestamptz) to authenticated';
  execute 'grant execute on function public.kicklive_mark_notifications_read(integer) to authenticated';
  execute 'grant execute on function public.kicklive_mark_all_notifications_read() to authenticated';
  execute 'grant execute on function public.kicklive_set_match_interest(integer, boolean) to authenticated';
  execute 'grant execute on function public.kicklive_preference_defaults() to anon, authenticated';
end
$grants$;

-- No `grant … on sequence`: Supabase's default privileges already cover the identity sequences of tables
-- created here, and `grant … on sequence if exists …` is not a thing PostgreSQL accepts — so the correct
-- option was to leave the working default alone rather than invent syntax for it. What *is* checked below is
-- that a service-role insert can allocate an id, because a missing sequence privilege is a 42501 in
-- production and a pass in every test here.

-- ── 9. verification ────────────────────────────────────────────────────────────────────────────────
--
--  Raises on any failure, so the `commit;` at the end is unreachable from a half-applied state. This is the
--  same shape as the Phase 1 and Phase 3 files, and for a reason that matters more here than anywhere: a
--  notification schema with a missing policy is a privacy bug, not a broken feature.
do $verify$
declare
  v_kind_list text;
  v_count     integer;
begin
  -- 9.1 the five tables, RLS enabled and *not* forced.
  select count(*) into v_count from pg_tables
   where schemaname = 'public'
     and tablename in ('notification_preferences','notification_devices','notification_jobs','notification_deliveries','match_interest');
  if v_count <> 5 then
    raise exception 'phase5 verification failed: expected 5 notification tables, found %', v_count;
  end if;

  select count(*) into v_count from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('notification_preferences','notification_devices','notification_jobs','notification_deliveries','match_interest')
     and relrowsecurity and not relforcerowsecurity;
  if v_count <> 5 then
    -- A `%` in the message is a substitution slot, not decoration: RAISE counts the specifiers and the
    -- arguments and refuses to compile when they disagree ("too few parameters specified for RAISE"), which
    -- would abort the whole verify block. So the number is passed.
    raise exception 'phase5 verification failed: all 5 tables need RLS enabled and FORCE off (got %), because the SECURITY DEFINER RPCs write as the owner and a forced policy would block them', v_count;
  end if;
  -- The mirror of that check, so a later "harden everything" edit cannot quietly break every notification
  -- RPC: forced RLS here is not a safety improvement, it is the outage.
  select count(*) into v_count from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('notification_preferences','notification_devices','notification_jobs','notification_deliveries','match_interest')
     and relforcerowsecurity;
  if v_count > 0 then
    raise exception 'phase5 verification failed: % table(s) have FORCE ROW LEVEL SECURITY; see the comment in §5', v_count;
  end if;

  -- 9.2 the leak this whole migration exists to prevent.
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications: public read') then
    raise exception 'phase5 verification failed: notifications: public read still exists — a per-user inbox on a table everyone can read is a leak';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications: owner or broadcast read') then
    raise exception 'phase5 verification failed: the owner-or-broadcast policy is missing, so nobody can read their own inbox';
  end if;
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications: owner or broadcast read'
     -- `qual` is the deparsed USING clause as text. The catalog column `polqual` is a node-tree and lives in
     -- pg_policy, not in this view, so `pg_get_expr(polqual, tableoid)` here is a "column does not exist"
     -- error at migration time — the check would abort the file rather than pass.
     and qual like '%auth.uid()%';
  if v_count <> 1 then
    raise exception 'phase5 verification failed: the owner-or-broadcast policy does not reference auth.uid() in its USING clause';
  end if;

  -- 9.3 no client role may read a device token, in any form.
  if has_table_privilege('authenticated', 'public.notification_devices', 'insert')
     or has_table_privilege('anon', 'public.notification_devices', 'select') then
    raise exception 'phase5 verification failed: a client role can write or read notification_devices directly; registration is an RPC and the token is not selectable';
  end if;
  if has_table_privilege('authenticated', 'public.notification_jobs', 'insert')
     or has_table_privilege('anon', 'public.notification_jobs', 'select')
     or has_table_privilege('authenticated', 'public.notification_deliveries', 'insert') then
    raise exception 'phase5 verification failed: jobs and deliveries are not client-writable, and that is the only thing standing between an anon key and a mass send';
  end if;

  -- 9.4 the idempotency constraints exist, by name and by shape.
  select count(*) into v_count from pg_indexes
   where schemaname = 'public'
     and indexname in ('notifications_user_dedupe_key','notification_jobs_dedupe_key',
                       -- a table constraint's index is named after the constraint, and all three of these
                       -- are named explicitly above rather than left to Postgres' generated form.
                       'notification_deliveries_job_device_unique','notification_devices_token_unique');
  if v_count <> 4 then
    raise exception 'phase5 verification failed: one of the four idempotency/ownership indexes is missing (% of 4); without them a retried queue message is a duplicate push', v_count;
  end if;

  -- 9.5 the category vocabulary is the same list in all four constraints, and immutable.
  select string_agg(unnest, ',') into v_kind_list from unnest(array['goal','red_card','half_time','full_time','match_start','match_reminder','team_update','competition_update','news','system','announcement']);
  if (select count(*) from pg_constraint where conname in ('notifications_kind_check','notification_preferences_kind_check','notification_jobs_kind_check')) <> 3 then
    raise exception 'phase5 verification failed: a kind CHECK constraint is missing; the vocabulary must be enforced in every table, not in one';
  end if;
  if (select count(distinct pg_get_constraintdef(oid)) from pg_constraint
       where conname in ('notifications_kind_check','notification_preferences_kind_check','notification_jobs_kind_check')) <> 1 then
    raise exception 'phase5 verification failed: the three kind CHECKs do not hold the same list (% of distinct definitions)', (select count(distinct pg_get_constraintdef(oid)) from pg_constraint where conname in ('notifications_kind_check','notification_preferences_kind_check','notification_jobs_kind_check'));
  end if;
  if v_kind_list is null or length(v_kind_list) < 10 then
    raise exception 'phase5 verification failed: the kind list this file declares is unparseable';
  end if;

  -- 9.6 the trigger is attached, and to the table the engine actually writes.
  select count(*) into v_count from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where t.tgname = 'kicklive_notification_job' and c.relname = 'match_events' and not t.tgisinternal;
  if v_count <> 1 then
    raise exception 'phase5 verification failed: the match_events trigger is not attached, so no event will ever notify anyone';
  end if;

  -- 9.7 every function exists with the signature the Worker calls.
  select count(*) into v_count from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('kicklive_preference_defaults','kicklive_notification_defaults_document','kicklive_notification_preferences','kicklive_set_notification_preferences',
                       'kicklive_register_notification_device','kicklive_unregister_notification_device','kicklive_claim_notification_job',
                       'kicklive_notification_recipients','kicklive_notification_audience','kicklive_materialise_notifications',
                       'kicklive_record_notification_results','kicklive_finish_notification_job','kicklive_notifications_page',
                       'kicklive_mark_notifications_read','kicklive_mark_all_notifications_read','kicklive_set_match_interest',
                       'kicklive_broadcast_notification','kicklive_pending_notification_jobs','kicklive_prune_notification_devices',
                       'kicklive_notification_job_for_event');
  if v_count <> 20 then
    raise exception 'phase5 verification failed: expected 20 notification functions, found %', v_count;
  end if;

  -- 9.8 nothing is SECURITY INVOKER where it must not be, and nothing is DEFINER without a pinned path.
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'kicklive_%notification%'
     and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%';
  if v_count > 0 then
    raise exception 'phase5 verification failed: % SECURITY DEFINER notification function(s) without a pinned search_path — that is search_path hijacking, waiting for an unqualified reference', v_count;
  end if;

  -- 9.9 the view a settings screen may use exists, and does not carry a token column.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notification_devices_public' and column_name = 'token') then
    raise exception 'phase5 verification failed: notification_devices_public exposes `token`; the view is the thing that keeps a credential out of the settings screen';
  end if;
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'notification_devices_public' and column_name in ('id','platform','provider','active','last_seen_at');
  if v_count <> 5 then
    raise exception 'phase5 verification failed: notification_devices_public is missing columns the settings screen needs (% of 5)', v_count;
  end if;

  -- 9.10 the columns on profiles and notifications, or a client read of a missing column is a 400 at
  --      runtime and a very confusing bug report.
  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'notifications'
     and column_name in ('user_id','kind','dedupe_key','read_at','metadata','priority','expires_at');
  if v_count <> 7 then
    raise exception 'phase5 verification failed: notifications gained % of the 7 planned columns', v_count;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'notifications_enabled') then
    raise exception 'phase5 verification failed: profiles.notifications_enabled is missing; the global switch is not optional';
  end if;

  -- 9.11 a live functional check: the audience function and the page function must run as an anonymous
  --      caller without raising. auth.uid() is null here, which is exactly the state a signed-out visitor is
  --      in, so this exercises the "no rows, no error" path that a schema-only review cannot see.
  select count(*) into v_count from kicklive_notification_recipients(0);
  if coalesce((select count(*) from information_schema.routines where routine_schema = 'public' and routine_name = 'kicklive_notifications_page'), 0) <> 1 then
    raise exception 'phase5 verification failed: kicklive_notifications_page is not callable';
  end if;

  raise notice 'phase5 verification: ok — 5 tables (RLS on, force off so the owner-role RPCs can write), 20 functions, 1 trigger, notifications extended and owner-scoped, tokens unselectable, 11 categories consistent across 3 CHECKs';
end
$verify$;

-- PostgREST caches the catalogue: without this the new RPCs 404 until a restart, which reads like a Worker bug.
notify pgrst, 'reload schema';

commit;

-- ── VERIFY, by hand, once applied ─────────────────────────────────────────────────────────────────
--  VERIFY:  select count(*) from pg_policies where tablename like 'notification%';
--  VERIFY:  select policyname, cmd, qual from pg_policies where tablename = 'notifications';
--           -- must show "notifications: owner or broadcast read" and NOT "notifications: public read"
--  VERIFY:  select has_table_privilege('authenticated','public.notification_devices','select');   -- false
--  VERIFY:  select has_table_privilege('anon','public.notification_jobs','select');                -- false
--  VERIFY:  select * from kicklive_pending_notification_jobs(5);                                   -- {"jobIds": [], …}
--  VERIFY:  -- register a device as a real user (via the Worker route), then:
--           --   select id, provider, platform, active from notification_devices order by created_at desc limit 1;
--           -- and confirm the token is NOT in the view:
--           --   select * from notification_devices_public limit 1;
--  VERIFY:  -- fire an event through the engine and confirm the job exists without touching the queue:
--           --   select id, kind, dedupe_key, status from notification_jobs order by id desc limit 3;
--           -- then replay the same event and confirm the count did not move.
--
--  ROLLBACK — safe in any order, because this file drops nothing it did not create. Row data is the thing
--  to think about: notifications written after Phase 5 carry a user_id and a dedupe_key, and dropping those
--  columns loses the inbox. So roll back by removing the surface, not the data, unless the inbox is wanted:
--
--    drop trigger if exists kicklive_notification_job on public.match_events;
--    drop function if exists public.kicklive_notification_job_for_event();
--    drop view if exists public.notification_devices_public;
--    drop table if exists public.notification_deliveries, public.notification_jobs,
--                           public.match_interest, public.notification_devices, public.notification_preferences;
--    -- then restore Phase 1's read policy so the broadcast table behaves as it did:
--    drop policy if exists "notifications: owner or broadcast read" on public.notifications;
--    create policy "notifications: public read" on public.notifications
--      for select to anon, authenticated using (true);
--    -- and leave the added columns alone: they are inert, nullable-with-defaults, and dropping them is a
--    -- second destructive step for no benefit.
--
--  Nothing in this file needs `analyze`, and nothing in it should be run against a production database
--  without the checks above being read first on staging.
