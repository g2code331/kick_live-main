-- ============================================================================
--  Kick Live — Phase 1 production hardening
--  File: supabase/migrations/20260909120000_phase1_security_hardening.sql
--  Applies to: the project described by KICKLIVE_FINAL_SCHEMA.sql (see supabase/README.md)
-- ============================================================================
--
-- WHAT THIS DOES
--   1. Closes the privilege-escalation hole: a signed-in user could set profiles.role to 'admin'.
--   2. Makes SECURITY DEFINER helpers search_path-safe and least-privilege.
--   3. Removes all anonymous DML surface (table + column level), and makes `media.views`
--      increment atomically in the database instead of a client read-modify-write.
--   4. Adds the controlled path for privileged access: `access_requests` + admin-only RPCs,
--      every decision audited into activity_logs.
--   5. Tightens the loosest authorisation checks (team self-registration, audit-log identity)
--      and adds the indexes the hot read paths need.
--
-- WHAT THIS DOES NOT DO
--   * No DROP TABLE / DROP COLUMN / DELETE anywhere. Nothing here destroys data.
--   * It does not rewrite the schema or create a second set of tables: this file is additive and
--     idempotent, and every statement is safe to re-run.
--   * It does not remove the app's direct Supabase writes (Phase 2 moves them behind Workers);
--     it makes them safe while they are still there.
--
-- HOW TO APPLY (choose one, then run the verification block at the bottom)
--   a) CLI, preferred:  supabase link --project-ref <ref>
--                       supabase db push                  # applies pending migrations in order
--   b) Dashboard:       SQL Editor → paste this file → Run. Do it during a quiet window: the
--                       policies below are swapped in a single transaction, so readers never see a
--                       table with no policy.
--   c) CI (Phase 2):    supabase db push --dry-run first, then a review-gated apply job.
--
-- ROLLBACK: the exact inverse is at the bottom, commented out.
-- ============================================================================

begin;

-- ============================================================================
-- 1 · HELPER FUNCTIONS — search_path pinning and least privilege
-- ============================================================================
-- Both helpers were SECURITY DEFINER without a SET clause. `SECURITY DEFINER` runs as the owner
-- (postgres), so whatever `profiles` resolves to depends on the caller's search_path: a role able to
-- create objects in a schema that appears earlier in the path could shadow the table and make
-- is_admin() return true for anyone. Pinning the path removes that class of bug outright.

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'True when the JWT subject holds the admin role. SECURITY DEFINER so RLS policies can read profiles without recursing.';

create or replace function public.is_admin_or_media()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'media')
  );
$$;

-- Helper functions do not need to be callable from SQL beyond policy evaluation; keep them tight.
revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public.is_admin_or_media() from public, anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated, service_role;
grant execute on function public.is_admin_or_media() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1b · A media-role user must be able to publish, but 'admin' must never be
--      obtainable by any client-side code path. Single source of truth.
-- ----------------------------------------------------------------------------
create or replace function public.is_media()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'media'
  );
$$;

create or replace function public.is_team_manager()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'team_manager'
  );
$$;

revoke all on function public.is_media() from public, anon, authenticated;
revoke all on function public.is_team_manager() from public, anon, authenticated;
grant execute on function public.is_media() to anon, authenticated, service_role;
grant execute on function public.is_team_manager() to anon, authenticated, service_role;

