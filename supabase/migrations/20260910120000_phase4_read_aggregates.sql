-- ============================================================================
--  KICKLIVE · Phase 4 — read aggregates
--  20260910120000_phase4_read_aggregates.sql
--
--  Why this file exists (docs/PHASE4_DATA_ARCHITECTURE.md F-05, F-06):
--  the league table was computed in the browser from an unbounded read of every match in a competition, in
--  three places, with three rules; and the clubs page counted squad sizes by fetching one row per player in
--  the league. Neither answer needs the rows: both are a grouped aggregate Postgres can do in one pass and
--  return as ~20 rows. This is the only schema change in the phase, and it is additive — no drop, no alter
--  of an existing column, no rewrite of history.
--
--  Both functions are SECURITY **INVOKER**, deliberately. A read aggregate has no business seeing rows the
--  caller cannot see: it is here to compute an answer near the data, not to widen what anyone may read. RLS
--  on `matches`, `players` and `teams` therefore still decides which rows enter the aggregate, which is why
--  an anonymous visitor and a signed-in admin get the same public table and no more.
--
--  How to run it: `supabase db push`, or paste the whole file into the dashboard SQL editor. It opens with
--  `begin;` and closes with `commit;` like the other two files here, so an error mid-way rolls back rather
--  than leaving one function created and the next not. The verification block raises, which is what makes
--  that rollback the outcome you see instead of a silent partial state.
--
--  To watch it fail safely first: `psql -1 -f <this file> --single-transaction -v ON_ERROR_STOP=1`.
-- ============================================================================

begin;

