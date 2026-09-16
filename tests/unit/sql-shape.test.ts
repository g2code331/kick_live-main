/**
 * Static rules every `kicklive_*` migration must obey — each one is a bug that was actually shipped and then
 * found by applying the files to a real Postgres.
 *
 * The honest framing: these are *text* assertions over SQL, and a text assertion cannot prove SQL is valid.
 * What they can do is refuse the shapes that Postgres accepts at parse time and fails at *first evaluation*,
 * which is the class that hid longest: `text(3)` (a type with no modifier), a CHECK containing a subquery, a
 * regex with `{2,509}` (Postgres' RE_DUP_MAX is 255, so the expression compiles and then every insert throws
 * `invalid regular expression`), a `RAISE` whose format string has more `%` than it has arguments. None of
 * those fail `supabase db push`. All of them are visible in the text if you look for the shape rather than
 * the meaning.
 *
 * `node scripts/check-sql.mjs` is the real check — it applies every file to a Postgres with
 * `check_function_bodies = on` and re-runs them for idempotence — and this file is the cheap layer that runs
 * in CI where no database exists. The SKIP message in that script is deliberately loud, because a checker
 * that silently does nothing is worse than no checker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(REPO, "supabase/migrations");
const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
assert.ok(files.length >= 5, "the migration directory should not be empty");

/** Strips `--` line comments and `/* … *\/` blocks, so a rule about executable SQL is not answered by prose. */
const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const SOURCE: Record<string, string> = Object.fromEntries(files.map((f) => [f, code(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))]));

