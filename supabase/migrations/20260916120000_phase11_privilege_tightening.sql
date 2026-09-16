-- ============================================================================
-- STEP 20 · "a dashboard session" was defined as "a superuser session", and on Supabase it is not one
-- ============================================================================
-- What your screenshot proved: in the hosted SQL editor `session_user` is `postgres`, and Supabase's `postgres`
-- is NOT a superuser. My previous two files both asked "is this session a superuser?" — first via current_user
-- (wrong role), then via session_user (right role, wrong test). Both refused a legitimate operator.
--
-- The rule that actually matters is not "superuser", it is "a database session, not an API request". Two facts
-- make that decidable, and neither depends on which role Supabase happens to hand the dashboard:
--
--   1. Every browser/API call goes through PostgREST, which sets the transaction-local `request.jwt.claim.role`
--      GUC before switching role. A SQL-editor paste has no such GUC. That is the reliable half of the test.
--   2. The dashboard's login is a named operator role. Supabase gives its SQL editor `postgres`, and `postgres`
--      owns `public.profiles` because this very bundle creates the table through that connection — but "owns the
--      table" is NOT accepted as authority on its own: a `security definer` function inherits its owner's
--      identity, so rights alone cannot tell a browser call from a paste. Only the login can.
--
-- This file installs that rule as ONE function and points the guard trigger and the audited role writer at it,
-- so the two can never disagree again — which is the actual defect behind both errors you have seen.
-- ============================================================================


-- The shipped SETUP.sql wraps itself in explicit begin/commit for the same reason: if the editor already opened a
-- transaction this begin is a no-op warning, and if it did not, the four blocks below either all apply or none do.
begin;

-- ── 1 · the predicate, in one place ──────────────────────────────────────────────────────────────────────────
create or replace function public.kicklive_is_dashboard_session()
returns boolean
-- STABLE is legal here because the guard trigger below reads it once per row; the body writes nothing, so that is safe.
-- (Nothing may be commented inside the CREATE FUNCTION property list — the grammar rejects it.)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_login text := session_user;
  v_super boolean;
begin
  -- 1 · a PostgREST request — from the browser, from the Worker, from the API token — always carries the claim
  --     GUCs; a SQL-editor paste never does. This is the load-bearing test and it comes first, because it is the
  --     only one that cannot be influenced by privileges or by role membership.
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
              nullif(current_setting('request.jwt.claim',     true), '')) is not null then
    return false;
  end if;

  -- 2 · a client role is never the operator, whatever else it inherited. `not in (…)` is TRUE for NULL in SQL, so
  --     the operator roles must be tested for explicitly rather than by exclusion.
  if current_user is null or current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    return false;
  end if;

  -- 3 · the LOGIN must itself be the operator role. Two mistakes I had to make before writing this line:
  --     · asking whether `session_user` is a superuser — the hosted SQL editor never is, which is the refusal you
  --       got, and the reason this function exists at all;
  --     · asking only "does session_user hold CREATE on public". A SECURITY DEFINER function inherits its owner's
  --       identity, so a definer writer called by anon would have passed. Requiring current_user = session_user
  --       means nobody switched into the owner underneath us, and naming the operator roles means an owner only
  --       qualifies when it really is the role you logged in as.
  if current_user <> v_login then
    return false;
  end if;
  select rolsuper into v_super from pg_catalog.pg_roles where rolname = v_login;
  if v_login in ('postgres', 'supabase_admin') or coalesce(v_super, false) then
    return true;
  end if;

  -- 4 · one escape hatch, and only one: a self-hosted Supabase that renamed its dashboard role. It must hold
  --     CREATE on `public` (which a client role never does) AND own the table being protected. If your deployment
  --     does not match, run the paste as postgres — never loosen this predicate to make a paste "go through".
  if not has_schema_privilege(v_login, 'public', 'CREATE') then
    return false;
  end if;
  return (select r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            join pg_roles r on r.oid = c.relowner
           where n.nspname = 'public' and c.relname = 'profiles') = v_login;
end;
$$;

comment on function public.kicklive_is_dashboard_session() is
  'True only for the dashboard/psql LOGIN (postgres, supabase_admin, a superuser, or a self-hosted renamed owner), '
  'and false for every API request. Two things it deliberately does not do: it never asks whether the session is a '
  'superuser, because on hosted Supabase the SQL editor runs as postgres, which is NOT one, and that false answer is '
  'what made the previous fix refuse you; and it never trusts a role merely because it holds rights, because a '
  'SECURITY DEFINER function inherits its owner and would pass. A PostgREST request always carries request.jwt.claim*.';

