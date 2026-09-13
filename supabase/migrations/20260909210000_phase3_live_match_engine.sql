-- ============================================================================
--  Kick Live — Phase 3: the live match engine
--  File: supabase/migrations/20260909210000_phase3_live_match_engine.sql
--  Applies to: the project described by KICKLIVE_FINAL_SCHEMA.sql (see supabase/README.md)
--  Prerequisite: 20260909120000_phase1_security_hardening.sql (it reuses is_admin() and the
--                revoke-anon-DML posture; applying this one without Phase 1 leaves the column
--                guards weaker than they are written to be).
-- ============================================================================
--
-- WHAT THIS IS
--   Postgres becomes the authority for a live match. Everything the browser used to decide —
--   the score, the minute, the status, the order events happened in, who is allowed to write —
--   is decided here instead, by name, in one place:
--
--     1. `match_assignments`          who is officiating *this* match (the resource-level grant);
--     2. columns on `match_events`    sequence, period, idempotency key, correction state, recorder;
--     3. `matches.live_seq`           the per-match sequence counter, allocated under a row lock;
--     4. `kicklive_*` functions       validate → append → derive score/clock → audit, atomically;
--     5. column guards                a browser can no longer hand-write a result once a match is
--                                     engine-owned, no matter what its role or its UI looks like;
--     6. append-only                  an accepted event is never overwritten or deleted in place.
--
-- WHAT THIS DOES NOT DO
--   * No DROP TABLE / DROP COLUMN / TRUNCATE / DELETE of match data. Every existing `match_events`
--     row keeps its id and gains nullable columns; existing `matches` rows are untouched.
--   * No new status values and no new event types: `matches.status` keeps its 14-value CHECK list and
--     `match_events.event_type` its 27-value list. This file is additive; a contradiction between the
--     app and the database is worse than any missing feature.
--   * It does not touch `players.goals / assists / yellow_cards / red_cards / appearances`. Those are
--     *season* counters with no per-match ledger to recompute them from, and the engine refuses to
--     invent one: a goal recorded here updates the match's derived score, and the season rollup stays
--     whatever Phase 4 gives it a proper source for. (Known limitation, stated in the Phase 3 report.)
--   * No notifications, standings recompute, R2 or advertising. Declared elsewhere, deliberately absent.
--
-- HOW THE SCORE STAYS TRUE
--   `matches.home_score / away_score` are *derived*, written only from the fold over
--   `match_events` where `event_status = 'active'`:
--
--     goal / penalty_goal  → +1 to team_id (in a shoot-out period: to the shoot-out tally instead)
--     own_goal             → +1 to the *other* side
--     everything else      → no effect on the score
--
--   There is no "set the score" path in this migration, so a correction recalculates rather than
--   needing a second manual edit, and two controllers cannot disagree about the number.
--
-- THE RATCHET (why this is safe to apply while the old admin screens still exist)
--   The `matches` guard rejects a browser-authored change to `home_score / away_score / minute /
--   status / match_start_time / elapsed_seconds_before_pause / is_locked / confirmed_at / live_seq`
--   **only for a match the engine has taken over**, i.e. once `live_seq > 0`. Every other fixture keeps
--   behaving exactly as it does today. So a match enters the engine's protection at its first
--   recorded event, and nothing that is not live is disturbed by applying this file.
--
-- HOW TO APPLY
--   a) CLI, preferred:  supabase link --project-ref <ref>
--                       supabase db push              # then re-run the verification block below
--   b) Dashboard:       SQL Editor → paste → Run, in a quiet window. The whole file is one
--                       transaction, so a project either has the engine or still has what it had.
--   c) `psql "$DIRECT_URL" -f thisfile` — equivalent to (b).
--
--   The Durable Object layer (workers/src/do/MatchRoom.ts) degrades safely without this file: it
--   answers `503 DEPENDENCY_FAILED` naming this filename rather than accepting an event it cannot
--   persist. Applying it is therefore the deploy step, not a prerequisite for a build.
--
-- ROLLBACK: the inverse is at the bottom, commented out. It drops no data either.
-- ============================================================================

begin;

-- ============================================================================
-- 1 · MATCH ASSIGNMENTS — who may control *this* match
-- ============================================================================
-- Until now "the referee" was a free-text column on `matches` (`referee TEXT`), which can name a
-- person but cannot authenticate one. Control has to be a row, because a capability matrix can only
-- answer "is this an admin", and the question a live match asks is "is *this account* the head
-- referee of *this fixture*".
--
-- `role` is an officiating role, not an application role: the same person is a `fan` or
-- `team_manager` in `profiles` and a `head_referee` here. That separation is the point — being
-- assigned is revocable per match and never widens the account's own privileges anywhere else.

create table if not exists public.match_assignments (
  id           uuid        primary key default gen_random_uuid(),
  match_id     integer     not null references public.matches(id) on delete cascade,
  user_id      uuid        not null references public.profiles(id) on delete cascade,
  role         text        not null check (role in (
                              'head_referee', 'assistant_referee', 'fourth_official',
                              'var_official', 'match_commissioner', 'data_operator'
                            )),
  -- `stood_down` rather than a delete: "who was on this match in the 62nd minute" is a question a
  -- dispute asks, and a row that can be removed is not evidence.
  status       text        not null default 'assigned' check (status in ('assigned', 'stood_down')),
  note         text,
  assigned_by  uuid        references public.profiles(id) on delete set null,
  assigned_at  timestamptz not null default now(),
  stood_down_at timestamptz,
  constraint match_assignments_one_role_per_pair unique (match_id, user_id, role)
);

create index if not exists match_assignments_match_idx on public.match_assignments (match_id, status);
create index if not exists match_assignments_user_idx on public.match_assignments (user_id, status);

comment on table public.match_assignments is
  'Per-match officiating assignments. The only grant of match-control authority for a non-admin.';
comment on column public.match_assignments.role is
  'Officiating role. head_referee and match_commissioner may also close a match; data_operator may not.';

-- Privileges first, policies second: a table with a permissive policy and no grant is still closed,
-- and a table with a grant and no policy is open to whoever RLS lets in. Doing it in this order means
-- a half-applied migration never exposes the table.
revoke all on public.match_assignments from public, anon, authenticated;
grant select on public.match_assignments to authenticated;
-- No insert/update/delete grant for any client role: the only way in is
-- kicklive_assign_match() / kicklive_stand_down_assignment(), which re-check admin-ness internally.

alter table public.match_assignments enable row level security;

-- An official always sees their own rows (their console needs to know it is on the match); an admin
-- sees all of them. No anonymous visibility: which humans are officiating is not a public list.
drop policy if exists "match_assignments: own rows readable" on public.match_assignments;
create policy "match_assignments: own rows readable" on public.match_assignments
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "match_assignments: admin reads all" on public.match_assignments;
create policy "match_assignments: admin reads all" on public.match_assignments
  for select to authenticated using (public.is_admin());

-- The engine's own reads (inside SECURITY DEFINER functions, as the table owner) must see every
-- assignment row, and the owner is exempt from RLS by default — so no `force row level security` here.
-- Adding it would make `kicklive_record_match_event` read zero rows and reject every official, which
-- is the opposite of what this table is for. (Phase 1 learned the same thing on `access_requests`.)

-- ============================================================================
-- 2 · MATCH EVENTS — the ledger gains the fields a live service needs
-- ============================================================================
-- All additive, all nullable or defaulted: a project with three seasons of history takes this without
-- rewriting a row (except the `sequence` backfill below, which only fills what is missing).

alter table public.match_events
  add column if not exists client_event_id   text,
  add column if not exists sequence          integer,
  add column if not exists period            text not null default 'unknown',
  add column if not exists event_status      text not null default 'active',
  add column if not exists corrects_event_id integer,
  add column if not exists correction_reason text,
  add column if not exists corrected_by      uuid references public.profiles(id) on delete set null,
  add column if not exists corrected_at      timestamptz,
  add column if not exists recorded_by       uuid references public.profiles(id) on delete set null,
  add column if not exists recorded_by_role  text,
  add column if not exists metadata          jsonb;

-- Same list as `MatchPeriod` in workers/src/lib/matchLifecycle.ts, plus the `unknown` the column
-- defaults to for rows written before the engine existed. A test compares the two lists.
alter table public.match_events drop constraint if exists match_events_period_check;
alter table public.match_events
  add constraint match_events_period_check
  check (period in ('pre','first','half_time','second','extra_first','extra_second','shootout','done','interrupted','unknown'));

-- Only two row states: `corrected` is the end of an event's life, and a reversal is expressed as a
-- correction pair (the original marked corrected + a replacement row), never as a third state that
-- silently un-counts something.
alter table public.match_events drop constraint if exists match_events_event_status_check;
alter table public.match_events
  add constraint match_events_event_status_check
  check (event_status in ('active','corrected'));

-- Idempotency, in the one place it can be atomic. Two POSTs of the same draft are the same event.
create unique index if not exists match_events_client_event_key
  on public.match_events (match_id, client_event_id)
  where client_event_id is not null;

-- Server order per match. Partial so the backfill can proceed row by row without violating it.
create unique index if not exists match_events_match_sequence_key
  on public.match_events (match_id, sequence)
  where sequence is not null;
create index if not exists match_events_match_sequence_idx
  on public.match_events (match_id, sequence asc, id)
  where sequence is not null;
create index if not exists match_events_player_idx on public.match_events (player_id, event_type);
create index if not exists match_events_match_type_idx on public.match_events (match_id, event_type);

comment on column public.match_events.sequence is
  'Per-match order, allocated by kicklive_record_match_event from matches.live_seq. Never accepted from a client.';
comment on column public.match_events.client_event_id is
  'The controller''s idempotency key. Unique per (match, key): a retry returns the original row.';
comment on column public.match_events.event_status is
  'active | corrected. Append-only ledger state; a correction never deletes the original.';
comment on column public.match_events.metadata is
  'Small structured extras only (photo_url, video_url, var_decision, penalty_round, shootout_index, body_part, clock_note). The Worker whitelist validates it; the browser never renders it raw.';

-- `match_statistics` has no shoot-out columns, so the shoot-out tally stays derived from the shoot-out
-- period's events. Adding two columns here would be the other option; the fold is already the authority
-- for the score, and one more hand-maintained pair of numbers is one more way to disagree.

-- Backfill sequence for legacy rows, oldest first, per match. Idempotent: rows that already have one
-- are left alone, so re-running this file cannot renumber history.
with ranked as (
  select e.id, row_number() over (partition by e.match_id order by e.created_at nulls last, e.id) as rn
    from public.match_events e
   where e.sequence is null
)
update public.match_events e
   set sequence = ranked.rn
  from ranked
 where e.id = ranked.id;

