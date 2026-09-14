-- ============================================================================
-- READ-ONLY DIAGNOSTIC — "is this database the one the app expects?"
-- ============================================================================
-- Paste this into the Supabase SQL editor (New query → paste → Run) of whichever project the app points at, and
-- you get one row per thing the app depends on, with the file that fixes it named in `do_next`. Nothing here
-- writes: no inserts, no grants, no create, no drop. It is safe at any time, on any project, as many times as you
-- like, and it is the fastest way to tell "SETUP.sql was never pasted here" apart from "SETUP.sql is applied and
-- something else is wrong" — which is the pair of states that produces the confusing
-- `401 … permission denied for table profiles` on sign-up.
--
-- Local equivalent without a paste: `npm run db:check` applies supabase/SETUP.sql to a throwaway Postgres (PGlite)
-- and runs this file on it, which proves the *bundle* is in that state; this file proves *your project* is.
-- ============================================================================

select
  case when to_regclass('auth.users') is not null then 'pass' else 'fail' end as status,
  'this is a Supabase project (auth.users exists)' as check,
  'point the editor at the project named by `npm run pair:check`' as do_next
union all
select
  case when to_regclass('public.profiles') is not null then 'pass' else 'fail' end,
  'public.profiles exists',
  'paste the whole supabase/SETUP.sql into this project (not a single supabase/migrations file)'
union all
select
  case when to_regprocedure('public.handle_new_user()') is not null then 'pass' else 'fail' end,
  'the sign-up profile function public.handle_new_user() exists',
  'paste supabase/SETUP.sql; without it every new account is created with no profile row'
union all
select
  case
    when exists (
      select 1
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_proc p on p.oid = t.tgfoid
        join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
       where n.nspname = 'auth' and c.relname = 'users' and pn.nspname = 'public' and p.proname = 'handle_new_user'
    ) then 'pass'
    else 'fail'
  end,
  'auth.users has on_auth_user_created to public.handle_new_user() (the row a new account needs)',
  'paste supabase/SETUP.sql — it creates or replaces on_auth_user_created'
union all
select
  case when to_regprocedure('public.kicklive_set_user_role(uuid, text)') is not null then 'pass' else 'fail' end,
  'the only supported role writer (kicklive_set_user_role) is installed',
  'paste supabase/SETUP.sql (phase 10 installs it); until then CREATE_ADMIN_PROFILE.sql refuses to run'
union all
select
  case when count(1) = 0 then 'pass' else 'fail' end,
  'every auth user has a profile row (' || count(1)::text || ' account(s) without one)',
  'the row comes from the sign-up trigger; re-paste supabase/SETUP.sql, then register a fresh account'
  from auth.users u
  left join public.profiles p on p.id = u.id
 where to_regclass('public.profiles') is not null
having to_regclass('auth.users') is not null
union all
-- The privilege side, measured the way the shipped tests measure it. Deliberately NOT `has_table_privilege` /
-- `has_function_privilege`: those consult the *current* role and short-circuit to "yes" for a superuser, which is
-- exactly who runs the SQL editor — so they would report a correctly hardened project as broken. The bundle's own
-- `public.kicklive_has_grant(role, object, privilege[, column])` reads the stored ACL item instead, and answers
-- the same way for the postgres role and for an anonymous visitor.
select
  case
    when to_regprocedure('public.kicklive_set_user_role(uuid, text)') is null then 'n/a'
    when public.kicklive_has_grant('anon', 'public.kicklive_set_user_role(uuid, text)', 'X') then 'fail'
    else 'pass'
  end,
  'anon cannot execute the role writer (kicklive_set_user_role)',
  'paste supabase/SETUP.sql (phases 3 and 7 revoke the anonymous EXECUTE on writers)'
union all
select
  case
    when to_regclass('public.profiles') is null then 'n/a'
    when public.kicklive_has_grant('authenticated', 'public.profiles', 'w') then 'fail'
    else 'pass'
  end,
  'a browser session has no table-wide write on profiles (the trigger owns the row, a function owns the edit)',
  'if this says fail: the phase-1/phase-10 narrowing did not apply — re-paste supabase/SETUP.sql, then sign up once more'
union all
select
  case
    when to_regprocedure('public.kicklive_profile_update(text, text)') is null then 'fail'
    when public.kicklive_has_grant('anon', 'public.kicklive_profile_update(text, text)', 'X') then 'fail'
    when public.kicklive_has_grant('authenticated', 'public.kicklive_profile_update(text, text)', 'X') then 'pass'
    else 'fail'
  end,
  'the owner CAN save their own username/phone, and only through kicklive_profile_update()',
  'this is what ProfilePage and sign-up write through. fail = profile saving is broken for every user: re-paste supabase/SETUP.sql (phase 10 section 4 installs it)'
union all
select
  case when count(1) = 0 then 'pass' else 'fail' end,
  'every privileged table is protected by row-level security (' || count(1)::text || ' unprotected)',
  'paste supabase/SETUP.sql — phase 1 turns relrowsecurity on'
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and c.relname in ('profiles', 'advertisers', 'advertisements', 'sponsorships', 'media', 'notifications', 'system_health')
   and coalesce(c.relrowsecurity, false) = false
having to_regclass('public.profiles') is not null
 order by 1 desc, 2
 limit 40;
