#!/usr/bin/env node
/**
 * Apply every migration in `supabase/migrations/` to a real Postgres and then drive the pieces that only a
 * database can prove.
 *
 *   node scripts/check-sql.mjs --dsn postgres://user:***@127.0.0.1:5432/kicklive_scratch
 *   KICKLIVE_SQL_TEST_DSN=postgres://… node scripts/check-sql.mjs --flow
 *   … --skip=flow --keep
 *   … --fresh            recreate the scratch database first (see the comment at the flag: a chain that is
 *                        re-applied onto a database holding later-phase rows reports a defect that is not there)
 *
 * WHY THIS EXISTS. Until it did, the migrations in this repository had only ever been *read*. A text
 * review cannot see the eight classes of defect this file found on its first run (and `tests/unit/sql-shape.test.ts`
 * now pins rules for), all of which are invisible to `tsc`, prettier and the Node test suite:
 *
 *   · a table constraint written `foo_check check (…)` without the `constraint` keyword — a syntax error;
 *   · a regex CHECK using `{2,509}` — Postgres refuses any repetition count above 255, and it refuses it
 *     at the *first insert*, not at CREATE TABLE, so the migration installs and every write then fails;
 *   · `x = any (select arr_col)` — compares a text to a whole text[] row (`operator does not exist`);
 *   · a `;` after a CASE arm inside a plpgsql assignment — closes the statement and leaves the CASE open
 *     ("syntax error at end of input"), which fails the whole migration at CREATE FUNCTION;
 *   · a `%` in a RAISE message with no argument ("too few parameters specified for RAISE");
 *   · `polqual` read from the `pg_policies` *view* instead of `pg_policy`;
 *   · an index asserted by the name Postgres autogenerates (`…_dedupe_key_key`);
 *   · partial-update RPCs that required a column only a creation supplies.
 *
 * WHAT IT IS NOT. It is not the deployment. It runs against a scratch database with a stubbed `auth`
 * schema, no PostgREST, no R2 and no `supabase_admin`; passing here means the SQL is valid SQL and the
 * rules behave, not that the project is configured. Applying to the real Supabase database is still the
 * manual step in docs/PRODUCTION_MIGRATION_PLAN.md.
 *
 * The scratch driver needs a Postgres client. `pg` is not a dependency of this repository (the runtime is
 * a Worker, which has none), so it is resolved dynamically and the whole run SKIPS — loudly, with the
 * command to reproduce — when neither `pg` nor `--psql` is available. CI therefore stays green without a
 * database, and nobody can mistake a skip for a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
/** `--name=value` and `--name value`, because the second form is what people type first. */
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const DSN = opt("dsn") ?? process.env.KICKLIVE_SQL_TEST_DSN ?? "";
const BASELINE = "KICKLIVE_FINAL_SCHEMA.sql";
const MIGRATIONS_DIR = "supabase/migrations";

/** The Supabase-only surface the migrations assume, in the smallest form that lets them run.
 *  `auth.uid()` reads the same GUC PostgREST sets, so an assertion can impersonate a user by
 *  `set request.jwt.claim.sub = '<uuid>'` — which is what makes the RLS and capability tests possible. */