-- ============================================================================
-- 3 · MATCHES — the counters the engine owns
-- ============================================================================
-- `minute` and `status` already exist and keep their meaning; what is new is *who may write them*.

alter table public.matches
  add column if not exists live_seq         integer not null default 0,
  add column if not exists stoppage_minutes smallint,
  add column if not exists live_updated_at  timestamptz;

comment on column public.matches.live_seq is
  'Highest sequence allocated for this match. Doubles as the ratchet: 0 means the engine has never '
  'written this fixture, so the legacy browser path may still edit it.';
comment on column public.matches.stoppage_minutes is
  'Announced stoppage for the running period, in minutes. Set by a transition, never by a client clock.';
comment on column public.matches.live_updated_at is
  'When the engine last committed anything here. Lets a reader judge staleness without a socket.';

create index if not exists matches_live_seq_idx on public.matches (live_seq) where live_seq > 0;

-- ============================================================================
-- 4 · RIGHTS — the same answer the Worker computes, from the rows
-- ============================================================================
-- Deliberately duplicated, not delegated: the Worker's check is what produces a *nice 403*, and this
-- is what makes an unauthorised write impossible if the Worker is wrong, bypassed, or a future caller
-- talks to PostgREST directly. `assertSupabaseUrl` and the bearer token make `auth.uid()` real here.

create or replace function public.kicklive_match_rights(p_match_id integer)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_match   record;
  v_admin   boolean := false;
  v_roles   text[] := '{}';
  v_owns    boolean := false;
begin
  select m.id, m.status, m.home_team_id, m.away_team_id, coalesce(m.is_locked,false) as is_locked
    into v_match
    from public.matches m
   where m.id = p_match_id;

  if not found then
    return jsonb_build_object('match_id', p_match_id, 'exists', false);
  end if;

  if v_uid is not null then
    select exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'admin') into v_admin;
    select coalesce(array_agg(a.role order by a.assigned_at), '{}') into v_roles
      from public.match_assignments a
     where a.match_id = p_match_id and a.user_id = v_uid and a.status = 'assigned';
    select exists (
      select 1 from public.teams t
       where t.owner_id = v_uid
         and t.id in (v_match.home_team_id, v_match.away_team_id)
    ) into v_owns;
  end if;

  return jsonb_build_object(
    'match_id', p_match_id,
    'exists', true,
    'status', v_match.status,
    'is_locked', v_match.is_locked,
    'is_admin', v_admin,
    'assignments', to_jsonb(v_roles),
    'owns_a_club_in_this_match', v_owns,
    -- Mirrors services/matchAccess.ts: four officiating roles control, two of them close.
    'can_control', v_admin or v_roles && array['head_referee','assistant_referee','fourth_official','var_official'],
    'can_close',   v_admin or v_roles && array['head_referee','match_commissioner'],
    'can_lock',    v_admin,
    'can_correct_own',  v_admin or v_roles && array['head_referee','assistant_referee','fourth_official','var_official'],
    'can_correct_any',  v_admin,
    'can_reopen',       v_admin
  );
end;
$$;

comment on function public.kicklive_match_rights(integer) is
  'The per-match authority snapshot for the current JWT subject. Read by the engine functions and by GET /api/matches/:id/access.';

revoke all on function public.kicklive_match_rights(integer) from public, anon;
grant execute on function public.kicklive_match_rights(integer) to authenticated;

-- The one flag the column guards look for to recognise the engine's own writes. Transaction-local
-- (`set_config(..., true)`), so it cannot leak into a pooled connection, and a browser cannot set it:
-- PostgREST only forwards a fixed allowlist of GUCs, and `SET ROLE` changes current_user but not
-- session_user, which is the second half of the test.
create or replace function public.kicklive_enter_engine()
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('kicklive.engine', 'on', true);
end;
$$;

revoke all on function public.kicklive_enter_engine() from public, anon;
grant execute on function public.kicklive_enter_engine() to authenticated;

-- The derived score: a fold over the surviving rows, in one place so every caller agrees.
create or replace function public.kicklive_match_score(p_match_id integer)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'home', coalesce(sum(case
              when e.event_type in ('goal','penalty_goal') and t.id = m.home_team_id and e.period <> 'shootout' then 1
              when e.event_type = 'own_goal' and t.id = m.away_team_id then 1
              else 0 end), 0),
    'away', coalesce(sum(case
              when e.event_type in ('goal','penalty_goal') and t.id = m.away_team_id and e.period <> 'shootout' then 1
              when e.event_type = 'own_goal' and t.id = m.home_team_id then 1
              else 0 end), 0),
    'shootout', jsonb_build_object(
      'home', coalesce(sum(case when e.period = 'shootout' and e.event_type in ('goal','penalty_goal') and t.id = m.home_team_id then 1 else 0 end), 0),
      'away', coalesce(sum(case when e.period = 'shootout' and e.event_type in ('goal','penalty_goal') and t.id = m.away_team_id then 1 else 0 end), 0)
    )
  )
    from public.matches m
    left join lateral (
      select e2.event_type, e2.team_id, e2.period
        from public.match_events e2
       where e2.match_id = m.id and e2.event_status = 'active'
    ) e on true
    left join public.teams t on t.id = e.team_id
   where m.id = p_match_id;
$$;

comment on function public.kicklive_match_score(integer) is
  'home/away/shootout derived from active match_events. Own goals credit the opposing side; a shoot-out goal never enters the match score. Must stay equal to scoreFromEvents() in workers/src/lib/matchEvents.ts (pinned by tests/unit/live-match-engine.test.ts).';

revoke all on function public.kicklive_match_score(integer) from public, anon, authenticated;
grant execute on function public.kicklive_match_score(integer) to anon, authenticated;

-- The derived clock. `matches.minute` is a *rendering* of these three inputs, never an input itself.
create or replace function public.kicklive_match_clock(p_match_id integer)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_match   record;
  v_running boolean;
  v_seconds numeric;
  v_minute  integer;
  v_period  text;
begin
  select m.status, m.match_start_time, coalesce(m.elapsed_seconds_before_pause,0) as elapsed, m.stoppage_minutes
    into v_match
    from public.matches m where m.id = p_match_id;
  if not found then return null; end if;

  v_running := v_match.status in ('live','first_half','second_half','extra_time');
  v_seconds := v_match.elapsed::numeric + case
                  when v_running and v_match.match_start_time is not null
                    then greatest(0, extract(epoch from (now() - v_match.match_start_time)))
                  else 0 end;
  v_minute  := floor(v_seconds / 60)::integer + case when v_running then 1 else 0 end;

  v_period := case v_match.status
                when 'scheduled' then 'pre'
                when 'waiting' then 'pre'
                when 'live' then 'first'
                when 'first_half' then 'first'
                when 'half_time' then 'half_time'
                when 'second_half' then 'second'
                when 'extra_time' then 'extra_first'
                when 'penalty_shootout' then 'shootout'
                when 'suspended' then 'interrupted'
                when 'postponed' then 'interrupted'
                when 'cancelled' then 'interrupted'
                when 'abandoned' then 'interrupted'
                else 'done' end;

  return jsonb_build_object(
    'kind', case when v_running then 'wallclock'
                 when v_match.status in ('half_time','suspended') then 'paused'
                 else 'none' end,
    'started_at', case when v_running then v_match.match_start_time else null end,
    'elapsed_before_pause', v_match.elapsed,
    'minute', v_minute,
    'stoppage', v_match.stoppage_minutes,
    'period', v_period,
    'status', v_match.status
  );
end;
$$;

revoke all on function public.kicklive_match_clock(integer) from public, anon, authenticated;
grant execute on function public.kicklive_match_clock(integer) to anon, authenticated;

-- The event's own status, for the "is this legal right now" question both sides ask.
create or replace function public.kicklive_period_of(p_status text)
returns text
language sql immutable
as $$
  select case p_status
    when 'scheduled' then 'pre'      when 'waiting' then 'pre'
    when 'live' then 'first'         when 'first_half' then 'first'
    when 'half_time' then 'half_time' when 'second_half' then 'second'
    when 'extra_time' then 'extra_first' when 'penalty_shootout' then 'shootout'
    when 'suspended' then 'interrupted' when 'postponed' then 'interrupted'
    when 'cancelled' then 'interrupted'  when 'abandoned' then 'interrupted'
    else 'done' end;
$$;

create or replace function public.kicklive_minute_ceiling(p_status text)
returns integer
language sql immutable
as $$
  -- Generous by design: 45+8 of stoppage and a delayed restart are real. The job is to catch a
  -- `minute: 900` typo or a clock that ran while a tab slept, not to argue about 94'.
  select case public.kicklive_period_of(p_status)
    when 'pre' then 0
    when 'first' then 57
    when 'half_time' then 57
    when 'second' then 57
    when 'extra_first' then 75
    when 'extra_second' then 75
    when 'shootout' then 120
    when 'interrupted' then 130
    else 130 end;
$$;

-- ============================================================================
-- 5 · THE TRANSITION TABLE — as data, so the database can enforce it too
-- ============================================================================
-- The same rows workers/src/lib/matchLifecycle.ts uses, seeded here rather than trusted from the
-- caller. The anti-drift test (`tests/unit/live-match-engine.test.ts`) parses this INSERT and compares
-- it against `transitionsFrom()` row for row, so TypeScript and SQL cannot quietly grow different ideas
-- about what is legal. A move that is not in this table is refused *here*, in the database, even if the
-- Worker, the console and the mobile app all agree to allow it.
--
-- Two absences are deliberate and worth reading before "fixing" them:
--   * no status for the extra-time interval: `matches.status` has 14 values and inventing a 15th would
--     split every query that filters live matches. The interval is a `suspended` transition (bank the
--     clock) plus the `extra_time_half_time` event, which marks the moment in the timeline.
--   * no backwards move (second_half → first_half): the clock does not run backwards. A wrong period is
--     fixed with a correction to the events, which is auditable, rather than by rewinding the fixture.

create table if not exists public.kicklive_match_transitions (
  from_status     text    not null,
  to_status       text    not null,
  label           text    not null,
  requires_admin  boolean not null default false,
  reason_required boolean not null default false,
  primary key (from_status, to_status),
  constraint kicklive_transitions_known_status
    check (from_status in ('scheduled','waiting','first_half','half_time','second_half','extra_time',
                           'penalty_shootout','full_time','suspended','postponed','abandoned','cancelled',
                           'completed','live')
       and to_status in ('scheduled','waiting','first_half','half_time','second_half','extra_time',
                         'penalty_shootout','full_time','suspended','postponed','abandoned','cancelled',
                         'completed','live')),
  constraint kicklive_transitions_not_self check (from_status <> to_status)
);