-- ============================================================================
-- 2 · SIGNUP: THE ROLE IS NEVER THE CLIENT'S TO CHOOSE
-- ============================================================================
-- The trigger was already correct (it hardcodes 'fan'), but it trusted
-- raw_user_meta_data->>'username' without limit and left the door open for any future
-- "convenience" code that starts copying metadata roles across. It now also sanitises the
-- username, and a defensive belt-and-braces `role` write is impossible by construction.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_username text;
begin
  v_username := nullif(
    btrim(coalesce(new.raw_user_meta_data ->> 'username', split_part(coalesce(new.email, ''), '@', 1))),
    ''
  );
  if v_username is null then
    v_username := 'fan-' || left(replace(new.id::text, '-', ''), 8);
  end if;
  -- Length and character bounds are enforced here as well as in the UI: a username is displayed
  -- next to other people's content, so it must not be able to carry markup or control bytes.
  v_username := left(regexp_replace(v_username, '[^A-Za-z0-9 ._''-]', '', 'g'), 32);

  insert into public.profiles (id, email, username, role)
  values (new.id, new.email, coalesce(nullif(v_username, ''), 'fan'), 'fan')
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2b · GUARD TRIGGER: the hard rule that makes the policy hole unexploitable
-- ----------------------------------------------------------------------------
-- `profiles` still needs a self-update policy (people edit their own username/phone), so the policy
-- cannot also be the thing that protects `role`. This trigger is what protects it:
--   * INSERT  — a non-admin's requested role is ignored and rewritten to 'fan'.
--   * UPDATE  — a non-admin changing their own role (or their email, which belongs to Auth) is
--               rejected with 42501, so the UI can show *why* instead of silently losing the write.
-- Admins pass through; the app nevertheless routes all role changes through
-- kicklive_set_user_role() below, which adds the audit row and the last-admin guard.

create or replace function public.kicklive_guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean;
  v_superuser boolean;
begin
  -- A dashboard/psql session run as a superuser is the trusted path (bootstrapping, incident
  -- response, `supabase db push`). PostgREST can never reach this branch: it connects as
  -- `authenticator` and only *switches* to anon/authenticated with SET ROLE, which changes
  -- current_user but leaves session_user alone — so session_user is exactly the discriminator.
  select coalesce(bool_or(u.usesuper), false) into v_superuser
    from pg_user u where u.usename = session_user;
  if v_superuser then
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

drop trigger if exists kicklive_guard_profile_privileges on public.profiles;
create trigger kicklive_guard_profile_privileges
  before insert or update on public.profiles
  for each row execute function public.kicklive_guard_profile_privileges();

-- Column-level revoke: even if someone later re-creates a permissive policy, the role/email columns
-- are simply not updatable by client roles. Grants are checked before policies, so this wins.
-- `from public` is not a courtesy here: with the default privileges Supabase creates the client roles hold their own
-- ACL entries, and a revoke that names only PUBLIC leaves those entries exactly where they were.
revoke update (role)  on public.profiles from authenticated;
revoke update (role)  on public.profiles from anon;
revoke update (email) on public.profiles from authenticated;
revoke update (email) on public.profiles from anon;
revoke update (role), update (email) on public.profiles from public;

-- ============================================================================
-- 2a · HOW A GRANT IS CHECKED IN THIS REPOSITORY (used by every verify block that
--      follows, in this file and in the later phases)
-- ============================================================================
-- `has_table_privilege()` / `has_column_privilege()` / `has_function_privilege()` are not usable inside a
-- migration that a human runs from the Supabase SQL editor. Those functions answer "may this role do this,
-- after every shortcut is applied", and two of those shortcuts are always on here: a superuser may do
-- everything, and the owner of a table may do anything on it. Supabase hands the SQL editor one of
-- those identities. So every NEGATIVE assertion built on them fires on a correctly hardened database — the
-- `hardening failed: authenticated can still update profiles.role directly` paste was a `revoke update
-- (role)` that had landed perfectly, reported as a failure — and every POSITIVE one passes without checking
-- anything. An assertion that cannot fail is worse than no assertion: it is the reason the privilege work in
-- three phases of this repository was never actually proven.
--
-- The catalog does not care what role the editor runs as. `pg_class.relacl` records what was granted on a
-- table, `pg_proc.proacl` what was granted on a function, `pg_attribute.attacl` what was granted on one column,
-- which is exactly the property these verify blocks claim. A NULL ACL means "owner only, no explicit grants to
-- anyone", answered false for every non-owner: the same answer a real non-superuser client would get.
--
-- Column grants are the part that cannot be guessed, and the reason this helper has now been wrong twice. They
-- are NOT entries inside `relacl` marked with a column number: a per-column `grant update (role) on profiles`
-- lives in `pg_attribute.attacl` for that column, and a table-wide grant covers every column of it. So a
-- column check consults both, in that order. `aclexplode()` yields exactly four columns — grantor, grantee,
-- privilege_type, is_grantable — and nothing that names a fifth is a valid reading of an ACL. This repository
-- has no Postgres between writing this SQL and applying it in a dashboard, so that sentence is the only layer
-- that can catch an invented column name, and tests/unit/sql-shape.test.ts enforces it.
--
-- Deliberately granted to PUBLIC: this is a catalog reader with no data in it, and it has to be callable
-- from the least privileged session that exists. A verifier nobody may execute is a verifier that silently
-- reports nothing — which is the bug this section replaces.

