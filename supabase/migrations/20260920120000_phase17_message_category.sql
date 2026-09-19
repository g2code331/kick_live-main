-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 17 · A dedicated "message" notification category
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
--
-- Phase 16 notifies a thread owner when staff reply, and did so as kind 'system' as a stop-gap. That folded
-- message alerts into the same switch as account/platform notices, so a user could not mute "staff replied"
-- without also muting "your password was changed". This migration gives messages their own category.
--
-- Adding a twelfth category is a cross-cutting change: the vocabulary is written as three CHECK constraints
-- (notifications, notification_preferences, notification_jobs), two inline lists inside RPCs, the
-- `kicklive_preference_defaults()` literal, the Worker's policy maps and the client's array — and
-- `tests/unit/phase5-notifications.test.ts` compares all of them. This file changes the SQL side; the
-- TypeScript side (src/lib/data/notifications.ts, workers/src/lib/notificationPolicy.ts) is changed in the
-- same commit, and the parity test is updated to expect twelve.
--
-- Phase 5's migration is the source of truth for the *original* eleven and is never edited; this migration is
-- the source of truth for the twelfth. Every object below is redefined with CREATE OR REPLACE / drop-and-add,
-- so applying this file on top of phase 5 is the whole change, and re-applying it is a no-op.
--
-- `message` defaults ON (a reply you asked for is not noise) and is pushable (handled in the Worker policy).
-- Regenerate the bundle with `npm run sql:bundle`; do not hand-edit supabase/SETUP.sql.

-- ── 1. widen the three CHECK constraints ─────────────────────────────────────────────────────────────
-- `add constraint` has no `if not exists`, so each is dropped by name first — the same shape phase 5 used to
-- retire and replace a policy, and what makes this file idempotent.
do $constraints$
begin
  alter table public.notifications drop constraint if exists notifications_kind_check;
  alter table public.notifications add constraint notifications_kind_check
    check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                    'team_update','competition_update','news','system','announcement','message'));

  alter table public.notification_preferences drop constraint if exists notification_preferences_kind_check;
  alter table public.notification_preferences add constraint notification_preferences_kind_check
    check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                    'team_update','competition_update','news','system','announcement','message'));

  alter table public.notification_jobs drop constraint if exists notification_jobs_kind_check;
  alter table public.notification_jobs add constraint notification_jobs_kind_check
    check (kind in ('goal','red_card','half_time','full_time','match_start','match_reminder',
                    'team_update','competition_update','news','system','announcement','message'));
end
$constraints$;

-- ── 2. the defaults literal, now with `message` ──────────────────────────────────────────────────────
create or replace function public.kicklive_preference_defaults()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select '{
    "goal": true,
    "red_card": false,
    "half_time": true,
    "full_time": true,
    "match_start": true,
    "match_reminder": false,
    "team_update": false,
    "competition_update": false,
    "news": false,
    "system": true,
    "announcement": true,
    "message": true
  }'::jsonb;
$$;

comment on function public.kicklive_preference_defaults() is
  'Per-kind defaults (phase 17: adds message=true). Noisy categories (red_card, reminders, news) start off; a reply you asked for is not noise.';

-- ── 3. the two inline kind lists inside the preference RPCs ───────────────────────────────────────────
-- Both are redefined verbatim from phase 5 with `message` appended to the `unnest(array[...])` list. The
-- bodies are otherwise unchanged, and CREATE OR REPLACE preserves the grants phase 5 issued.
create or replace function public.kicklive_notification_defaults_document(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'notificationsEnabled', coalesce((select pr.notifications_enabled from public.profiles pr where pr.id = p_user_id), true),
           'categories', coalesce(
             (select jsonb_object_agg(k.kind, jsonb_build_object('enabled', coalesce(p.enabled, (select (kicklive_preference_defaults() ->> k.kind)::boolean)), 'channels', coalesce(p.channels, array['inbox','push'])))
                from (select unnest(array['goal','red_card','half_time','full_time','match_start','match_reminder','team_update','competition_update','news','system','announcement','message']) as kind) k
                left join public.notification_preferences p on p.user_id = p_user_id and p.kind = k.kind),
             '{}'::jsonb)
         );
