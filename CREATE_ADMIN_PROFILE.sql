-- ============================================================================
-- BOOTSTRAP THE FIRST ADMIN — one-time, emergency path only
-- ============================================================================
-- This file used to hardcode a personal Gmail address and that person's auth.users UUID and run a
-- blind `INSERT … ON CONFLICT DO UPDATE SET role = 'admin'`. Both halves were problems:
--   * a committed real identity + UUID is a permanent target (it tells an attacker which account to
--     phish, and the UUID is the key to that account's rows);
--   * a file that grants admin with one paste should not sit in a repository next to the app.
--
-- HOW TO RUN IT (Supabase dashboard → SQL editor → New query → paste → Run), as `postgres`:
--   1. Sign up in the app with the account that should be admin (or create it in Auth → Users).
--   2. Replace ONE placeholder below with that address, and TYPE it: do not paste it out of a chat, a
--      ticket or a markdown preview. Those wrap an address in a markdown link as soon as you paste, and
--      an address wearing markdown brackets is not an address — the guard in this file refuses it rather
--      than granting admin to a typo. (If your editor autolinks no matter what, set p_user_id instead:
--      a bare uuid cannot be autolinked. A gmail.com address is what gets linked most aggressively.)
--      Re-run after each edit: the file is idempotent, it only ever touches the one account you named.
--   3. Run. The Results grid must come back with the new admin; anything else and the script raised.
--
-- Read before running:
--   1. Once per fresh project — this is the "who grants the first admin" answer, not a day-to-day tool.
--   2. After that, every role change goes through public.kicklive_set_user_role() from the admin UI
--      (audited, last-admin-guarded). Nothing in the app should ever call this file again.
--   3. Then delete this file from the working copy, or keep it but never commit a real address.
--   4. Never run this from CI, and never point a deployment secret at it.
--
-- Requires: supabase/SETUP.sql already run (it is the base schema + Phase 1 hardening + the rest).
-- ============================================================================

do $$
declare
  -- ───────────────────────────────────────────────────────────────────────────
  -- FILL IN EXACTLY ONE OF THESE TWO, then Run. Type the value; do not paste it
  -- out of a chat or a ticket (see the note at the top about markdown links).
  -- ───────────────────────────────────────────────────────────────────────────
  p_email    text := 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL';
  p_user_id  uuid := null;      -- e.g. '3f1a…' when you would rather not put an address in the editor
  v_user_id  uuid;
  v_email    text;
  v_count    text;
  v_input    text := coalesce(nullif(btrim(p_email), ''), 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL');
begin
  if p_user_id is not null and v_input <> 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL' then
    raise exception 'p_email and p_user_id are both set — point at one account, not two';
  end if;

  if p_user_id is null then
    if v_input = 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL' then
      raise exception
        'nothing to do on purpose: set p_email (or p_user_id) to an account that already exists in auth.users. '
        'Sign up in the app first — this script will not create an identity and it will not guess one.';
    end if;
    -- A markdown link is the failure this guard exists for. `[you@x.com](mailto:you@x.com)` is a perfectly
    -- valid string literal, so without this the script would report "no auth.users row" and send you off to
    -- check whether the account exists when the address is what is broken.
    if v_input ~ '[[:space:]<>()\[\]"'':]' or v_input ilike 'mailto:%' then
      raise exception 'that is not a bare address: % — an autolinker has wrapped it in [ … ](mailto:…). Keep only '
        'local@domain.tld between the quotes (or use p_user_id, which cannot be autolinked).', v_input;
    end if;
    -- exactly one @, no spaces, a dot in the domain: a typo here would otherwise silently
    -- "succeed" against nobody, or worse, against a different account.
    if v_input !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or v_input like '%@%@%' then
      raise exception 'p_email % does not look like an address (one @, no spaces, a dot in the domain)', v_input;
    end if;
  end if;

  select u.id, u.email
    into v_user_id, v_email
    from auth.users u
   where (p_user_id is not null and u.id = p_user_id)
      or (p_user_id is null and lower(u.email) = lower(v_input))
   limit 1;

  if v_user_id is null then
    select count(*)::text into v_count from auth.users;
    raise exception
      'no auth.users row for % — that is the whole answer: create the account first (sign up in the app, or '
      'Auth → Users → Add user), then re-run. This project currently has % auth user(s). If % ends in a '
      'bracket, an autolinker ate your address while you were pasting: type it in.', v_input, v_count, v_input;
  end if;

  -- The on-signup trigger normally created this row already; this only covers a profile that was
  -- lost before the trigger existed. No role here: the trigger/RPC own that column.
  insert into public.profiles (id, email, username, role)
  select v_user_id, u.email,
         left(coalesce(nullif(btrim(u.raw_user_meta_data ->> 'username'), ''), split_part(u.email, '@', 1)), 32), 'fan'
    from auth.users u
   where u.id = v_user_id
  on conflict (id) do nothing;

  -- Grant it, through the supported path, then *verify the grant* rather than trusting that an UPDATE
  -- affected a row. The two failure modes this closes are the ones that would otherwise come back as
  -- "I ran it and nothing happened":
  --   * the RPC is admin-only, so on a project with no admin yet the raw write is the bootstrap route — and if
  --     the session is not a superuser, that raw write is refused by the guard trigger, which is the correct
  --     answer but must be *said* rather than raised as a bare 42501;
  --   * a profile row that does not exist (auth user created before the on-signup trigger, or a project where
  --     the insert above was skipped) makes any UPDATE a silent no-op — `updated 0 rows` is not visible here.
  if exists (select 1 from public.profiles where role = 'admin') then
    begin
      perform public.kicklive_set_user_role(v_user_id, 'admin');
    exception when insufficient_privilege then
      raise exception 'kicklive_set_user_role refused: the session running this script is not an admin. Run it as '
        'postgres from the Supabase SQL editor, or promote an existing admin first.' using errcode = '42501';
    end;
  else
    if not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
      raise exception 'this is the first admin and the only supported writer (kicklive_set_user_role) needs one: '
        'run this file as postgres in the SQL editor. Refusing to write public.profiles.role directly, because '
        'that column is revoked from client roles on purpose.' using errcode = '42501';
    end if;
    update public.profiles set role = 'admin', updated_at = now() where id = v_user_id;
  end if;

  if not exists (select 1 from public.profiles where id = v_user_id and role = 'admin') then
    raise exception 'the account % (id %) exists and the script ran, but profiles.role is still not admin — the row '
      'was not written. Check that public.profiles has a row for this id and that the guard trigger has not refused '
      'the write for a reason printed above.', v_email, v_user_id using errcode = 'P0002';
  end if;

  raise notice 'admin granted to % (id %). Further role changes go through the admin UI (kicklive_set_user_role)',
    v_email, v_user_id;
  raise notice 'now delete this file from the working copy';
end;
$$;
-- What the Results grid shows after a successful run: every admin, so you can see your own address
-- in the list (and notice if the list is longer than you expected).
select id, email, username, role, updated_at
  from public.profiles
 where role = 'admin'
 order by updated_at desc nulls last;