create or replace function public.kicklive_has_grant(
  p_role text, p_object text, p_privilege text, p_column text default null
)
returns boolean
language plpgsql stable
set search_path = pg_catalog
as $hg$
declare
  v_rel     oid;
  v_pro     oid;
  v_rel_acl aclitem[];
  v_col_acl aclitem[];
begin
  v_rel := to_regclass(p_object);
  if v_rel is null then
    -- Not a relation this session can see, so it is a function signature: `public.f(integer)`. The same
    -- shape `has_function_privilege()` took, which is what lets a call site be converted by renaming the
    -- function and nothing else — a mechanical diff is an auditable diff.
    v_pro := to_regprocedure(p_object);
    if v_pro is null then
      -- Loud on purpose. Both lookups answering NULL means the name is wrong, and a helper that returned
      -- false here would make every negative assertion about that object pass for free — the exact failure
      -- mode this whole section replaced. A verifier must be unable to certify a typo.
      raise exception 'kicklive_has_grant: % matches neither a relation nor a function identity', p_object
        using errcode = '42704';
    end if;
    return exists (
      select 1
        from pg_proc p
        join pg_roles r on r.rolname = p_role
        join aclexplode(p.proacl) g on g.privilege_type = p_privilege
       where p.oid = v_pro
         and (g.grantee = r.oid or g.grantee = 0)   -- 0 is PUBLIC, which every role inherits
    );
  end if;

  select c.relacl into v_rel_acl from pg_class c where c.oid = v_rel;

  if p_column is null then
    if v_rel_acl is null then
      return false;                  -- owner-only: nothing is granted to anybody explicitly
    end if;
    return exists (
      select 1
        from pg_roles r
        join aclexplode(v_rel_acl) g on g.privilege_type = p_privilege
       where r.rolname = p_role
         and (g.grantee = r.oid or g.grantee = 0)
    );
  end if;

  -- A table-wide grant covers every column, so it is asked first; a column-specific grant is the only thing
  -- that can override it in the other direction, and it is read from that column's attacl.
  if v_rel_acl is not null and exists (
    select 1
      from pg_roles r
      join aclexplode(v_rel_acl) g on g.privilege_type = p_privilege
     where r.rolname = p_role
       and (g.grantee = r.oid or g.grantee = 0)
  ) then
    return true;
  end if;

  select a.attacl into v_col_acl
    from pg_attribute a
   where a.attrelid = v_rel and a.attname = p_column and not a.attisdropped;
  if not found then
    return false;                    -- not a column of this relation: no grant on it can exist
  end if;
  if v_col_acl is null then
    return false;
  end if;
  return exists (
    select 1
      from pg_roles r
      join aclexplode(v_col_acl) g on g.privilege_type = p_privilege
     where r.rolname = p_role
       and (g.grantee = r.oid or g.grantee = 0)
  );
end;
$hg$;

grant execute on function public.kicklive_has_grant(text, text, text, text) to public;

comment on function public.kicklive_has_grant(text, text, text, text) is
  'Is there a real GRANT of this privilege to this role, ignoring the superuser and owner shortcuts? The only '
  'privilege question a migration can answer correctly from the SQL editor. p_object is a table/view '
  '(''public.profiles'') or a function identity signature (''public.f(integer)''), told apart by to_regclass; '
  'p_privilege is an ACL letter (table/view r a w d D x t, sequence r w U, function X); p_column narrows a '
  'table check to one column and reads pg_attribute.attacl as well as relacl.';

-- ============================================================================
-- 3 · ANONYMOUS READS AND WRITES
-- ============================================================================
-- Supabase's defaults grant anon SELECT *and DML* on everything in `public`, leaving RLS as the only
-- barrier. Reads stay public (this is a public sports site), but a browser session that is not signed
-- in has no business writing anywhere, so DML is taken away at the privilege level too.

revoke insert, update, delete on all tables in schema public from anon;
alter default privileges in schema public
  revoke insert, update, delete on tables from anon;