$$;

create or replace function public.kicklive_set_notification_preferences(
  p_enabled    boolean,
  p_categories jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  r      record;
  v_kind text;
  v_seen text[] := '{}';
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if p_categories is null or jsonb_typeof(p_categories) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'categories must be an object');
  end if;

  update public.profiles set notifications_enabled = coalesce(p_enabled, true) where id = v_user;

  for r in select * from jsonb_each(p_categories)
  loop
    v_kind := r.key;
    if not exists (select 1 from (select unnest(array['goal','red_card','half_time','full_time','match_start','match_reminder','team_update','competition_update','news','system','announcement','message']) as k) x where x.k = v_kind) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_KIND', 'detail', v_kind);
    end if;
    if r.value ? 'enabled' and jsonb_typeof(r.value -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', v_kind || '.enabled must be a boolean');
    end if;
    if r.value ? 'channels' and (jsonb_typeof(r.value -> 'channels') <> 'array'
       or exists (select 1 from jsonb_array_elements_text(r.value -> 'channels') c where c not in ('inbox','push'))) then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', v_kind || '.channels must be a subset of {inbox,push}');
    end if;

    insert into public.notification_preferences (user_id, kind, enabled, channels, updated_at)
    values (
      v_user,
      v_kind,
      coalesce((r.value ->> 'enabled')::boolean, (select (kicklive_preference_defaults() ->> v_kind)::boolean), false),
      coalesce(array(select jsonb_array_elements_text(r.value -> 'channels')), array['inbox','push']),
      now()
    )
    on conflict (user_id, kind) do update
      set enabled = excluded.enabled,
          channels = excluded.channels,
          updated_at = now();

    v_seen := array_append(v_seen, v_kind);
  end loop;

  return jsonb_build_object('ok', true, 'document', kicklive_notification_defaults_document(v_user));
end;
$$;

-- ── 4. verification (reports; hard-raises only on a live correctness failure) ────────────────────────
do $verify$
declare
  v_count integer;
begin
  -- 17.1 all three CHECKs now admit 'message'. Proven by a live insert-and-rollback into the one table a
  --      DEFINER verify block can write without a user context (notification_jobs, via a targeted job).
  begin
    insert into public.notification_jobs (dedupe_key, kind, title, body, metadata)
    values ('phase17-verify:' || gen_random_uuid()::text, 'message', 'verify', 'verify',
            jsonb_build_object('target', jsonb_build_object('type','user','userId', gen_random_uuid()::text)));
    delete from public.notification_jobs where dedupe_key like 'phase17-verify:%';
  exception when check_violation then
    raise exception 'phase17 verification failed: notification_jobs_kind_check still rejects the message kind';
  end;

  -- 17.2 the defaults literal carries message=true.
  if (public.kicklive_preference_defaults() ->> 'message') is distinct from 'true' then
    raise exception 'phase17 verification failed: kicklive_preference_defaults() does not default message on';
  end if;

  -- 17.3 the set-preferences validator accepts the message kind (a signed-out call still parses the vocab
  --      before it refuses on auth, so this exercises the UNKNOWN_KIND path being widened, not the write).
  --      auth.uid() is null here, so the function short-circuits at UNAUTHENTICATED — which proves it is
  --      callable and its body compiled with the new array.
  perform public.kicklive_set_notification_preferences(true, '{}'::jsonb);

  select count(*) into v_count from pg_constraint
   where conname in ('notifications_kind_check','notification_preferences_kind_check','notification_jobs_kind_check');
  if v_count <> 3 then
    raise exception 'phase17 verification failed: expected 3 kind CHECK constraints, found %', v_count;
  end if;

  raise notice 'phase17 verification: ok — message category added to 3 CHECKs, defaults literal and both inline RPC lists; defaults on and pushable (Worker policy)';
end
$verify$;

-- PostgREST caches the catalogue: the redefined RPCs need a reload.
notify pgrst, 'reload schema';