-- ── 1. one predicate: which statuses count as a result ──────────────────────────────────────
--
--  `matches.status`'s CHECK list (KICKLIVE_FINAL_SCHEMA.sql §3.6) admits 'full_time' and 'completed'.
--  'finished' is not in it: the superseded `MatchControlComplete` used to write it and the CHECK rejected
--  the row, but a project created from an older schema dump may still hold one. Tolerating it here — and
--  only here, in the one predicate every reader shares — keeps the aggregate agreeing with the browser rule
--  in `src/lib/data/standings.ts` instead of quietly disagreeing with it. `tests/unit/phase4-data.test.ts`
--  pins the two against each other, so they cannot drift apart silently.
create or replace function kicklive_is_final_status(p_status text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status in ('full_time', 'completed', 'finished');
$$;

comment on function kicklive_is_final_status(text) is
  'The single definition of "this match is a result", shared by the standings aggregate and pinned against src/lib/data/standings.ts.';

-- ── 2. the league table, computed where the rows are ─────────────────────────────────────────
--
--  Shape mirrors `StandingRow` in `src/lib/data/standings.ts`, because the client falls back to that rule
--  when this function is not deployed and the two must be interchangeable (same fields, same tie-breaks):
--  points, then goal difference, then goals for, then name. `form` is chronological (`["W","D"]` = won then
--  drew); `recentForm()` on the client shows the last five, newest first.
create or replace function kicklive_competition_standings(
  p_competition_id integer,
  out team_id         integer,
  out name            text,
  out short_name      text,
  out primary_color   text,
  out secondary_color text,
  out played          integer,
  out won             integer,
  out drawn           integer,
  out lost            integer,
  out gf              integer,
  out ga              integer,
  out gd              integer,
  out points          integer,
  out form            jsonb
)
returns setof record
language sql
stable
set search_path = public, pg_temp
as $$
  with sides as (
    select m.home_team_id as team,
           m.away_team_id as opponent,
           coalesce(m.home_score, 0) as scored,
           coalesce(m.away_score, 0) as conceded,
           m.start_time,
           m.id as match_id,
           m.status
      from matches m
     where m.competition_id = p_competition_id
       and m.home_team_id is not null
       and m.away_team_id is not null
    union all
    select m.away_team_id,
           m.home_team_id,
           coalesce(m.away_score, 0),
           coalesce(m.home_score, 0),
           m.start_time,
           m.id,
           m.status
      from matches m
     where m.competition_id = p_competition_id
       and m.home_team_id is not null
       and m.away_team_id is not null
  ),
  -- Every club that appears in the competition, played or not: the browser rule builds a row for each of
  -- them (played = 0), so a competition mid-schedule must not shrink to only its finished sides.
  participants as (
    select distinct team from sides
  ),
  decided as (
    select * from sides where kicklive_is_final_status(status)
  ),
  tallied as (
    select team,
           count(*)                                                    as played,
           count(*) filter (where scored > conceded)                   as won,
           count(*) filter (where scored = conceded)                   as drawn,
           count(*) filter (where scored < conceded)                   as lost,
           coalesce(sum(scored), 0)                                    as gf,
           coalesce(sum(conceded), 0)                                  as ga,
           coalesce(sum(scored), 0) - coalesce(sum(conceded), 0)        as gd,
           -- 3/1/0, the rule the app has always applied; `competitions` has no points-per-win column, so
           -- inventing one here would be a schema change smuggled into a performance phase.
           coalesce(sum(case when scored > conceded then 3
                             when scored = conceded then 1
                             else 0 end), 0)                            as points
      from decided
     group by team
  ),
  forms as (
    select team,
           jsonb_agg(
             case when scored > conceded then 'W'
                  when scored = conceded then 'D'
                  else 'L'
             end
             order by start_time nulls last, match_id
           ) as form
      from decided
     group by team
  )
  select t.id,
         t.name,
         t.short_name,
         t.primary_color,
         t.secondary_color,
         coalesce(ta.played, 0)::integer,
         coalesce(ta.won, 0)::integer,
         coalesce(ta.drawn, 0)::integer,
         coalesce(ta.lost, 0)::integer,
         coalesce(ta.gf, 0)::integer,
         coalesce(ta.ga, 0)::integer,
         coalesce(ta.gd, 0)::integer,
         coalesce(ta.points, 0)::integer,
         coalesce(f.form, '[]'::jsonb)
    from participants p
    join teams t on t.id = p.team
    left join tallied ta on ta.team = t.id
    left join forms f on f.team = t.id
   -- The browser rule only counts clubs that are `active` (or pre-date the status column); keeping the same
   -- filter means the fallback and the function cannot disagree about a rejected club.
   where t.status = 'active' or t.status is null
   order by coalesce(ta.points, 0) desc,
            coalesce(ta.gd, 0) desc,
            coalesce(ta.gf, 0) desc,
            t.name asc;
$$;

comment on function kicklive_competition_standings(integer) is
  'League table for one competition, computed near the rows. SECURITY INVOKER: RLS decides which matches count. Mirrors src/lib/data/standings.ts.';

-- ── 3. squad sizes, for the club index ───────────────────────────────────────────────────────
--
--  `TeamsPage` used to read `select('team_id')` across every player row in the database and count them in a
--  Map — one row per human being, per page view. The column is named `count` because that is the field the
--  client spec reads.
create or replace function kicklive_squad_sizes()
returns table (team_id integer, count bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  select p.team_id, count(*)::bigint
    from players p
    join teams t on t.id = p.team_id
   where p.team_id is not null
   group by p.team_id
   order by count(*) desc, p.team_id asc;
$$;

comment on function kicklive_squad_sizes() is
  'Rows per club, aggregated in Postgres. Replaces a per-player row scan in TeamsPage; bounded by RLS on players.';

-- ── 4. grants: execute for the roles that read, nothing else ──────────────────────────────────
--
--  Same posture as Phase 1/3: revoke broadly, then grant the one privilege the read path needs. These are
--  functions, so there is nothing to revoke DML on; the point of the revoke is that `execute` is granted to
--  PUBLIC by default in a fresh database.
revoke all on function kicklive_is_final_status(text) from public, anon, authenticated;
revoke all on function kicklive_competition_standings(integer) from public, anon, authenticated;
revoke all on function kicklive_squad_sizes() from public, anon, authenticated;

grant execute on function kicklive_is_final_status(text) to anon, authenticated, service_role;
grant execute on function kicklive_competition_standings(integer) to anon, authenticated, service_role;
grant execute on function kicklive_squad_sizes() to anon, authenticated, service_role;

-- ── 5. indexes: proposed, and deliberately NOT applied here ───────────────────────────────────
--
--  The rule for this phase is that an index needs a measurement. There is no database in this repository's
--  sandbox to measure against — no Postgres, no rows, no plan — so nothing is applied here. What is here
--  instead is the exact candidate set, in the exact names `scripts/query-audit.mjs --explain` prints (that
--  command emits an `explain (analyze, buffers, settings)` for the read each index serves, and a test in
--  `tests/unit/query-ratchet.test.ts` fails if this list and that list stop agreeing, because a name that
--  drifts is a name nobody applies).
--
--  Apply one at a time, against staging with production-shaped data, only for the ones whose plan shows a
--  sequential scan you actually pay for. `CREATE INDEX CONCURRENTLY` on a large table; `ANALYZE` after.
--
--    -- matches: the home live strip and every status-filtered fixture list — `status in (…) [and competition_id = …] order by start_time desc`
--    -- create index if not exists matches_status_start_time_idx on matches (status, start_time desc);
--    -- matches: the paginated match list, `order by start_time desc limit n`
--    -- create index if not exists matches_start_time_idx on matches (start_time desc);
--    -- matches: the standings aggregate's two side-scans and every per-competition fixture read
--    -- create index if not exists matches_competition_id_start_time_idx on matches (competition_id, start_time);
--    -- players: top scorers (`order by goals desc limit n`), the only unbounded sort left in a public read
--    -- create index if not exists players_goals_idx on players (goals desc nulls last, id);
--    -- teams: the club index and every sidebar — `status in (active, null) order by name`
--    -- create index if not exists teams_status_name_idx on teams (status, name);
--    -- media: the media feed and portal lists, `order by created_at desc limit n`
--    -- create index if not exists media_created_at_idx on media (created_at desc);
--    -- players: only if §3's aggregate turns out to cost more than it saves; its plan is
--    --   explain (analyze, buffers) select * from kicklive_squad_sizes();
--    -- create index if not exists players_team_id_idx on players (team_id);
--
--  The one the phase was tempted by and did not do: a covering index on `matches (competition_id) include
--  (status, home_score, away_score, home_team_id, away_team_id, start_time)` would make the standings
--  aggregate index-only. That is an index justified by one function written in the same change — precisely
--  the circular measurement the rule exists to stop.

-- ── 6. verification ───────────────────────────────────────────────────────────────────────────
--
--  Run in the same transaction as the file. It raises, so `commit` is unreachable from a broken state.
do $verify$
declare
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('kicklive_is_final_status','kicklive_competition_standings','kicklive_squad_sizes')) <> 3 then
    raise exception 'phase4 verification failed: expected 3 read aggregates in public, found a different number';
  end if;

  -- INVOKER, not DEFINER: an aggregate must not see rows the caller cannot.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('kicklive_competition_standings','kicklive_squad_sizes')
       and p.prosecdef
  ) then
    raise exception 'phase4 verification failed: a read aggregate is SECURITY DEFINER; it must be INVOKER';
  end if;

  -- search_path pinned, or a hijacked `public` alias could change what the aggregate reads.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('kicklive_is_final_status','kicklive_competition_standings','kicklive_squad_sizes')
       and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=public%'
  ) then
    raise exception 'phase4 verification failed: a read aggregate does not pin search_path';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'kicklive_is_final_status'
       and p.prosrc like '%full_time%' and p.prosrc like '%completed%' and p.prosrc like '%finished%'
  ) then
    raise exception 'phase4 verification failed: kicklive_is_final_status lost a status the client rule counts';
  end if;

  -- Execute granted to the roles the browser uses, and nothing granted to PUBLIC beyond that.
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('kicklive_is_final_status','kicklive_competition_standings','kicklive_squad_sizes')
       -- read the ACL rather than has_function_privilege(): the latter is true for the superuser the SQL
       -- editor runs as, which would make this count 3 on a database where the grant never landed.
       and exists (
         select 1 from pg_roles r, aclexplode(p.proacl) g
          where r.rolname = 'anon' and g.privilege_type = 'X' and (g.grantee = r.oid or g.grantee = 0))
  ) <> 3 then
    raise exception 'phase4 verification failed: anon cannot execute one of the read aggregates';
  end if;

  -- Calling the aggregate on a competition that does not exist must answer "nothing", not raise: the client
  -- treats an error as an outage and a zero-row answer as an empty table.
  perform kicklive_competition_standings(-1);
  perform count(*) from kicklive_squad_sizes();

  raise notice 'phase4 read aggregates: ok (3 functions, INVOKER, search_path pinned, granted to anon)';
end
$verify$;

-- PostgREST caches the schema cache; without this the new functions 404 until the next reload.
notify pgrst, 'reload schema';

-- ── manual checks, once applied ────────────────────────────────────────────────────────────────
--  VERIFY:  select count(*) from kicklive_squad_sizes();
--  VERIFY:  select * from kicklive_competition_standings((select id from competitions order by id limit 1)) limit 5;
--  VERIFY:  -- compare against the browser rule on the same data:
--           --   node scripts/query-audit.mjs --live --url https://<ref>.supabase.co --key <anon>
--           --   and open /tables (it now shows the SQL answer; the fallback path is /team/:id's cache key)
--  ROLLBACK: drop function if exists kicklive_competition_standings(integer);
--            drop function if exists kicklive_squad_sizes();
--            drop function if exists kicklive_is_final_status(text);
--            -- nothing else in this file needs undoing: no table, column, policy or row was touched.

commit;
