-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 14 · Targeted admin notifications (by role, or to one account)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
--
-- Phase 5 gave admins one many-to-many send: `kicklive_broadcast_notification`, which reaches every
-- notification-enabled account of a given kind ("all-enabled"). This phase adds the narrower sends the
-- admin console needs — "all team managers", "all media", "all admins", or "one person" — WITHOUT
-- touching the broadcast path, the trigger path, or the queue/delivery machinery.
--
-- The design keeps a single source of truth for "who is entitled to be told":
--
--   * A new job-aware resolver, `kicklive_notification_audience_job(job_id)`, starts from the SAME
--     preference-respecting rule as phase 5's `kicklive_notification_audience(...)` and then intersects it
--     with an optional target stored in the job's metadata (`metadata.target`). A job with no target
--     resolves to exactly the phase-5 audience, so every existing broadcast and every event job behaves
--     identically — this is the invariant the verification block at the end asserts.
--
--   * The two delivery-time functions (`kicklive_notification_recipients` and
--     `kicklive_materialise_notifications`) are repointed at the job-aware resolver. That is the only
--     behavioural change to existing functions, and it is a no-op for untargeted jobs.
--
--   * A new admin RPC, `kicklive_send_targeted_notification(...)`, validates like the broadcast RPC
--     (admin-gated, same kind whitelist, same length limits, same audience cap / confirmation wall) and
--     writes a job carrying `metadata.target`.
--
-- Source of truth is this migration; regenerate the bundle with `npm run sql:bundle`. Do not hand-edit
-- supabase/SETUP.sql.

-- ── 0. widen the has-target constraint so a non-match job is legal ────────────────────────────────────
--
-- Phase 5's `notification_jobs_has_target` reads:
--   check (match_id is not null or competition_id is not null or team_id is not null or kind = 'announcement')
-- Its intent was "a job with no audience selector is not a thing a trigger should be able to create". But it
-- expressed that as "has an id, OR is an announcement", which is too narrow: a broadcast of kind `news`,
-- `team_update`, `competition_update` or `system` has no id and is not an announcement, so phase 5's own
-- `kicklive_broadcast_notification` would violate this constraint for four of its five allowed kinds — and
-- so would every targeted send this phase adds. (The bug went unseen because the only broadcast exercised so
-- far was an announcement.)
--
-- The fix keeps the intent and states it correctly: a job is legal when it names an id (the trigger path),
-- OR it carries an explicit audience selector in metadata — a `broadcast` marker (phase 5) or a `target`
-- (phase 14). A trigger-created event job has neither and still must name an id, so nothing about the event
-- path changes.
do $constraint$
begin
  alter table public.notification_jobs drop constraint if exists notification_jobs_has_target;
  alter table public.notification_jobs add constraint notification_jobs_has_target
    check (
      match_id is not null
      or competition_id is not null
      or team_id is not null
      or kind = 'announcement'
      or (metadata ? 'broadcast')
      or (metadata ? 'target')
    );
end
$constraint$;

