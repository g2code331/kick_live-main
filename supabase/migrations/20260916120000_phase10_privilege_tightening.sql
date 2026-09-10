-- =============================================================================
-- Phase 10 · privilege tightening — profile contact fields
-- =============================================================================
--
-- WHAT THIS FIXES, EXACTLY
--
-- Phase 1's audit (docs/SECURITY_AUDIT_PHASE1.md F-05) closed the *anonymous* half of a read policy:
-- `profiles: public read USING (true)` was replaced by `profiles: authenticated read USING (true)`, and the
-- public pages were moved to the `profiles_public` view. The authenticated half was knowingly left: a row
-- policy can only answer "which rows", so every signed-in account could still read *every other account's*
-- `email` and `phone` straight off PostgREST —
--
--   GET /rest/v1/profiles?select=email,phone          (any fan's JWT, 1500 rows, no consent)
--
-- Nothing in the app needed that. Six surfaces read those two columns and all six have a narrower shape that
-- is correct: own-profile reads (AuthContext, ProfilePage's email field), and admin desks that list users or
-- look up the manager who owns a team (UserManagement, AdminPortal, TeamDashboard, the access-request queue).
-- The Worker's own auth query read `email` too, and `/me` handed it back, for no consumer.
--
-- WHY COLUMN GRANTS AND NOT A POLICY
--
-- Postgres checks column privileges *before* RLS, per column, per role — which is the only mechanism in the
-- database that says "these two columns, not this row". `revoke select` plus `grant select (…)` therefore
-- narrows what `authenticated` may project at all, while the existing policy keeps its meaning for the columns
-- that remain. A fan's query above now answers 42501 instead of a list of addresses, and no UI can forget to
-- filter. `service_role` keeps full access, because the Worker's admin client, Phase 5's notification
-- addressing and Phase 7's referee-contact projection are the code that legitimately reads a contact — and
-- they run as themselves, not as the caller.
--
-- The two functions below are how the *legitimate* browser reads happen: a definer function can ask
-- `is_admin()` and `auth.uid()`, which is precisely the row-and-caller logic a column grant cannot express.
-- Same shape as every phase since 6: additive, `security definer`, pinned `search_path`, no client grant
-- beyond `authenticated`, and the decision made inside the function rather than in a handler.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · the narrowing
-- ─────────────────────────────────────────────────────────────────────────────

-- Order matters: revoke first so the column list is the whole grant, not an addition to an older one.
revoke select on public.profiles from authenticated;

grant select (id, username, role, avatar_url, team_id, created_at, updated_at)
  on public.profiles to authenticated;

comment on column public.profiles.email is
  'Contact field. Not projectable by `authenticated`: read your own through kicklive_profile_self(), and an admin list through kicklive_profile_contacts().';
comment on column public.profiles.phone is
  'Contact field. Readable by its owner only, through kicklive_profile_self().';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · own row, complete
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.kicklive_profile_self()
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- The caller's own row, including the two columns the client may no longer project. `auth.uid()` is the only
  -- selector: there is no id parameter, because a function that takes one is a function that gets asked for
  -- somebody else's phone number by a curious client with a valid token.
  select case
    when auth.uid() is null then jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED')
    else coalesce(
      to_jsonb(p) - 'id' || jsonb_build_object('ok', true, 'id', p.id::text),
      jsonb_build_object('ok', false, 'code', 'NOT_FOUND')
    )
  end
  from (select id, email, username, phone, role, avatar_url, team_id, created_at, updated_at
          from public.profiles
         where id = auth.uid()) p
$fn$;

revoke all on function public.kicklive_profile_self() from public;
grant execute on function public.kicklive_profile_self() to authenticated, service_role;

comment on function public.kicklive_profile_self() is
  'The caller''s own profile, contact fields included. RLS still applies (invoker-side row filters are irrelevant here: the selector is auth.uid()), and the function is stable, definer, and takes no argument.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · an admin list, bounded, auditable by shape
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.kicklive_profile_contacts(p_ids uuid[] default null, p_limit integer default 100)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_limit integer;
  v_rows jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- Clamped rather than trusted: this is the one door that returns addresses, so the same reasoning that
  -- clamps `kicklive_audit_list` applies here. A desk that needs more than 200 rows is a desk that needs a
  -- page, not a wider door.
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(
    jsonb_agg(row_to_json(x) order by x.created_at desc),
    '[]'::jsonb
  )
    into v_rows
    from (
      select p.id::text as id, p.username, p.email, p.role, p.created_at
        from public.profiles p
       where (p_ids is null or p.id = any (p_ids))
       order by p.created_at desc nulls last
       limit v_limit
    ) x;

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_rows), 'contacts', v_rows);
end
$fn$;

