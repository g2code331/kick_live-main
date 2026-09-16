-- STEP 22 · the one privilege that survived every narrowing: TRUNCATE, schema-wide
-- Phases 1–12 revoked TRUNCATE on exactly two tables (profiles, activity_logs) because those were the two the
-- audit named. But Supabase hands every table it creates a default GRANT ALL to `authenticated` and `anon`, and
-- ALL includes TRUNCATE. A live count of this schema found thirteen tables a signed-in fan — and in several
-- cases even a logged-out `anon` — could still empty with one statement: competitions, matches, teams,
-- standings, players, media, notifications, seasons, team_news, team_staff, match_commentary, match_events,
-- match_statistics. TRUNCATE is not DELETE: it ignores row-level security entirely, so RLS policies protect
-- none of these rows from it. A fan cannot delete a single match row through RLS, yet could truncate the whole
-- matches table — the policy layer never sees the statement.
--
-- Unlike a schema-wide revoke of DELETE/INSERT/UPDATE (which would strip match_interest inserts and
-- notification_devices reads that ride on the same default grant), TRUNCATE appears in NO legitimate app path:
-- nothing in the client, the Worker, or any definer function issues it. That is what makes the schema-wide form
-- correct here where it would be reckless elsewhere — this revoke removes a privilege the application never uses,
-- across every table at once, so a table added tomorrow that forgets its own lockdown is still covered by the
-- default-privileges change below rather than left as the next hole.
begin;

-- ── 1 · what the API roles hold right now: every table where authenticated or anon can TRUNCATE
--        (run this same select after the revoke and the two result sets should differ by exactly these rows).
--        The probe reads the real ACL through public.kicklive_has_grant (never has_table_privilege, which a
--        superuser SQL-editor session answers "true" for regardless of the grant — the reason phase 1 built the
--        helper). It is fed c.oid::regclass::text rather than a hand-formatted name: the planner is free to
--        evaluate a WHERE function before the nspname filter narrows the scan, and a name like
--        format('public.%I', 'users') built from an unrelated row could resolve against a non-existent relation
--        and error. An oid round-trips through regclass to its own, always-resolvable name, so it is filter-safe.
select c.relname as object,
       public.kicklive_has_grant('authenticated', c.oid::regclass::text, 'D') as auth_truncate,
       public.kicklive_has_grant('anon', c.oid::regclass::text, 'D') as anon_truncate
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and (public.kicklive_has_grant('authenticated', c.oid::regclass::text, 'D')
    or public.kicklive_has_grant('anon', c.oid::regclass::text, 'D'))
order by c.relname;

-- ── 2 · revoke TRUNCATE from every existing table in the schema, from both API roles.
--        This touches only TRUNCATE; SELECT/INSERT/UPDATE/DELETE grants the app relies on are left exactly as
--        the earlier phases left them.
revoke truncate on all tables in schema public from authenticated, anon;

-- ── 3 · and close the same door on tables that do not exist yet. Supabase's default privileges grant ALL to
--        the API roles on newly-created tables; alter those defaults so a future table is born without TRUNCATE
--        for authenticated/anon. This is scoped to objects the `postgres` owner creates, which is how the
--        migrations and Supabase's own DDL run. Existing rows are handled by step 2; this is only for the next
--        table nobody has written yet.
alter default privileges in schema public revoke truncate on tables from authenticated, anon;
alter default privileges for role postgres in schema public revoke truncate on tables from authenticated, anon;

-- ── 4 · prove it. REPORT what remains rather than VETO (a raise rolls the whole single-transaction paste back —
--        see step 20/21). The one hard raise is reserved for a live regression this file itself would have
--        caused: destroying an app-critical grant. If TRUNCATE somehow survives on a table, that is a finding to
--        read in the notice and chase, not a reason to abort every earlier statement in the paste.
do $$
declare
  v_left    text := '';
  v_broke   text := '';
  r         record;
begin
  -- 4a · any table where an API role can still TRUNCATE, after the revoke
  for r in
    select c.relname,
           public.kicklive_has_grant('authenticated', c.oid::regclass::text, 'D') as a,
           public.kicklive_has_grant('anon', c.oid::regclass::text, 'D') as n
    from pg_class c
    join pg_namespace nsp on nsp.oid = c.relnamespace
    where nsp.nspname = 'public'
      and c.relkind = 'r'
      and (public.kicklive_has_grant('authenticated', c.oid::regclass::text, 'D')
        or public.kicklive_has_grant('anon', c.oid::regclass::text, 'D'))
    order by c.relname
  loop
    v_left := v_left || ' ' || r.relname || case when r.a and r.n then '(auth,anon)'
                                                 when r.a then '(auth)'
                                                 else '(anon)' end;
  end loop;

  -- 4b · the app-critical DML that MUST survive — this revoke was TRUNCATE-only, so any of these turning false
  --       means something went wrong and the paste should not stand.
  if not public.kicklive_has_grant('authenticated', 'public.match_interest', 'a')       then v_broke := v_broke || ' match_interest-INSERT'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.match_interest', 'r')       then v_broke := v_broke || ' match_interest-SELECT'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.match_interest', 'd')       then v_broke := v_broke || ' match_interest-DELETE'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.notification_devices', 'r') then v_broke := v_broke || ' notification_devices-SELECT'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.notification_devices', 'd') then v_broke := v_broke || ' notification_devices-DELETE'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.notification_preferences', 'a') then v_broke := v_broke || ' notification_preferences-INSERT'; end if;
  if not public.kicklive_has_grant('authenticated', 'public.notification_preferences', 'w') then v_broke := v_broke || ' notification_preferences-UPDATE'; end if;
  -- profiles SELECT is NOT checked at the table level: phase 10 deliberately revoked the table-wide SELECT grant
  -- and left authenticated only the column grants it needs, so a table-wide SELECT read is false by design. The
  -- column grant is what survives — asked below with the p_column argument — and phase 13 does not touch it.
  if not public.kicklive_has_grant('authenticated', 'public.profiles', 'r', 'id')       then v_broke := v_broke || ' profiles-id-SELECT'; end if;

  if v_broke <> '' then
    raise exception 'step 22 went too wide: a TRUNCATE-only revoke must not have touched these, but they are now missing:%', v_broke
      using errcode = '42501';
  end if;

  if v_left <> '' then
    raise notice 'STILL TRUNCATABLE by an API role after step 22:%. If this is non-empty on a fresh paste, a table '
      'was created after this migration ran and inherited the default GRANT ALL — re-run this file, or add the '
      'table to its own lockdown.', v_left;
  else
    raise notice 'step 22 verified: no table in schema public is TRUNCATE-able by authenticated or anon, and the '
      'app-critical INSERT/SELECT/UPDATE/DELETE grants are intact.';
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