/** Every statement in the file, split on `;` at the top level — enough granularity to bind a name to its drop. */
function statements(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let dollarTag = "";
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) {
        dollarTag = "";
        i += dollarTag.length;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      current += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[a-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length - 1;
        continue;
      }
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

describe("migrations · the shapes Postgres forgives and then punishes", () => {
  it("no `create trigger` without an earlier `drop trigger if exists` for the same name", () => {
    // Idempotence, and it is not a formality: `supabase db reset`, a staging database built from this directory
    // twice, and a retried partial deploy all re-run a file. Postgres has no `create or replace trigger`, so
    // the second run would fail — or worse, in a file that drops by a *different* name, leave two triggers
    // firing where one was intended.
    for (const [file, text] of Object.entries(SOURCE)) {
      const dropped = new Set<string>();
      for (const stmt of statements(text)) {
        const drop = /^drop trigger if exists ([\w]+) on ([\w.]+)/i.exec(stmt);
        if (drop) dropped.add(`${drop[1]!.toLowerCase()}@${drop[2]!.toLowerCase()}`);
        // `ON <table>` is not next to the name: Postgres puts the timing and the event list between them
        // (`create trigger x before insert or update on public.t for each row …`), so the table is found by
        // scanning forward. A regex anchored on `trigger NAME on` matches nothing at all in real files — which
        // is the worst outcome a lint can have, because it reports the rule as satisfied.
        const create = /^create (?:or replace )?(?:constraint )?trigger (\w+)\b[\s\S]*?\bon\s+([\w.]+)/i.exec(stmt);
        if (create) {
          const key = `${create[1]!.toLowerCase()}@${create[2]!.toLowerCase()}`;
          assert.ok(dropped.has(key), `${file}: trigger ${key} is created without a preceding "drop trigger if exists"`);
        }
      }
    }
  });

  it("every policy created is also dropped by its own name somewhere in the file", () => {
    // Phase 5 dropped Phase 1's `"notifications: public read"` and created `"notifications: owner or broadcast
    // read"`, which is correct on a fresh install and dies on the second (`policy … already exists`). A file
    // that retires a policy by the *old* name still has to be able to re-apply its own.
    for (const [file, text] of Object.entries(SOURCE)) {
      const created = [...text.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]!);
      const dropped = new Set([...text.matchAll(/drop policy if exists "([^"]+)"/g)].map((m) => m[1]!));
      for (const name of created) assert.ok(dropped.has(name), `${file}: policy "${name}" is created but never dropped by that name`);
    }
  });

  it("a named constraint is dropped before it is added", () => {
    for (const [file, text] of Object.entries(SOURCE)) {
      const dropped = new Set([...text.matchAll(/drop constraint if exists (\w+)/g)].map((m) => m[1]!.toLowerCase()));
      for (const m of text.matchAll(/add constraint (\w+)/g)) {
        assert.ok(dropped.has(m[1]!.toLowerCase()) || /create table/i.test(file), `${file}: constraint ${m[1]} is added without a preceding drop`);
      }
    }
  });

  it("`text` takes no modifier, and a length bound belongs in a CHECK", () => {
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/\btext\((\d+)\)/g)) {
        assert.fail(`${file}: "text(${m[1]})" is not a type in Postgres — it is varchar(${m[1]}) or plain text plus a length CHECK`);
      }
    }
  });

  it("no CHECK constraint contains a subquery or a clock", () => {
    // A CHECK may not contain a subquery at all (`column "x" does not exist` style errors at CREATE TIME, which
    // is at least loud) and *may* call `now()` — which is silent, because a CHECK is only evaluated on write, so
    // "ends_at is in the future" would freeze the value of the moment into permanent truth. Both are refused.
    const banned = /\b(select\s+|exists\s*\(\s*select|now\s*\(\s*\)|current_date|current_timestamp|clock_timestamp|localtimestamp)/i;
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/constraint (\w+[_a-z]*)\s+check \(/gi)) {
        const name = m[1]!;
        let i = (m.index ?? 0) + m[0].length;
        let depth = 1;
        while (i < text.length && depth > 0) {
          if (text[i] === "(") depth += 1;
          if (text[i] === ")") depth -= 1;
          i += 1;
        }
        const body = text.slice((m.index ?? 0) + m[0].length, i - 1);
        assert.ok(!banned.test(body), `${file}: constraint ${name} reads the clock or another table: ${body.slice(0, 120)}`);
      }
    }
  });

  it("an expression UNIQUE is an index, never a constraint", () => {
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/unique\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
        const inner = m[1]!;
        if (/[a-z_]+\s*\(/i.test(inner)) {
          assert.fail(`${file}: unique (${inner.slice(0, 80)}) is an expression index — write "create unique index" instead; a UNIQUE constraint takes columns only`);
        }
      }
    }
  });

  it("no SQL regex repeats more than 255 times", () => {
    // The one that cost the most: `{2,509}` compiled fine, installed fine, and threw
    // `invalid regular expression: invalid repetition count(s)` on the first insert that evaluated it.
    // Postgres' RE_DUP_MAX is 255, and it is checked at parse-of-expression time, which is *evaluation* for a
    // CHECK or a function body. The bound belongs in a `char_length` predicate.
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
        const upper = m[2] === undefined ? Number(m[1]) : Number(m[2]);
        assert.ok(upper <= 255, `${file}: regex repetition {${m[1]},${m[2] ?? ""}} exceeds Postgres' RE_DUP_MAX (255); put the length bound in char_length()`);
      }
    }
  });

  it("privilege checks take the role first", () => {
    // `has_function_privilege(function, privilege, role)` reads naturally and is wrong: every `has_*_privilege`
    // takes (role, object, privilege). Inverted, the call usually raises — but inside a `do $$ … $$` verify
    // block that only runs on a real deploy, and only when bodies are parsed, which `db push` does not do.
    const firstArg = /^\s*(?:has_(?:function|table|column|schema|any_privilege|database)_privilege)\s*\(\s*([^,)]+)/gim;
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(firstArg)) {
        const arg = m[1]!.trim().toLowerCase();
        const roleish = /^(?:'|::)|^(?:anon|authenticated|service_role|postgres|supabase_admin)\b|^(?:'anon'|'authenticated'|'service_role'|v_role|v_grantee|current_user|session_user|p_role)/;
        assert.ok(
          roleish.test(arg) || /^v_/.test(arg) || /^(?:current|session)_user/.test(arg),
          `${file}: a privilege check's first argument is \`${arg}\`, which is not a role — the order is (role, object, privilege)`,
        );
      }
    }
  });

  it("a RAISE's format specifiers and arguments agree", () => {
    // `raise exception 'a % uses b'` with one argument is fine; with a stray `%` and no argument it is
    // `too few parameters specified for RAISE`, raised when the body is compiled. Same fix class as the regex:
    // a literal that has to be written as `%%`, or the placeholder removed.
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/\braise\s+(?:exception|warning|notice|info|log|debug1|debug2|debug3|debug4|debug5|fatal)\s+(?=')/gi)) {
        // Postgres concatenates adjacent string literals — including across newlines — into one format
        // string, so a RAISE message may be written as several quoted fragments before the `,` argument
        // list or the `USING`/`;` terminator. Walk from the first quote collecting every fragment (and the
        // whitespace between them) so the specifier count is taken over the WHOLE message, and the argument
        // list is read from what follows the last fragment. Counting only the first fragment is a false
        // positive on a long multi-line message whose `%` args sit after the continuation lines.
        const start = (m.index ?? 0) + m[0].length;
        let i = start;
        let combined = "";
        for (;;) {
          const frag = /^'((?:[^']|'')*)'/.exec(text.slice(i));
          if (!frag) break;
          combined += frag[1];
          i += frag[0].length;
          const gap = /^\s*/.exec(text.slice(i))![0];
          if (text[i + gap.length] === "'") {
            i += gap.length;
            continue;
          }
          break;
        }
        const specifiers = (combined.match(/(?:^|[^%])%[sILNO]?/g) ?? []).length;
        if (specifiers === 0) continue;
        const rest = text.slice(i);
        const argList = /^\s*,/.test(rest)
          ? rest
              .slice(rest.indexOf(",") + 1)
              .split(/;|\busing\b/i)[0]!
              .trim()
          : "";
        const args = argList && argList.length > 0 ? argList.split(",").filter((a) => a.trim().length > 0).length : 0;
        assert.ok(
          args >= specifiers,
          `${file}: a RAISE format has ${String(specifiers)} specifier(s) and ${String(args)} argument(s) — Postgres raises "too few parameters specified for RAISE" when the body compiles`,
        );
      }
    }
  });

  it("no array variable is extended with `||` and a bare literal", () => {
    // `v_missing := v_missing || 'x'` where `v_missing` is a `text[]` resolves the unknown literal as a second
    // *array* and dies with `malformed array literal: "x"`. Append with `array_append`, or cast the element.
    for (const [file, text] of Object.entries(SOURCE)) {
      const arrays = new Set<string>();
      for (const m of text.matchAll(/\b(v_\w+)\s+(?:[\w.]+\s*)?text\[\]/g)) arrays.add(m[1]!.toLowerCase());
      for (const m of text.matchAll(/\b(v_\w+)\s*(?::=|:=)\s*\1\s*\|\|\s*'[^']*'/g)) {
        // Only a text[] misbehaves here — `v := v || 'x'` on a plain `text` is ordinary string
        // concatenation and correct. Restrict the failure to variables actually declared `text[]`, or a
        // scalar accumulator like phase-12's `v_bad text := ''` is a false positive.
        if (arrays.has(m[1]!.toLowerCase())) {
          assert.fail(`${file}: ${m[1]} is appended to with || 'literal'; for a text[] that means "malformed array literal" — use array_append(${m[1]}, …)`);
        }
      }
      for (const m of text.matchAll(/\b(v_\w+)\s*\|\|\s*'/g)) {
        if (arrays.has(m[1]!.toLowerCase())) {
          assert.fail(`${file}: ${m[1]} is a text[] combined with || '…'; use array_append(${m[1]}, …) or cast the element to ${m[1]}'s array type`);
        }
      }
    }
  });

  it("a `select … = any (subquery)` never compares against an array column", () => {
    // `x = any ((select p.allowed_formats from …))` looks like "is x in that array" and is not: the subquery is
    // a *row* whose single column is an array, so Postgres resolves `= any` against a set of rows and raises
    // `operator does not exist: text = text[]`. Unnest it, or join and negate.
    for (const [file, text] of Object.entries(SOURCE)) {
      for (const m of text.matchAll(/=\s*any\s*\(\s*\(?\s*select\s+([\w.]+)/gi)) {
        const selected = m[1]!.toLowerCase();
        assert.ok(!/\.?(allowed_formats|tags|_ids|keys)$/.test(selected), `${file}: "= any (select ${m[1]})" compares a scalar to an array column; use unnest() or a join`);
      }
    }
  });

  it("every definer function pins its search_path", () => {
    for (const [file, text] of Object.entries(SOURCE)) {
      const bodies = [...text.matchAll(/create or replace function public\.(\w+)[\s\S]{0,900}?as\s+\$/g)].map((m) => m[1]!);
      for (const name of bodies) {
        const start = text.indexOf(`create or replace function public.${name}(`);
        const header = text.slice(start, text.indexOf("$", start));
        if (!/security\s+definer/i.test(header)) continue;
        assert.ok(
          /set\s+search_path\s*=/i.test(header),
          `${file}: ${name} is SECURITY DEFINER without SET search_path, which makes an unqualified name resolvable by whoever can write to a schema on the path`,
        );
      }
    }
  });

  it("a migration that creates a table also grants it away deliberately", () => {
    // Not a syntax rule — a reminder-shaped rule, and the class of bug the phase-7 grant loop was written to
    // avoid: a `revoke all` with no matching grant leaves a function able to run and unable to read, which is a
    // runtime 42501 on the first user request, invisible to every static tool in the repo.
    for (const [file, text] of Object.entries(SOURCE)) {
      if (!/^2026\d+_(phase[5678])/.test(file)) continue;
      const created = [...text.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]!);
      const mentioned = new Set([...text.matchAll(/grant[^;]*on table public\.(\w+)/g)].map((m) => m[1]!.toLowerCase()));
      for (const table of created) {
        assert.ok(mentioned.has(table.toLowerCase()) || /revoke all on table public\./.test(text), `${file}: table ${table} is created with no grant or revoke over it`);
      }
    }
  });
});

