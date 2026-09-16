-- STEP 21 · the privilege layer the phases never touched: TRUNCATE / DELETE / INSERT
-- Two tables: public.profiles (every account) and public.activity_logs (the audit trail — production's own
-- count reported it truncatable by authenticated, and scripts/sql-flow.mjs:935 already expects a delete on it
-- to be refused). Scope stays narrow on purpose: a schema-wide revoke would also strip match_interest inserts
-- and notification_devices reads, which ride on the same Supabase default grant. UPDATE is NOT touched: on
-- profiles the flow's column revokes own it, and on activity_logs phase 9 has one sanctioned update.
begin;

-- ── 1 · what the API roles actually hold, right now (run it again after the revokes and diff the two rows)
select 'public.profiles' as object,
       public.kicklive_has_grant('authenticated', 'public.profiles', 'r')     as auth_select,
       public.kicklive_has_grant('authenticated', 'public.profiles', 'a')     as auth_insert,
       public.kicklive_has_grant('authenticated', 'public.profiles', 'd')     as auth_delete,
       public.kicklive_has_grant('authenticated', 'public.profiles', 'D')   as auth_truncate,
       public.kicklive_has_grant('anon', 'public.profiles', 'D')            as anon_truncate
union all
select 'public.activity_logs',
       public.kicklive_has_grant('authenticated', 'public.activity_logs', 'r'),
       public.kicklive_has_grant('authenticated', 'public.activity_logs', 'a'),
       public.kicklive_has_grant('authenticated', 'public.activity_logs', 'd'),
       public.kicklive_has_grant('authenticated', 'public.activity_logs', 'D'),
       public.kicklive_has_grant('anon', 'public.activity_logs', 'D');

-- ── 2 · revoke exactly what nothing uses
revoke truncate on public.profiles from authenticated, anon;
revoke trigger, references on public.profiles from authenticated, anon;
revoke delete on public.profiles from authenticated, anon;
revoke insert on public.profiles from authenticated, anon;

revoke truncate, delete on public.activity_logs from authenticated, anon;
revoke trigger, references on public.activity_logs from authenticated, anon;

-- ── 3 · prove it, and refuse only live security failures (a raise here would roll the paste back — see step 20)
do $$
declare
  v_bad text := '';
begin
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'D') then v_bad := v_bad || ' profiles-TRUNCATE'; end if;
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'd')   then v_bad := v_bad || ' profiles-DELETE'; end if;
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'a')   then v_bad := v_bad || ' profiles-INSERT'; end if;
  if public.kicklive_has_grant('anon', 'public.profiles', 'D') then v_bad := v_bad || ' anon-profiles-TRUNCATE'; end if;
  if public.kicklive_has_grant('authenticated', 'public.activity_logs', 'D') then v_bad := v_bad || ' trail-TRUNCATE'; end if;
  if public.kicklive_has_grant('authenticated', 'public.activity_logs', 'd')   then v_bad := v_bad || ' trail-DELETE'; end if;
  if to_regprocedure('public.kicklive_set_user_role(uuid, text)') is not null
     and public.kicklive_has_grant('anon', 'public.kicklive_set_user_role(uuid, text)', 'X') then
    raise exception 'anon may execute the role writer — re-run the bundle; this file does not grant it' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('postgres', 'public.profiles', 'w') then
    raise exception 'the owner lost UPDATE on public.profiles: kicklive_set_user_role() could not write, and the '
      'bootstrap would fail with a bare "permission denied for table profiles". Restore it: '
      'grant update, insert, references on public.profiles to postgres;';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'w', 'role') then
    raise notice 'STILL EXPOSED: authenticated can update profiles.role at the PRIVILEGE layer, so the guard trigger '
      'is the only thing between a signed-in fan and an admin account. Find what confers it with: '
      'select * from aclexplode((select relacl from pg_class where oid = ''public.profiles''::regclass)). '
      'This file does not touch UPDATE, so re-running it will not change that.';
  end if;
  if v_bad <> '' then
    raise exception 'the revokes did not land; the API roles still hold:%', v_bad using errcode = '42501';
  end if;
  raise notice 'step 21 verified: profiles and the audit trail are no longer truncatable/deletable/insertable by the API roles.';
end;
$$;

commit;

notify pgrst, 'reload schema';