-- profiles held `USING (true)` for SELECT, which handed every account's email and phone number to
-- any anonymous caller with the anon key. Anonymous consumers (news, fixtures, standings) never read
-- profiles; the two places that did are admin surfaces, which are authenticated.
drop policy if exists "profiles: public read" on public.profiles;
drop policy if exists "Public read profiles" on public.profiles;

drop policy if exists "profiles: authenticated read" on public.profiles;
create policy "profiles: authenticated read"
  on public.profiles for select to authenticated
  using (true);

-- When Phase 2 splits the public identity surface out, read through this instead of the base table:
-- username and avatar only, no email, no phone, and it works for anon.
create or replace view public.profiles_public as
  select p.id, p.username, p.avatar_url, p.created_at
  from public.profiles p;

comment on view public.profiles_public is
  'Non-sensitive identity projection for public pages. Never select email or phone here.';

grant select on public.profiles_public to anon, authenticated;
revoke all on public.profiles_public from public;

-- activity_logs is the audit trail. `WITH CHECK (true)` let any signed-in user write a log entry
-- attributed to somebody else, which destroys its evidentiary value.
drop policy if exists "activity_logs: auth insert" on public.activity_logs;
create policy "activity_logs: auth insert"
  on public.activity_logs for insert to authenticated
  with check (user_id = auth.uid());

-- Team self-registration is intended, but `WITH CHECK (true)` let any signed-in user insert a team
-- row with an arbitrary owner_id (impersonation) or flip status straight to 'active' (skipping
-- approval). A pending team must belong to whoever registered it.
drop policy if exists "teams: managers create" on public.teams;
create policy "teams: managers create"
  on public.teams for insert to authenticated
  with check (owner_id = auth.uid() and status = 'pending');

-- ============================================================================
-- 4 · EVERY WRITE POLICY NOW NAMES ITS ROLES AND CHECKS NEW ROWS
-- ============================================================================
-- Two fixes at once: `to authenticated` (otherwise a policy also applies to anon), and an explicit
-- `with check` (PostgREST/Postgres reuse USING for WITH CHECK when it is omitted — correct today,
-- but it silently changes meaning if someone later edits the USING half). Statements are wrapped in
-- DO blocks so a policy that does not exist yet is skipped rather than failing the transaction.

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('seasons',        'seasons: admin all'),
      ('competitions',   'competitions: admin all'),
      ('matches',        'matches: admin all'),
      ('match_events',   'match_events: admin all'),
      ('match_commentary','match_commentary: admin all'),
      ('match_statistics','match_statistics: admin all'),
      ('standings',      'standings: admin all'),
      ('team_staff',     'team_staff: admin all'),
      ('notifications',  'notifications: admin all'),
      ('profiles',       'profiles: admin all'),
      ('teams',          'teams: admin all'),
      ('players',        'players: admin all'),
      ('team_news',      'team_news: admin all'),
      ('activity_logs',  'activity_logs: admin all')
    ) as t(tbl, pol)
  loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.tbl and policyname = r.pol) then
      execute format('drop policy %I on public.%I', r.pol, r.tbl);
    end if;
    execute format('create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', r.pol, r.tbl);
  end loop;
end;
$$;

-- The audit trail stays read-only for admins through RLS (writes are self-attributed, above), so it
-- is not part of the FOR ALL sweep.
drop policy if exists "activity_logs: admin read" on public.activity_logs;
create policy "activity_logs: admin read"
  on public.activity_logs for select to authenticated
  using (public.is_admin());

-- media stays admin-or-media (MediaPublisher never sets author_id today, so a per-author rule would
-- lock people out of their existing drafts — that split is scheduled for Phase 2, see the doc).
drop policy if exists "media: admin and media all" on public.media;
create policy "media: admin and media all"
  on public.media for all to authenticated
  using (public.is_admin_or_media())
  with check (public.is_admin_or_media());

