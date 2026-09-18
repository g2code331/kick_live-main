-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Phase 15 · Direct messaging (user ↔ staff inbox)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
--
-- A conversation inbox between an ordinary account and the staff desk (admins + media). It is deliberately
-- NOT open user-to-user peer messaging: in a league product the message a fan or a team manager needs to
-- send is "to whoever runs this", and the reply comes from staff. Modelling that as a thread with one
-- non-staff participant and a staff pool keeps the audience rule a single fact and keeps a fan from being
-- cold-messaged by a stranger.
--
-- Shape:
--   • message_threads — one row per conversation. `user_id` is the non-staff participant (the thread's
--     owner); staff are not enumerated because any staff member may read and answer. `subject` is optional
--     free text. `last_message_at` / `last_message_preview` denormalise the list view. Unread is tracked
--     from two "last read" clocks — one for the owner, one for the staff side — so a badge does not need a
--     per-message read table.
--   • messages — one row per message, `sender_id` + `sender_is_staff`, `body`.
--
-- Security model is phase 5's, exactly: RLS enabled (not forced), every client role REVOKEd on both tables,
-- and NO client INSERT/UPDATE path. All writes go through SECURITY DEFINER functions that take the actor
-- from auth.uid(); a body can never name a sender. Reads use RLS: an owner sees their own threads/messages,
-- staff (is_admin_or_media) see all.
--
-- Source of truth is this migration; regenerate the bundle with `npm run sql:bundle`. Do not hand-edit
-- supabase/SETUP.sql.

-- ── 1. tables ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.message_threads (
  id                   bigint generated always as identity primary key,
  -- The non-staff participant. A thread always has exactly one; staff are a pool, not a column.
  user_id              uuid not null references public.profiles(id) on delete cascade,
  subject              text,
  status               text not null default 'open'
                       constraint message_threads_status_check check (status in ('open','closed')),
  last_message_at      timestamptz not null default now(),
  last_message_preview text,
  -- Two clocks, one per side, so "unread" is an interval comparison rather than a join to a read table.
  user_last_read_at    timestamptz not null default now(),
  staff_last_read_at   timestamptz,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now()
);

comment on table public.message_threads is
  'Phase 15: one conversation between a non-staff account (user_id) and the staff desk. Staff are a pool (is_admin_or_media), not a stored participant.';

create index if not exists message_threads_user_idx
  on public.message_threads (user_id, last_message_at desc);
create index if not exists message_threads_recent_idx
  on public.message_threads (last_message_at desc);

create table if not exists public.messages (
  id              bigint generated always as identity primary key,
  thread_id       bigint not null references public.message_threads(id) on delete cascade,
  sender_id       uuid references public.profiles(id) on delete set null,
  -- Denormalised from the sender's role at send time: a thread's history must read correctly even after a
  -- sender's role changes or their account is deleted.
  sender_is_staff boolean not null,
  body            text not null
                  constraint messages_body_length check (length(body) between 1 and 4000),
  created_at      timestamptz not null default now()
);

comment on table public.messages is
  'Phase 15: one message in a thread. sender_is_staff is captured at send time so history is stable across role changes.';

create index if not exists messages_thread_idx
  on public.messages (thread_id, created_at);

-- ── 2. row level security ─────────────────────────────────────────────────────────────────────────────
--
-- Same rule as phase 5: enable (never force, because the RPCs run as the owner), revoke every client role,
-- and add read-only policies. No client INSERT/UPDATE policy exists — the RPCs are the only write path.
do $rls$
declare
  t text;
begin
  foreach t in array array['message_threads','messages']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end
$rls$;

-- Threads: the owner sees their own; staff see all. No anon (a signed-out visitor has no inbox).
drop policy if exists "message_threads: owner or staff read" on public.message_threads;
create policy "message_threads: owner or staff read"
  on public.message_threads for select to authenticated
  using (user_id = auth.uid() or public.is_admin_or_media());

