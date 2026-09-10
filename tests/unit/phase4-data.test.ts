/**
 * Phase 4 · the read aggregates in `supabase/migrations/20260910120000_phase4_read_aggregates.sql` against
 * the TypeScript rule they replace.
 *
 * There is no Postgres in this sandbox, so the SQL cannot be executed here (the same limit Phase 3 recorded
 * in `docs/PRODUCTION_ARCHITECTURE.md` §17.4, and the reason this file exists rather than a "tests passed,
 * ship it" line). What *can* be pinned mechanically is the thing that actually breaks in a phase like this:
 * the rule in the database drifting from the rule in the client fallback. `/tables` shows one and `/team/:id`
 * can show the other, and both look plausible.
 *
 * So these tests read the migration's text and compare it to `src/lib/data/standings.ts` — statuses counted
 * as final, points, tie-break order, who appears in the table, and the two invariants that matter for
 * safety (SECURITY INVOKER, pinned `search_path`, `execute` for `anon`) — plus a structural pass that the
 * file is well-formed SQL as far as dollar-quoting and statement separation go.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const MIGRATION = path.join(REPO, "supabase/migrations/20260910120000_phase4_read_aggregates.sql");
const src = fs.readFileSync(MIGRATION, "utf8");

/** Body of one `create or replace function …$$ … $$;` definition, or null. */
function functionBody(name: string): string | null {
  const at = src.indexOf(`create or replace function ${name}(`);
  if (at < 0) return null;
  const open = src.indexOf("$$", at);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}

/** Everything outside `--` comments and `$$ … $$` bodies. */
function statements(): string[] {
  const stripped = src.replace(/^\s*--.*$/gm, "");
  const out: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped.startsWith("$$", i)) {
      inDollar = !inDollar;
      current += "$$";
      i += 1;
      continue;
    }
    if (!inDollar && stripped[i] === ";") {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += stripped[i];
  }
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