-- Public reads, restated so each one is explicit about being a read for everyone.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('teams',          'teams: public read'),
      ('players',        'players: public read'),
      ('seasons',        'seasons: public read'),
      ('competitions',   'competitions: public read'),
      ('matches',        'matches: public read'),
      ('match_events',   'match_events: public read'),
      ('match_commentary','match_commentary: public read'),
      ('match_statistics','match_statistics: public read'),
      ('team_news',      'team_news: public read'),
      ('standings',      'standings: public read'),
      ('team_staff',     'team_staff: public read'),
      ('notifications',  'notifications: public read')
    ) as t(tbl, pol)
  loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.tbl and policyname = r.pol) then
      execute format('drop policy %I on public.%I', r.pol, r.tbl);
    end if;
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', r.pol, r.tbl);
  end loop;
end;
$$;

-- media reads: published for everyone, drafts only for the roles that manage them.
drop policy if exists "media: public read" on public.media;
create policy "media: public read"
  on public.media for select to anon, authenticated
  using (published = true or public.is_admin_or_media());

-- ============================================================================
-- 5 · media.views — the one remaining anonymous write, made atomic
-- ============================================================================
-- NewsPage used to read the row and write `views + 1` back from the browser: concurrent readers lost
-- counts, and the same code path let a signed-in media user set an arbitrary value. The function
-- below is the only way to touch the column, it increments by one on a single row, and it can be
-- rate-limited in one place later (Workers + KV, Phase 2).

create or replace function public.kicklive_record_media_view(p_media_id integer)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  update public.media
     set views = coalesce(views, 0) + 1
   where id = p_media_id
     and published = true;
$$;

comment on function public.kicklive_record_media_view(integer) is
  'Atomic +1 on media.views for a published article. The only anonymous write in the product.';

revoke all on function public.kicklive_record_media_view(integer) from public, authenticated;
grant execute on function public.kicklive_record_media_view(integer) to anon, authenticated;

-- Nobody updates a counter by hand any more.
revoke update on public.media from anon;

-- ============================================================================
-- 6 · ACCESS REQUESTS — the only sanctioned route to a privileged role
-- ============================================================================
-- Replaces the client-side "role password" map in src/pages/auth/SignupPage.tsx (which shipped the
-- passwords inside the bundle). A signed-up fan asks; an admin decides; both sides of that decision
-- are auditable rows, and no client-side code can grant anything.