-- Messages: readable when the caller can read the parent thread. Expressed as the same predicate rather than
-- a join to keep the two policies impossible to drift apart.
drop policy if exists "messages: owner or staff read" on public.messages;
create policy "messages: owner or staff read"
  on public.messages for select to authenticated
  using (
    public.is_admin_or_media()
    or exists (
      select 1 from public.message_threads t
       where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );

-- No FOR INSERT/UPDATE/DELETE policy on either table, on purpose: every mutation is an RPC that takes the
-- actor from auth.uid(). A client with a direct write path could forge a sender or answer as staff.

-- ── 3. functions the Worker calls ──────────────────────────────────────────────────────────────────────

-- 3.1 the caller's thread list (owner sees their own; staff see the whole desk, most-recent first).
create or replace function public.kicklive_message_threads(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_staff boolean := public.is_admin_or_media();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  return jsonb_build_object(
    'ok', true,
    'staff', v_staff,
    'threads', coalesce((
      select jsonb_agg(row_to_json(x))
        from (
          select t.id, t.user_id, t.subject, t.status,
                 t.last_message_at, t.last_message_preview,
                 -- Unread from the reader's own clock: staff read against staff_last_read_at, the owner
                 -- against user_last_read_at.
                 case
                   when v_staff then (t.staff_last_read_at is null or t.last_message_at > t.staff_last_read_at)
                   else t.last_message_at > t.user_last_read_at
                 end as unread,
                 p.username as user_name
            from public.message_threads t
            left join public.profiles p on p.id = t.user_id
           where v_staff or t.user_id = v_uid
           order by t.last_message_at desc
           limit v_limit
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.kicklive_message_threads(integer) is
  'Phase 15: the caller''s conversation list. Owner sees their own threads; staff (is_admin_or_media) see all. Unread is derived from the reader''s side clock.';

-- 3.2 one thread's messages, and mark it read for the caller's side in the same call.
create or replace function public.kicklive_message_thread(p_thread_id bigint, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_staff boolean := public.is_admin_or_media();
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_thread public.message_threads;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  select * into v_thread from public.message_threads where id = p_thread_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if not (v_staff or v_thread.user_id = v_uid) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  -- Reading the thread marks it read for the reader's side.
  if v_staff then
    update public.message_threads set staff_last_read_at = now() where id = p_thread_id;
  else
    update public.message_threads set user_last_read_at = now() where id = p_thread_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'thread', jsonb_build_object(
      'id', v_thread.id, 'userId', v_thread.user_id, 'subject', v_thread.subject, 'status', v_thread.status,
      'lastMessageAt', v_thread.last_message_at
    ),
    'messages', coalesce((
      select jsonb_agg(row_to_json(x))
        from (
          select m.id, m.sender_id, m.sender_is_staff, m.body, m.created_at,
                 p.username as sender_name
            from public.messages m
            left join public.profiles p on p.id = m.sender_id
           where m.thread_id = p_thread_id
           order by m.created_at
           limit v_limit
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.kicklive_message_thread(bigint, integer) is
  'Phase 15: one thread''s messages for an authorised reader, and marks the thread read for the reader''s side.';

-- 3.3 send a message. Creates the thread on first send for a non-staff caller; staff must name an existing
--     thread (staff open a conversation by answering one, or via kicklive_message_start).
create or replace function public.kicklive_send_message(
  p_thread_id bigint,
  p_body      text,
  p_subject   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_staff   boolean := public.is_admin_or_media();
  v_thread  public.message_threads;
  v_id      bigint;
  v_preview text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if length(coalesce(p_body, '')) = 0 or length(p_body) > 4000 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'body 1-4000 characters');
  end if;

  if p_thread_id is null then
    -- A new thread. Only a non-staff caller may open one this way (their message needs no target: it goes to
    -- the desk). Staff open a thread with kicklive_message_start, which names the user.
    if v_staff then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'staff open a thread with kicklive_message_start');
    end if;
    insert into public.message_threads (user_id, subject, last_message_preview, created_by, user_last_read_at)
    values (v_uid, nullif(p_subject, ''), left(p_body, 140), v_uid, now())
    returning * into v_thread;
  else
    select * into v_thread from public.message_threads where id = p_thread_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    if not (v_staff or v_thread.user_id = v_uid) then
      return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
    end if;
    if v_thread.status = 'closed' then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'this conversation is closed');
    end if;
  end if;

  insert into public.messages (thread_id, sender_id, sender_is_staff, body)
  values (v_thread.id, v_uid, v_staff, p_body)
  returning id into v_id;

  v_preview := left(p_body, 140);
  -- Sending also marks the thread read for the sender's side (you have, by definition, seen your own send).
  update public.message_threads
     set last_message_at = now(),
         last_message_preview = v_preview,
         user_last_read_at  = case when v_staff then user_last_read_at  else now() end,
         staff_last_read_at = case when v_staff then now() else staff_last_read_at end
   where id = v_thread.id;

  return jsonb_build_object('ok', true, 'threadId', v_thread.id, 'messageId', v_id);
end;
$$;

comment on function public.kicklive_send_message(bigint, text, text) is
  'Phase 15: send a message (auth.uid() is the sender). p_thread_id null opens a new thread for a non-staff caller; staff must send into an existing thread.';

-- 3.4 staff open a thread addressed to a specific user (the outbound half of the desk).
create or replace function public.kicklive_message_start(
  p_user_id uuid,
  p_body    text,
  p_subject text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.message_threads;
  v_id     bigint;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if not public.is_admin_or_media() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if length(coalesce(p_body, '')) = 0 or length(p_body) > 4000 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'body 1-4000 characters');
  end if;
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'detail', 'no such account');
  end if;

  insert into public.message_threads (user_id, subject, last_message_preview, created_by, staff_last_read_at)
  values (p_user_id, nullif(p_subject, ''), left(p_body, 140), v_uid, now())
  returning * into v_thread;

  insert into public.messages (thread_id, sender_id, sender_is_staff, body)
  values (v_thread.id, v_uid, true, p_body)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'threadId', v_thread.id, 'messageId', v_id);
end;
$$;

comment on function public.kicklive_message_start(uuid, text, text) is
  'Phase 15: staff-only. Opens a thread addressed to p_user_id with a first (staff) message.';

-- 3.5 close / reopen a thread. Owner or staff.
create or replace function public.kicklive_message_set_status(p_thread_id bigint, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_staff  boolean := public.is_admin_or_media();
  v_thread public.message_threads;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if p_status not in ('open','closed') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'detail', 'status must be open or closed');
  end if;
  select * into v_thread from public.message_threads where id = p_thread_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if not (v_staff or v_thread.user_id = v_uid) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  update public.message_threads set status = p_status where id = p_thread_id;
  return jsonb_build_object('ok', true, 'threadId', p_thread_id, 'status', p_status);
end;
$$;

comment on function public.kicklive_message_set_status(bigint, text) is
  'Phase 15: close or reopen a thread. Owner or staff.';

-- 3.6 an unread count for the badge, cheap and side-effect free.
create or replace function public.kicklive_message_unread_count()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_staff boolean := public.is_admin_or_media();
  v_count integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', true, 'count', 0);
  end if;
  if v_staff then
    select count(*) into v_count from public.message_threads t
     where t.staff_last_read_at is null or t.last_message_at > t.staff_last_read_at;
  else
    select count(*) into v_count from public.message_threads t
     where t.user_id = v_uid and t.last_message_at > t.user_last_read_at;
  end if;
  return jsonb_build_object('ok', true, 'count', coalesce(v_count, 0));
end;
$$;

comment on function public.kicklive_message_unread_count() is
  'Phase 15: number of threads with something the caller has not read, from the caller''s side clock.';

-- ── 4. privileges ──────────────────────────────────────────────────────────────────────────────────────
--
-- Every function is revoked from public/anon/authenticated, then granted to authenticated only where the
-- action is a legitimate client one. All six are: each takes the actor from auth.uid() and re-checks role
-- inside, so a granted `authenticated` cannot act as someone else or forge staff.
do $grants$
declare
  f    text;
  args text;
begin
  for f, args in select * from (values
    ('kicklive_message_threads', 'integer'),
    ('kicklive_message_thread', 'bigint,integer'),
    ('kicklive_send_message', 'bigint,text,text'),
    ('kicklive_message_start', 'uuid,text,text'),
    ('kicklive_message_set_status', 'bigint,text'),
    ('kicklive_message_unread_count', '')
  ) as t(f, args)
  loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f, args);
  end loop;

  execute 'grant execute on function public.kicklive_message_threads(integer) to authenticated';
  execute 'grant execute on function public.kicklive_message_thread(bigint, integer) to authenticated';
  execute 'grant execute on function public.kicklive_send_message(bigint, text, text) to authenticated';
  execute 'grant execute on function public.kicklive_message_start(uuid, text, text) to authenticated';
  execute 'grant execute on function public.kicklive_message_set_status(bigint, text) to authenticated';
  execute 'grant execute on function public.kicklive_message_unread_count() to authenticated';
end
$grants$;

-- ── 5. verification (reports; hard-raises only on a live correctness failure) ────────────────────────────
do $verify$
declare
  v_count integer;
begin
  -- 15.1 both tables exist with RLS enabled and not forced (the RPCs run as owner).
  select count(*) into v_count from pg_tables
   where schemaname = 'public' and tablename in ('message_threads','messages');
  if v_count <> 2 then
    raise exception 'phase15 verification failed: expected 2 messaging tables, found %', v_count;
  end if;
  select count(*) into v_count from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('message_threads','messages') and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 0 then
    raise exception 'phase15 verification failed: RLS is FORCED on a messaging table, which would make the owner-role RPCs write zero rows';
  end if;

  -- 15.2 no client INSERT/UPDATE/DELETE policy exists on either table (the RPCs are the only write path).
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename in ('message_threads','messages') and cmd <> 'SELECT';
  if v_count <> 0 then
    raise exception 'phase15 verification failed: a write policy exists on a messaging table; the only write path must be the SECURITY DEFINER RPCs';
  end if;

  -- 15.3 the six functions exist.
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('kicklive_message_threads','kicklive_message_thread','kicklive_send_message',
                       'kicklive_message_start','kicklive_message_set_status','kicklive_message_unread_count');
  if v_count <> 6 then
    raise exception 'phase15 verification failed: expected 6 messaging functions, found %', v_count;
  end if;

  -- 15.4 every messaging function is DEFINER with a pinned search_path (the hijacking guard).
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'kicklive_message%'
     and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%';
  if v_count > 0 then
    raise exception 'phase15 verification failed: % messaging function(s) are SECURITY DEFINER without a pinned search_path', v_count;
  end if;

  -- 15.5 the client roles cannot touch the tables directly (revoke held).
  select count(*) into v_count from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('message_threads','messages')
     and grantee in ('anon','authenticated');
  if v_count > 0 then
    raise exception 'phase15 verification failed: a client role has a direct table grant on a messaging table';
  end if;

  -- 15.6 a live read as the anonymous caller must not raise (the "no rows, no error" path a signed-out
  --      visitor is in): the unread count answers 0.
  begin
    perform public.kicklive_message_unread_count();
  exception when others then
    raise exception 'phase15 verification failed: kicklive_message_unread_count() raised on the anonymous state: %', sqlerrm;
  end;

  raise notice 'phase15 verification: ok — 2 tables (RLS on, force off), read-only client policies, 6 owner-role RPCs, no client write path';
end
$verify$;

-- PostgREST caches the catalogue: without this the new RPCs 404 until a restart, which reads like a Worker bug.
notify pgrst, 'reload schema';
