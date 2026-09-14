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
-- anon first, and named: phase 1 §7 dropped the *policy* that let a browser read profiles, but a policy is not
-- a grant, and the table-wide SELECT that Supabase's default privileges handed `anon` was still in relacl — which
-- is exactly what this file's own verification caught when the bundle was executed against a real Postgres. The
-- public surface is profiles_public; the base table has no reason to be readable by an anonymous role at any layer.
revoke select on public.profiles from anon;
revoke select on public.profiles from public;
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

revoke all on function public.kicklive_profile_self() from public, anon;
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

revoke all on function public.kicklive_profile_contacts(uuid[], integer) from public, anon;
grant execute on function public.kicklive_profile_contacts(uuid[], integer) to authenticated, service_role;

comment on function public.kicklive_profile_contacts(uuid[], integer) is
  'Admin-only directory projection (id, username, email, role, created_at), limit clamped to 1..200, gated on is_admin() on the caller''s own token — the Phase 8 rule, not the Phase 7 mistake: a service-role call has no subject and would answer ADMIN_ONLY forever.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · the write path the narrowing took away (a self-service profile edit)
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 dropped the `profiles` write policies and phase 10 narrowed the column grants, so after this bundle a
-- browser session can no longer write its own row at all: `profiles` has no INSERT/UPDATE policy for
-- `authenticated`, and the table-wide UPDATE was revoked. That is the correct *privilege* answer, and it was
-- also an outage: `ProfilePage`'s save and `AuthContext.signUp`'s profile upsert both wrote the table directly,
-- so "username and phone cannot be edited by the person who owns them" became the state of the world. The
-- symptom people reported was a sign-up that succeeded and then said `permission denied for table profiles`
-- (HTTP 401 from PostgREST), because PostgREST reports an RLS refusal exactly that way.
--
-- So the write comes back, through a definer function — the shape every phase has used since: the client gets no
-- column privileges it did not have, only a narrow, validated, self-only verb. `role` and `email` are *not
-- parameters*, which is the property the tests assert; a caller cannot name a column this function does not
-- accept, and the only row it can touch is the one whose id is `auth.uid()`.
--
-- `on_conflict` semantics are folded in too, which is what makes sign-up work on a project where the trigger has
-- not run (a row may not exist yet), without handing the client an `insert` privilege on a table whose rows are
-- normally created by the trigger.

create or replace function public.kicklive_profile_update(
  p_username text default null,
  p_phone    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_name    text := nullif(btrim(coalesce(p_username, '')), '');
  -- A blank phone *clears* it, which a null cannot express on its own: `null` means "leave the stored value
  -- alone" in the DO UPDATE below. A `text` parameter cannot distinguish absent from empty from the caller's
  -- side, so the empty string is the documented "remove it" and is carried by its own flag. (A sentinel string
  -- stored in the column was tried and is wrong: an upsert writes its insert row verbatim even when the row
  -- already exists, so a sentinel would land in the phone column.)
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_clear   boolean := p_phone is not null and btrim(p_phone) = '';
  v_rows    int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED',
      'message', 'no auth.uid() — this call needs a signed-in user token, not the anon key.');
  end if;

  -- Same rules the sign-up trigger applies, so the two write paths cannot disagree about what a valid name is.
  if p_username is not null and v_name is null then
    return jsonb_build_object('ok', false, 'code', 'BAD_USERNAME', 'message', 'a username cannot be blank');
  end if;
  if length(v_name) > 32 then
    return jsonb_build_object('ok', false, 'code', 'BAD_USERNAME', 'message', 'a username is at most 32 characters');
  end if;
  if v_phone is not null and v_phone !~ '^[+0-9() .-]{6,24}$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_PHONE', 'message', 'a phone holds 6-24 characters of digits, spaces and +()-; save it blank to clear it');
  end if;

  -- `email` is NOT NULL on this table, so the *insert* half of the upsert must supply it — from `auth.users`,
  -- never from a parameter, which is what makes "a user cannot rewrite their own login" true at the schema level
  -- rather than in a handler. The update half deliberately leaves it alone.
  insert into public.profiles as p (id, email, username, phone)
  select v_uid, u.email, coalesce(v_name, 'fan-' || left(v_uid::text, 8)), v_phone
    from auth.users u where u.id = v_uid
  on conflict (id) do update
     -- `excluded.*` is the *insert* row, which is defaulted above for a not-supplied username; the update half
     -- must therefore read the parameters, not `excluded`, or a phone-only save would rename the account.
     set username   = coalesce(v_name, p.username),
         -- `v_clear`, not the value: an explicit clear has to be able to write a null, and the insert row of an
         -- upsert is applied verbatim, so `coalesce(excluded.phone, …)` alone can never blank a field.
         phone      = case when v_clear then null else coalesce(v_phone, p.phone) end,
         updated_at = now();
  get diagnostics v_rows = row_count;

  -- One row is the whole contract: the caller's own profile was written, or there is no auth.users row to build
  -- one from (an account deleted mid-session) and that must be said rather than reported as a save.
  if v_rows <> 1 then
    if not exists (select 1 from auth.users where id = v_uid) then
      raise exception 'kicklive_profile_update: the signed-in id % has no auth.users row, so no profile can be written' , v_uid using errcode = 'P0002';
    end if;
    raise exception 'kicklive_profile_update wrote % rows for the caller; expected 1' , v_rows using errcode = 'P0002';
  end if;

  begin
    -- Same shape as phase 1's role-change log: `entity_id` is an integer column and a profile id is a uuid, so
    -- the id goes in `entity_name` and nothing user-typed is copied into the audit row beyond that.
    insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
    values (v_uid, 'profile.updated', 'profile', null, v_uid::text,
            jsonb_build_object('username_changed', p_username is not null, 'phone_changed', p_phone is not null));
  exception when insufficient_privilege or undefined_table then
    -- A log this session cannot write must not eat the user's save. (The role is a definer, so this is only a
    -- belt-and-braces path; a hard failure of the insert itself is not swallowed.)
    null;
  end;

  return jsonb_build_object('ok', true, 'id', v_uid::text,
                            'username', (select username from public.profiles where id = v_uid),
                            'phone',    (select phone    from public.profiles where id = v_uid));
  -- (returned rather than raised: a validation refusal is a result the UI shows inline, not an exception the
  -- client has to unwrap out of a 400.)