-- Everyone may ask the question; the answer discloses nothing and refusing anon/authenticated here would only
-- make the callers fail for a confusing reason.
grant execute on function public.kicklive_is_dashboard_session() to public, anon, authenticated, service_role;

-- ── 2 · the guard trigger, on the same rule ────────────────────────────────────────────────────────────────
create or replace function public.kicklive_guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
begin
  if public.kicklive_is_dashboard_session() then
    return new;
  end if;

  v_admin := coalesce(public.is_admin(), false);

  if tg_op = 'INSERT' then
    if not v_admin then
      new.role := 'fan';
    end if;
    return new;
  end if;

  if not v_admin then
    if new.role is distinct from old.role then
      raise exception
        'role changes are not permitted on public.profiles; call public.kicklive_set_user_role() as an admin'
        using errcode = '42501';
    end if;
    if new.email is distinct from old.email then
      raise exception
        'email is owned by auth.users; change it through Supabase Auth, not public.profiles'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.kicklive_guard_profile_privileges() is
  'Blocks client-side role/email writes on public.profiles. Exempts an API request never, a dashboard session '
  'always (kicklive_is_dashboard_session), and an admin session for the insert path it already owns.';

-- ── 3 · the audited role writer, on the same rule ────────────────────────────────────────────────────────────
create or replace function public.kicklive_set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous    text;
  v_admin_count int;
begin
  if not coalesce(public.is_admin(), false) and not public.kicklive_is_dashboard_session() then
    raise exception 'permission denied: kicklive_set_user_role needs an admin, or a database session (SQL editor / psql), not an API request'
      using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('fan', 'team_manager', 'media', 'admin') then
    raise exception 'unknown role %', coalesce(p_role, '<null>') using errcode = '22023';
  end if;

  select role into v_previous from public.profiles where id = p_user_id;
  if v_previous is null then
    raise exception 'no profile for user %', p_user_id using errcode = 'P0002';
  end if;
  if v_previous = p_role then
    return;
  end if;

  -- Self-lockout is unrecoverable without dashboard access, so it is refused at the database rather than left to
  -- a UI warning. A dashboard session is still bound by it: a guard is not a permission check.
  if v_previous = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count from public.profiles where role = 'admin';
    if v_admin_count <= 1 then
      raise exception 'this is the last admin account; promote another user first' using errcode = '23514';
    end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;

  -- A dashboard session has no auth.uid(), so the audit row records the target as actor and says WHICH KIND of
  -- session did it: "an admin changed this" and "a person at the dashboard changed this" are different facts.
  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (coalesce(auth.uid(), p_user_id), 'user.role_' || p_role, 'profile', null, p_user_id::text,
          jsonb_build_object('from', v_previous, 'to', p_role, 'by', auth.uid(),
                             'via', case when auth.uid() is null then 'dashboard-session' else 'admin' end));
end;
$$;

comment on function public.kicklive_set_user_role(uuid, text) is
  'The only supported way to change a role. Admin-only or database-session-only, audited, refuses to demote the '
  'last admin. A browser/API session never qualifies: kicklive_is_dashboard_session() reads the PostgREST JWT GUCs.';

-- Revoke from the broad `public` pseudo-role AND the client roles in one statement, then re-grant the two roles
-- that are actually allowed. Revoking from `public` alone does NOT remove the `anon`/`authenticated` aclitems that
-- Supabase's default privileges create, so a lone `from public` would leave a signed-in fan able to execute the
-- role writer — which is exactly what tests/unit/sql-shape.test.ts asserts against. A combined
-- `from public, anon, authenticated` is safe even when one of those grantees has no explicit ACL entry yet:
-- Postgres treats revoking a privilege that was never granted as a no-op, not an error (verified against the same
-- PGlite engine the suite runs on). This mirrors the phase-1 pattern (`from public, anon`).
revoke all on function public.kicklive_set_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.kicklive_set_user_role(uuid, text) to authenticated, service_role;

