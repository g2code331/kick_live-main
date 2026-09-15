/**
 * `supabase/SETUP.sql` is the one answer to "which SQL do I run on a new project?" — the base schema
 * and every migration, concatenated verbatim in apply order, fenced so a failed paste names its own
 * section. It is generated, and a generated file is only trustworthy while something re-checks it on
 * every commit: this file is that something (the same `--check` mode the CI gate uses).
 *
 * The deletion half of the rule matters as much as the bundle half: the three superseded root files
 * were removed on 2026-09-12 because every new-project incident started with somebody pasting one of
 * them; if they return to the tree, the paste-bait is back too.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

const bundle = read("supabase/SETUP.sql");
const sources = [
  "KICKLIVE_FINAL_SCHEMA.sql",
  ...fs
    .readdirSync(path.join(REPO, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `supabase/migrations/${f}`),
];

describe("the one-file SQL bundle", () => {
  it("carries every source verbatim, base schema first, migrations in filename order", () => {
    let lastEnd = -1;
    for (const [n, rel] of sources.entries()) {
      const body = read(rel).replace(/\s+$/, "");
      assert.ok(bundle.includes(body), `${rel} is embedded verbatim (edit the source, never the bundle)`);
      const marker = bundle.indexOf(`BEGIN section ${n + 1}: ${rel}`);
      assert.ok(marker > lastEnd, `${rel} appears as section ${String(n + 1)} in apply order`);
      lastEnd = marker;
    }
    // Pinned on purpose: the operator-facing number is the point. Whoever is handed the paste is told how
    // many files the bundle holds, and adding a migration is exactly the moment to revisit that sentence.
    assert.equal(sources.length, 13, "the count is the fact an operator needs: base + twelve");
  });

  it("announces each section, so the SQL editor's first result row names the failing step", () => {
    // Derived, not pinned: the total is the bundle's own section count, so a hardcoded "1 / 10" broke on
    // every migration added after it, for no extra guarantee. What matters is that the first and the last
    // section announce the same total the bundle actually has.
    const total = sources.length;
    const first = sources[0]!;
    const last = sources[sources.length - 1]!;
    assert.ok(bundle.includes(`SELECT '1 / ${total}: ${first}' AS kicklive_sql_section;`), `the first section announces 1 / ${total}`);
    assert.ok(bundle.includes(`SELECT '${total} / ${total}: ${last}' AS kicklive_sql_section;`), `the last section announces ${total} / ${total}`);
  });

  it("does not smuggle in the admin bootstrap", () => {
    // The bundle is pasted by whoever the dashboard hands the editor to; the admin grant assumes a superuser
    // session and names a real account, so it must stay a separate reviewed step. Pinned on the *grant*, not
    // on a sentinel string: the check has to keep meaning "no admin minting in here" whatever the bootstrap's
    // placeholders happen to be called this month.
    assert.ok(!bundle.includes("nothing supplied: set exactly one of p_email"), "the bootstrap's refusal must not live in the bundle");
    assert.ok(!/\"p_email\"/.test(bundle) && !bundle.includes("set public.kicklive_set_user_role"), "nor its inputs, nor a direct role write");
    assert.ok(fs.existsSync(path.join(REPO, "CREATE_ADMIN_PROFILE.sql")), "it remains its own reviewed step, documented after the bundle");
  });

  it("is exactly what the generator would produce right now", () => {
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts/build-sql-bundle.mjs"), "--check"], { encoding: "utf8" });
    assert.equal(r.status, 0, `sql:bundle:check failed — run \`npm run sql:bundle\`:\n${r.stderr || r.stdout}`);
  });

  it("and the superseded files it replaced are actually gone", () => {
    for (const gone of ["SUPABASE_COMPLETE_SCHEMA.sql", "SUPABASE_NEW_PROJECT_SETUP.sql", "supabase_migrations.sql"]) {
      assert.ok(!fs.existsSync(path.join(REPO, gone)), `${gone} came back; it is weaker than Phase 1 and nobody can tell it apart from the real thing at paste time`);
    }
  });
});