comment on table public.kicklive_match_transitions is
  'Reference data: the legal status moves of a match. Read by kicklive_transition_match() and mirrored by workers/src/lib/matchLifecycle.ts.';

-- Reference data derived from the application's table, so it is replaced rather than merged: a stale
-- legal move left behind by a previous version would be a security property, not a cosmetic one.
delete from public.kicklive_match_transitions;

insert into public.kicklive_match_transitions (from_status, to_status, label, requires_admin, reason_required) values
  ('scheduled','waiting','Check in',false,false),
  ('scheduled','first_half','Kick off',false,false),
  ('scheduled','live','Kick off',false,false),
  ('scheduled','postponed','Postpone',true,true),
  ('scheduled','cancelled','Cancel',true,true),
  ('waiting','first_half','Kick off',false,false),
  ('waiting','live','Kick off',false,false),
  ('waiting','scheduled','Stand down',false,false),
  ('waiting','postponed','Postpone',true,true),
  ('waiting','cancelled','Cancel',true,true),
  ('first_half','half_time','Half time',false,false),
  ('first_half','suspended','Suspend',false,true),
  ('first_half','abandoned','Abandon',false,true),
  ('first_half','postponed','Postpone',true,true),
  ('first_half','full_time','Full time',false,false),
  ('live','half_time','Half time',false,false),
  ('live','suspended','Suspend',false,true),
  ('live','abandoned','Abandon',false,true),
  ('live','postponed','Postpone',true,true),
  ('live','full_time','Full time',false,false),
  ('half_time','second_half','Second half',false,false),
  ('half_time','suspended','Suspend',false,true),
  ('half_time','abandoned','Abandon',false,true),
  ('second_half','full_time','Full time',false,false),
  ('second_half','extra_time','Extra time',false,false),
  ('second_half','suspended','Suspend',false,true),
  ('second_half','abandoned','Abandon',false,true),
  ('second_half','postponed','Postpone',true,true),
  ('extra_time','full_time','Full time',false,false),
  ('extra_time','penalty_shootout','Shoot-out',false,false),
  ('extra_time','suspended','Suspend',false,true),
  ('extra_time','abandoned','Abandon',false,true),
  ('penalty_shootout','full_time','Full time',false,false),
  ('penalty_shootout','suspended','Suspend',false,true),
  ('penalty_shootout','abandoned','Abandon',false,true),
  ('full_time','completed','Finalize',false,false),
  ('full_time','second_half','Reopen',true,true),
  ('full_time','abandoned','Abandon (after the fact)',true,true),
  ('completed','full_time','Un-finalize',true,true),
  ('suspended','first_half','Resume',false,false),
  ('suspended','live','Resume',false,false),
  ('suspended','second_half','Resume',false,false),
  ('suspended','half_time','Resume into interval',false,false),
  ('suspended','extra_time','Resume into extra time',false,false),
  ('suspended','abandoned','Abandon',false,true),
  ('suspended','postponed','Postpone',true,true),
  ('abandoned','scheduled','Reinstate',true,true),
  ('postponed','scheduled','Reinstate',true,true),
  ('cancelled','scheduled','Reinstate',true,true);

-- Supabase's default privileges hand every new table to `anon`/`authenticated` with ALL rights, which
-- for a reference table means "any signed-in user can rewrite what a legal transition is". Take that back
-- and pin the read with RLS, since a project that auto-enables RLS would otherwise see zero rows.
revoke all on public.kicklive_match_transitions from public, anon, authenticated;
grant select on public.kicklive_match_transitions to anon, authenticated;
alter table public.kicklive_match_transitions enable row level security;
drop policy if exists "kicklive transitions: public read" on public.kicklive_match_transitions;
create policy "kicklive transitions: public read" on public.kicklive_match_transitions
  for select using (true);

-- The lifecycle event each target status writes alongside itself (null = no event type describes it, so
-- only the audit row records the change; inventing an unrelated event type to fill the gap would lie).
create or replace function public.kicklive_lifecycle_event_for(p_from_status text, p_to_status text)
returns text
language sql stable
as $$
  select case
    when p_to_status in ('first_half','live') and p_from_status in ('scheduled','waiting') then 'kickoff'
    when p_to_status = 'half_time' then 'half_time'
    when p_to_status = 'second_half' and p_from_status <> 'suspended' then 'second_half_start'
    when p_to_status = 'extra_time' and p_from_status <> 'suspended' then 'extra_time_start'
    when p_to_status = 'penalty_shootout' then 'penalty_shootout_start'
    when p_to_status = 'full_time' then 'full_time'
    when p_to_status = 'abandoned' then 'match_abandoned'
    else null end;
$$;

-- ============================================================================
-- 6 · EVENT VALIDATION — what is *impossible*, not merely malformed
-- ============================================================================
-- `lib/matchEvents.ts` runs the same rules for the friendly error message, and this runs them for the
-- guarantee. Raised messages are operator-facing prose: never interpolate user input into one.

create or replace function public.kicklive_assert_match_event(
  p_match_id integer,
  p_event_type text,
  p_team_id integer,
  p_player_id integer,
  p_assist_player_id integer,
  p_minute integer,
  p_allow_duplicate_content boolean default false
)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_match   record;
  v_status  text;
  v_period  text;
  v_ceiling integer;
  v_playing boolean;
  v_yellows integer;
  v_sent_off integer;
  v_other    integer;
begin
  select m.home_team_id, m.away_team_id, m.status into v_match from public.matches m where m.id = p_match_id;
  if not found then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  v_status := v_match.status;
  v_period := public.kicklive_period_of(v_status);
  v_ceiling := public.kicklive_minute_ceiling(v_status);
  v_playing := v_status in ('live','first_half','half_time','second_half','extra_time','penalty_shootout','suspended');

  -- Lifecycle and internal types are written by the state machine, never by a tap. `substitution_on` /
  -- `substitution_off` stay unwritten on purpose: a single `substitution` row carrying player_id (on) and
  -- assist_player_id (off) is the shape every existing screen already reads.
  if p_event_type in ('kickoff','half_time','second_half_start','extra_time_start','penalty_shootout_start',
                      'full_time','match_abandoned') then
    raise exception 'kicklive: that event is written by the match state machine; change the status instead' using errcode = 'P0001';
  end if;
  if p_event_type in ('substitution_on','substitution_off') then
    raise exception 'kicklive: record one substitution with both players instead of two half events' using errcode = 'P0001';
  end if;

  -- Closed for ordinary live events. A correction is a different route and a different permission;
  -- `kicklive_correct_match_event` does not call this gate the same way.
  if not v_playing then
    raise exception 'kicklive: an event is not allowed while the match is %', v_status using errcode = '23514';
  end if;

  if p_minute is null or p_minute < 0 then
    raise exception 'kicklive: minute must be zero or greater' using errcode = 'P0001';
  end if;
  if p_minute > v_ceiling then
    raise exception 'kicklive: minute is beyond the % minute ceiling for this period', v_ceiling using errcode = 'P0001';
  end if;

  if p_team_id is not null and p_team_id not in (v_match.home_team_id, v_match.away_team_id) then
    raise exception 'kicklive: that team is not playing in this match' using errcode = 'P0001';
  end if;
  if p_event_type in ('goal','own_goal','penalty_goal','penalty_missed','yellow_card','second_yellow',
                      'red_card','substitution','corner','offside','free_kick','throw_in','goal_kick')
     and p_team_id is null then
    raise exception 'kicklive: this event must name a team' using errcode = 'P0001';
  end if;

  -- Right players: they must belong to one of the two clubs, and to the team the event names.
  if p_player_id is not null then
    select count(*) into v_other from public.players pl
      where pl.id = p_player_id and pl.team_id = p_team_id;
    if p_team_id is not null and v_other = 0 then
      raise exception 'kicklive: that player does not play for the team on this event' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.players pl where pl.id = p_player_id
                     and pl.team_id in (v_match.home_team_id, v_match.away_team_id)) then
      raise exception 'kicklive: that player is not in either squad for this match' using errcode = 'P0001';
    end if;
  end if;
  if p_assist_player_id is not null then
    if p_assist_player_id = p_player_id then
      raise exception 'kicklive: a player cannot appear twice on one event' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.players pl where pl.id = p_assist_player_id
                     and pl.team_id in (v_match.home_team_id, v_match.away_team_id)) then
      raise exception 'kicklive: that player is not in either squad for this match' using errcode = 'P0001';
    end if;
  end if;

  if p_event_type = 'substitution' and (p_player_id is null or p_assist_player_id is null) then
    raise exception 'kicklive: a substitution needs the player coming on and the one coming off' using errcode = 'P0001';
  end if;
  if p_event_type in ('penalty_goal','penalty_missed','yellow_card','second_yellow','red_card','injury',
                       'offside','free_kick') and p_player_id is null then
    raise exception 'kicklive: this event needs a player' using errcode = 'P0001';
  end if;
  -- A missed penalty carrying `goal_type` is nonsense, so the caller clears it rather than being refused
  -- for a field the form sends by default (see `readEventBody`, which nulls it the same way).
  -- Card arithmetic, from the rows rather than from a counter that can drift.
  if p_event_type in ('yellow_card','second_yellow','red_card') and p_player_id is not null then
    select count(*) into v_yellows from public.match_events e
     where e.match_id = p_match_id and e.event_status = 'active' and e.player_id = p_player_id
       and e.event_type in ('yellow_card','second_yellow');
    select count(*) into v_sent_off from public.match_events e
     where e.match_id = p_match_id and e.event_status = 'active' and e.player_id = p_player_id
       and e.event_type in ('red_card','second_yellow');
    if p_event_type <> 'red_card' and v_sent_off > 0 then
      raise exception 'kicklive: that player has already been sent off' using errcode = 'P0001';
    end if;
    if p_event_type = 'second_yellow' and v_yellows < 1 then
      raise exception 'kicklive: a second yellow needs a first one on record' using errcode = 'P0001';
    end if;
    if p_event_type = 'yellow_card' and v_yellows >= 2 then
      raise exception 'kicklive: that player already has two cautions; record a send-off instead' using errcode = 'P0001';
    end if;
    if p_event_type = 'red_card' and v_sent_off > 0 then
      raise exception 'kicklive: that player has already been sent off' using errcode = 'P0001';
    end if;
  end if;

  -- A player who has left the field cannot score: that is a correction to the substitution, not an event.
  if p_event_type not in ('yellow_card','second_yellow','red_card','substitution') and p_player_id is not null then
    select count(*) into v_other from public.match_events e
     where e.match_id = p_match_id and e.event_status = 'active' and e.event_type = 'substitution'
       and e.assist_player_id = p_player_id and e.sequence < coalesce((select max(sequence) from public.match_events where match_id = p_match_id), 0);
    if v_other > 0 then
      raise exception 'kicklive: that player was substituted off; fix the substitution with a correction' using errcode = 'P0001';
    end if;
  end if;

  -- Content duplicate: same type, same team, same player, same minute, same period. Two identical goals
  -- at 12' are not a thing; a double entry is, and this is the line that tells them apart.
  if p_allow_duplicate_content is not true then
    select count(*) into v_other from public.match_events e
     where e.match_id = p_match_id and e.event_status = 'active' and e.event_type = p_event_type
       and coalesce(e.team_id, -1) = coalesce(p_team_id, -1)
       and coalesce(e.player_id, -1) = coalesce(p_player_id, -1)
       and e.minute = p_minute and e.period = v_period;
    if v_other > 0 then
      raise exception 'kicklive: duplicate — that event is already recorded at this minute. Resend with allow_duplicate_content if it genuinely happened twice.'
        using errcode = '23505';
    end if;
  end if;

  return v_period;
