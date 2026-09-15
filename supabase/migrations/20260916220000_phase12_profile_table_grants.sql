-- STEP 21 · the privilege layer the phases never touched: TRUNCATE / DELETE / INSERT
-- Two tables: public.profiles (every account) and public.activity_logs (the audit trail — production's own
-- count reported it truncatable by authenticated, and scripts/sql-flow.mjs:935 already expects a delete on it
-- to be refused). Scope stays narrow on purpose: a schema-wide revoke would also strip match_interest inserts
-- and notification_devices reads, which ride on the same Supabase default grant. UPDATE is NOT touched: on
-- profiles the flow's column revokes own it, and on activity_logs phase 9 has one sanctioned update.
begin;

-- ── 1 · what the API roles actually hold, right now (run it again after the revokes and diff the two rows)
select 'public.profiles' as object,
       has_table_privilege('authenticated', 'public.profiles', 'SELECT')     as auth_select,
       has_table_privilege('authenticated', 'public.profiles', 'INSERT')     as auth_insert,
       has_table_privilege('authenticated', 'public.profiles', 'DELETE')     as auth_delete,
       has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')   as auth_truncate,
       has_table_privilege('anon', 'public.profiles', 'TRUNCATE')            as anon_truncate
union all
select 'public.activity_logs',
       has_table_privilege('authenticated', 'public.activity_logs', 'SELECT'),
       has_table_privilege('authenticated', 'public.activity_logs', 'INSERT'),
       has_table_privilege('authenticated', 'public.activity_logs', 'DELETE'),
       has_table_privilege('authenticated', 'public.activity_logs', 'TRUNCATE'),
       has_table_privilege('anon', 'public.activity_logs', 'TRUNCATE');

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
  if has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE') then v_bad := v_bad || ' profiles-TRUNCATE'; end if;
  if has_table_privilege('authenticated', 'public.profiles', 'DELETE')   then v_bad := v_bad || ' profiles-DELETE'; end if;
  if has_table_privilege('authenticated', 'public.profiles', 'INSERT')   then v_bad := v_bad || ' profiles-INSERT'; end if;
  if has_table_privilege('anon',          'public.profiles', 'TRUNCATE') then v_bad := v_bad || ' anon-profiles-TRUNCATE'; end if;
  if has_table_privilege('authenticated', 'public.activity_logs', 'TRUNCATE') then v_bad := v_bad || ' trail-TRUNCATE'; end if;
  if has_table_privilege('authenticated', 'public.activity_logs', 'DELETE')   then v_bad := v_bad || ' trail-DELETE'; end if;
  if to_regprocedure('public.kicklive_set_user_role(uuid, text)') is not null
     and has_function_privilege('anon', 'public.kicklive_set_user_role(uuid, text)', 'execute') then
    raise exception 'anon may execute the role writer — re-run the bundle; this file does not grant it' using errcode = '42501';
  end if;
  if not has_table_privilege('postgres', 'public.profiles', 'UPDATE') then
    raise exception 'the owner lost UPDATE on public.profiles: kicklive_set_user_role() could not write, and the '
      'bootstrap would fail with a bare "permission denied for table profiles". Restore it: '
      'grant update, insert, references on public.profiles to postgres;';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') then
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