describe("the SQL checker is wired in, not decorative", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  it("npm run check:sql exists and points at the script", () => {
    assert.ok(pkg.scripts?.["check:sql"]?.includes("scripts/check-sql.mjs"), "package.json must expose the checker as a script, or it is a file nobody runs");
  });
  it("the checker skips loudly rather than quietly", () => {
    const source = fs.readFileSync(path.join(REPO, "scripts/check-sql.mjs"), "utf8");
    assert.match(source, /SKIP/, "a checker with no database must say SKIP in its output");
    assert.match(source, /nothing was executed, so this remains a SKIP/, "and must say what the fallback did not cover");
    assert.match(source, /refusing to run against/, "and must refuse a DSN that does not look like a scratch database");
  });

  it("a SKIP still executes what a local engine can execute", () => {
    // Three privilege defects in this repository were invisible to every static check and only appeared when a
    // human pasted the bundle into the Supabase editor. `check:sql` used to answer that situation with "SKIP"
    // and a exit-0; now it runs the chain on PGlite first, so a machine without a database still executes SQL
    // instead of only reading it. A fallback that quietly became a full pass would be worse than the SKIP, so
    // the skip text, the caveat and the non-zero exit on failure are all pinned here.
    const checker = fs.readFileSync(path.join(REPO, "scripts/check-sql.mjs"), "utf8");
    assert.match(checker, /await import\("\.\/sql-pglite\.mjs"\)/, "the skip branch must run the local engine");
    assert.match(checker, /return local\.ok \? 0 : 1/, "and its verdict must reach the exit code");
    const local = fs.readFileSync(path.join(REPO, "scripts/sql-pglite.mjs"), "utf8");
    assert.match(local, /alter default privileges in schema public grant all on tables/, "the run is meaningless without Supabase\'s default ALL grants");
    assert.match(local, /no PostgREST|Not a Supabase project|no PostgREST/i, "and it must say what it is not");
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.ok(pkg.scripts?.["sql:run"]?.includes("sql-pglite"), "npm run sql:run must expose the runner on its own");
    assert.ok(pkg.devDependencies?.["@electric-sql/pglite"], "the engine must be a declared dev dependency, not an ad-hoc install");
  });
  it("the behavioural flow is a repo file, not a scratch one", () => {
    assert.ok(fs.existsSync(path.join(REPO, "scripts/sql-flow.mjs")), "the flow that exercises save/refuse/serve paths belongs in the repo");
    const flow = fs.readFileSync(path.join(REPO, "scripts/sql-flow.mjs"), "utf8");
    assert.ok(flow.includes("kicklive_ad_serve") && flow.includes("kicklive_ad_record_event"), "the flow must cover the two public functions by name");
  });
});