revoke all on function public.kicklive_profile_contacts(uuid[], integer) from public;
grant execute on function public.kicklive_profile_contacts(uuid[], integer) to authenticated, service_role;

comment on function public.kicklive_profile_contacts(uuid[], integer) is
  'Admin-only directory projection (id, username, email, role, created_at), limit clamped to 1..200, gated on is_admin() on the caller''s own token — the Phase 8 rule, not the Phase 7 mistake: a service-role call has no subject and would answer ADMIN_ONLY forever.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · verification, at apply time
-- ─────────────────────────────────────────────────────────────────────────────

-- Every phase in this repository has been bitten by a privilege statement that parsed, applied and did
-- nothing — a grant loop whose `like` pattern missed a function, a policy renamed out of existence. So the
-- properties this file exists to establish are asserted here, in the catalog, before the migration is
-- considered installed.
do $verify$
declare
  n integer;
begin
  if has_column_privilege('authenticated', 'public.profiles', 'email', 'select') then
    raise exception 'phase 10 verify: authenticated can still select profiles.email — the narrowing did not land' using errcode = '42501';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'phone', 'select') then
    raise exception 'phase 10 verify: authenticated can still select profiles.phone' using errcode = '42501';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'username', 'select') then
    raise exception 'phase 10 verify: the narrowing also took profiles.username, which every public surface reads' using errcode = '42501';
  end if;
  if not has_column_privilege('service_role', 'public.profiles', 'email', 'select') then
    raise exception 'phase 10 verify: service_role lost email — the Worker''s admin client and Phase 5 addressing would break' using errcode = '42501';
  end if;
  if has_column_privilege('anon', 'public.profiles', 'username', 'select') then
    raise exception 'phase 10 verify: anon can select from profiles directly; the public surface is profiles_public' using errcode = '42501';
  end if;

  -- The read policy must survive: column privileges narrow *what* may be projected, RLS narrows which rows,
  -- and dropping the policy on the way through would silently turn "admins read a directory" into "nobody
  -- reads anything" for the columns that remain.
  select count(1) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles: authenticated read';
  if n <> 1 then
    raise exception 'phase 10 verify: the profiles read policy is % rows, expected 1', n using errcode = '42501';
  end if;

  foreach n in array array[
    (select count(1) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'kicklive_profile_self'),
    (select count(1) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'kicklive_profile_contacts')
  ] loop
    if n <> 1 then
      raise exception 'phase 10 verify: a profile function is missing from the catalog' using errcode = '42501';
    end if;
  end loop;

  if has_function_privilege('anon', 'public.kicklive_profile_self()', 'execute')
    or has_function_privilege('anon', 'public.kicklive_profile_contacts(uuid[], integer)', 'execute') then
    raise exception 'phase 10 verify: a stranger may execute the contact functions' using errcode = '42501';
  end if;
  if not has_function_privilege('authenticated', 'public.kicklive_profile_self()', 'execute') then
    raise exception 'phase 10 verify: the owner cannot read their own profile back' using errcode = '42501';
  end if;
end
$verify$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · rollback
-- ─────────────────────────────────────────────────────────────────────────────
-- Reversible by hand, and only by hand — this migration drops nothing, so a rollback is "give the columns
-- back", which is exactly the state Phase 1 shipped and the state this file exists to leave behind:
--
--   revoke execute on function public.kicklive_profile_self() from authenticated, service_role;
--   revoke execute on function public.kicklive_profile_contacts(uuid[], integer) from authenticated, service_role;
--   drop function if exists public.kicklive_profile_self();
--   drop function if exists public.kicklive_profile_contacts(uuid[], integer);
--   grant select on public.profiles to authenticated;
--
-- The frontend changes that accompany this migration degrade rather than break if it is rolled back: an extra
-- RPC that returns rows the client could have read anyway.