const SUPABASE_STUB = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  encrypted_password text,
  phone text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{"role":"authenticated","provider":"email"}'::jsonb,
  role text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_sign_in_at timestamptz
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function auth.email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '')
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres login; end if;
end $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
`;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

async function loadDriver() {
  // Two attempts, because a bare specifier and a resolved path fail for different reasons: `import("pg")`
  // works when the package is a dependency of this repo (it is not, and will not be — the runtime is a
  // Worker), while CJS resolution honours NODE_PATH, which is how a sandbox or a CI job that installed `pg`
  // somewhere else can still run this without touching package.json.
  try {
    const mod = await import("pg");
    return { kind: "pg", pg: mod.default ?? mod };
  } catch {
    /* try the resolver below */
  }
  try {
    const resolved = createRequire(import.meta.url).resolve("pg");
    const mod = await import(pathToFileURL(resolved).href);
    return { kind: "pg", pg: mod.default ?? mod };
  } catch {
    return { kind: "psql" };
  }
}

function migrationFiles() {
  return fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `${MIGRATIONS_DIR}/${f}`);
}

/** Maps a parser `position` onto a line number, so a failure names the place rather than the file. */
function lineOf(source, position) {
  if (!position) return null;
  return source.slice(0, Number(position)).split("\n").length;
}

function excerpt(source, line, before = 4, after = 2) {
  if (!line) return "";
  const rows = source.split("\n");
  return rows
    .slice(Math.max(0, line - 1 - before), line + after)
    .map((l, i) => `   ${String(Math.max(0, line - before) + i).padStart(5)} | ${l}`)
    .join("\n");
}

async function runPsql(dsn, sql) {
  const res = spawnSync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-q", "--single-transaction"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || "psql failed").trim());
  return { rows: [] };
}

async function main() {
  const files = [BASELINE, ...migrationFiles()];
  const driver = await loadDriver();

  if (driver.kind === "psql" && !opt("psql") && !flag("psql")) {
    console.log(
      [
        "SKIP  no way to reach Postgres.",
        "",
        `      This checker needs either the \`pg\` package (npm i --no-save pg) or a psql binary,`,
        `      plus a scratch database: createdb kicklive_scratch, then`,
        "",
        `        node scripts/check-sql.mjs --dsn postgres://$(whoami)@127.0.0.1:5432/kicklive_scratch`,
        "",
        "      It is deliberately not a hard dependency: the runtime is a Cloudflare Worker, which has",
        "      no database driver at all. Do not treat this SKIP as a pass — see docs/PRODUCTION_MIGRATION_PLAN.md.",
      ].join("\n"),
    );
    return 0;
  }

  if (!flag("allow-any-database") && !/(scratch|test|ci|local)/i.test(DSN)) {
    throw new Error(
      `refusing to run against ${DSN || "(no DSN)"}: the DSN must name a scratch database (its text has to contain ` +
        `"scratch", "test", "ci" or "local") unless --allow-any-database is passed. This script applies migrations and ` +
        `writes rows; pointing it at production is how a check becomes an incident.`,
    );
  }

  if (flag("fresh") && driver.kind !== "pg") {
    // The psql path shells out one transaction per statement and never holds a session, so it has no way to
    // release the database it is about to drop — and it runs no flow either, which makes a reset there a
    // wipe with nothing behind it. Name the missing dependency instead of failing inside a constructor.
    throw new Error("--fresh needs the `pg` driver (npm i --no-save pg); create the scratch database by hand for --psql runs");
  }

  if (flag("fresh") && flag("allow-any-database")) {
    // Two flags that should never meet. `--allow-any-database` exists so a reviewer can point the *apply*
    // passes at something unusual; `--fresh` drops a database. Keeping them apart means the destructive half
    // of this tool is always governed by the name check, with no combination that opts out of it.
    throw new Error("--fresh and --allow-any-database are mutually exclusive: a flag that drops a database only runs against a scratch name");
  }
  if (flag("fresh")) {
    // WHY THIS EXISTS. The rerun pass re-applies every migration, and Phase 7's swap of
    // `media_assets_kind_check` is a drop-and-re-add to *its* nine-kind list, which Phase 8 then widens to
    // ten. On a database left holding a `sponsors` asset row — the usual debris of a flow run that aborted
    // before its cleanup — Phase 7's rerun fails for a reason that is not a defect anywhere. The alternative
    // fixes were worse: narrowing Phase 8 to dodge it, or editing a committed migration whose production
    // apply already happened and will never be replayed. A scratch database is supposed to be scratchable,
    // so the checker is given a way to say that out loud. It is opt-in, because destroying a database is
    // never a default, and it runs after the name check above, which is what bounds it.
    const url = new URL(DSN);
    const dbname = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!dbname) throw new Error(`--fresh needs a database name in the DSN, got ${DSN}`);
    const { Client } = driver.pg;
    const admin = new Client({ connectionString: new URL(`${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`).href });
    await admin.connect();
    // `with (force)` (PG13+) because this script's own previous session may still be holding the database,
    // and "drop the scratch database" that quietly fails with "is being used by another user" is the worst
    // possible outcome of a flag whose entire job is to remove state.
    // Quoted, and doubled quotes escaped, because a database name is an identifier and `drop database` takes
    // no parameter: the only safe form is one the parser cannot reinterpret.
    const quoted = `"${dbname.replace(/"/g, '""')}"`;
    await admin.query(`drop database if exists ${quoted} with (force)`);
    await admin.query(`create database ${quoted}`);
    await admin.end();
    console.log(`ok    fresh: recreated database ${dbname}`);
  }

  let client = null;
  const query = async (sql) => {
    if (client) return client.query(sql);
    return runPsql(DSN, sql);
  };
  if (driver.kind === "pg") {
    if (!DSN) throw new Error("--dsn or KICKLIVE_SQL_TEST_DSN is required when a driver is installed");
    const { Client } = driver.pg;
    client = new Client({ connectionString: DSN });
    await client.connect();
    await client.query("set session_preparation_mode = 'simple'").catch(() => {});
  }

  let failed = 0;
  const step = async (label, sql, options = {}) => {
    try {
      await query(`set check_function_bodies = ${options.bodies === "on" ? "on" : "off"};`);
      await query(sql);
      console.log(`ok    ${label}`);
    } catch (error) {
      failed += 1;
      const message = error.message ?? String(error);
      const line = lineOf(sql, error.position);
      console.log(`FAIL  ${label}: ${message.split("\n")[0]}${line ? ` (near line ${line})` : ""}`);
      if (line) console.log(excerpt(sql, line));
      if (error.where) console.log(`      context: ${String(error.where).split("\n")[0]}`);
      // A failed file leaves the session's transaction aborted, and every statement after it would fail
      // for that reason alone: a checker that reports one failure and nine knock-ons is worse than one
      // that misses the bug, because the nine look like the finding. Roll back first, then keep going.
      await query("rollback").catch(() => {});
    }
  };

  if (!flag("skip=stub")) await step("stub: auth schema and roles", SUPABASE_STUB);
  for (const file of files) {
    if (flag("skip=baseline") && file === BASELINE) continue;
    await step(`apply   ${file}`, read(file), { bodies: "off" });
  }
  // Second pass, bodies ON: idempotence, and every `language sql` body gets parsed AND name-resolved
  // against the real catalog — the closest thing to a type-check the SQL has.
  for (const file of files) {
    await step(`rerun   ${file}`, read(file), { bodies: "on" });
  }
  if (!flag("skip=flow")) {
    // Both flows in one session: the admin flow leaves the catalog in a state the sponsorship flow reads,
    // and importing the module twice would be a second copy of the same fixtures running in an order nobody
    // chose. Each returns its own failure count and both are added, so a red run says how red.
    const { runFlow, runSponsorshipFlow } = await import(path.join(ROOT, "scripts", "sql-flow.mjs"));
    const admin = await runFlow({ query, log: console.log });
    const sponsor = await runSponsorshipFlow({ query, log: console.log });
    failed += admin.failed + sponsor.failed;
  }
  // No cleanup by default, and no `drop schema public cascade` ever: this script is pointed at a DSN by
  // hand, and a checker that destroys a schema it was pointed at is a worse instrument than one that
  // leaves a scratch database behind. `dropdb` is one command away for whoever made it.
  if (client) await client.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} step(s) failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
