-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 16 · Notify a thread owner when staff reply
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
--
-- Ties phase 15 (messaging) to phase 5/14 (notifications). When a STAFF member sends a message, the thread
-- owner is not looking at the staff desk and should get a push/inbox notification. The reverse direction
-- (a user writing in) is already covered by the desk's own unread badge and has no single staff recipient,
-- so it is deliberately not notified here.
--
-- Mechanism:
--   • kind = 'message' — its own category (added in the phase-17 migration that runs alongside this one), so
--     a user can mute message notifications without muting the broader 'system' account category. It defaults
--     to enabled in kicklive_preference_defaults;
--   • the phase-14 metadata target `{"type":"user","userId":<owner>}`, so the job-aware audience
--     (kicklive_notification_audience_job) narrows the system audience to exactly the owner — and still
--     honours their preference, so a user who muted `system` is not messaged;
--   • the phase-14-widened has-target constraint accepts an id-less job because metadata carries a target.
--
-- The job is created in the same transaction as the message (an AFTER INSERT trigger), so a reply and its
-- notification are one fact; the `*/5` sweep delivers it, exactly like a match-event job. No Worker code is
-- involved in creating it.
--
-- Source of truth is this migration; regenerate the bundle with `npm run sql:bundle`. Do not hand-edit
-- supabase/SETUP.sql.

create or replace function public.kicklive_notification_job_for_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_thread   public.message_threads;
  v_sender   text;
  v_preview  text;
begin
  -- Only a staff message notifies, and only the thread owner. A user's own message to the desk is not a
  -- push (there is no single staff recipient, and the desk badge already shows it).
  if not new.sender_is_staff then
    return new;
  end if;

  select * into v_thread from public.message_threads where id = new.thread_id;
  if not found then
    return new;
  end if;

  -- Sender's display name, best effort. A deleted sender still gets a sensible label.
  select coalesce(p.username, 'Support') into v_sender from public.profiles p where p.id = new.sender_id;
  v_sender := coalesce(v_sender, 'Support');

  v_preview := left(new.body, 140);

  insert into public.notification_jobs (dedupe_key, kind, title, body, metadata, recipient_count, created_by)
  values (
    -- One job per message, keyed on the message id so a re-fired trigger cannot double-send.
    format('message:%s', new.id),
    'message',
    'New message from ' || v_sender,
    coalesce(nullif(v_thread.subject, ''), v_preview),
    jsonb_build_object(
      'target', jsonb_build_object('type', 'user', 'userId', v_thread.user_id::text),
      'source', 'message',
      'threadId', new.thread_id,
      'messageId', new.id,
      'link', '/messages'
    ),
    1,
    new.sender_id
  )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

comment on function public.kicklive_notification_job_for_message() is
  'Phase 16: AFTER INSERT on messages — a staff reply queues a system notification targeted at the thread owner (phase-14 user target). A user message does not notify.';

-- AFTER INSERT: the return value is ignored, but NEW is returned so a future change to BEFORE ROW cannot
-- silently discard the message row.
drop trigger if exists kicklive_message_notification on public.messages;
create trigger kicklive_message_notification
  after insert on public.messages
  for each row execute function public.kicklive_notification_job_for_message();

-- Service-role only, like every other job-writing function.
do $grants$
begin
  execute 'revoke all on function public.kicklive_notification_job_for_message() from public, anon, authenticated';
end
$grants$;

-- ── verification (reports; hard-raises only on a live correctness failure) ────────────────────────────
do $verify$
declare
  v_count integer;
begin
  -- 16.1 the function exists and is DEFINER with a pinned search_path.
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'kicklive_notification_job_for_message'
     and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%';
  if v_count <> 1 then
    raise exception 'phase16 verification failed: kicklive_notification_job_for_message is missing or not a DEFINER with a pinned search_path';
  end if;

  -- 16.2 the trigger is attached to the messages table.
  select count(*) into v_count from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where t.tgname = 'kicklive_message_notification' and c.relname = 'messages' and not t.tgisinternal;
  if v_count <> 1 then
    raise exception 'phase16 verification failed: the messages notification trigger is not attached';
  end if;

  raise notice 'phase16 verification: ok — staff replies queue a system notification targeted at the thread owner, delivered by the existing sweep';
end
$verify$;

-- PostgREST caches the catalogue: keep the reload in step with the other phases.
notify pgrst, 'reload schema';
