/**
 * Phase 4 · the ratchet, enforced where CI actually runs it.
 *
 * `node scripts/query-audit.mjs --check` is the operator command and
 * `docs/data/phase4-query-inventory.md` is the report; neither gates anything on its own. This file is the
 * gate. It runs the same script the way CI would (so a renamed flag or a broken `--check` fails here rather
 * than silently in a workflow nobody looked at), and it compares the live `--json` totals with
 * `scripts/query-audit.baseline.json` and with the committed inventory document.
 *
 * Why "no increase" and not "never": the baseline numbers came out of migrating 12 screens onto
 * `src/lib/data`, and the superseded Match Control implementations plus the legacy admin screens still hold
 * most of what is left (`docs/PHASE4_DATA_ARCHITECTURE.md` §5). Recording that honestly and refusing to grow
 * it is worth more than a rule that would be waived on its first useful day. To move a number down: migrate a
 * screen. To move one up deliberately: `node scripts/query-audit.mjs --write-baseline`, and the diff of that
 * file is the review.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO, "scripts/query-audit.mjs");
const BASELINE = path.join(REPO, "scripts/query-audit.baseline.json");
const INVENTORY = path.join(REPO, "docs/data/phase4-query-inventory.md");
const MIGRATION_SQL = path.join(REPO, "supabase/migrations/20260910120000_phase4_read_aggregates.sql");

const run = (...args: string[]) => execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const report = JSON.parse(run("--json")) as { totals: Record<string, number> };
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { totals: Record<string, number>; generatedBy: string };
const explain = run("--explain");

/** The keys `--check` compares; a rename on either side would otherwise disable the gate silently. */
const RATCHET_KEYS = ["unboundedReads", "pollers", "starSelects"];

describe("query ratchet", () => {
  it("holds: no unbounded read, self-refetching poller or whole-row read has been added", () => {
    const regressions = RATCHET_KEYS.filter((k) => report.totals[k] > baseline.totals[k]).map((k) => `${k}: baseline ${String(baseline.totals[k])} → now ${String(report.totals[k])}`);
    assert.deepEqual(
      regressions,
      [],
      `\nnew query sites appeared outside src/lib/data.\n` +
        `  node scripts/query-audit.mjs            # the table\n` +
        `  node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md   # everything\n`,
    );
  });

  it("agrees with the operator command, so the two cannot drift", () => {
    assert.equal(
      run("--check").trim(),
      `query-audit: ok — unbounded ${String(report.totals.unboundedReads)}/${String(baseline.totals.unboundedReads)}, pollers ${String(report.totals.pollers)}/${String(baseline.totals.pollers)}, whole-row ${String(report.totals.starSelects)}/${String(baseline.totals.starSelects)}`,
    );
  });

  it("baselines every count the script reports, not just the three it gates", () => {
    for (const key of Object.keys(report.totals)) {
      assert.ok(key in baseline.totals, `${key} is reported but not baselined — a new metric would never be guarded`);
    }
    assert.equal(baseline.generatedBy, "scripts/query-audit.mjs --static");
  });

  it("keeps the committed inventory consistent with the tree", () => {
    const doc = fs.readFileSync(INVENTORY, "utf8");
    const row = doc.match(/\| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|/);
    assert.ok(row, "the totals row is missing from docs/data/phase4-query-inventory.md");
    const keys = ["querySites", "reads", "writes", "rpc", "starSelects", "unboundedReads", "files", "tables", "pollers"];
    const stale = keys.filter((k, i) => String(report.totals[k]) !== row![i + 1]);
    assert.deepEqual(stale, [], `the generated report is stale for: ${stale.join(", ")} — rerun  node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md`);
  });

  it("still prints the index candidates, commented, instead of shipping an unmeasured index", () => {
    // Every candidate the audit tool knows about must appear in the migration's commented block, and none
    // of them may be active. Names have to agree or the two lists drift and nobody applies either.
    const candidates = [...explain.matchAll(/^-- candidate index: (\w+)$/gm)].map((m) => m[1]);
    assert.ok(candidates.length >= 5, `expected the audit to name candidates, found ${String(candidates.length)}`);
    const migration = fs.readFileSync(MIGRATION_SQL, "utf8");
    for (const name of candidates) {
      assert.ok(migration.includes(`create index if not exists ${name} on`), `${name} is a candidate the migration does not mention`);
    }
    const active = fs.readFileSync(MIGRATION_SQL, "utf8").replace(/^\s*--.*$/gm, "");
    assert.ok(!/create index/i.test(active), "the migration must not apply an index it could not measure");
  });
});
