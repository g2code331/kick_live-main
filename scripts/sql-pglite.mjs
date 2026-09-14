#!/usr/bin/env node
/**
 * Executes the migration chain on a real Postgres that needs no server: PGlite is a full PostgreSQL build
 * compiled to WebAssembly, and it is the only way this repository can *run* its SQL in a sandbox with no
 * database, no network and no `apt`. That matters because three separate defects in the privilege-verification
 * code were invisible to every static check the repo has and were only found by a human pasting the bundle into
 * the Supabase editor. Reading SQL cannot see any of them.
 *
 *   node scripts/sql-pglite.mjs                        # run supabase/SETUP.sql end to end
 *   node scripts/sql-pglite.mjs --file CREATE_ADMIN_PROFILE.sql --after supabase/SETUP.sql
 *   node scripts/sql-pglite.mjs --json
 *
 * WHAT IT IS. Every statement of the bundle, in file order, one at a time, inside a single transaction with a
 * savepoint per statement so one failure does not abort the rest — because the useful output is *all* the
 * failures, not the first. The database is prepared to look like a fresh Supabase project in exactly the one
 * respect that has bitten this repository repeatedly: the `anon` / `authenticated` / `service_role` roles
 * exist, and `alter default privileges` has handed them ALL on every table, function and sequence in `public`.
 * With those default grants in place, a `revoke … from public` is provably not enough, and an assertion that
 * reads `relacl` says so out loud.
 *
 * WHAT IT IS NOT. Not a Supabase project: no PostgREST (so RLS is not enforced for the owner), no
 * postgresql.conf, no `auth` or `extensions` schema beyond a stub, no R2, no queues, and the extension set is
 * whatever this build ships (usually only plpgsql). A green run here means *the SQL is valid and its own
 * verification blocks pass*. It does not mean the app works, and it never replaces `check-sql.mjs --dsn`
 * against a scratch database, which adds the behavioural flow.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// `--flag=value` *and* `--flag value`: the space form is what a human types first, and silently ignoring it (and
// then running the default file instead of the one named) is exactly the "the tool is broken" experience.
const flag = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);
const KNOWN_FLAGS = ["file", "after", "print", "json"];
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a.replace(/^--/, "").split("=")[0]));
if (unknownFlags.length) {
  console.error(`sql-pglite: unknown flag(s) ${unknownFlags.join(", ")} — supported: --file=X --after=X --print --json`);
  process.exit(2);
}

// ---------------------------------------------------------------- statement splitter
// Splits on `;` at the top level only, respecting single-quoted strings (with '' escapes), dollar-quoted
// bodies ($fn$, $verify$, $hg$ …) and both comment styles. A regex cannot do this: the bundle's rollback
// sections are large /* */ blocks full of semicolons, and its functions are dollar-quoted full of them.
export function splitStatements(src) {
  const out = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" && src[i + 1] === "'") {
      buf += "''";
      i += 2;
      continue;
    }
    if (c === "'") {
      buf += c;
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          buf += "'";
          i++;
          break;
        }
        buf += src[i++];
      }
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") buf += src[i++];
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      buf += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        buf += tag;
        i += tag.length;
        const end = src.indexOf(tag, i);
        if (end < 0) {
          buf += src.slice(i);
          i = src.length;
          continue;
        }
        buf += src.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out.map((t) => t.trim()).filter(Boolean);
}

// Statements that are noise, or that this engine cannot honour. `begin`/`commit` are replaced by the runner's
// own transaction; `notify pgrst` is PostgREST's cache invalidation and there is no PostgREST here.
const DROPPED = [/^\s*begin\s*$/i, /^\s*commit\s*$/i, /^\s*rollback(\s+to\s+\S+)?\s*$/i, /^\s*notify\s+pgrst\b/i, /^\s*checkpoint\s*$/i];
// Extensions this build does not ship, each replaced by a stub with the same call signature, so a `create
// extension` is not a failure and a `gen_random_uuid()` / `uuid_generate_v4()` still resolves.
const STUBBED_EXTENSIONS = /create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_-]+)"?/i;
const STUBABLE = new Set(["uuid-ossp", "pgcrypto", "pg_stat_statements", "realtime", "vector"]);

const PRELUDE = `
-- idempotent, because PGlite's in-memory instances share one cluster: roles and default privileges are
-- cluster-level, so a second run in the same process must not trip over the first.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
drop schema if exists public cascade;
create schema public;
create schema if not exists extensions;
create schema if not exists auth;
drop table if exists auth.users cascade;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(), is_sso_user boolean default false, banned_at timestamptz
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select '{}'::jsonb $$;
-- what the missing extensions would have provided
create or replace function public.uuid_generate_v4() returns uuid language sql volatile as
  $$ select gen_random_uuid() $$;
create schema if not exists realtime;
create table if not exists realtime.subscriptions (id bigint generated always as identity primary key);
-- THE POINT OF THIS BLOCK: a fresh Supabase project grants ALL to the client roles through default privileges,
-- and every "did the revoke land" assertion in this repository only means anything against that reality.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
`;

