/**
 * The migrations are executed, not merely read.
 *
 * Why this exists, stated plainly because it is the whole reason: three separate defects in this repository's
 * privilege verification were invisible to `tsc`, to prettier, to every unit test and to a careful human reader,
 * and each was only found when somebody pasted `supabase/SETUP.sql` into the Supabase SQL editor.
 *
 *   1. the assertions asked `has_column_privilege()` what a grant was — always "yes" for the SQL editor's role;
 *   2. the replacement helper joined `aclexplode` on a column that does not exist, and then on a *letter*
 *      where `aclexplode` reports a *name*, which made every negative assertion pass for free;
 *   3. `revoke update (role) on public.profiles` — the headline control — removed a column aclitem that was
 *      never the reason the role could write, because the table-wide grant Supabase grants by default already
 *      covers every column. The hole stayed open for the entire time the checks were "green".
 *
 * All three are the same class: SQL whose *meaning* can only be observed by running it. So it is run here, on
 * PGlite (a real PostgreSQL, compiled to WebAssembly — no server, no network, no credentials), against a
 * database prepared to look like a fresh Supabase project in exactly the respect that matters: the client roles
 * exist and `alter default privileges` has handed them ALL. A privilege test that passes without those default
 * grants is testing a database that does not exist.
 *
 * This file has no PostgREST, so RLS is not exercised for the owner, and the extension set is minimal; that is
 * why `scripts/check-sql.mjs --dsn …` remains the real gate. What this catches is the cheaper, more frequent
 * failure: a migration that cannot be applied at all, and a verification block that certifies something untrue.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { runOnPglite } = await import(path.join(REPO, "scripts/sql-pglite.mjs"));

const available = fs.existsSync(path.join(REPO, "node_modules/@electric-sql/pglite/package.json"));

// Every probe is one row of booleans/counts, asserted below by name. `false`/`0` is the hardened answer for
// the first group; `true`/`1` is the app-still-works answer for the second. Getting both in one query is the
// point: a control that closes the hole and also locks the UI out is not a control, it is an outage.
const PROBE = `
select
  -- the hole this whole file exists for, measured on the ACL the bundle actually leaves behind
  public.kicklive_has_grant('authenticated','public.profiles','w','role')     as auth_can_write_role,
  public.kicklive_has_grant('anon','public.profiles','w','role')               as anon_can_write_role,
  public.kicklive_has_grant('authenticated','public.profiles','w','email')     as auth_can_write_email,
  public.kicklive_has_grant('public','public.profiles','w')                    as public_can_write_profiles,
  public.kicklive_has_grant('anon','public.profiles','r')                      as anon_can_read_profiles,
  -- what must survive the hardening, or the deployment is an outage rather than a fix
  public.kicklive_has_grant('authenticated','public.profiles','w','username')  as auth_can_edit_username,
  public.kicklive_has_grant('authenticated','public.profiles','w','phone')     as auth_can_edit_phone,
  public.kicklive_has_grant('authenticated','public.profiles','r','role')      as auth_can_read_role,
  public.kicklive_has_grant('service_role','public.profiles','r')              as worker_can_read_profiles,
  -- an engine RPC a client role was never granted must not be reachable by that role; the one it *was*
  -- granted must be, or the live console is broken by the privilege sweep rather than protected by it
  (select count(1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'kicklive_record_match_event'
       and public.kicklive_has_grant('anon', p.oid::regprocedure::text, 'X'))   as anon_can_call_the_engine,
  (select count(1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'kicklive_record_match_event'
       and public.kicklive_has_grant('authenticated', p.oid::regprocedure::text, 'X'))
                                                                            as staff_can_call_the_engine,
  -- no count of "how many functions may anon execute": the shipped schema publishes a couple of dozen reads
  -- on purpose, and pinning that number would make every legitimate public read a failing test. What is
  -- pinned is the *shape* — nothing whose name says it writes may be reachable anonymously. A name is a weak
  -- signal, and it is deliberately not the only one here: the same clause would also catch a rename that
  -- hides a writer, which is the review comment that check is for.
  (select count(1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'kicklive\_%'
       and p.proacl is not null
       and p.proname ~ '_(save|set_[a-z_]+|delete_[a-z_]+|correct_[a-z_]+|assign|finalize|stand_down|decide|reserve|attach|touch_epoch)$'
       and public.kicklive_has_grant('anon', p.oid::regprocedure::text, 'X'))
                                                                            as anon_can_reach_a_writer
  from (select 1) _
`;

test("the bundle executes on a real Postgres and its own verification blocks pass", { skip: !available && "no @electric-sql/pglite" }, async () => {
  const r = await runOnPglite({ files: ["supabase/SETUP.sql"], log: () => {} });
  assert.equal(r.skipped, false);
  assert.deepEqual(
    r.failures.map((f) => `[${f.code}] ${f.file}: ${f.message}`),
    [],
    `${r.executed} statements ran; ${r.failures.length} failed`,
  );
  assert.ok(r.executed > 700, `expected the whole bundle to be executed, saw ${r.executed} statements`);
});

test("the privilege model the bundle leaves behind is the one its comments claim", { skip: !available && "no pglite" }, async () => {
  let seen;
  const r = await runOnPglite({
    files: ["supabase/SETUP.sql"],
    log: () => {},
    probe: [
      {
        run: async (db) => {
          seen = (await db.query(PROBE)).rows[0];
        },
      },
    ],
  });
  assert.ok(seen, "the probe ran");
  for (const [key, want] of Object.entries({
    auth_can_write_role: false,
    anon_can_write_role: false,
    auth_can_write_email: false,
    public_can_write_profiles: false,
    anon_can_read_profiles: false,
    auth_can_edit_username: true,
    auth_can_edit_phone: true,
    auth_can_read_role: true,
    worker_can_read_profiles: true,
    anon_can_call_the_engine: 0,
    staff_can_call_the_engine: 1,
    anon_can_reach_a_writer: 0,
  })) {
    assert.equal(seen[key], want, `${key} = ${seen[key]}, expected ${want}`);
  }
});

test("the admin bootstrap grants, verifies, and refuses every way of getting it wrong", { skip: !available && "no pglite" }, async () => {
  const base = fs.readFileSync(path.join(REPO, "CREATE_ADMIN_PROFILE.sql"), "utf8");
  // jsonb_build_object rather than an embedded JSON literal: this seed crosses JS and SQL quoting, and a
  // quoting bug here reads exactly like a bug in the script under test.
  const seed =
    "insert into auth.users (id, email, raw_user_meta_data) values " +
    "('22222222-2222-2222-2222-222222222222','admin@kicklive.football'," +
    "jsonb_build_object('username','chief'));" +
    String.fromCharCode(10);

  // Each variant edits the two declaration lines only, because that is all an operator edits. The first is the
  // whole file pasted untouched; the last is the case a sentinel-string placeholder could not express — an
  // address that *is* the operator's, in a project where they have not signed up yet.
  const set = (email, id = "null") => base.replace("p_email    text := null;", "p_email    text := " + email + ";").replace("p_user_id  uuid := null;", "p_user_id  uuid := " + id + ";");
  const variants = [
    { name: "unedited", admin: base, want: "nothing supplied: set exactly one of p_email" },
    { name: "markdown-autolinked address", admin: set("'[someone@gmail.com](mailto:someone@gmail.com)'"), want: "not a bare address" },
    { name: "address with no account behind it", admin: set("'nobody@nowhere.test'"), want: "no auth.users row for nobody@nowhere.test" },
    { name: "the operator's own address, nobody signed up yet", admin: set("'g2code33@gmail.com'"), want: "this project has 0 auth user" },
    { name: "both inputs set", admin: set("'someone@example.com'", "'22222222-2222-2222-2222-222222222222'"), want: "point at one account, not two" },
  ];
  for (const v of variants) {
    fs.writeFileSync(path.join(REPO, ".tmp-admin-variant.sql"), v.admin);
    const r = await runOnPglite({ files: ["supabase/SETUP.sql", ".tmp-admin-variant.sql"], log: () => {} });
    assert.equal(r.failures.length, 1, `${v.name}: expected exactly one raised error, got ${r.failures.length}`);
    assert.match(r.failures[0].message, new RegExp(v.want), `${v.name}: wrong explanation (${r.failures[0].message})`);
    fs.rmSync(path.join(REPO, ".tmp-admin-variant.sql"), { force: true });
  }

  // the success path, plus the state check the script is supposed to guarantee
  fs.writeFileSync(path.join(REPO, ".tmp-admin-variant.sql"), seed + set("'admin@kicklive.football'"));
  const ok = await runOnPglite({
    files: ["supabase/SETUP.sql", ".tmp-admin-variant.sql"],
    log: () => {},
    probe: [
      {
        run: async (db) => {
          const rows = (await db.query("select role, username from public.profiles where id = '22222222-2222-2222-2222-222222222222'")).rows;
          assert.deepEqual(rows, [{ role: "admin", username: "chief" }], "the bootstrap must leave exactly one admin profile for the account it named");
          const admins = (await db.query("select count(1)::int n from public.profiles where role = 'admin'")).rows[0].n;
          assert.equal(admins, 1, "and it must not have made anybody else an admin");
        },
      },
    ],
  });
  fs.rmSync(path.join(REPO, ".tmp-admin-variant.sql"), { force: true });
  assert.deepEqual(
    ok.failures.map((f) => f.message),
    [],
    "the happy path runs clean, including its own verification",
  );
});