create table if not exists public.access_requests (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null
                  constraint access_requests_user_id_fkey
                  references public.profiles(id) on delete cascade,
  requested_role  text        not null
                  constraint access_requests_role_allowed
                  check (requested_role in ('team_manager', 'media')),
  reason          text        not null
                  constraint access_requests_reason_length
                  check (char_length(reason) between 10 and 1000),
  status          text        not null default 'pending'
                  constraint access_requests_status_allowed
                  check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by      uuid        constraint access_requests_decided_by_fkey
                              references public.profiles(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text        constraint access_requests_note_length
                              check (decision_note is null or char_length(decision_note) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.access_requests is
  'Applications for team_manager/media access. Granting a role only happens inside kicklive_decide_access_request().';

-- One open request per person: otherwise a queue-jumper can spam approvals.
create unique index if not exists access_requests_one_open_per_user
  on public.access_requests (user_id)
  where status = 'pending';

create index if not exists access_requests_pending_created
  on public.access_requests (created_at desc)
  where status = 'pending';

alter table public.access_requests enable row level security;
-- Deliberately NOT `force row level security`: FORCE also applies to the table owner, and the
-- RPCs below run as the owner (postgres) by design — they would be blocked by their own table.

-- An applicant can see their own requests. Writes go through the RPCs below only, so there is
-- deliberately no INSERT / UPDATE policy: RLS with force + no write policy = no client-side writes.
drop policy if exists "access_requests: own read" on public.access_requests;
create policy "access_requests: own read"
  on public.access_requests for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "access_requests: admin read" on public.access_requests;
create policy "access_requests: admin read"
  on public.access_requests for select to authenticated
  using (public.is_admin());

grant select on public.access_requests to authenticated;
revoke all on public.access_requests from anon;
revoke all on public.access_requests from public;
-- Supabase's default privileges hand authenticated INSERT/UPDATE/DELETE on every new table. RLS
-- already denies them (there is no write policy), and the grant is removed so the denial does not
-- depend on remembering to keep it that way.
revoke insert, update, delete, truncate, references, trigger on public.access_requests from authenticated;

-- ----------------------------------------------------------------------------
-- 6a · ask for access
-- ----------------------------------------------------------------------------
create or replace function public.kicklive_request_access(p_role text, p_reason text)
returns public.access_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.access_requests;
begin
  if auth.uid() is null then
    raise exception 'sign in before requesting access' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('team_manager', 'media') then
    raise exception 'only team_manager and media can be requested' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'explain the request in at least 10 characters' using errcode = '22023';
  end if;
  if char_length(p_reason) > 1000 then
    raise exception 'keep the request under 1000 characters' using errcode = '22023';
  end if;

  -- Already holding it? Nothing to request.
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = p_role) then
    raise exception 'this account already has the % role', p_role using errcode = '23505';
  end if;

  insert into public.access_requests (user_id, requested_role, reason)
  values (auth.uid(), p_role, btrim(p_reason))
  on conflict (user_id) where status = 'pending' do update
     set requested_role = excluded.requested_role,
         reason         = excluded.reason,
         updated_at     = now()
    returning * into v_request;

  insert into public.activity_logs (user_id, action, entity_type, entity_name, details)
  values (auth.uid(), 'access_request.submitted', 'access_request', v_request.id::text,
          jsonb_build_object('requested_role', p_role));

  return v_request;
end;
$$;

comment on function public.kicklive_request_access(text, text) is
  'Queue (or replace) the caller''s single pending access request. Never grants anything itself.';

-- ----------------------------------------------------------------------------
-- 6b · decide it — the only path that grants a privileged role to a non-admin
-- ----------------------------------------------------------------------------
create or replace function public.kicklive_decide_access_request(
  p_request_id uuid,
  p_decision   text,
  p_note       text default null
)
returns public.access_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.access_requests;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'only an admin can decide access requests' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;

  select * into v_request
    from public.access_requests
   where id = p_request_id
     for update;
  if v_request is null then
    raise exception 'access request % not found', p_request_id using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'this request was already %', v_request.status using errcode = '23514';
  end if;

  if p_decision = 'approved' then
    update public.profiles
       set role = v_request.requested_role, updated_at = now()
     where id = v_request.user_id;
  end if;

  update public.access_requests
     set status = p_decision,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = p_request_id
  returning * into v_request;

  insert into public.activity_logs (user_id, action, entity_type, entity_name, details)
  values (auth.uid(), 'access_request.' || p_decision, 'access_request', v_request.id::text,
          jsonb_build_object('target_user', v_request.user_id, 'role', v_request.requested_role));

  return v_request;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6c · withdraw own request
-- ----------------------------------------------------------------------------
create or replace function public.kicklive_cancel_access_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.access_requests
     set status = 'cancelled', updated_at = now()
   where id = p_request_id
     and user_id = auth.uid()
     and status = 'pending';
end;
$$;

-- ----------------------------------------------------------------------------
-- 6d · admin-only, audited, last-admin-safe role changes
-- ----------------------------------------------------------------------------
create or replace function public.kicklive_set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous text;
  v_admin_count int;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'permission denied (not an admin)' using errcode = '42501';
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

  -- An instance without an admin cannot grant another one: self-lockout is unrecoverable without
  -- dashboard access, so refuse it at the database rather than trusting the UI to warn.
  if v_previous = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count from public.profiles where role = 'admin';
    if v_admin_count <= 1 then
      raise exception 'this is the last admin account; promote another user first' using errcode = '23514';
    end if;
  end if;

  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;

  insert into public.activity_logs (user_id, action, entity_type, entity_id, entity_name, details)
  values (auth.uid(), 'user.role_' || p_role, 'profile', null, p_user_id::text,
          jsonb_build_object('from', v_previous, 'to', p_role, 'by', auth.uid()));
end;
$$;

comment on function public.kicklive_set_user_role(uuid, text) is
  'The only supported way to change a role. Admin-only, audited, refuses to demote the last admin.';

revoke all on function public.kicklive_request_access(text, text) from public, anon;
revoke all on function public.kicklive_decide_access_request(uuid, text, text) from public, anon;
revoke all on function public.kicklive_cancel_access_request(uuid) from public, anon;
revoke all on function public.kicklive_set_user_role(uuid, text) from public, anon;
grant execute on function public.kicklive_request_access(text, text) to authenticated;
grant execute on function public.kicklive_decide_access_request(uuid, text, text) to authenticated;
grant execute on function public.kicklive_cancel_access_request(uuid) to authenticated;
grant execute on function public.kicklive_set_user_role(uuid, text) to authenticated;

-- ============================================================================
-- 7 · HOT-PATH INDEXES
-- ============================================================================
-- Every screen polls these three shapes; without these the polls do sequential scans per request.
create index if not exists idx_matches_status_start
  on public.matches (status, start_time desc);
create index if not exists idx_match_events_match_minute
  on public.match_events (match_id, minute desc, id desc);
create index if not exists idx_match_commentary_match_created
  on public.match_commentary (match_id, created_at desc);
create index if not exists idx_players_team
  on public.players (team_id);
create index if not exists idx_teams_owner_status
  on public.teams (owner_id, status);
create index if not exists idx_media_published_featured
  on public.media (published, featured desc, created_at desc);
create index if not exists idx_activity_logs_created
  on public.activity_logs (created_at desc);
create index if not exists idx_profiles_role
  on public.profiles (role);

-- ============================================================================
-- 8 · SELF-CHECK — fail the transaction loudly rather than half-applying
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'profiles' and t.tgname = 'kicklive_guard_profile_privileges'
       and not t.tgisinternal
  ) then
    raise exception 'hardening failed: the profiles privilege guard trigger is missing';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'
       and policyname = 'profiles: public read'
  ) then
    raise exception 'hardening failed: anonymous read of profiles is still enabled';
  end if;

  -- Who is running this, recorded rather than assumed: the answer decides whether `has_*_privilege()` could
  -- have told the truth at all, and it is the first line to read when a privilege assertion is argued about.
  if exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
    raise notice 'phase 1 verify: applying as the superuser %; privilege checks here read relacl/proacl, not has_*_privilege()', current_user;
  end if;

  if public.kicklive_has_grant('authenticated', 'public.profiles', 'w', 'role') then
    raise exception 'hardening failed: profiles.role is still granted UPDATE to authenticated — revoke did not land';
  end if;
  if public.kicklive_has_grant('anon', 'public.profiles', 'w', 'role') then
    raise exception 'hardening failed: profiles.role is still granted UPDATE to anon';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.profiles', 'w', 'email') then
    raise exception 'hardening failed: profiles.email is still granted UPDATE to authenticated';
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY — run these after applying, all from an anonymous SQL session
-- ============================================================================
-- Expected: one row per policy, all writes to non-public tables return 42501 for anon.
--
-- select tablename, policyname, cmd, roles, qual, with_check
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
--
-- select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
--
-- select pg_get_functiondef('public.is_admin()'::regprocedure);   -- must show SET search_path
--
-- select count(*) from public.access_requests;                     -- 0 rows, table exists
--
-- The escalation probe (run as a signed-in fan token, e.g. via the REST inspector):
--   PATCH /rest/v1/profiles?id=eq.<own-uuid> {"role":"admin"}
--   → expect HTTP 401/403 with "role changes are not permitted on public.profiles"
-- Pre-migration this returned 204 No Content, which is the whole point of this file.
--
-- ============================================================================
-- ROLLBACK (deliberately commented out; nothing here deletes data)
-- ============================================================================
-- begin;
-- drop trigger if exists kicklive_guard_profile_privileges on public.profiles;
-- drop policy if exists "profiles: authenticated read" on public.profiles;
-- create policy "profiles: public read" on public.profiles for select using (true);
-- grant update (role, email) on public.profiles to authenticated;
-- drop function if exists public.kicklive_set_user_role(uuid, text);
-- drop function if exists public.kicklive_decide_access_request(uuid, text, text);
-- drop function if exists public.kicklive_request_access(text, text);
-- drop function if exists public.kicklive_cancel_access_request(uuid);
-- drop function if exists public.kicklive_record_media_view(integer);
-- drop table if exists public.access_requests;   -- only if you accept losing pending requests
-- drop view  if exists public.profiles_public;
-- commit;
--
-- The revoked anon DML and the retargeted admin/media policies are *not* rolled back above, because
-- restoring them is what we are trying to avoid. If you must, restore them from
-- KICKLIVE_FINAL_SCHEMA.sql section 7, and treat that as an incident, not a rollback.