let instanceCount = 0;

export async function runOnPglite({ files, log = console.log, probe = null, echoRows = false } = {}) {
  let PGlite;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    return { available: false, ok: false, skipped: true, failures: [], note: "no @electric-sql/pglite (dev dependency) — run `npm ci`" };
  }
  // A fresh directory per run, not the default in-memory mode: PGlite's in-memory instances in one process
  // share a cluster, so `create role` on the second run died with "role anon already exists" — which is a
  // confusing failure for a test suite that runs three of these back to back. os.tmpdir(), never the repo,
  // so a crashed run cannot leave a directory inside a working tree.
  instanceCount++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kicklive-pglite-${process.pid}-`));
  const db = new PGlite({ dataDir: dir });
  const failures = [];
  let executed = 0;
  let stubbed = [];
  try {
    await db.exec(PRELUDE);
    await db.query("begin");
    for (const file of files) {
      const src = fs.readFileSync(path.isAbsolute(file) ? file : path.join(REPO, file), "utf8");
      for (const st of splitStatements(src)) {
        const probe = st.replace(/--[^\n]*/g, "").trim();
        const ext = STUBBED_EXTENSIONS.exec(probe);
        if (ext && STUBABLE.has(ext[1])) {
          stubbed.push(`${file}: create extension ${ext[1]} → stub`);
          continue;
        }
        if (DROPPED.some((re) => re.test(probe.split("\n").pop().trim()))) continue;
        await db.query("savepoint stmt").catch(() => {});
        try {
          const res = await db.query(st);
          await db.query("release savepoint stmt").catch(() => {});
          executed++;
          // `--print` echoes the rows of any statement that returns them, so a *diagnostic* file can be run
          // locally (`npm run db:check`) and not only inside the Supabase editor. Without the flag nothing is
          // printed: 850 statements of migration noise would drown the verdict, and every `select` inside a
          // migration would be reported as if it were an answer.
          if (echoRows) {
            for (const row of res?.rows ?? []) console.log(`  ${JSON.stringify(row)}`);
          }
        } catch (e) {
          await db.query("rollback to savepoint stmt").catch(() => {});
          failures.push({
            file,
            code: e.code,
            message: String(e.message || "").split("\n")[0],
            near: st.replace(/\s+/g, " ").slice(0, 140),
          });
        }
      }
    }
    // An optional probe runs *inside* the same transaction, so a caller can assert on the state the chain
    // produced (an admin row, an ACL) and still leave nothing behind. Failures are reported as failures,
    // with the same shape, so a probe cannot be silently skipped by a caller that forgot to look.
    if (probe) {
      const sqls = Array.isArray(probe) ? probe : [probe];
      for (const one of sqls) {
        // a probe entry is either a SQL string (its rows are echoed) or { run(db) } for an assertion the
        // caller wants made *inside* the transaction — before the rollback that leaves no residue.
        if (one && typeof one.run === "function") {
          try {
            await one.run(db);
          } catch (e) {
            failures.push({ file: "probe", code: "PROBE", message: String(e.message).split("\n")[0] });
          }
          continue;
        }
        if (typeof one === "function") {
          const r = await one(db);
          if (r) failures.push({ file: "probe", code: "PROBE", message: String(r) });
          continue;
        }
        try {
          const rows = (await db.query(one)).rows;
          console.log("  probe:", JSON.stringify(rows));
        } catch (e) {
          failures.push({ file: "probe", code: e.code, message: `probe failed: ${String(e.message).split("\n")[0]}`, near: one.slice(0, 140) });
        }
      }
    }
    await db.query("rollback").catch(() => {}); // nothing is kept; the point is the verdict
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const result = { available: true, ok: failures.length === 0, skipped: false, executed, failures, stubbed };
  if (!has("json")) {
    log(`sql-pglite: ${executed} statements executed, ${failures.length} failure(s)`);
    for (const f of failures.slice(0, 20)) log(`  ${f.file}  [${f.code}] ${f.message}\n      near: ${f.near}`);
    for (const s of stubbed) log(`  note: ${s}`);
    log("  caveat: no PostgREST, no postgresql.conf, stubbed auth/extensions — valid SQL and passing");
    log("         verification blocks, not an application test. See scripts/check-sql.mjs --dsn for that.");
  }
  return result;
}

const DIRECT = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (DIRECT) {
  const one = flag("file");
  const after = flag("after");
  const files = one ? [one] : ["supabase/SETUP.sql"];
  if (after) files.unshift(after);
  const r = await runOnPglite({ files, echoRows: has("print") });
  if (has("json")) console.log(JSON.stringify(r, null, 2));
  process.exit(r.skipped ? 0 : r.ok ? 0 : 1);
}
