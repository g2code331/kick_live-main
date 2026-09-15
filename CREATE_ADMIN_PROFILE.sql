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
--   2. Set ONE of the two values below to that account, and TYPE it: do not paste an address out of a chat,
--      a ticket or a markdown preview. Those wrap it in a markdown link as soon as you paste, and an address
--      wearing brackets is not an address — the guard below refuses it rather than granting admin to a typo.
--      If your editor autolinks no matter what, set p_user_id instead: a bare uuid cannot be autolinked.
--      Both default to NULL, and that is deliberate. An earlier version of this file used a placeholder
--      STRING and compared the input against it, which had two failures: an address that happens to equal
--      the sentinel (it is, after all, the operator's own address in this repository) was refused as
--      "unedited", and the comparison was a guess about the operator's editor rather than a fact about the
--      database. NULL means "not supplied" with no possible collision; whether an account exists is a
--      question auth.users answers exactly. So there is no placeholder left to overwrite anywhere.
--   3. Run. It first checks its own ground (this is a Supabase project, `public.profiles` exists, the sign-up
--      trigger and the role RPC are installed) and refuses with the fixing file named in the message, rather than
--      "succeeding" against a database that cannot hold the grant. Then the Results grid must come back with the
--      new admin; anything else and the script raised, with the reason in the message. Re-running is safe: the grant is idempotent and only ever touches the
--      one account named.
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
  p_email    text := 'g2code33@gmail.com';      -- e.g. 'you@example.com' — typed, never pasted out of a chat
  p_user_id  uuid := null;      -- e.g. '3f1a…' when you would rather not put an address in the editor
  v_user_id  uuid;
  v_email    text;
  v_count    text;
  v_missing  text;
  v_input    text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if p_user_id is not null and v_input is not null then
    raise exception 'p_email and p_user_id are both set — point at one account, not two';
  end if;
  if p_user_id is null and v_input is null then
    raise exception
      'nothing supplied: set exactly one of p_email / p_user_id (both are null). The account must already '
      'exist — sign up in the app, or Auth → Users → Add user, then re-run. This script will not create an '
      'identity and it will not guess one.';
  end if;


  -- ── Preflight: refuse loudly when this project is not the hardened database ──────────────────────
  -- Everything below assumes supabase/SETUP.sql has been applied in full. A project with only the base schema
  -- produces the "ran it and nothing happened" experience these guards exist to end:
  --   * no `on_auth_user_created` trigger → accounts created in the app get no `profiles` row, which is exactly
  --     the state that makes sign-up report "permission denied for table profiles" (HTTP 401 from PostgREST);
  --   * no `kicklive_set_user_role` → the supported role writer is missing, so the grant below has no path.
  -- Both are answered by existence lookups rather than catalog joins, because `pg_trigger.tgdropped` does not
  -- exist in every build this repo executes against (PGlite's catalog has no such column) — a join written
  -- against it fails *for the wrong reason*, which is how this check nearly shipped broken. A database with no
  -- auth users is skipped on purpose: that is not a hardening problem but a sign-up to do, and the account
  -- lookup below says it better. An empty project therefore passes preflight and reads `no accounts exist yet`;
  -- a populated-but-unhardened one stops here, because "sign up in the app" would only produce the very profile
  -- error the operator is trying to escape.
  if to_regclass('auth.users') is null then
    raise exception 'this database has no auth.users — it is not a Supabase project (or the SQL editor is pointed at the wrong one). '
      'Run this file in the Supabase project the app actually talks about; npm run pair:check prints that ref.' using errcode = '42P01';
  end if;

  if (select count(1) from auth.users) > 0 then
    if to_regclass('public.profiles') is null then
      raise exception 'public.profiles does not exist in this project, so there is nothing to grant into. Paste supabase/SETUP.sql — the whole '
        'bundle, not one supabase/migrations/*.sql file — then re-run this file.' using errcode = '42P01';
    end if;
    if to_regprocedure('public.handle_new_user()') is null or to_regprocedure('public.kicklive_set_user_role(uuid, text)') is null then
      -- Params come before `using` in plpgsql's grammar; the opposite order is an "unrecognized RAISE statement
      -- option" syntax error, which is how a guard meant to prevent confusion would have shipped as a fresh one.
      -- Nor may a parameter be a parenthesised expression: `raise …, concat_ws(…)` is a syntax error at the
      -- comma. Hence the variable, and hence the note: only *running* this file can catch either of them.
      v_missing := concat_ws(
        ' and ',
        case when to_regprocedure('public.handle_new_user()') is null then 'public.handle_new_user()' end,
        case when to_regprocedure('public.kicklive_set_user_role(uuid, text)') is null then 'public.kicklive_set_user_role(uuid, text)' end);
      raise exception 'this project is missing % — the sign-up trigger and/or the only supported role writer. That is the signature of a database where '
        'supabase/SETUP.sql was never applied (or only half of it was), which is also why profile rows go missing at sign-up. Paste the whole bundle '
        '(idempotent: create or replace everywhere), then re-run this file.', v_missing using errcode = 'P0001';
    end if;
  end if;

  if p_user_id is null then
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
    -- Two different situations, and the user count tells you which one you are in: 0 means nobody has
    -- signed up at all (create the account first), N > 0 means the account list is fine and the *address*
    -- is what does not match — a typo, a different case than Supabase stored, or an autolinked paste.
    raise exception
      'no auth.users row for % (this project has % auth user(s)). % — if that count is 0, sign up / Add user '
      'first and re-run; if it is not, the address above is not one of them: check spelling and case, and if '
      'it ends in a bracket an autolinker ate it while you were pasting, so type it in.',
      v_input, v_count,
      case when v_count = '0' then 'no accounts exist yet' else 'the address is not among them' end;
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
-- The Results grid you get back. It is deliberately *not* `select … from public.profiles`: the Supabase editor
-- runs a paste statement by statement, so after the block above raises (a bad edit, an unhardened project) an
-- unguarded trailing select adds "relation public.profiles does not exist" — a second, unrelated-looking error
-- that sends people hunting for the wrong thing. This reads only the catalog, which always exists, and tells you
-- which half of the story you are in: a number, or the fix. On success the NOTICE above named the account.
select case
         when exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                       where n.nspname = 'public' and c.relname = 'profiles')
           then 'public.profiles exists — run `select id, email, username, role, updated_at from public.profiles where role = ''admin'';` '
                'to see every admin. The NOTICE above named the one this run promoted.'
         else 'no public.profiles in this project — paste supabase/SETUP.sql (the whole bundle) into this project first, then re-run this file.'
       end as next_step,
       (select count(1) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'profiles') as profiles_table_present;

