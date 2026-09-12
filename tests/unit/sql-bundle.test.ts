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
    assert.equal(sources.length, 10, "the count is the fact an operator needs: base + nine");
  });

  it("announces each section, so the SQL editor's first result row names the failing step", () => {
    assert.ok(bundle.includes("SELECT '1 / 10: KICKLIVE_FINAL_SCHEMA.sql' AS kicklive_sql_section;"));
    assert.ok(bundle.includes("SELECT '10 / 10: supabase/migrations/20260916120000_phase10_privilege_tightening.sql' AS kicklive_sql_section;"));
  });

  it("does not smuggle in the admin bootstrap", () => {
    assert.ok(
      !bundle.includes("REPLACE-WITH-AN-EXISTING-ACCOUNT-EMAIL"),
      "the profile grant names a real user and assumes a superuser session — SETUP.sql stays runnable by whoever the dashboard hands the editor to",
    );
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
