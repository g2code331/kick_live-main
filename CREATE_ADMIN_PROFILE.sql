-- ============================================================================
-- BOOTSTRAP THE FIRST ADMIN — one-time, emergency path only
-- ============================================================================
-- This file used to hardcode a personal Gmail address and that person's auth.users UUID and run a
-- blind `INSERT … ON CONFLICT DO UPDATE SET role = 'admin'`. Both halves were problems:
--   * a committed real identity + UUID is a permanent target (it tells an attacker which account to
--     phish, and the UUID is the key to that account's rows);
--   * a file that grants admin with one paste should not sit in a repository next to the app.
--
-- Read before running:
--   1. Run it in the Supabase dashboard SQL editor as `postgres`, once, on a fresh project — this is
--      the "who grants the first admin" answer, not a day-to-day tool.
--   2. After that, every role change goes through public.kicklive_set_user_role() from the admin UI
--      (audited, last-admin-guarded). Nothing in the app should ever call this file again.
--   3. Then delete this file from the repository, or keep it but never commit a real address.
--   4. Never run this from CI, and never point a deployment secret at it.
--
-- Requires: KICKLIVE_FINAL_SCHEMA.sql + the Phase 1 hardening migration (supabase/migrations/).
-- ============================================================================

do $$
declare
  -- Fill in the address of an account that already exists in auth.users. Sign up first, then run this.
  v_email  text := 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL';
  v_user_id uuid;
begin
  if v_email = 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL' then
    raise exception 'edit v_email first; this script does not know who should be admin on purpose';
  end if;

  select id into v_user_id from auth.users where lower(email) = lower(v_email) limit 1;
  if v_user_id is null then
    raise exception 'no auth.users row for % — sign up in the app first', v_email;
  end if;

  -- The on-signup trigger normally created this row already; this only covers a profile that was
  -- lost before the trigger existed. No role here: the trigger/RPC own that column.
  insert into public.profiles (id, email, username, role)
  select v_user_id, u.email, left(coalesce(nullif(btrim(u.raw_user_meta_data ->> 'username'), ''),
                                           split_part(u.email, '@', 1)), 32), 'fan'
    from auth.users u
   where u.id = v_user_id
  on conflict (id) do nothing;

  update public.profiles set role = 'admin', updated_at = now() where id = v_user_id;

  raise notice 'admin granted to % (id %)', v_email, v_user_id;
  raise notice 'now delete this file from the working copy; further role changes go through the admin UI';
end;
$$;

-- Verify (returns exactly one row with role = 'admin'):
-- select id, email, username, role from public.profiles where role = 'admin';