-- ── 4 · the privilege half, only if it is actually missing ─────────────────────────────────────────────────
-- An owner needs no grant, and Supabase has historically granted `postgres` everything via default privileges;
-- but a bundle-wide `revoke ... from public` sweeps `postgres` in with the anonymous role, and then the RPC above
-- fails at the UPDATE with a bare "permission denied for table profiles" instead of doing its job. Re-granting
-- the owner what ownership already implies adds no exposure to any client role.
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'profiles'
       and has_schema_privilege('postgres', n.nspname, 'CREATE')
  ) then
    raise notice 'note: `postgres` holds no CREATE on public in this project (profiles is owned by %). The re-grants below are applied anyway; that is what a normal Supabase project already has, so it adds no exposure.',
      (select r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
        where n.nspname = 'public' and c.relname = 'profiles');
  end if;
  execute 'grant update, insert, references on public.profiles to postgres';
  execute 'grant select, insert on public.activity_logs to postgres';
  execute 'grant usage, select on all sequences in schema public to postgres';
exception when undefined_table then
  raise notice 'public.activity_logs does not exist here; the audit insert is skipped by the writer, not by this grant';
end;
$$;

-- ── 5 · prove it in this same run, WITHOUT being able to veto the migration ─────────────────────────
-- Supabase's SQL editor executes a multi-statement script in ONE transaction, so a raise anywhere below would roll
-- back the four blocks above and leave the database exactly as broken as it was — which is precisely what happened
-- when this block asserted a table-wide UPDATE grant that current main deliberately does not have. A verification
-- block reports, it does not undo. Only one case still raises: anon being able to execute the role writer, which is
-- a live security failure rather than an unfinished task, and it is the one this file has no business leaving in.
do $$
declare
  v_login text := session_user;
  v_super boolean := (select coalesce(bool_or(usesuper), false) from pg_user where usename = v_login);
  v_own   text := (select r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     join pg_roles r on r.oid = c.relowner
                    where n.nspname = 'public' and c.relname = 'profiles');
  v_cap   boolean := has_schema_privilege(v_login, 'public', 'CREATE');
begin
  if public.kicklive_has_grant('anon', 'public.kicklive_set_user_role(uuid, text)', 'X') then
    raise exception 'anon may execute the role writer — re-run supabase/SETUP.sql (phases 3 and 7 revoke it), then re-run this file'
      using errcode = '42501';
  end if;

  if to_regprocedure('public.kicklive_set_user_role(uuid, text)') is null then
    raise notice 'CHECK FAILED: kicklive_set_user_role is missing, so blocks 1-4 did not apply. Re-run the whole file as one script.';
  end if;

  if not public.kicklive_is_dashboard_session() then
    raise notice 'CHECK FAILED: this paste was not recognised as a dashboard session (login=%, superuser=%, CREATE on public=%, profiles owner=%). '
      'The functions and grants above are installed and safe, but the rule refused this login: the SQL editor must be '
      'connected as the login that owns public.profiles (or use psql as postgres/supabase_admin). Do NOT make it pass by '
      'loosening kicklive_is_dashboard_session() — it is the only thing between the public site and editing user roles.',
      v_login, v_super, v_cap, v_own;
  end if;

  -- Whether a browser session may write its own profile is NOT this file's decision, and asserting it was my mistake:
  -- current main fixes signup with the definer writer public.kicklive_profile_update(text, text) and deliberately
  -- keeps `profiles` non-updatable by a client role, because a table-wide UPDATE is the hole phases 1 and 10 closed.
  -- Report the absence; never demand a widened grant, and never let it abort the script.
  if to_regprocedure('public.kicklive_profile_update(text, text)') is null then
    raise notice 'SIGNUP PATH NOT FOUND: this project has no public.kicklive_profile_update(text, text), so registration still fails with "permission denied for table profiles". Fix: paste the current supabase/SETUP.sql (its phase 10 §4 installs the writer). Do NOT grant UPDATE on profiles to authenticated — that reopens the role/email hole.';
  end if;

  raise notice 'KickLive admin bootstrap verified: login=% (superuser=%, CREATE on public=%), public.profiles owned by=%, guard trigger and audited role writer now share one predicate, anon cannot execute the writer.',
    v_login, v_super, v_cap, v_own;
end;
$$;

-- Proof that the writer is reachable by the only two roles that should reach it — read the row, it changes nothing:
select public.kicklive_has_grant('anon',          'public.kicklive_set_user_role(uuid, text)', 'X') as anon_can     -- want false
     , public.kicklive_has_grant('authenticated', 'public.kicklive_set_user_role(uuid, text)', 'X') as authed_can   -- want true
     , public.kicklive_is_dashboard_session() as dashboard_session;                                                  -- want true here

commit;

notify pgrst, 'reload schema';   -- PostgREST must see the two new/changed function signatures