end;
$$;

revoke all on function public.kicklive_assert_match_event(integer, text, integer, integer, integer, integer, boolean) from public, authenticated;
grant execute on function public.kicklive_assert_match_event(integer, text, integer, integer, integer, integer, boolean) to authenticated;

-- One place that turns a row into the wire shape, so the socket feed, the REST timeline and the
-- mutation ack can never disagree about a field name. Key set pinned by the frontend protocol mirror.
create or replace function public.kicklive_event_frame(p_event_id integer)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(e)
    from (
      select ev.id, ev.event_type, ev.team_id, t.name as team_name,
             ev.player_id, pl.name as player_name,
             ev.assist_player_id, apl.name as assist_player_name,
             ev.minute, coalesce(ev.extra_minute,0) as extra_minute, ev.period,
             ev.description, ev.goal_type, ev.card_reason, ev.video_url,
             coalesce(ev.metadata,'{}'::jsonb) as metadata,
             ev.client_event_id, ev.recorded_by,
             -- Who tapped the button is audit, not fan content. The join above runs as the function
             -- owner, so RLS on profiles does not protect it here; the gate has to be explicit.
             case when public.is_admin() then pr.username else null end as recorded_by_name,
             ev.created_at as recorded_at, ev.event_status as status,
             ev.corrects_event_id, ev.correction_reason, ev.sequence
        from public.match_events ev
        left join public.teams   t   on t.id   = ev.team_id
        left join public.players pl  on pl.id  = ev.player_id
        left join public.players apl on apl.id = ev.assist_player_id
        left join public.profiles pr on pr.id  = ev.recorded_by
       where ev.id = p_event_id
    ) e;
$$;

revoke all on function public.kicklive_event_frame(integer) from public, anon, authenticated;
grant execute on function public.kicklive_event_frame(integer) to anon, authenticated;

-- Per-match team aggregates, derived from the same ledger. Only the columns the events can actually
-- answer are touched: possession, shots, saves and passes stay whatever the controller entered, because
-- no event type carries them and inventing a number would be worse than leaving it alone.
create or replace function public.kicklive_sync_match_statistics(p_match_id integer)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_home integer;
  v_away integer;
begin
  select m.home_team_id, m.away_team_id into v_home, v_away from public.matches m where m.id = p_match_id;
  if v_home is null or v_away is null then return; end if;

  insert into public.match_statistics as s (match_id, home_corners, away_corners, home_offsides, away_offsides,
                                            home_yellow_cards, away_yellow_cards, home_red_cards, away_red_cards, updated_at)
  select p_match_id,
         count(*) filter (where e.event_type = 'corner'      and e.team_id = v_home),
         count(*) filter (where e.event_type = 'corner'      and e.team_id = v_away),
         count(*) filter (where e.event_type = 'offside'     and e.team_id = v_home),
         count(*) filter (where e.event_type = 'offside'     and e.team_id = v_away),
         count(*) filter (where e.event_type in ('yellow_card','second_yellow') and e.team_id = v_home),
         count(*) filter (where e.event_type in ('yellow_card','second_yellow') and e.team_id = v_away),
         count(*) filter (where e.event_type in ('red_card','second_yellow')   and e.team_id = v_home),
         count(*) filter (where e.event_type in ('red_card','second_yellow')   and e.team_id = v_away),
         now()
    from public.match_events e
   where e.match_id = p_match_id and e.event_status = 'active'
  on conflict (match_id) do update set
    home_corners      = excluded.home_corners,
    away_corners      = excluded.away_corners,
    home_offsides     = excluded.home_offsides,
    away_offsides     = excluded.away_offsides,
    home_yellow_cards = excluded.home_yellow_cards,
    away_yellow_cards = excluded.away_yellow_cards,
    home_red_cards    = excluded.home_red_cards,
    away_red_cards    = excluded.away_red_cards,
    updated_at        = now();
end;
$$;

revoke all on function public.kicklive_sync_match_statistics(integer) from public, authenticated;
grant execute on function public.kicklive_sync_match_statistics(integer) to authenticated;

-- ============================================================================
-- 7 · RECORD AN EVENT — the commit point for every goal, card and substitution
-- ============================================================================
-- One function, one transaction, in this order: authorise → idempotency → lock the match row →
-- validate → allocate sequence → insert → derive score → sync statistics → audit. The ack the
-- controller receives is this function's return value, so "accepted" and "in the database" are the same
-- event, which is the property the fan view depends on.