describe("privilege assertions in the migrations read the catalog, not the superuser shortcut", () => {
  // This rule exists because of a real paste. `supabase/SETUP.sql` into the Supabase SQL editor runs as a
  // superuser, and `has_column_privilege()` / `has_table_privilege()` / `has_function_privilege()` answer
  // "true" for a superuser (and for the owner of the object) no matter what was revoked. So the Phase 1
  // self-check raised `hardening failed: authenticated can still update profiles.role directly` on a
  // database where that revoke had landed perfectly — and, far worse, the same class of function made every
  // POSITIVE assertion in these files pass while checking nothing at all. A verifier that cannot fail is
  // how three phases of privilege work went unproven.
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("no executable SQL asks a has_*_privilege() function what a grant is", () => {
    const offenders: string[] = [];
    for (const f of ["KICKLIVE_FINAL_SCHEMA.sql", ...files.map((x) => `supabase/migrations/${x}`)]) {
      const body = code(fs.readFileSync(path.join(REPO, f), "utf8"));
      body.split("\n").forEach((line, i) => {
        if (/has_(column|table|function)_privilege\s*\(/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 96)}`);
        }
      });
    }
    assert.deepEqual(offenders, [], "privilege assertions must read relacl/proacl via public.kicklive_has_grant; see the note in the Phase 1 hardening migration");
  });

  it("the grant reader exists, is callable by anyone, and answers from the ACL", () => {
    const p1 = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260909120000_phase1_security_hardening.sql"), "utf8");
    assert.match(p1, /create or replace function public\.kicklive_has_grant\(/, "the helper is defined in the first migration, before anything uses it");
    assert.match(p1, /grant execute on function public\.kicklive_has_grant\(text, text, text, text\) to public;/, "a verifier an operator cannot call is a verifier that reports nothing");
    // The needles name the helper's own shapes rather than `pg_catalog.`-qualified spellings: the helper pins
    // `set search_path = pg_catalog`, so every catalog reference inside it is deliberately unqualified.
    assert.match(p1, /select c\.relacl into v_rel_acl\s+from pg_class/, "it reads pg_class.relacl");
    assert.match(p1, /join aclexplode\(/, "and pg_proc.proacl / pg_attribute.attacl through aclexplode — no has_*_privilege anywhere");
    assert.ok((p1.match(/aclexplode\(/g) ?? []).length >= 4, "each of the four ACL paths (function, table, table-wide-covers-column, column) explodes its own ACL");
    assert.match(p1, /if v_rel_acl is null then\s*\n\s*return false;/, "a NULL ACL (owner-only) must answer false for non-owners, not error");
  });

  it("the helper reads real catalog columns, in the place the privileges actually live", () => {
    // Written after two failed attempts, both of them invisible to every check this repository has: first the
    // superuser shortcut, then a join on `g.objid`, a column `aclexplode()` does not expose. Neither could be
    // found without a Postgres, and there is no Postgres between writing this SQL and applying it in a
    // dashboard — so the shape rules below are that missing database, and they are deliberately strict about
    // names rather than about behaviour.
    const p1 = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260909120000_phase1_security_hardening.sql"), "utf8");
    const body = p1.slice(p1.indexOf("create or replace function public.kicklive_has_grant("), p1.indexOf("$hg$;\n"));
    assert.ok(body.length > 200, "the helper body must be findable — if the dollar-quote tag changed, update this test and the comment explaining why");

    for (const bad of ["objid", "privtype", "is_grantable", "aclvisible", "grantor_oid", "colid"]) {
      assert.ok(!new RegExp(`g\\.${bad}\\b`).test(body), `aclexplode() has no \${bad} column — its output is grantor, grantee, privilege_type, is_grantable, and nothing else`);
    }
    for (const good of ["g.grantee", "g.privilege_type"]) {
      assert.ok(body.includes(good), `the helper must read ${good} from aclexplode, not re-derive it`);
    }

    // A per-column GRANT is stored on the column, not as a marked-up entry on the table: asking relacl alone
    // about a column answers "not granted" whatever the truth is.
    assert.match(body, /from pg_attribute/i, "column privileges live in pg_attribute.attacl; the helper must consult it");
    assert.match(body, /attacl/i, "and it must name the column it reads");
    assert.ok(/not found/.test(body) && /attisdropped/.test(body), "a column that is not there answers false, and a dropped one is not a column");

    // A helper that returns false for an unresolvable name certifies a typo'd revoke as hardened.
    assert.match(body, /raise exception[^;]*matches neither a relation nor a function identity/, "an unknown p_object must raise, not answer false");

    // `set search_path = pg_catalog` is not decoration here: the helper runs inside every verify block, and a
    // role able to create a `pg_roles` in an earlier path schema would otherwise decide what every assertion sees.
    assert.match(body, /set search_path = pg_catalog/, "catalog readers pin their own search_path");
  });

  it("every call site asks with a code the object kind can hold", () => {
    // 'U' on a table column was the second bug: USAGE is a sequence/function letter, so the join matched no
    // aclitem and the assertion could not fire for any reason at all. A code that cannot exist is not a false
    // check, it is no check.
    const CODES = { rel: "arwdDxt", seq: "rwU", func: "X" };
    const offenders: string[] = [];
    for (const f of fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const executable = raw
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      for (const m of executable.matchAll(/kicklive_has_grant\(\s*'[^']+'\s*,\s*'([^']+)'\s*,\s*'([^']*)'/g)) {
        const kind = m[1].includes("(") ? "func" : /_(?:seq|sequences)$/.test(m[1]) ? "seq" : "rel";
        if (!CODES[kind].includes(m[2])) offenders.push(`${f}: ${m[1]} asked with '${m[2]}' — a ${kind} holds [${CODES[kind].split("").join(" ")}]`);
      }
    }
    assert.deepEqual(offenders, [], "privilege codes must match the object kind, or the check passes without looking");
  });

  it("the privilege value compared with aclexplode is a long name, never an ACL letter", () => {
    // The bug this rule exists for. aclexplode() reports privilege_type as a LONG name (EXECUTE, SELECT,
    // UPDATE), while r a w d D x t U X are the codes used by acldefault() and by GRANT/REVOKE text. A
    // comparison of the two matches nothing, for any role, which reads as "not granted": every NEGATIVE
    // assertion in nine migrations passed while checking nothing, and the single POSITIVE one in phase 3
    // failed the apply. That failure is the only reason anyone found it. The helper now takes a letter (so
    // a call site still reads like the GRANT above it) and translates it here, where the set of legal
    // names is knowable - and raises on an argument that is neither a letter nor a name.
    const NAMES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "USAGE", "EXECUTE"];
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("--")) return;
        const m = /privilege_type\s*=\s*'([^']{1,3})'/.exec(line);
        if (m && !NAMES.includes(m[1]!)) offenders.push(f + ":" + (i + 1) + " compares privilege_type to a value no ACL can hold: " + m[1]);
      });
    }
    assert.deepEqual(offenders, [], "privilege_type may only be compared with a name aclexplode can report; the letters belong in kicklive_has_grant");

    const p1 = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260909120000_phase1_security_hardening.sql"), "utf8");
    const body = p1.slice(p1.indexOf("create or replace function public.kicklive_has_grant("), p1.indexOf("$hg$;"));
    // every long name must be reachable from the translation, and every branch of the helper must filter
    // through it - a branch left comparing the raw argument is the same bug in one path instead of four.
    const quote = String.fromCharCode(39); // an SQL string literal's delimiter, without escaping noise here
    const missing = NAMES.filter((n) => !body.includes(quote + n + quote));
    assert.deepEqual(missing, [], "the helper must be able to produce every privilege name aclexplode reports here");
    const executable = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n"); // aclexplode is named in the prose above the helper; only code can compare to it
    const branches = (executable.match(/aclexplode\(/g) ?? []).length;
    const viaNames = (executable.match(/privilege_type = any\s*\(v_names\)/g) ?? []).length;
    assert.ok(branches >= 4, "four ACL paths expected: function, table, table-wide-covers-column, column");
    assert.equal(viaNames, branches, "every aclexplode branch must compare the translated name set, not the argument");
    assert.match(body, /raise exception\s*'kicklive_has_grant: % is neither/, "an unrecognised privilege argument must raise, not answer false");
  });

  it("a positive assertion in a verify block exists at all, because negatives cannot prove a translation", () => {
    // Every hardening assertion is `if granted then raise` — with a broken comparison all of them hold while
    // nothing is true. The migrations therefore need at least one `if not granted then raise`, which is the
    // shape that fails loudly when the privilege read stops matching reality. Phase 3 has one per client-facing
    // RPC; that is deliberate and must stay.
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const positives: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const n = (text.match(/if not public\.kicklive_has_grant\(/g) ?? []).length;
      if (n) positives.push(`${f}:${n}`);
    }
    assert.ok(positives.length >= 2, `expected a positive "is it really granted?" assertion in more than one phase, saw ${positives.join(" ")}`);
    // and each must be paired with a raise, or it is a no-op expression statement: the failure mode is
    // someone turning `if not granted then raise` into `v_x := kicklive_has_grant(...)` and the assertion
    // vanishing while the suite still finds the call. What the message says is the author's business.
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      for (const m of text.matchAll(/if not public\.kicklive_has_grant\([\s\S]{0,400}?\) then/g)) {
        const tail = text.slice(m.index, m.index + m[0].length + 260);
        // The direct form is `if not granted then raise exception …`. The accumulate form — used where a phase
        // wants to report EVERY missing grant in one message rather than abort on the first — is
        // `if not granted then v_x := v_x || ' name'; end if;` followed later by `raise exception '…:%', v_x`.
        // Both end in a raise, so both are real assertions; only a bare `v_x := kicklive_has_grant(…)` with no
        // branch and no raise (the degradation this guards against) is not.
        let ok = /raise exception/.test(tail);
        if (!ok) {
          const acc = /then\s+(v_\w+)\s*:=\s*\1\s*\|\|/.exec(tail);
          if (acc) {
            ok = new RegExp(`raise\\s+exception[\\s\\S]*\\b${acc[1]!}\\b`).test(text);
          }
        }
        assert.ok(ok, `${f}: a positive assertion with no raise is not an assertion`);
      }
    }
  });
  it("a `from public` revoke never stands alone where the same file grants a client role", () => {
    // The second half of the same bug: revoking from PUBLIC does not remove the anon/authenticated aclitem
    // entries Supabase's default privileges create. Where a file grants a client role execute, the revoke
    // must name that role (the grant then puts it back on purpose); where a file grants nobody, the revoke
    // is left alone so trigger functions and internal helpers keep working for the role that fires them.
    const missing: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const granted = new Map<string, Set<string>>();
      for (const m of raw.matchAll(/grant\s+execute\s+on\s+function\s+(?:public\.)?(\w+)\s*(?:\([^;]*?\))?\s+to\s+([^;]+);/gi)) {
        const set = granted.get(m[1]!.toLowerCase()) ?? new Set<string>();
        for (const r of m[2]!.matchAll(/[a-z_]+/g)) set.add(r[0]!.toLowerCase());
        granted.set(m[1]!.toLowerCase(), set);
      }
      raw.split("\n").forEach((line, i) => {
        const m = /^(?:\s*)?revoke all on function (?:public\.)?([\w]+)\s*(?:\([^;]*\))? from public;$/.exec(line.trim());
        if (!m || m[1] === "kicklive_has_grant") return;
        const roles = granted.get(m[1]!.toLowerCase());
        if (!roles) return;
        const unremoved = ["anon", "authenticated"].filter((r) => roles.has(r));
        if (unremoved.length) missing.push(`${f}:${i + 1} ${m[1]} — granted to ${unremoved.join("/")} but revoked only from PUBLIC`);
      });
    }
    assert.deepEqual(missing, [], "a `revoke … from public` leaves the client roles' own grants in place; name them");
  });
});

describe("the worker editor mirror is an extends, never a copy of the options", () => {
  // `workers/tsconfig.json` exists only so a language service opened under `workers/` resolves the same program the
  // build does. When it re-listed `lib`/`types` itself, the editor could not resolve the `types` entry from inside
  // `workers/` (type reference directives search `<config dir>/node_modules/@types` first) and reported "Cannot find
  // type definition file for '@cloudflare/workers-types'" on a config the build was passing. Extending the build's
  // own file means there is exactly one list of options, and the editor cannot drift from a config that is already
  // checked in CI.
  const mirror = JSON.parse(fs.readFileSync(path.join(REPO, "workers/tsconfig.json"), "utf8"));
  assert.equal(mirror.extends, "../tsconfig.workers.json", "the mirror must extend the build config, not restate it");
  assert.ok(!("compilerOptions" in mirror), "compilerOptions here would be a second source of truth for the Worker program");
  assert.deepEqual(mirror.include, ["src"], "and it adds nothing but the include, so tsc -p on it checks the same files");
});

describe("the admin bootstrap refuses to guess who the admin is", () => {
  // Every rule here is a guard that exists because a one-paste admin grant is the most expensive file in the
  // repository. The first version hardcoded a real address and a UUID and blindly upserted `role = 'admin'`;
  // the second version asked the operator to paste an address into an editor whose markdown autolinking turns
  // `a@b.com` into `[a@b.com](mailto:a@b.com)`, which used to fail as "no such user" (or, worse, match nothing
  // and be re-run against a different row). So: the placeholder must be unfilled-able-to-something-real, the
  // markdown shape must be caught by name, and no identity may ever be committed.
  // `code()` on purpose: this file explains in its own header what it no longer does, and a rule about
  // executable SQL must not be answered by prose (the header mentions the deleted ON CONFLICT … DO UPDATE).
  const sql = code(fs.readFileSync(path.join(REPO, "CREATE_ADMIN_PROFILE.sql"), "utf8"));

  it("it is a reviewed bootstrap, not a bundle member, and it never upserts a role blindly", () => {
    // Both inputs default to NULL, and no comparison against a sentinel string exists any more. That was a
    // real failure, not a stylistic one: the previous version used the literal
    // 'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL' as both the placeholder *and* the sentinel to compare against,
    // so an operator whose real address happened to be that string was refused as "unedited". A sentinel can
    // collide with the value it is standing in for; null cannot, and "does this account exist" is a question
    // auth.users answers exactly — so existence is the only test, and the file has nothing to overwrite.
    assert.match(sql, /p_email\s+text\s*:=\s*null/, "no placeholder string to overwrite, and none to collide with");
    assert.match(sql, /p_user_id\s+uuid\s*:=\s*null/, "and the same for the uuid form");
    assert.match(sql, /raise exception\s*\n?\s*'nothing supplied/, "an unedited file must still raise, not run");
    assert.ok(!/REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL/.test(sql), "a sentinel string that doubles as a possible real value is the bug, not the guard");
    assert.match(sql, /on conflict \(id\) do nothing/, "the profile insert must not write over a real account's row");
    assert.ok(!/on conflict[^;\n]*do update[^;\n]*role/i.test(sql), "an ON CONFLICT … DO UPDATE that touches role is how a paste grants admin to whatever the address typo'd into");
    assert.match(sql, /lower\(u\.email\) = lower\(v_input\)/, "the lookup is by the operator's typed input, once, into a variable");
  });

  it("a markdown-linked address is named as the mistake it is", () => {
    assert.match(sql, /mailto/, "the guard must know what an autolinked address looks like");
    assert.match(sql, /\[\[:space:\]\<\>\(\)\\\[\\\]/, "brackets, parens and quotes in p_email are refused before the lookup");
    assert.match(sql, /does not look like an address \(one @, no spaces, a dot in the domain\)/, "and a malformed one too, rather than matching nothing");
    assert.match(sql, /no auth\.users row for %/, "the miss says what to do (sign up first) and how many users exist");
  });

  it("nothing in the tree names a person", () => {
    // `\b` is deliberate: the point is that the file cannot be copy-pasted into a repo again with an identity in it.
    const raw = fs.readFileSync(path.join(REPO, "CREATE_ADMIN_PROFILE.sql"), "utf8");
    assert.ok(!/[A-Za-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)[A-Za-z0-9.-]*/i.test(raw), "CREATE_ADMIN_PROFILE.sql must not contain a real address, in code or in prose");
    for (const f of ["CREATE_ADMIN_PROFILE.sql", "supabase/SETUP.sql", "KICKLIVE_FINAL_SCHEMA.sql"]) {
      const body = fs.readFileSync(path.join(REPO, f), "utf8");
      assert.ok(!/[A-Za-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)[A-Za-z0-9.-]*/i.test(body), `${f} carries a personal address`);
    }
    for (const stray of ["repomix-output.xml", "output.md", ".replit"]) {
      assert.ok(
        !fs.existsSync(path.join(REPO, stray)),
        `${stray} came back: a whole-tree dump (or a provider config with a duplicated key) is how deleted values reappear in docs, in CI scans and in the next audit`,
      );
    }
  });
});

// Shared by both ordering rules: the base schema plus every migration, in the order an operator applies them.
const targets: Array<[string, string]> = [
  ["KICKLIVE_FINAL_SCHEMA.sql", fs.readFileSync(path.join(REPO, "KICKLIVE_FINAL_SCHEMA.sql"), "utf8")],
  ...files.map((f) => [f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")] as [string, string]),
];

describe("a LANGUAGE sql function is never created before anything its body resolves eagerly", () => {
  // Same rule, second object kind: `LANGUAGE sql` bodies are parsed *and planned* at CREATE FUNCTION time, so
  // a call to a function the file defines further down is `42P01: function … does not exist` on an empty
  // project. Phase 7 shipped exactly that for weeks — `kicklive_ad_eligibility` called `kicklive_ad_targeting_matches`
  // 100 lines before it was created — and it survived every test because the flow that would catch it needs a
  // database. `tests/unit/sql-executes.test.mjs` now runs the chain on a real one; this rule is the cheap version
  // that also says *which line* to move.
  for (const [name, raw] of targets) {
    it(`${name}: every LANGUAGE sql body calls only functions the file already created`, () => {
      const defined = new Map<string, number>();
      for (const m of raw.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/gi)) {
        const key = m[1]!.toLowerCase();
        if (!defined.has(key)) defined.set(key, raw.slice(0, m.index).split("\n").length);
      }
      for (const fn of raw.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[\w."]+\s*\([^)]*\)[^;]*?LANGUAGE\s+sql\b[\s\S]*?(\$[a-z_0-9]*\$)([\s\S]*?)\1\s*;/gi)) {
        const at = raw.slice(0, fn.index).split("\n").length;
        for (const call of fn[2]!.matchAll(/(?:public\.)?(kicklive_[a-z0-9_]+)\s*\(/gi)) {
          const line = defined.get(call[1]!.toLowerCase());
          if (line === undefined) continue; // helper defined in another file — legitimate, they apply in order
          assert.ok(
            line <= at,
            `${name}: the LANGUAGE sql function at line ${at} calls ${call[1]}, which the file only creates at line ${line} — Postgres resolves that call at CREATE FUNCTION time (42P01 on an empty project)`,
          );
        }
      }
    });
  }
});

describe("a LANGUAGE sql function is never created before the table its body reads", () => {
  // The bug this file exists for: KICKLIVE_FINAL_SCHEMA.sql created `is_admin()` (`LANGUAGE sql`, body
  // `SELECT 1 FROM public.profiles`) in SECTION 2, while `profiles` was not created until SECTION 3. Postgres
  // parses and plans the body of a `LANGUAGE sql` function at CREATE FUNCTION time, so the whole file failed on
  // an empty project with `42P01: relation "public.profiles" does not exist` — the first paste a real staging
  // project ever got. A migration that references a table created by an EARLIER file is fine (operators apply
  // them in order); a file that references its own later creations is not, and that ordering is invisible in a
  // text review unless someone knows Postgres validates `sql` bodies eagerly but leaves `plpgsql` bodies lazy.
  for (const [name, raw] of targets) {
    it(`${name}: every LANGUAGE sql body reads only tables the file already created`, () => {
      const lines = raw.split("\n");
      const created = new Map<string, number>();
      lines.forEach((line, i) => {
        const m = /^\s*CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?"?(\w+)"?/i.exec(line);
        if (m && !created.has(m[1]!.toLowerCase())) created.set(m[1]!.toLowerCase(), i + 1);
      });
      for (const fn of raw.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[\w.]+\s*\([^)]*\)[^;]*?LANGUAGE\s+sql\b[\s\S]*?\$\$([\s\S]*?)\$\$\s*;/gi)) {
        const at = raw.slice(0, fn.index).split("\n").length;
        for (const ref of fn[1]!.matchAll(/\b(?:FROM|JOIN|INTO)\s+(?:public\.)?([a-z_]\w*)/gi)) {
          const line = created.get(ref[1]!.toLowerCase());
          if (line === undefined) continue; // table from another file, or a CTE alias — neither is this rule
          assert.ok(
            line <= at,
            `${name}: the function at line ${at} reads ${ref[1]}, which the file only creates at line ${line} — Postgres plans LANGUAGE sql bodies at CREATE FUNCTION time (42P01 on an empty database)`,
          );
        }
      }
    });
  }
});