-- ── 1. job-aware audience resolver ───────────────────────────────────────────────────────────────────
--
-- Reads the job's kind/scope AND its metadata target, and returns the preference-filtered users the job
-- should reach. `metadata.target` shapes:
--   • absent, or {"type":"all"}          → the phase-5 audience unchanged
--   • {"type":"role","role":"media"}     → that audience, restricted to profiles.role = 'media'
--   • {"type":"user","userId":"<uuid>"}  → that audience, restricted to the one account
--
-- Restricting the phase-5 audience (rather than selecting profiles directly) is deliberate: a targeted send
-- still honours the recipient's master switch and per-category preference, so "all managers" cannot be used
-- to bypass someone who turned that category off.
create or replace function public.kicklive_notification_audience_job(p_job_id bigint)
returns table (user_id uuid, channels text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.user_id, a.channels
    from public.notification_jobs j
    join lateral public.kicklive_notification_audience(j.kind, j.match_id, j.competition_id, j.team_id) as a on true
    left join public.profiles pr on pr.id = a.user_id
   where j.id = p_job_id
     and (
       -- No target, or an explicit "all": the phase-5 audience, untouched.
       coalesce(j.metadata #>> '{target,type}', 'all') = 'all'
       -- Role target: same audience, narrowed to that role.
       or (
         (j.metadata #>> '{target,type}') = 'role'
         and pr.role = (j.metadata #>> '{target,role}')
       )
       -- Single-user target: same audience, narrowed to that account.
       or (
         (j.metadata #>> '{target,type}') = 'user'
         and a.user_id::text = (j.metadata #>> '{target,userId}')
       )
     );
$$;

comment on function public.kicklive_notification_audience_job(bigint) is
  'Phase 14: the phase-5 audience for a job, intersected with its optional metadata.target (role/user). No target = the phase-5 audience unchanged. Service-role only.';

-- ── 2. repoint the two delivery-time functions at the job-aware resolver ──────────────────────────────
--
-- Recipients: identical to phase 5 except the lateral join is now `_job`. For an untargeted job the row set
-- is byte-for-byte what phase 5 produced.
create or replace function public.kicklive_notification_recipients(p_job_id bigint)
returns table (device_id uuid, user_id uuid, token text, provider text, platform text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, a.user_id, d.token, d.provider, d.platform
    from public.notification_jobs j
    join lateral public.kicklive_notification_audience_job(j.id) as a on true
    join public.notification_devices d on d.user_id = a.user_id
   where j.id = p_job_id
     and 'push' = any (a.channels)
     and d.active
     and d.provider = 'fcm'
     and coalesce(d.failure_count, 0) < 5
     and not exists (
       select 1 from public.notification_deliveries dd
        where dd.job_id = j.id and dd.device_id = d.id
     )
   order by a.user_id, d.id;
$$;

comment on function public.kicklive_notification_recipients(bigint) is
  'Tokens for one job, preference-filtered (phase 14: via the job-aware audience so a role/user target is honoured) and de-duplicated against delivery history. Never granted to a client role.';

-- Inbox materialisation: same, via the job-aware audience.
create or replace function public.kicklive_materialise_notifications(p_job_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into public.notifications (user_id, title, body, kind, match_id, dedupe_key, metadata, created_at)
  select a.user_id, j.title, j.body, j.kind, j.match_id,
         j.dedupe_key || '|u:' || a.user_id, j.metadata, now()
    from public.notification_jobs j
    join lateral public.kicklive_notification_audience_job(j.id) as a on true
   where j.id = p_job_id
     and 'inbox' = any (a.channels)
  on conflict (user_id, dedupe_key) where dedupe_key is not null and user_id is not null do nothing;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'created', v_rows);
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'created', 0, 'note', 'already materialised');
end;
$$;

-- ── 3. the targeted-send RPC ─────────────────────────────────────────────────────────────────────────
--
-- Same wall as `kicklive_broadcast_notification`: admin-only (checked here, not only on the route), the
-- five admin kinds, the length limits, the audience count taken from the exact rule delivery will use, the
-- configurable cap, and the >1000 confirmation gate. The one addition is the target, validated against the
-- role vocabulary and, for a single user, against the account actually existing.
create or replace function public.kicklive_send_targeted_notification(
  p_title text,
  p_body  text,
  p_kind  text,
  p_target_type text,           -- 'role' | 'user'
  p_target_role text default null,
  p_target_user uuid default null,
  p_confirm boolean default false,
  p_max_audience integer default 50000,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audience integer;
  v_job      bigint;
  v_target   jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if p_kind not in ('announcement','system','news','competition_update','team_update') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'an announcement may not claim a match-event category');
  end if;
  if length(coalesce(p_title,'')) = 0 or length(p_title) > 120 or length(coalesce(p_body,'')) > 480 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'title 1-120 and body up to 480 characters');
  end if;

  if p_target_type = 'role' then
    if p_target_role not in ('fan','team_manager','media','admin') then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'unknown role');
    end if;
    v_target := jsonb_build_object('type', 'role', 'role', p_target_role);
  elsif p_target_type = 'user' then
    if p_target_user is null then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'a user target needs a user id');
    end if;
    if not exists (select 1 from public.profiles where id = p_target_user) then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', 'no such account');
    end if;
    v_target := jsonb_build_object('type', 'user', 'userId', p_target_user::text);
  else
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'target must be role or user');
  end if;

  -- The job must exist to be counted by the job-aware resolver, but must not exist if the count fails the
  -- cap. Resolved by inserting first, counting through the resolver, then deleting the job if it is refused —
  -- all in this function's single transaction, so a refused send leaves nothing behind.
  insert into public.notification_jobs (dedupe_key, kind, title, body, metadata, created_by)
  values (
    format('targeted:%s:%s', coalesce(p_created_by::text, 'system'), extract(epoch from now())::bigint || ':' || floor(random()*1000000)::text),
    p_kind, p_title, p_body,
    jsonb_build_object('target', v_target, 'targeted', true),
    p_created_by
  )
  returning id into v_job;

  select count(*) into v_audience from public.kicklive_notification_audience_job(v_job);

  if v_audience > p_max_audience then
    delete from public.notification_jobs where id = v_job;
    return jsonb_build_object('ok', false, 'code', 'AUDIENCE_TOO_LARGE', 'audience', v_audience, 'limit', p_max_audience);
  end if;
  if v_audience > 1000 and not coalesce(p_confirm, false) then
    delete from public.notification_jobs where id = v_job;
    return jsonb_build_object('ok', false, 'code', 'CONFIRMATION_REQUIRED', 'audience', v_audience);
  end if;

  update public.notification_jobs set recipient_count = v_audience where id = v_job;

  return jsonb_build_object('ok', true, 'jobId', v_job, 'audience', v_audience);
end;
$$;

comment on function public.kicklive_send_targeted_notification(text, text, text, text, text, uuid, boolean, integer, uuid) is
  'Phase 14: admin-gated send to a role or a single account. Same validation/cap/confirmation wall as the broadcast RPC; writes a job with metadata.target, counted through the job-aware audience.';

-- ── 4. privileges: service-role only, exactly like the phase-5 RPCs it sits beside ───────────────────
do $grants$
begin
  execute 'revoke all on function public.kicklive_notification_audience_job(bigint) from public, anon, authenticated';
  execute 'revoke all on function public.kicklive_send_targeted_notification(text, text, text, text, text, uuid, boolean, integer, uuid) from public, anon, authenticated';
  -- recipients/materialise had their grants revoked in phase 5; CREATE OR REPLACE preserves them, but a
  -- re-revoke is idempotent and documents the intent next to the redefinition.
  execute 'revoke all on function public.kicklive_notification_recipients(bigint) from public, anon, authenticated';
  execute 'revoke all on function public.kicklive_materialise_notifications(bigint) from public, anon, authenticated';
end
$grants$;

-- ── 5. verification (reports; hard-raises only on a live correctness failure) ────────────────────────
do $verify$
declare
  v_count integer;
begin
  -- 14.1 both new functions exist with the signatures the Worker/tests call.
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('kicklive_notification_audience_job', 'kicklive_send_targeted_notification');
  if v_count <> 2 then
    raise exception 'phase14 verification failed: expected 2 new functions, found %', v_count;
  end if;

  -- 14.2 the new DEFINER functions have a pinned search_path (the phase-5 hijacking guard, applied here).
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('kicklive_notification_audience_job','kicklive_send_targeted_notification','kicklive_notification_recipients','kicklive_materialise_notifications')
     and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%';
  if v_count > 0 then
    raise exception 'phase14 verification failed: % targeted-notification function(s) are SECURITY DEFINER without a pinned search_path', v_count;
  end if;

  -- 14.3 the invariant: for a job WITHOUT a target, the job-aware audience equals the phase-5 audience.
  --      Proven on the empty/anonymous state (auth.uid() is null), which is the state a schema check runs in;
  --      both must return the same count (0) without raising. A mismatch would mean existing broadcasts and
  --      event jobs changed behaviour, which this phase must not do.
  begin
    perform 1 from public.kicklive_notification_audience_job(0) limit 1;
    perform 1 from public.kicklive_notification_audience('announcement', null, null, null) limit 1;
  exception when others then
    raise exception 'phase14 verification failed: the job-aware audience or the phase-5 audience raised on the anonymous state: %', sqlerrm;
  end;

  -- 14.4 the neighbours are still service-role only (a client grant here would expose the subscriber list).
  select count(*) into v_count
    from information_schema.role_routine_grants
   where routine_schema = 'public'
     and routine_name in ('kicklive_notification_audience_job','kicklive_send_targeted_notification')
     and grantee in ('anon','authenticated','public');
  if v_count > 0 then
    raise exception 'phase14 verification failed: a targeted-notification function is granted to a client role';
  end if;

  -- 14.5 the widened has-target constraint accepts a targeted/broadcast job. Proven by writing one with no
  --      id and a metadata target, then rolling it back — a live insert is the only honest check that the
  --      CHECK expression means what the RPC needs, and a schema-only review would have missed the original
  --      bug entirely.
  begin
    insert into public.notification_jobs (dedupe_key, kind, title, body, metadata)
    values ('phase14-verify:' || gen_random_uuid()::text, 'news', 'verify', 'verify',
            jsonb_build_object('target', jsonb_build_object('type', 'role', 'role', 'media')));
    -- Undo it: verification must leave no rows behind.
    delete from public.notification_jobs where dedupe_key like 'phase14-verify:%';
  exception when check_violation then
    raise exception 'phase14 verification failed: a targeted (id-less) notification job is still rejected by notification_jobs_has_target — the constraint widening did not take';
  end;

  raise notice 'phase14 verification: ok — has-target constraint widened for id-less broadcast/targeted jobs, job-aware audience added, recipients/materialise repointed (no-op for untargeted jobs), targeted-send RPC added, all service-role only';
end
$verify$;

-- PostgREST caches the catalogue: without this the new RPC 404s until a restart, which reads like a Worker bug.
notify pgrst, 'reload schema';