create or replace function public.kicklive_record_match_event(
  p_match_id integer,
  p_client_event_id text,
  p_event_type text,
  p_team_id integer default null,
  p_player_id integer default null,
  p_assist_player_id integer default null,
  p_minute integer default 0,
  p_extra_minute integer default 0,
  p_description text default null,
  p_goal_type text default null,
  p_card_reason text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_expected_sequence integer default null,
  p_allow_duplicate_content boolean default false
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_rights  jsonb;
  v_admin   boolean := false;
  v_match   record;
  v_seq     integer;
  v_period  text;
  v_existing record;
  v_event_id integer;
  v_score   jsonb;
  v_clock   jsonb;
  v_role    text;
begin
  perform public.kicklive_enter_engine();

  if v_uid is null then
    raise exception 'kicklive: an event needs an authenticated official' using errcode = '42501';
  end if;

  v_rights := public.kicklive_match_rights(p_match_id);
  if v_rights->>'exists' <> 'true' then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  v_admin := (v_rights->>'is_admin')::boolean;
  if (v_rights->>'can_control')::boolean is not true then
    raise exception 'kicklive: this account is not an assigned official for this match' using errcode = '42501';
  end if;
  if (v_rights->>'is_locked')::boolean is true and not v_admin then
    raise exception 'kicklive: the match is locked and not accepting events' using errcode = '23514';
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;

  -- Idempotency, before anything is locked: a retry of an event already settled returns the original
  -- row. `duplicate`, not an error — the client's queue can then mark it synced and stop retrying.
  if p_client_event_id is not null then
    select ev.* into v_existing from public.match_events ev
     where ev.match_id = p_match_id and ev.client_event_id = p_client_event_id
     order by ev.sequence nulls first limit 1;
    if found then
      v_score := public.kicklive_match_score(p_match_id);
      v_clock := public.kicklive_match_clock(p_match_id);
      return jsonb_build_object(
        'sequence', coalesce(v_existing.sequence, 0),
        'status', v_clock->>'status',
        'score', v_score,
        'clock', v_clock,
        'event', public.kicklive_event_frame(v_existing.id),
        'duplicate', true
      );
    end if;
  end if;

  -- The row lock is the serialiser. The Durable Object also queues per match, but a second Worker
  -- isolate, a mobile app mid-retry or a direct PostgREST caller would otherwise interleave between
  -- "read live_seq" and "insert", which is exactly how two goals become one sequence number.
  select m.live_seq, m.status into v_match from public.matches m where m.id = p_match_id for update;

  if p_expected_sequence is not null and p_expected_sequence <> coalesce(v_match.live_seq, 0) then
    -- Not a failure to be swallowed: the caller's view was stale, so this answer carries the truth.
    return jsonb_build_object(
      'sequence', coalesce(v_match.live_seq, 0),
      'status', v_match.status,
      'score', public.kicklive_match_score(p_match_id),
      'clock', public.kicklive_match_clock(p_match_id),
      'event', null,
      'rejected', jsonb_build_object(
        'reason', format('expected sequence %s but the match is at %s', p_expected_sequence, coalesce(v_match.live_seq, 0)),
        'actual_sequence', coalesce(v_match.live_seq, 0)
      )
    );
  end if;

  v_period := public.kicklive_assert_match_event(p_match_id, p_event_type, p_team_id, p_player_id,
                                                 p_assist_player_id, p_minute, p_allow_duplicate_content);
  -- `video_url` is a real column today; promoting it out of metadata keeps existing screens working.
  if p_event_type = 'penalty_missed' then
    p_goal_type := null;
  end if;

  v_seq := coalesce(v_match.live_seq, 0) + 1;

  insert into public.match_events as ev (
      match_id, event_type, team_id, player_id, assist_player_id, minute, extra_minute, description,
      goal_type, card_reason, video_url, metadata, client_event_id, sequence, period, event_status,
      recorded_by, recorded_by_role, created_at
    ) values (
      p_match_id, p_event_type, p_team_id, p_player_id, p_assist_player_id, p_minute,
      coalesce(p_extra_minute, 0), nullif(btrim(coalesce(p_description, '')), ''), p_goal_type, p_card_reason,
      nullif(btrim(coalesce(p_metadata->>'video_url', '')), ''), coalesce(p_metadata - 'video_url', '{}'::jsonb),
      p_client_event_id, v_seq, v_period, 'active', v_uid, v_role, now()
    )
  returning ev.id into v_event_id;

  v_score := public.kicklive_match_score(p_match_id);
  v_clock := public.kicklive_match_clock(p_match_id);
  update public.matches m
     set live_seq = v_seq,
         home_score = (v_score->>'home')::integer,
         away_score = (v_score->>'away')::integer,
         minute = (v_clock->>'minute')::integer,
         live_updated_at = now(),
         updated_at = now()
   where m.id = p_match_id;

  -- `match_statistics` only *after* the score, so a reader that polls the statistics row never sees
  -- cards from an event whose insert was rolled back: they are the same transaction either way.
  perform public.kicklive_sync_match_statistics(p_match_id);

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (
    v_uid, 'match.event', 'match', p_match_id, format('match %s', p_match_id),
    jsonb_build_object(
      'via', 'database',
      'actor_role', v_role,
      'event_type', p_event_type,
      'event_id', v_event_id,
      'sequence', v_seq,
      'minute', p_minute,
      'period', v_period,
      'team_id', p_team_id,
      'player_id', p_player_id,
      'client_event_id', p_client_event_id,
      'result', jsonb_build_object('home', v_score->>'home', 'away', v_score->>'away'),
      'status', v_clock->>'status'
    )
  );

  return jsonb_build_object(
    'sequence', v_seq,
    'status', v_clock->>'status',
    'score', v_score,
    'clock', v_clock,
    'event', public.kicklive_event_frame(v_event_id),
    'duplicate', false
  );
end;
$$;

comment on function public.kicklive_record_match_event(integer, text, text, integer, integer, integer, integer, integer, text, text, text, jsonb, integer, boolean) is
  'The only supported way to append a match event. Authorises, deduplicates on client_event_id, allocates the sequence, derives the score and audits — in one transaction.';

revoke all on function public.kicklive_record_match_event(integer, text, text, integer, integer, integer, integer, integer, text, text, text, jsonb, integer, boolean) from public, authenticated;
grant execute on function public.kicklive_record_match_event(integer, text, text, integer, integer, integer, integer, integer, text, text, text, jsonb, integer, boolean) to authenticated;

-- ============================================================================
-- 8 · TRANSITION — the state machine, executed by the database
-- ============================================================================
-- Clock physics live here, not in the browser: kickoff starts `match_start_time`, an interruption banks
-- the elapsed seconds into `elapsed_seconds_before_pause`, and a resume continues from them. Halftime is
-- therefore not "someone remembered to pause the timer".

create or replace function public.kicklive_transition_match(
  p_match_id integer,
  p_to_status text,
  p_reason text default null,
  p_stoppage smallint default null,
  p_expected_sequence integer default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_rights  jsonb;
  v_admin   boolean := false;
  v_from    text;
  v_move    record;
  v_match   record;
  v_seq     integer;
  v_event_id integer;
  v_score   jsonb;
  v_clock   jsonb;
  v_role    text;
begin
  perform public.kicklive_enter_engine();

  if v_uid is null then
    raise exception 'kicklive: a status change needs an authenticated official' using errcode = '42501';
  end if;
  v_rights := public.kicklive_match_rights(p_match_id);
  if v_rights->>'exists' <> 'true' then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  v_admin := (v_rights->>'is_admin')::boolean;
  v_from := v_rights->>'status';

  select * into v_move from public.kicklive_match_transitions t
   where t.from_status = v_from and t.to_status = p_to_status;
  if not found then
    raise exception 'kicklive: illegal_transition — % to % is not a legal move. From here: %',
      v_from, p_to_status,
      coalesce((select string_agg(t.to_status, ', ' order by t.to_status)
                  from public.kicklive_match_transitions t
                 where t.from_status = v_from
                   and (v_admin or t.requires_admin is false)), 'nothing — this match is closed')
      using errcode = '23514';
  end if;
  if v_move.requires_admin and not v_admin then
    raise exception 'kicklive: that change undoes or replaces a finished match and is restricted to platform admins' using errcode = '42501';
  end if;
  if v_move.reason_required and coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'kicklive: % needs a reason; it is the audit trail a dispute is decided on', v_move.label using errcode = 'P0001';
  end if;

  if v_move.to_status in ('full_time','completed','postponed','cancelled','abandoned') then
    if (v_rights->>'can_close')::boolean is not true then
      raise exception 'kicklive: only the head referee, the match commissioner or an admin may end this match' using errcode = '42501';
    end if;
  else
    if (v_rights->>'can_control')::boolean is not true then
      raise exception 'kicklive: this account is not an assigned official for this match' using errcode = '42501';
    end if;
  end if;
  if (v_rights->>'is_locked')::boolean is true and not v_admin then
    raise exception 'kicklive: the match is locked and not accepting changes' using errcode = '23514';
  end if;

  select m.live_seq, m.status into v_match from public.matches m where m.id = p_match_id for update;
  if p_expected_sequence is not null and p_expected_sequence <> coalesce(v_match.live_seq, 0) then
    return jsonb_build_object(
      'sequence', coalesce(v_match.live_seq, 0),
      'status', v_match.status,
      'score', public.kicklive_match_score(p_match_id),
      'clock', public.kicklive_match_clock(p_match_id),
      'event', null,
      'rejected', jsonb_build_object(
        'reason', format('expected sequence %s but the match is at %s', p_expected_sequence, coalesce(v_match.live_seq, 0)),
        'actual_sequence', coalesce(v_match.live_seq, 0)
      )
    );
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;
  v_seq := coalesce(v_match.live_seq, 0) + 1;

  update public.matches m
     set status = v_move.to_status,
         live_seq = v_seq,
         -- Running periods start a fresh segment; stopped ones bank what elapsed and drop the start
         -- instant, so the displayed minute freezes where play actually stopped.
         match_start_time = case
           when v_move.to_status in ('live','first_half','second_half','extra_time') then
             case when m.match_start_time is null or m.status in ('scheduled','waiting','half_time','suspended','second_half','full_time')
                  then now() else m.match_start_time end
           else null end,
         elapsed_seconds_before_pause = case
           when v_move.to_status in ('live','first_half','second_half','extra_time') then
             case when m.status = 'suspended' then coalesce(m.elapsed_seconds_before_pause, 0) else 0 end
           when v_move.to_status in ('half_time','suspended')
             then coalesce(m.elapsed_seconds_before_pause, 0)
                  + greatest(0, coalesce(floor(extract(epoch from (now() - m.match_start_time)))::integer, 0))
           else coalesce(m.elapsed_seconds_before_pause, 0)
                + greatest(0, coalesce(floor(extract(epoch from (now() - m.match_start_time)))::integer, 0))
         end,
         stoppage_minutes = coalesce(p_stoppage, m.stoppage_minutes),
         live_updated_at = now(),
         updated_at = now()
   where m.id = p_match_id;

  -- The status change is itself an event, so the timeline reads as a story rather than as a set of flags.
  if public.kicklive_lifecycle_event_for(v_from, v_move.to_status) is not null
     -- Kicking off twice (a suspension resumed into the first half) must not add a second kickoff.
     and not (public.kicklive_lifecycle_event_for(v_from, v_move.to_status) = 'kickoff'
              and exists (select 1 from public.match_events e
                           where e.match_id = p_match_id and e.event_type = 'kickoff' and e.event_status = 'active'))
  then
    insert into public.match_events as ev (match_id, event_type, minute, extra_minute, description, sequence, period, event_status, recorded_by, recorded_by_role, created_at)
    values (p_match_id, public.kicklive_lifecycle_event_for(v_from, v_move.to_status),
            (public.kicklive_match_clock(p_match_id)->>'minute')::integer, 0,
            nullif(btrim(coalesce(p_reason, '')), ''), v_seq,
            public.kicklive_period_of(v_move.to_status), 'active', v_uid, v_role, now())
      returning ev.id into v_event_id;
  end if;
  -- A transition with no lifecycle event (suspend, stand down, reinstate) still consumes the sequence it
  -- allocated, so a client's gap detection never waits for an event that will not arrive. The audit row
  -- at the end of this function is what makes that gap explicable to a human reading the trail.

  -- The score cannot change from a status move alone, but the derived minute and a shoot-out tally can;
  -- recomputing the fold is cheaper than reasoning about which of them moved.
  v_score := public.kicklive_match_score(p_match_id);
  v_clock := public.kicklive_match_clock(p_match_id);
  update public.matches m
     set home_score = (v_score->>'home')::integer,
         away_score = (v_score->>'away')::integer,
         minute = (v_clock->>'minute')::integer
   where m.id = p_match_id;
  perform public.kicklive_sync_match_statistics(p_match_id);

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (
    v_uid, 'match.status', 'match', p_match_id, format('match %s', p_match_id),
    jsonb_build_object('via','database','actor_role',v_role,'from',v_from,'to',v_move.to_status,
                       'label',v_move.label,'reason',nullif(btrim(coalesce(p_reason,'')),''),
                       'sequence',v_seq,'result',jsonb_build_object('home',v_score->>'home','away',v_score->>'away'),
                       'stoppage_minutes', p_stoppage)
  );

  return jsonb_build_object(
    'sequence', v_seq,
    'status', v_clock->>'status',
    'score', v_score,
    'clock', v_clock,
    'event', case when v_event_id is null then null else public.kicklive_event_frame(v_event_id) end,
    'duplicate', false,
    'label', v_move.label,
    'previous_status', v_from
  );
end;
$$;

revoke all on function public.kicklive_transition_match(integer, text, text, smallint, integer) from public, authenticated;
grant execute on function public.kicklive_transition_match(integer, text, text, smallint, integer) to authenticated;

-- ============================================================================
-- 9 · CORRECTIONS — the only permitted way an accepted event changes meaning
-- ============================================================================
-- The original row is *not* edited and never deleted: it is marked `corrected`, keeps its sequence, and
-- gains who/when/why. A replacement row (when the truth is "it was 63', not 61'") is appended through the
-- same validator as any other event and linked by `corrects_event_id`. The score then *recomputes*, which
-- is why there is no score-correction UI anywhere: correcting the row corrects the result.

create or replace function public.kicklive_correct_match_event(
  p_event_id integer,
  p_reason text,
  p_replacement jsonb default null,
  p_expected_sequence integer default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_original record;
  v_match_id integer;
  v_rights   jsonb;
  v_admin    boolean := false;
  v_open     boolean;
  v_seq      integer;
  v_live     record;
  v_period   text;
  v_new_id   integer;
  v_score    jsonb;
  v_clock    jsonb;
  v_role     text;
begin
  perform public.kicklive_enter_engine();

  if v_uid is null then
    raise exception 'kicklive: a correction needs an authenticated account' using errcode = '42501';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'kicklive: a correction needs a reason; it is the audit trail a league dispute is decided on' using errcode = 'P0001';
  end if;

  -- `ev.*` only: naming `match_id` twice would give the record two fields of the same name, and
  -- plpgsql's complaint about that is not a helpful one at 20:00 on a Sunday.
  select ev.* into v_original from public.match_events ev where ev.id = p_event_id;
  if not found then
    raise exception 'kicklive: no such event' using errcode = 'P0002';
  end if;
  v_match_id := v_original.match_id;
  if v_original.event_status <> 'active' then
    raise exception 'kicklive: that event has already been corrected' using errcode = '23514';
  end if;

  v_rights := public.kicklive_match_rights(v_match_id);
  v_admin := (v_rights->>'is_admin')::boolean;
  v_open := v_rights->>'status' in ('live','first_half','half_time','second_half','extra_time','penalty_shootout','suspended');

  if not v_admin then
    if (v_rights->>'can_correct_own')::boolean is not true then
      raise exception 'kicklive: this account may not correct events in this match' using errcode = '42501';
    end if;
    if v_original.recorded_by is distinct from v_uid then
      raise exception 'kicklive: an official may correct only the events they recorded; a platform admin may correct any' using errcode = '42501';
    end if;
    -- "Corrections after full time should require admin" — a result that has been published to a
    -- competition is not editable by the person who published it.
    if not v_open then
      raise exception 'kicklive: the match is closed; only a platform admin may correct it now' using errcode = '23514';
    end if;
  end if;

  select m.live_seq into v_live from public.matches m where m.id = v_match_id for update;
  if p_expected_sequence is not null and p_expected_sequence <> coalesce(v_live.live_seq, 0) then
    return jsonb_build_object(
      'sequence', coalesce(v_live.live_seq, 0),
      'status', v_rights->>'status',
      'score', public.kicklive_match_score(v_match_id),
      'clock', public.kicklive_match_clock(v_match_id),
      'event', null,
      'rejected', jsonb_build_object('reason','the match moved while this correction was in flight',
                                    'actual_sequence', coalesce(v_live.live_seq, 0))
    );
  end if;

  v_seq := coalesce(v_live.live_seq, 0) + 1;
  select p.role into v_role from public.profiles p where p.id = v_uid;

  update public.match_events
     set event_status = 'corrected', correction_reason = btrim(p_reason), corrected_by = v_uid, corrected_at = now()
   where id = p_event_id and event_status = 'active';

  if p_replacement is not null and jsonb_typeof(p_replacement) = 'object'
     and coalesce(p_replacement->>'event_type','') <> '' then
    v_period := public.kicklive_assert_match_event(
      v_match_id,
      p_replacement->>'event_type',
      nullif(p_replacement->>'team_id','')::integer,
      nullif(p_replacement->>'player_id','')::integer,
      nullif(p_replacement->>'assist_player_id','')::integer,
      coalesce(nullif(p_replacement->>'minute','')::integer, v_original.minute),
      coalesce((p_replacement->>'allow_duplicate_content')::boolean, false)
    );
    insert into public.match_events as ev (
        match_id, event_type, team_id, player_id, assist_player_id, minute, extra_minute, description,
        goal_type, card_reason, metadata, client_event_id, sequence, period, event_status,
        recorded_by, recorded_by_role, corrects_event_id, correction_reason, created_at
      ) values (
        v_match_id, p_replacement->>'event_type',
        nullif(p_replacement->>'team_id','')::integer,
        nullif(p_replacement->>'player_id','')::integer,
        nullif(p_replacement->>'assist_player_id','')::integer,
        coalesce(nullif(p_replacement->>'minute','')::integer, v_original.minute),
        coalesce(nullif(p_replacement->>'extra_minute','')::integer, v_original.extra_minute),
        coalesce(nullif(p_replacement->>'description',''), v_original.description),
        coalesce(nullif(p_replacement->>'goal_type',''), v_original.goal_type),
        coalesce(nullif(p_replacement->>'card_reason',''), v_original.card_reason),
        coalesce((p_replacement->'metadata')::jsonb, '{}'::jsonb),
        coalesce(nullif(p_replacement->>'client_event_id',''), 'corr-' || md5(random()::text || clock_timestamp()::text)),
        v_seq, v_period, 'active', v_uid, v_role, p_event_id, btrim(p_reason), now()
      )
    returning ev.id into v_new_id;
  end if;

  v_score := public.kicklive_match_score(v_match_id);
  v_clock := public.kicklive_match_clock(v_match_id);
  update public.matches m
     set live_seq = v_seq,
         home_score = (v_score->>'home')::integer,
         away_score = (v_score->>'away')::integer,
         live_updated_at = now(),
         updated_at = now()
   where m.id = v_match_id;
  perform public.kicklive_sync_match_statistics(v_match_id);

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (
    v_uid, 'match.event_corrected', 'match', v_match_id, format('match %s', v_match_id),
    jsonb_build_object(
      'via','database','actor_role',v_role,
      'corrected_event_id', p_event_id,
      'replacement_event_id', v_new_id,
      'reason', btrim(p_reason),
      'sequence', v_seq,
      'original', jsonb_build_object('event_type', v_original.event_type, 'minute', v_original.minute,
                                     'team_id', v_original.team_id, 'player_id', v_original.player_id,
                                     'goal_type', v_original.goal_type, 'card_reason', v_original.card_reason,
                                     'description', v_original.description, 'recorded_by', v_original.recorded_by),
      'result', jsonb_build_object('home', v_score->>'home', 'away', v_score->>'away')
    )
  );

  return jsonb_build_object(
    'sequence', v_seq,
    'status', v_clock->>'status',
    'score', v_score,
    'clock', v_clock,
    'event', case when v_new_id is null then public.kicklive_event_frame(p_event_id) else public.kicklive_event_frame(v_new_id) end,
    'duplicate', false
  );
end;
$$;

revoke all on function public.kicklive_correct_match_event(integer, text, jsonb, integer) from public, authenticated;
grant execute on function public.kicklive_correct_match_event(integer, text, jsonb, integer) to authenticated;

-- ============================================================================
-- 10 · FINALIZE — publish the result, derived rather than declared
-- ============================================================================
-- Reuses `kicklive_transition_match` for the move itself (so `full_time → completed` has exactly one
-- definition of legal) and adds what only finalizing does: the score-consistency check, `confirmed_at`,
-- and the lock that stops further ordinary edits.

create or replace function public.kicklive_finalize_match(p_match_id integer, p_confirm boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_rights jsonb;
  v_score  jsonb;
  v_match  record;
  v_result jsonb;
begin
  perform public.kicklive_enter_engine();

  if p_confirm is not true then
    raise exception 'kicklive: finalizing publishes the result and closes corrections; pass confirm=true' using errcode = 'P0001';
  end if;
  v_rights := public.kicklive_match_rights(p_match_id);
  if v_rights->>'exists' <> 'true' then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  if (v_rights->>'can_close')::boolean is not true then
    raise exception 'kicklive: only the head referee, the match commissioner or an admin may finalize this match' using errcode = '42501';
  end if;
  if v_rights->>'status' = 'completed' then
    raise exception 'kicklive: this match is already finalized' using errcode = '23514';
  end if;

  select m.home_score, m.away_score, (select count(*) from public.match_events e
                                       where e.match_id = m.id and e.event_status = 'active') as events
    into v_match from public.matches m where m.id = p_match_id;

  -- The one disagreement worth stopping for: a result nobody can point at an event for. Everything else
  -- resolves in favour of the ledger, because the ledger is where the truth was recorded.
  if v_match.events = 0 and (coalesce(v_match.home_score,0) <> 0 or coalesce(v_match.away_score,0) <> 0) then
    raise exception 'kicklive: the stored result has no events behind it. Record what happened (or import the match sheet) before finalizing.'
      using errcode = '23514';
  end if;

  v_result := public.kicklive_transition_match(p_match_id, 'completed', null, null, null);
  v_score := public.kicklive_match_score(p_match_id);

  update public.matches m
     set home_score = (v_score->>'home')::integer,
         away_score = (v_score->>'away')::integer,
         confirmed_at = now(),
         is_locked = true,
         live_updated_at = now(),
         updated_at = now()
   where m.id = p_match_id;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (
    auth.uid(), 'match.finalize', 'match', p_match_id, format('match %s', p_match_id),
    jsonb_build_object('via','database','result', v_score, 'locked', true,
                       'previous_status', v_rights->>'status')
  );

  return jsonb_build_object(
    'sequence', (v_result->>'sequence')::integer,
    'status', 'completed',
    'score', v_score,
    'clock', public.kicklive_match_clock(p_match_id),
    'event', v_result->'event',
    'duplicate', false,
    'confirmed_at', (select m.confirmed_at from public.matches m where m.id = p_match_id),
    'is_locked', true
  );
end;
$$;

revoke all on function public.kicklive_finalize_match(integer, boolean) from public, authenticated;
grant execute on function public.kicklive_finalize_match(integer, boolean) to authenticated;

create or replace function public.kicklive_set_match_lock(p_match_id integer, p_locked boolean, p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_rights jsonb;
begin
  perform public.kicklive_enter_engine();
  v_rights := public.kicklive_match_rights(p_match_id);
  if v_rights->>'exists' <> 'true' then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  -- A lock outranks an official's own rights, so only the platform may place or lift one.
  if (v_rights->>'can_lock')::boolean is not true then
    raise exception 'kicklive: only a platform admin may lock or unlock a match' using errcode = '42501';
  end if;
  if p_locked and coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'kicklive: locking a match needs a reason' using errcode = 'P0001';
  end if;

  update public.matches m
     set is_locked = p_locked, live_updated_at = now(), updated_at = now()
   where m.id = p_match_id;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (auth.uid(), case when p_locked then 'match.lock' else 'match.unlock' end, 'match', p_match_id,
          format('match %s', p_match_id), jsonb_build_object('via','database','reason', nullif(btrim(coalesce(p_reason,'')),'')));

  return jsonb_build_object('is_locked', p_locked, 'status', (select m.status from public.matches m where m.id = p_match_id));
end;
$$;

revoke all on function public.kicklive_set_match_lock(integer, boolean, text) from public, authenticated;
grant execute on function public.kicklive_set_match_lock(integer, boolean, text) to authenticated;

-- ============================================================================
-- 11 · LIVE STATE — what the Durable Object rebuilds itself from
-- ============================================================================
-- The room can be evicted, redeployed or crashed at any moment; this single call returns everything it
-- needs to carry on with the same numbers. Returning it from SQL rather than letting the object stitch
-- four queries together is what keeps "the DO caught up" and "the DO agreed with Postgres" the same fact.

create or replace function public.kicklive_match_live_state(p_match_id integer)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when m.id is null then null else jsonb_build_object(
    'status', m.status,
    'sequence', coalesce(m.live_seq, 0),
    'score', public.kicklive_match_score(m.id),
    'clock', public.kicklive_match_clock(m.id),
    'match', jsonb_build_object(
      'id', m.id,
      'home_team_id', m.home_team_id,
      'away_team_id', m.away_team_id,
      'home_team_name', th.name,
      'away_team_name', ta.name,
      'home_team_color', th.primary_color,
      'away_team_color', ta.primary_color,
      'competition', c.name,
      'round', m.round,
      'venue', m.venue,
      'kickoff_at', m.start_time,
      'is_locked', coalesce(m.is_locked, false),
      'attendance', m.attendance
    ),
    'events', coalesce((
      select jsonb_agg(public.kicklive_event_frame(e.id) order by e.sequence nulls first, e.id)
        from (select ev.id, ev.sequence from public.match_events ev
               where ev.match_id = m.id
               order by ev.sequence desc nulls last, ev.id desc
               limit 60) e
    ), '[]'::jsonb),
    -- Connection counts are the room's business; a cold rebuild has none, and the object overwrites
    -- these two on the way out.
    'rebuilt_from_database', false,
    'controllers_online', 0,
    'viewers_online', 0
  ) end
    from public.matches m
    left join public.teams th on th.id = m.home_team_id
    left join public.teams ta on ta.id = m.away_team_id
    left join public.competitions c on c.id = m.competition_id
   where m.id = p_match_id;
$$;

revoke all on function public.kicklive_match_live_state(integer) from public, anon, authenticated;
-- Anon on purpose: this returns what `matches` and `match_events` already make public, and the fan
-- sockets (and the local adapter) must be able to hydrate a room without anyone's token.
grant execute on function public.kicklive_match_live_state(integer) to anon, authenticated;

-- ============================================================================
-- 12 · ASSIGNMENTS — the grant of match authority, and its release
-- ============================================================================

create or replace function public.kicklive_assign_match(p_match_id integer, p_user_id uuid, p_role text, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public.kicklive_enter_engine();
  if not public.is_admin() then
    raise exception 'kicklive: only a platform admin assigns officials' using errcode = '42501';
  end if;
  if p_role not in ('head_referee','assistant_referee','fourth_official','var_official','match_commissioner','data_operator') then
    raise exception 'kicklive: unknown officiating role' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.matches m where m.id = p_match_id) then
    raise exception 'kicklive: no such match' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'kicklive: that account does not exist; the official must sign up first' using errcode = 'P0001';
  end if;

  insert into public.match_assignments (match_id, user_id, role, note, assigned_by)
  values (p_match_id, p_user_id, p_role, nullif(btrim(coalesce(p_note,'')),''), auth.uid())
  on conflict (match_id, user_id, role) do update
     set status = 'assigned', note = excluded.note, assigned_by = excluded.assigned_by,
         assigned_at = now(), stood_down_at = null
  returning id into v_id;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (auth.uid(), 'match.assign', 'match', p_match_id, format('match %s', p_match_id),
          jsonb_build_object('via','database','user_id',p_user_id,'role',p_role));

  return jsonb_build_object('id', v_id, 'match_id', p_match_id, 'role', p_role, 'user_id', p_user_id);
end;
$$;

create or replace function public.kicklive_stand_down_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  perform public.kicklive_enter_engine();
  select a.* into v_row from public.match_assignments a where a.id = p_assignment_id;
  if not found then
    raise exception 'kicklive: no such assignment' using errcode = 'P0002';
  end if;
  if v_row.user_id <> auth.uid() and not public.is_admin() then
    raise exception 'kicklive: you may stand down your own assignment; an admin must release someone else’s' using errcode = '42501';
  end if;

  update public.match_assignments
     set status = 'stood_down', stood_down_at = now()
   where id = p_assignment_id and status = 'assigned';

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (auth.uid(), 'match.assignment_stood_down', 'match', v_row.match_id, format('match %s', v_row.match_id),
          jsonb_build_object('via','database','assignment_id',p_assignment_id,'role',v_row.role,
                             'self', v_row.user_id = auth.uid()));

  return jsonb_build_object('id', p_assignment_id, 'status', 'stood_down', 'match_id', v_row.match_id);
end;
$$;

revoke all on function public.kicklive_assign_match(integer, uuid, text, text) from public, authenticated;
revoke all on function public.kicklive_stand_down_assignment(uuid) from public, authenticated;
grant execute on function public.kicklive_assign_match(integer, uuid, text, text) to authenticated;
grant execute on function public.kicklive_stand_down_assignment(uuid) to authenticated;

-- ============================================================================
-- 13 · THE GUARDS — where "the browser is not the authority" stops being a slogan
-- ============================================================================
-- Three triggers, and the reason each one exists:
--
--   1. `matches` result columns — a hand-typed score, minute or status is how two sources of truth are
--      born. Once the engine owns a match (`live_seq > 0`), those columns move only through `kicklive_*`.
--   2. `match_events` append-only — an accepted event is history. A wrong one is corrected by the RPC,
--      which is audited; not overwritten, and not deleted, including by an admin's own session.
--   3. sequence on insert — a row that arrives by the legacy direct-insert path still gets an order
--      number, so it appears in the timeline instead of being invisible to a reconnecting client.
--
-- Why `session_user` and not `current_user`: PostgREST switches role with `SET ROLE`, which changes
-- `current_user` and leaves `session_user` alone. `session_user` is therefore the only value that
-- distinguishes "a browser asked for this" from "a person at a psql prompt or a dashboard noticed an
-- incident". The engine's own writes are recognised by the transaction-local GUC its functions set.

create or replace function public.kicklive_guard_match_result_columns()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_engine    boolean := coalesce(current_setting('kicklive.engine', true), '') = 'on';
  v_superuser boolean;
begin
  select coalesce(bool_or(u.usesuper), false) into v_superuser from pg_user u where u.usename = session_user;

  if tg_op = 'DELETE' then
    if not v_engine and not v_superuser and coalesce(old.live_seq, 0) > 0 then
      -- A match that has been played in the engine is a record of what happened. Deleting it is an
      -- incident, so it takes an operator with a real database session, not a session in a browser tab.
      raise exception 'kicklive: a match played in the live engine cannot be deleted from the app; archive it by cancelling or postponing it'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if v_engine or v_superuser then
    return new;
  end if;

  -- The ratchet: a fixture the engine has never written keeps today's behaviour exactly, so applying
  -- this migration cannot break the legacy admin screens on matches that are not live.
  if coalesce(old.live_seq, 0) = 0 then
    return new;
  end if;

  if new.home_score is distinct from old.home_score
     or new.away_score is distinct from old.away_score
     or new.minute is distinct from old.minute
     or new.status is distinct from old.status
     or new.match_start_time is distinct from old.match_start_time
     or new.elapsed_seconds_before_pause is distinct from old.elapsed_seconds_before_pause
     or new.stoppage_minutes is distinct from old.stoppage_minutes
     or new.is_locked is distinct from old.is_locked
     or new.confirmed_at is distinct from old.confirmed_at
     or new.live_seq is distinct from old.live_seq then
    raise exception 'kicklive: this match is live-engine owned; score, minute, status and lock change through POST /api/matches/%s/events, /state, /corrections or /finalize', old.id
      using errcode = '42501';
  end if;

  -- Everything else on the row — venue, attendance, weather, referee note, lineup links — stays editable
  -- by whoever could edit it before. A guard that blocks the whole table would be security theatre with
  -- collateral damage.
  return new;
end;
$$;

drop trigger if exists kicklive_guard_match_result_columns on public.matches;
create trigger kicklive_guard_match_result_columns
  before update or delete on public.matches
  for each row execute function public.kicklive_guard_match_result_columns();

create or replace function public.kicklive_guard_match_events_append_only()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_engine    boolean := coalesce(current_setting('kicklive.engine', true), '') = 'on';
  v_superuser boolean;
begin
  select coalesce(bool_or(u.usesuper), false) into v_superuser from pg_user u where u.usename = session_user;
  if v_engine or v_superuser then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- `NEW` is not assigned in a DELETE trigger, so the match id is read from whichever record exists.
  if tg_op = 'DELETE' then
    raise exception 'kicklive: match_events is an append-only ledger; correct the event with kicklive_correct_match_event (or POST /api/matches/%s/corrections) instead of editing or deleting a row', old.match_id
      using errcode = '42501';
  end if;
  raise exception 'kicklive: match_events is an append-only ledger; correct the event with kicklive_correct_match_event (or POST /api/matches/%s/corrections) instead of editing or deleting a row', new.match_id
    using errcode = '42501';
end;
$$;

drop trigger if exists kicklive_guard_match_events_append_only on public.match_events;
create trigger kicklive_guard_match_events_append_only
  before update or delete on public.match_events
  for each row execute function public.kicklive_guard_match_events_append_only();

-- Legacy insert path (an admin adding a match sheet from the old screen, `MultiMatchQueue` before it is
-- repointed): keep the ledger ordered rather than pretending the insert did not happen.
create or replace function public.kicklive_sequence_on_insert()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_seq integer;
begin
  if new.sequence is not null then
    return new;
  end if;
  -- The matches guard rejects a browser write to `live_seq` on an engine-owned match, so this path only
  -- ever allocates for a fixture that has not been taken over yet. That refusal is the point.
  update public.matches m
     set live_seq = coalesce(m.live_seq, 0) + 1
   where m.id = new.match_id
   returning m.live_seq into v_seq;
  new.sequence := v_seq;
  if new.period is null or new.period = 'unknown' then
    new.period := public.kicklive_period_of((select m.status from public.matches m where m.id = new.match_id));
  end if;
  if new.recorded_by is null then
    new.recorded_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists kicklive_sequence_on_insert on public.match_events;
create trigger kicklive_sequence_on_insert
  before insert on public.match_events
  for each row execute function public.kicklive_sequence_on_insert();

-- ============================================================================
-- 14 · POLICIES AND PRIVILEGES ON THE LEDGER
-- ============================================================================
-- The base schema gave `match_events` two policies: public read, and admin-may-do-anything. The second
-- is why every screen in the old console could insert an event with no assignment in sight. An official's
-- insert is now granted by the row that assigns them, and update/delete are withdrawn from every client
-- role (grants *and* policies, because either one alone can be re-opened by accident).

revoke insert, update, delete on public.match_events from anon;
revoke update, delete on public.match_events from authenticated;
-- Deliberately *not* `alter default privileges ... revoke update, delete from authenticated`: that would
-- reach every table created after this migration, including the club and media writes that are working
-- today. Table-scoped is the correct scope here. (Phase 1 does the default-privileges trick for `anon`
-- because "a browser tab must not write anywhere" is genuinely schema-wide.)

drop policy if exists "match_events: officials insert" on public.match_events;
create policy "match_events: officials insert" on public.match_events
  for insert to authenticated
  with check (
    (public.kicklive_match_rights(match_id)->>'can_control') = 'true'
    and coalesce((public.kicklive_match_rights(match_id)->>'is_locked')::boolean, false) is not true
  );

comment on policy "match_events: officials insert" on public.match_events is
  'Append path for an assigned official, retained so the legacy screens and the engine agree. The engine path runs as the owner and does not depend on this; the assignment check happens twice on purpose.';

-- There is deliberately no update or delete policy for `authenticated`. The correction RPC writes through
-- the owner, and the append-only trigger closes the in-policy hole as well.

-- `matches` keeps its existing read/write policies; only the guard above changes what an
-- engine-owned row will accept. No policy here depends on a client-declared role.

-- ============================================================================
-- 15 · FUNCTION PRIVILEGES (final sweep: nothing left callable by `public`)
-- ============================================================================
revoke all on function public.kicklive_period_of(text) from public;
revoke all on function public.kicklive_minute_ceiling(text) from public;
revoke all on function public.kicklive_lifecycle_event_for(text, text) from public;
-- Trigger functions are not meant to be called directly at all. Revoking keeps `select
-- kicklive_guard_match_result_columns()` out of the reachable surface; the trigger itself runs as the
-- function owner, which a revoke does not affect.
revoke all on function public.kicklive_guard_match_result_columns() from public;
revoke all on function public.kicklive_guard_match_events_append_only() from public;
revoke all on function public.kicklive_sequence_on_insert() from public;
revoke all on function public.kicklive_assert_match_event(integer, text, integer, integer, integer, integer, boolean) from public, authenticated;
grant execute on function public.kicklive_assert_match_event(integer, text, integer, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 16 · VERIFICATION — this migration refuses to commit half-built
-- ============================================================================
-- If any of these fail, the transaction rolls back and the project is exactly as it was. That is the
-- difference between "apply the migration and hope" and "apply the migration or learn why not".

do $$
declare
  v_count integer;
begin
  if to_regclass('public.match_assignments') is null then
    raise exception 'hardening failed: match_assignments was not created';
  end if;

  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'match_events'
     and column_name in ('client_event_id','sequence','period','event_status','corrects_event_id',
                         'correction_reason','corrected_by','corrected_at','recorded_by','recorded_by_role','metadata');
  if v_count <> 11 then
    raise exception 'hardening failed: match_events has % of the 11 ledger columns', v_count;
  end if;

  select count(*) into v_count from information_schema.columns
   where table_schema = 'public' and table_name = 'matches'
     and column_name in ('live_seq','stoppage_minutes','live_updated_at');
  if v_count <> 3 then
    raise exception 'hardening failed: matches is missing its engine columns';
  end if;

  if (select count(*) from public.kicklive_match_transitions) < 49 then
    raise exception 'hardening failed: the transition table holds % legal moves, expected 49',
      (select count(*) from public.kicklive_match_transitions);
  end if;
  -- No orphan moves, and no move that contradicts the status CHECK list on `matches`.
  select count(*) into v_count from public.kicklive_match_transitions t
   where t.from_status not in (select unnest(array['scheduled','waiting','first_half','half_time','second_half',
                                                    'extra_time','penalty_shootout','full_time','suspended',
                                                    'postponed','abandoned','cancelled','completed','live']));
  if v_count > 0 then
    raise exception 'hardening failed: % transition rows name an unknown status', v_count;
  end if;

  if not public.kicklive_has_grant('authenticated','public.kicklive_record_match_event(integer,text,text,integer,integer,integer,integer,integer,text,text,text,jsonb,integer,boolean)','X') then
    raise exception 'hardening failed: the record function is not granted EXECUTE to authenticated';
  end if;
  if public.kicklive_has_grant('anon','public.kicklive_record_match_event(integer,text,text,integer,integer,integer,integer,integer,text,text,text,jsonb,integer,boolean)','X') then
    raise exception 'hardening failed: anon is granted EXECUTE on the record function';
  end if;
  if not public.kicklive_has_grant('anon','public.kicklive_match_live_state(integer)','X') then
    raise exception 'hardening failed: the fan snapshot function is not granted EXECUTE to anon';
  end if;
  if public.kicklive_has_grant('authenticated','public.match_assignments','a') then
    raise exception 'hardening failed: assignments are granted INSERT outside kicklive_assign_match()';
  end if;
  if public.kicklive_has_grant('authenticated','public.match_events','w','event_type') then
    raise exception 'hardening failed: match_events is granted UPDATE to a client role';
  end if;

  -- By NAME, not by pattern. A `like 'kicklive_%'` count over these tables is a claim about the whole
  -- schema from inside one file: Phase 5 later adds `kicklive_notification_job` to `match_events`, so the
  -- count would become 4 and this check would fail on any re-run of this migration — an assertion that
  -- breaks because a *later* file did something correct is a bug in the assertion.
  select count(*) into v_count from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname in ('matches','match_events') and not t.tgisinternal
     and t.tgname in ('kicklive_guard_match_result_columns', 'kicklive_guard_match_events_append_only', 'kicklive_sequence_on_insert');
  if v_count <> 3 then
    raise exception 'hardening failed: % engine triggers installed, expected 3', v_count;
  end if;

  -- The base schema's "admin all" policy does allow UPDATE/DELETE for the admin role; that is accepted
  -- and covered by the append-only trigger (which outlives any policy edit). What must never exist is a
  -- client-role policy for mutating the ledger, and none may be left behind by an earlier version of
  -- this file.
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename = 'match_events'
     and cmd in ('UPDATE','DELETE') and 'authenticated' = any (roles);
  if v_count > 0 then
    raise exception 'hardening failed: % update/delete policies on match_events are granted to authenticated', v_count;
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY — run these after applying, and again after any change to the app's write paths
-- ============================================================================
-- 1. The engine's surface, from an anonymous session (the SQL editor runs as a privileged role, so the
--    privilege assertions below are best repeated through the PostgREST inspector with an anon key):
--
--      select proname, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname like 'kicklive_%' order by 1;
--
-- 2. The guards, from the browser's point of view. With a signed-in *fan* or *admin* token:
--
--      PATCH /rest/v1/matches?id=eq.<a match with live_seq>0>   {"home_score": 9}
--        → expect 403 and "this match is live-engine owned"
--      PATCH /rest/v1/matches?id=eq.<a fixture never touched by the engine> {"home_score": 9}
--        → expect 204 (the ratchet: legacy screens keep working)
--      DELETE /rest/v1/match_events?id=eq.<any>
--        → expect 403 and "append-only ledger"
--
-- 3. The state machine, from an assigned official's token:
--
--      POST /rest/v1/rpc/kicklive_transition_match
--        {"p_match_id": 1, "p_to_status": "first_half"}                      → sequence 1, kickoff event
--        {"p_match_id": 1, "p_to_status": "scheduled"}                        → 409 "illegal_transition"
--        {"p_match_id": 1, "p_to_status": "abandoned"}                        → 400 "needs a reason"
--      POST /rest/v1/rpc/kicklive_record_match_event
--        {"p_match_id":1,"p_client_event_id":"a1","p_event_type":"goal","p_team_id":<home>,
--         "p_player_id":<a home player>,"p_minute":12}                          → home_score 1
--        repeat it verbatim                                                      → duplicate:true, score unchanged
--        {"p_event_type":"goal", ... "p_minute": 88} while in first_half        → 400 ceiling
--
-- 4. The audit trail a dispute is decided on:
--
--      select created_at, action, user_id, details from public.activity_logs
--       where entity_type = 'match' and entity_id = 1 order by created_at desc limit 25;
--
-- 5. Nothing was lost: `select count(*) from match_events` before and after must be identical, and
--      select count(*) from match_events where sequence is null;   -- rows the engine has not numbered
--      select count(*) from matches where live_seq > 0;            -- matches under engine protection
--    must both start at 0 on a project that has not used the engine yet.
--
-- ============================================================================
-- ROLLBACK (deliberately commented out; drops no data)
-- ============================================================================
-- begin;
-- drop trigger if exists kicklive_sequence_on_insert on public.match_events;
-- drop trigger if exists kicklive_guard_match_events_append_only on public.match_events;
-- drop trigger if exists kicklive_guard_match_result_columns on public.matches;
-- drop function if exists public.kicklive_sequence_on_insert();
-- drop function if exists public.kicklive_guard_match_events_append_only();
-- drop function if exists public.kicklive_guard_match_result_columns();
-- drop policy if exists "match_events: officials insert" on public.match_events;
-- -- The ledger columns keep their contents; dropping the columns would delete history, so rollback
-- -- stops at the functions unless you are certain nothing has been written yet.
-- drop function if exists public.kicklive_assign_match(integer, uuid, text, text);
-- drop function if exists public.kicklive_stand_down_assignment(uuid);
-- drop function if exists public.kicklive_match_live_state(integer);
-- drop function if exists public.kicklive_set_match_lock(integer, boolean, text);
-- drop function if exists public.kicklive_finalize_match(integer, boolean);
-- drop function if exists public.kicklive_correct_match_event(integer, text, jsonb, integer);
-- drop function if exists public.kicklive_transition_match(integer, text, text, smallint, integer);
-- drop function if exists public.kicklive_record_match_event(integer, text, text, integer, integer, integer, integer, integer, text, text, text, jsonb, integer, boolean);
-- drop function if exists public.kicklive_assert_match_event(integer, text, integer, integer, integer, integer, boolean);
-- drop function if exists public.kicklive_sync_match_statistics(integer);
-- drop function if exists public.kicklive_event_frame(integer);
-- drop function if exists public.kicklive_lifecycle_event_for(text, text);
-- drop function if exists public.kicklive_match_clock(integer);
-- drop function if exists public.kicklive_match_score(integer);
-- drop function if exists public.kicklive_match_rights(integer);
-- drop function if exists public.kicklive_enter_engine();
-- drop function if exists public.kicklive_period_of(text);
-- drop function if exists public.kicklive_minute_ceiling(text);
-- drop table if exists public.kicklive_match_transitions;
-- drop table if exists public.match_assignments;      -- only if you accept losing the assignment rows
-- commit;
--
-- The added columns on `match_events` and `matches` are *not* dropped by this rollback, on purpose: they
-- are nullable/defaulted, harmless while unused, and removing them would rewrite the ledger. If you must
-- reclaim them, do it in a reviewed migration of its own after the app has stopped reading them.