describe("phase4 · migration file shape", () => {
  it("is balanced in its dollar quoting and ends each statement", () => {
    const dollars = (src.match(/\$\$/g) ?? []).length;
    assert.equal(dollars % 2, 0, `unbalanced $$ quoting (${dollars} markers)`);
    const stmts = statements();
    assert.ok(stmts.length >= 12, `expected a dozen or so statements, found ${stmts.length}`);
    for (const s of stmts) {
      assert.ok(!/^\s*;/.test(s), "no empty statements");
      assert.ok(s.includes("$$") === false || s.split("$$").length % 2 === 1, "each statement balances its quoting");
    }
  });

  it("defines exactly the three aggregates, adds no table and drops nothing", () => {
    const created = [...src.matchAll(/create or replace function\s+([a-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual([...created].sort(), ["kicklive_competition_standings", "kicklive_is_final_status", "kicklive_squad_sizes"], "this migration owns exactly three functions");
    const forbidden = /\b(drop table|alter table|truncate|delete from|update matches|update players|create table)\b/i;
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
    assert.ok(!forbidden.test(codeOnly), "Phase 4 must not touch a table, a row, or history — aggregates only");
  });

  it("leaves the indexes commented, because nothing was measured", () => {
    const active = src.replace(/^\s*--.*$/gm, "");
    assert.ok(!/create index/i.test(active), "an index in this file without a plan attached is exactly what the phase forbids");
    assert.match(src, /create index if not exists matches_status_start_time_idx/, "the candidates are named, with the shape they serve");
    assert.match(src, /--explain/, "and the command that would justify one is in the file");
  });
});

describe("phase4 · the standings rule is one rule", () => {
  const body = functionBody("kicklive_competition_standings") ?? "";
  const predicate = functionBody("kicklive_is_final_status") ?? "";

  it("counts exactly the statuses the client counts", () => {
    // `freshness.ts` says: DONE_STATUSES = ['full_time','completed'] + LEGACY_DONE = ['finished'].
    const statuses = [...predicate.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(statuses, ["completed", "finished", "full_time"], "the SQL predicate and the client's list must hold the same members");
  });

  it("scores 3/1/0 and breaks ties in the same order", () => {
    assert.match(body, /when scored > conceded then 3\s+when scored = conceded then 1\s+else 0 end/s, "points, as POINTS in src/lib/data/standings.ts");
    const order = body.slice(body.lastIndexOf("order by"));
    assert.match(
      order,
      /coalesce\(ta\.points, 0\) desc,\s*coalesce\(ta\.gd, 0\) desc,\s*coalesce\(ta\.gf, 0\) desc,\s*t\.name asc/,
      "the tie-break ladder, in order — the same four keys `rankStandings()` applies",
    );
  });

  it("lists every club in the competition, not only the ones with results", () => {
    assert.match(body, /participants as \(\s*select distinct team from sides\s*\)/, "an unplayed club appears with played = 0, as the client builds it");
  });

  it("filters clubs the way the client's read does", () => {
    assert.match(body, /t\.status = 'active' or t\.status is null/);
  });

  it("returns the fields the client maps, in the order its row type expects", () => {
    const outs = [
      ...src
        .slice(src.indexOf("create or replace function kicklive_competition_standings("), src.indexOf("as $$", src.indexOf("kicklive_competition_standings")))
        .matchAll(/out\s+([a-z_]+)\s+([a-z]+)/g),
    ].map((m) => m[1]);
    assert.deepEqual(outs, ["team_id", "name", "short_name", "primary_color", "secondary_color", "played", "won", "drawn", "lost", "gf", "ga", "gd", "points", "form"]);
  });

  it("squad sizes returns the column the client spec reads", () => {
    const squad = functionBody("kicklive_squad_sizes") ?? "";
    assert.match(src, /returns table \(team_id integer, count bigint\)/, "`count` is the field `queries.ts` maps into the Map");
    assert.match(squad, /group by p\.team_id/);
  });
});

describe("phase4 · the safety properties of a read aggregate", () => {
  it("is SECURITY INVOKER, so RLS still decides which rows count", () => {
    // Strip comments *and* string literals: the verification block quotes the phrase "SECURITY DEFINER" in
    // the error message it raises when it finds one, and a test that matched its own file's prose would be
    // measuring nothing.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*--.*$/gm, "")
      .replace(/'[^']*'/g, "''");
    assert.ok(!/security definer/i.test(code), "a Phase 4 aggregate must not widen what anyone can read");
    assert.equal((src.match(/language sql/gi) ?? []).length, 3, "all three are plain SQL, so the planner can inline them");
  });

  it("pins search_path and grants execute to exactly the read roles", () => {
    const pins = (src.match(/set search_path = public, pg_temp/g) ?? []).length;
    assert.ok(pins >= 3, "each function pins its search path");
    for (const fn of ["kicklive_is_final_status(text)", "kicklive_competition_standings(integer)", "kicklive_squad_sizes()"]) {
      assert.ok(src.includes(`revoke all on function ${fn} from public;`), `${fn} is revoked from public first`);
      assert.match(src, new RegExp(`grant execute on function ${fn.replace(/[()]/g, "\\$&")} to anon, authenticated, service_role;`), `${fn} is granted to the read roles`);
    }
  });

  it("tells PostgREST to reload, or the new RPCs 404 until the next restart", () => {
    assert.match(src, /notify pgrst, 'reload schema';/);
  });

  it("verifies itself and refuses to half-apply", () => {
    assert.match(src, /do \$verify\$/);
    const raises = (src.match(/raise exception 'phase4 verification failed:/g) ?? []).length;
    assert.ok(raises >= 4, `the verification block has ${raises} failure modes; it must cover existence, privileges, INVOKER, search_path and the status list`);
  });

  it("wraps itself in one transaction, like the other files here, and shows how to undo it", () => {
    const code = statements();
    // `statements()` splits *on* the semicolon, so the delimiters are not part of the pieces.
    assert.equal(code[0], "begin", "opens a transaction (supabase/README.md rule: no half-applied file)");
    assert.equal(code.at(-1), "commit", "and closes it — a raising verification block makes the commit unreachable on failure");
    assert.match(src, /--\s+ROLLBACK:/, "with the undo statements written down, though this file needs no data undo");
    assert.match(src, /supabase db push/);
  });
});
