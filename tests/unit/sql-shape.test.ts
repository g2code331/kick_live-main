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
      for (const m of text.matchAll(/\braise\s+(?:exception|warning|notice|info|log|debug1|debug2|debug3|debug4|debug5|fatal)\s+((?:'[^']*'|[^\s;,()]+)(?:\s*\|\|[^(;]*)?)/gi)) {
        const head = m[1]!;
        const quoted = /^'((?:[^']|'')*)'/.exec(head)?.[1];
        if (quoted === undefined) continue;
        const specifiers = (quoted.match(/(?:^|[^%])%[sILNO]?/g) ?? []).length;
        if (specifiers === 0) continue;
        const rest = text.slice((m.index ?? 0) + m[0].length);
        const argList = /^\s*,/.test(rest) ? rest.slice(rest.indexOf(",") + 1, rest.indexOf(";")).trim() : "";
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
        assert.fail(`${file}: ${m[1]} is appended to with || 'literal'; for a text[] that means "malformed array literal" — use array_append(${m[1]}, …)`);
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
    assert.match(source, /Do not treat this SKIP as a pass/, "and must say, in the same breath, that a SKIP is not a pass");
    assert.match(source, /refusing to run against/, "and must refuse a DSN that does not look like a scratch database");
  });
  it("the behavioural flow is a repo file, not a scratch one", () => {
    assert.ok(fs.existsSync(path.join(REPO, "scripts/sql-flow.mjs")), "the flow that exercises save/refuse/serve paths belongs in the repo");
    const flow = fs.readFileSync(path.join(REPO, "scripts/sql-flow.mjs"), "utf8");
    assert.ok(flow.includes("kicklive_ad_serve") && flow.includes("kicklive_ad_record_event"), "the flow must cover the two public functions by name");
  });
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
    assert.match(sql, /p_email\s+text\s*:=\s*'REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL'/, "one named placeholder, filled in by a human");
    assert.match(sql, /raise exception\s*\n?\s*'nothing to do on purpose/, "an unedited file must raise, not run");
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

describe("a LANGUAGE sql function is never created before the table its body reads", () => {
  // The bug this file exists for: KICKLIVE_FINAL_SCHEMA.sql created `is_admin()` (`LANGUAGE sql`, body
  // `SELECT 1 FROM public.profiles`) in SECTION 2, while `profiles` was not created until SECTION 3. Postgres
  // parses and plans the body of a `LANGUAGE sql` function at CREATE FUNCTION time, so the whole file failed on
  // an empty project with `42P01: relation "public.profiles" does not exist` — the first paste a real staging
  // project ever got. A migration that references a table created by an EARLIER file is fine (operators apply
  // them in order); a file that references its own later creations is not, and that ordering is invisible in a
  // text review unless someone knows Postgres validates `sql` bodies eagerly but leaves `plpgsql` bodies lazy.
  const targets: Array<[string, string]> = [
    ["KICKLIVE_FINAL_SCHEMA.sql", fs.readFileSync(path.join(REPO, "KICKLIVE_FINAL_SCHEMA.sql"), "utf8")],
    ...files.map((f) => [f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")] as [string, string]),
  ];

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