end
$fn$;

comment on function public.kicklive_profile_update(text, text) is
  'Self-service profile edit: username and phone for auth.uid(), and nothing else. No role or email parameter '
  'by design; a row is created if the sign-up trigger has not run in this project. NULL means "leave alone", an '
  'empty/blank phone means "clear it".';

-- Revoke every client role by name, then grant the one that needs it: `from public` alone would leave the
-- Supabase default-privilege grants to anon/authenticated/service_role standing (the exact trap phase 1 fell into
-- for `profiles`), and a writer left granted to anon is not a control.
revoke all on function public.kicklive_profile_update(text, text) from public, anon, authenticated, service_role;
grant execute on function public.kicklive_profile_update(text, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · verification, at apply time

-- ─────────────────────────────────────────────────────────────────────────────

-- Every phase in this repository has been bitten by a privilege statement that parsed, applied and did
-- nothing — a grant loop whose `like` pattern missed a function, a policy renamed out of existence. So the
-- properties this file exists to establish are asserted here, in the catalog, before the migration is
-- considered installed.
do $verify$
declare
  n integer;
begin
  -- Every privilege check in this file reads the ACL for the reason recorded in the Phase 1 hardening
  -- migration (`public.kicklive_has_grant`): from a superuser session has_column_privilege() answers "true"
  -- for all of them, which turns this whole block into a pass on a database that was never hardened.
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'r', 'email') then
    raise exception 'phase 10 verify: profiles.email is still granted SELECT to authenticated — the narrowing did not land' using errcode = '42501';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'r', 'phone') then
    raise exception 'phase 10 verify: profiles.phone is still granted SELECT to authenticated' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('authenticated', 'public.profiles', 'r', 'username') then
    raise exception 'phase 10 verify: the narrowing also took profiles.username, which every public surface reads' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('service_role', 'public.profiles', 'r', 'email') then
    raise exception 'phase 10 verify: service_role lost email — the Worker''s admin client and Phase 5 addressing would break' using errcode = '42501';
  end if;
  if public.kicklive_has_grant('anon', 'public.profiles', 'r', 'username') then
    raise exception 'phase 10 verify: anon is granted SELECT on profiles directly; the public surface is profiles_public' using errcode = '42501';
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

  if public.kicklive_has_grant('anon', 'public.kicklive_profile_self()', 'X')
    or public.kicklive_has_grant('anon', 'public.kicklive_profile_contacts(uuid[], integer)', 'X') then
    raise exception 'phase 10 verify: a stranger may execute the contact functions' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('authenticated', 'public.kicklive_profile_self()', 'X') then
    raise exception 'phase 10 verify: the owner cannot read their own profile back' using errcode = '42501';
  end if;

  -- The write verb that replaces the table write the narrowing removed. Positive *and* negative: an assertion
  -- suite that only ever says "closed" cannot tell a control from an outage, and this function is the reason
  -- ProfilePage still works at all.
  if to_regprocedure('public.kicklive_profile_update(text, text)') is null then
    raise exception 'phase 10 verify: public.kicklive_profile_update(text, text) is missing, so a signed-in user has no way to save a profile' using errcode = '42501';
  end if;
  if public.kicklive_has_grant('anon', 'public.kicklive_profile_update(text, text)', 'X') then
    raise exception 'phase 10 verify: a stranger may execute the profile writer' using errcode = '42501';
  end if;
  if not public.kicklive_has_grant('authenticated', 'public.kicklive_profile_update(text, text)', 'X') then
    raise exception 'phase 10 verify: the owner cannot save their own profile' using errcode = '42501';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'kicklive_profile_update'
       and p.proargnames && array['p_role','p_email','role','email']
  ) then
    raise exception 'phase 10 verify: kicklive_profile_update accepts a parameter that names role or email — that is the escalation this function must not have' using errcode = '42501';
  end if;
end
$verify$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · rollback
-- ─────────────────────────────────────────────────────────────────────────────
-- Reversible by hand, and only by hand — this migration drops nothing, so a rollback is "give the columns
-- back", which is exactly the state Phase 1 shipped and the state this file exists to leave behind:
--
--   revoke execute on function public.kicklive_profile_update(text, text) from authenticated, service_role;
--   drop function if exists public.kicklive_profile_update(text, text);
--   revoke execute on function public.kicklive_profile_self() from authenticated, service_role;
--   revoke execute on function public.kicklive_profile_contacts(uuid[], integer) from authenticated, service_role;
--   drop function if exists public.kicklive_profile_self();
--   drop function if exists public.kicklive_profile_contacts(uuid[], integer);
--   grant select on public.profiles to authenticated;
--
-- The frontend changes that accompany this migration degrade rather than break if it is rolled back: an extra
-- RPC that returns rows the client could have read anyway.
