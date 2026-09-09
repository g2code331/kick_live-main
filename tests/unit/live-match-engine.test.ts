/**
 * Phase 3 · the live match engine's contracts, checked against the database they describe.
 *
 * The interesting risk in a system like this is not "is the TypeScript well typed" — it is that three
 * documents have to agree about the same facts and nothing in the compiler connects them:
 *
 *   - `KICKLIVE_FINAL_SCHEMA.sql` (the baseline schema, and the CHECK lists Postgres enforces);
 *   - `supabase/migrations/20260909210000_phase3_live_match_engine.sql` (the ledger columns, the
 *     `kicklive_*` functions and the transition table);
 *   - `workers/src/**` (the state machine, the event specifications, the RPC argument names) and
 *     `src/lib/live/**` (the browser's mirror of the same wire shapes).
 *
 * Every test here reads the SQL as text and compares lists, rather than restating them. If a status, an
 * event type, a transition, an RPC parameter or a wire field is renamed in one place only, the migration
 * and the app stop agreeing — which is exactly the class of bug a live match cannot survive, because by
 * then the data is already wrong in front of a crowd.
 *
 * `worker-local` and a real `supabase db push` cover execution; this file covers *agreement*, which no
 * amount of end-to-end testing would catch on its own.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  allowedNextStatuses,
  canRecordEvents,
  clockKind,
  MATCH_STATUS_VALUES,
  minuteCeiling,
  periodOf,
  transitionsFrom,
  type MatchPeriod,
  type MatchStatus,
} from "../../workers/src/lib/matchLifecycle.ts";
import { assertRecordable, EVENT_SPECS, scoreFromEvents, SCORING_TYPES, type EventLike } from "../../workers/src/lib/matchEvents.ts";
import { PROTOCOL_VERSION, type EventRowStatus } from "../../workers/src/types/live.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const SCHEMA = read("KICKLIVE_FINAL_SCHEMA.sql");
const MIGRATION = read("supabase/migrations", "20260909210000_phase3_live_match_engine.sql");
/** The migration as it would execute: comment lines removed, so a `--` note can never satisfy an assertion. */
const MIGRATION_LIVE = MIGRATION.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const STATUS_LIST = [
  "scheduled",
  "waiting",
  "first_half",
  "half_time",
  "second_half",
  "extra_time",
  "penalty_shootout",
  "full_time",
  "suspended",
  "postponed",
  "abandoned",
  "cancelled",
  "completed",
  "live",
];

/** The first `check (col in (…))` list inside the baseline schema's `create table` block for `table`. */
function schemaCheckList(table: string, column: string): string[] {
  const start = SCHEMA.search(new RegExp(`create table (?:if not exists )?public\\.${table}\\b`, "i"));
  assert.ok(start >= 0, `baseline schema has no ${table}`);
  const end = SCHEMA.indexOf("\n);", start);
  const block = SCHEMA.slice(start, end > start ? end : start + 4000);
  const at = block.search(new RegExp(`\\n\\s*${column}\\s+text\\b`, "i"));
  assert.ok(at >= 0, `${table}.${column} not found in the baseline schema`);
  const list = /check\s*\(\s*'?\w*'?\s+in\s*\(([^)]*)\)/is.exec(block.slice(at));
  assert.ok(list, `no CHECK list for ${table}.${column}`);
  return sqlItems(list[1] ?? "");
}

function sqlItems(source: string): string[] {
  return source
    .split(",")
    .map((raw) => raw.trim().replace(/^'|'$/g, ""))
    .filter((raw) => raw.length > 0 && !raw.includes("$") && /^[a-z_]+$/.test(raw));
}

/** Every `column … IN (...)` list in a SQL text. */
function sqlInLists(sql: string, column: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`${column}\\b[^)]*?in\\s*\\(([^)]*)\\)`, "gis");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const items = sqlItems(m[1] ?? "");
    if (items.length > 0) out.push(items);
  }
  return out;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Splits a PostgREST `select` list on commas that are not inside an embed's parentheses. */
function splitOutsideParens(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of source) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((part) => part.replace(/\s+/g, " ").replace(/^ | $/g, "").replace(/^"|"$/g, ""));
}

/** The `{…}` block starting at `at`, brace-balanced — argument lists contain `?? {}`, so `[^}]*` lies. */
function balanced(source: string, at: number): string {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at + 1, i);
    }
  }
  return "";
}

/** A whole function definition, from its signature to the `$$;` that closes it. */
function sqlFunction(name: string): string {
  const found = new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\n\\$\\$;`).exec(MIGRATION_LIVE);
  assert.ok(found, `${name} must be defined by the migration`);
  return found[0];
}

describe("phase3 · status and event vocabulary", () => {
  it("the state machine knows exactly the statuses the matches CHECK list allows", () => {
    assert.deepEqual(uniqueSorted(MATCH_STATUS_VALUES), uniqueSorted(schemaCheckList("matches", "status")), "workers/src/lib/matchLifecycle.ts and matches.status must allow the same statuses");
    assert.equal(MATCH_STATUS_VALUES.length, 14, "the schema's 14 statuses, no more: a 15th would split every live-match query");
    assert.deepEqual(uniqueSorted(MATCH_STATUS_VALUES), uniqueSorted(STATUS_LIST), "the shared list used by this file");
  });

  it("lib/validation.ts mirrors the same two lists (its 400s and the DB's 23514 say the same thing)", () => {
    const validation = read("workers/src/lib/validation.ts");
    const statuses = /export const MATCH_STATUSES = \[([\s\S]*?)\] as const;/.exec(validation);
    assert.ok(statuses, "MATCH_STATUSES not found in lib/validation.ts");
    assert.deepEqual(((statuses[1] ?? "").match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")).sort(), MATCH_STATUS_VALUES.slice().sort());

    const types = /export const MATCH_EVENT_TYPES = \[([\s\S]*?)\] as const;/.exec(validation);
    assert.ok(types, "MATCH_EVENT_TYPES not found in lib/validation.ts");
    assert.deepEqual(
      ((types[1] ?? "").match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")).sort(),
      schemaCheckList("match_events", "event_type").sort(),
      "the API's accepted event types must be exactly the ledger's CHECK list",
    );
  });

  it("every event type in the schema has a server-side specification, and only one definition exists", () => {
    const fromSchema = schemaCheckList("match_events", "event_type");
    assert.equal(fromSchema.length, 27, "the baseline schema declares 27 event types");
    assert.deepEqual(Object.keys(EVENT_SPECS).sort(), fromSchema.slice().sort(), "EVENT_SPECS must cover the ledger's list exactly");
    for (const type of fromSchema) assert.equal(EVENT_SPECS[type as keyof typeof EVENT_SPECS].type, type, `${type} must be keyed by its own name`);
  });

  it("the goal_type vocabulary matches the column's CHECK list", () => {
    const validation = read("workers/src/lib/validation.ts");
    const listed = (/export const GOAL_TYPES = \[([^\]]*)\]/.exec(validation) ?? [])[1] ?? "";
    assert.deepEqual((listed.match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")).sort(), schemaCheckList("match_events", "goal_type").sort());
  });

  it("no controller can tap a lifecycle event, and the SQL validator refuses the same set", () => {
    const lifecycle = Object.values(EVENT_SPECS)
      .filter((spec) => spec.lifecycle || !spec.recordable)
      .map((spec) => spec.type);
    assert.deepEqual(
      lifecycle.slice().sort(),
      ["extra_time_start", "full_time", "half_time", "kickoff", "match_abandoned", "penalty_shootout_start", "second_half_start", "substitution_off", "substitution_on"].sort(),
    );
    for (const type of lifecycle) assert.throws(() => assertRecordable(type), /state machine|two half events/, `${type} must be refused as a direct tap`);

    // Three `p_event_type in (…)` lists exist in the validator; only the two that refuse a tap count
    // here — the third is the "this event must name a team" requirement, which is a different rule.
    const refused = [...sqlFunction("kicklive_assert_match_event").matchAll(/if p_event_type in \(([\s\S]*?)\) then\s*\n\s*raise exception '([^']*)'/g)];
    assert.ok(refused.length >= 3, `expected the validator's refusal lists, found ${String(refused.length)}`);
    const refusals = refused.filter((m) => /state machine|two half events/.test(m[2] ?? ""));
    assert.equal(refusals.length, 2, "lifecycle types and half-substitutions are refused in two named lists");
    assert.deepEqual(uniqueSorted(refusals.flatMap((m) => sqlItems(m[1] ?? ""))), lifecycle.slice().sort(), "the SQL refusal lists and EVENT_SPECS must refuse the same types");
    assert.equal(EVENT_SPECS.extra_time_half_time.recordable, true, "the extra-time interval is the one lifecycle-shaped event a controller taps by hand");
  });

  it("the statuses a live event may be recorded in, and the ones it may not, partition the vocabulary", () => {
    const recording = MATCH_STATUS_VALUES.filter((s) => canRecordEvents(s));
    const closed = MATCH_STATUS_VALUES.filter((s) => !canRecordEvents(s));
    assert.deepEqual(recording.slice().sort(), ["extra_time", "first_half", "half_time", "live", "penalty_shootout", "second_half", "suspended"]);
    assert.deepEqual(closed.slice().sort(), ["abandoned", "cancelled", "completed", "full_time", "postponed", "scheduled", "waiting"]);
    assert.equal(closed.length + recording.length, MATCH_STATUS_VALUES.length);
  });

  it("every status has a clock kind and a period, and `live` behaves like `first_half`", () => {
    const periods: MatchPeriod[] = ["pre", "first", "half_time", "second", "extra_first", "extra_second", "shootout", "done", "interrupted"];
    for (const status of MATCH_STATUS_VALUES) {
      assert.ok(["wallclock", "paused", "none"].includes(clockKind(status)), `${status} has no clock kind`);
      assert.ok(periods.includes(periodOf(status)), `${status} has an unknown period`);
    }
    assert.equal(clockKind("live"), clockKind("first_half"));
    assert.equal(minuteCeiling("live"), minuteCeiling("first_half"));
    assert.equal(periodOf("live"), periodOf("first_half"));
  });
});

describe("phase3 · the transition table is one table, not two opinions", () => {
  /** Parses the migration's `insert into public.kicklive_match_transitions … values (…)`. */
  function seeded(): { from: string; to: string; label: string; admin: boolean; reason: boolean }[] {
    const block = /insert into public\.kicklive_match_transitions[^;]*values([\s\S]*?);\n/s.exec(MIGRATION_LIVE);
    assert.ok(block, "the migration must seed kicklive_match_transitions with one INSERT … VALUES list");
    return [...(block[1] ?? "").matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([^']*)'\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g)].map((m) => ({
      from: String(m[1]),
      to: String(m[2]),
      label: String(m[3]),
      admin: m[4] === "true",
      reason: m[5] === "true",
    }));
  }

  it("the SQL rows and transitionsFrom() are the same set of moves", () => {
    const rows = seeded();
    assert.ok(rows.length >= 45, `only ${String(rows.length)} transitions were parsed from the migration`);
    const inTs = MATCH_STATUS_VALUES.flatMap((from) => transitionsFrom(from).map((t) => `${from}→${t.to}`));
    assert.equal(new Set(inTs).size, inTs.length, "the TypeScript table has a duplicate move");
    assert.deepEqual(rows.map((r) => `${r.from}→${r.to}`).sort(), inTs.sort(), "a legal move must be legal in the database and in the app, or one of them is fiction");
  });

  it("admin-only moves and reason requirements agree on both sides", () => {
    for (const row of seeded()) {
      const transition = transitionsFrom(row.from as MatchStatus).find((t) => t.to === row.to);
      assert.ok(transition, `${row.from}→${row.to} is missing from the TypeScript table`);
      assert.equal(transition.requires === "admin", row.admin, `${row.from}→${row.to} admin-only flag differs`);
      assert.equal(transition.reasonRequired === true, row.reason, `${row.from}→${row.to} reason-required flag differs`);
      assert.ok(transition.label.length > 2 && row.label.length > 2, `${row.from}→${row.to} needs a label on both sides`);
    }
  });

  it("the migration's own status CHECK accepts only the 14 real statuses", () => {
    const tableBlock = /create table if not exists public\.kicklive_match_transitions[\s\S]*?\n\);/.exec(MIGRATION_LIVE)?.[0] ?? "";
    assert.ok(tableBlock.length > 200, "kicklive_match_transitions must be created before its CHECK is asserted");
    const lists = sqlInLists(tableBlock, "from_status").concat(sqlInLists(tableBlock, "to_status"));
    assert.ok(lists.length >= 2, "both status columns need a CHECK");
    for (const list of lists) assert.deepEqual(uniqueSorted(list), uniqueSorted(MATCH_STATUS_VALUES), "the transition table's status CHECK drifted from matches.status");
  });

  it("no status can move to itself, and a closed match moves only for an admin", () => {
    for (const from of MATCH_STATUS_VALUES) {
      const next = transitionsFrom(from);
      assert.ok(!next.some((t) => t.to === from), `${from}→${from} is not a thing`);
      // Four statuses are "closed" for the engine. `full_time` is not one of them: finalizing is the head
      // referee's own move. `scheduled` has not been played, so checking in is ordinary work.
      if (["completed", "cancelled", "postponed", "abandoned"].includes(from)) {
        for (const t of next) assert.equal(t.requires, "admin", `${from}→${t.to} must be admin-only: the match is closed`);
      }
    }
    assert.deepEqual(allowedNextStatuses("full_time", false), ["completed"]);
    assert.deepEqual(allowedNextStatuses("full_time", true).slice().sort(), ["abandoned", "completed", "second_half"]);
    assert.deepEqual(allowedNextStatuses("completed", false), [], "a finalized result is not editable by an official; that is a correction or an admin reopen");
  });

  it("the SQL side refuses what is not in the table, in the app's words", () => {
    const transitionFn = sqlFunction("kicklive_transition_match");
    assert.match(transitionFn, /illegal_transition/);
    assert.match(transitionFn, /from here: %/i);
    assert.match(transitionFn, /requires_admin and not v_admin/);
    assert.match(transitionFn, /reason_required and coalesce\(length\(btrim\(p_reason\)\), 0\) < 3/);
    // The clock physics live here, not in a browser tab.
    assert.match(transitionFn, /match_start_time = case/);
    assert.match(transitionFn, /elapsed_seconds_before_pause = case/);
    assert.match(transitionFn, /for update/);
  });
});

describe("phase3 · the ledger columns and the RPC contract", () => {
  const ledgerColumns = [
    "client_event_id",
    "sequence",
    "period",
    "event_status",
    "corrects_event_id",
    "correction_reason",
    "corrected_by",
    "corrected_at",
    "recorded_by",
    "recorded_by_role",
    "metadata",
  ];

  it("every column the engine writes is added by the migration, exactly once", () => {
    const alter = /alter table public\.match_events\n((?:\s*add column if not exists[^\n]*\n?)+)/.exec(MIGRATION_LIVE);
    assert.ok(alter, "the migration must add the ledger columns in one ALTER TABLE");
    for (const column of ledgerColumns) {
      const added = (alter[1] ?? "").match(new RegExp(`add column if not exists ${column}\\b`, "g")) ?? [];
      assert.equal(added.length, 1, `${column} must be added exactly once`);
    }
    // …and everything `loadEvents` selects must be a column the schema keeps or this migration adds.
    const persistence = read("workers/src/services/matchPersistence.ts");
    const selected = /"([^"]*\bid, match_id, event_type[^"]*)"/.exec(persistence);
    assert.ok(selected, "loadEvents must select its columns from one place");
    const known = new Set([
      ...ledgerColumns,
      "id",
      "match_id",
      "event_type",
      "team_id",
      "player_id",
      "assist_player_id",
      "minute",
      "extra_minute",
      "description",
      "goal_type",
      "card_reason",
      "video_url",
      "created_at",
      "team",
      "player",
      "assist_player",
    ]);
    for (const raw of splitOutsideParens(selected[1] ?? "")) {
      // `team:teams(id,name)` reads the embed's alias; `recorded_by` reads the column.
      const name = ((raw.split(":")[0] ?? raw).split("(")[0] ?? "").trim();
      if (name.length === 0) continue;
      assert.ok(known.has(name), `loadEvents reads ${name}, which the migration neither keeps nor adds`);
    }
  });

  it("event_status and period CHECK lists match the TypeScript unions", () => {
    const statusLists = sqlInLists(MIGRATION_LIVE, "event_status");
    assert.ok(statusLists.length >= 1, "event_status needs a CHECK list");
    assert.deepEqual(uniqueSorted(statusLists[0] ?? []), ["active", "corrected"]);
    const live = read("workers/src/types/live.ts");
    const union = /export type EventRowStatus = ([^;]+);/.exec(live)?.[1] ?? "";
    assert.deepEqual(uniqueSorted((union.match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, ""))), ["active", "corrected"], "EventRowStatus must be exactly what the column allows");
    const declared: EventRowStatus[] = ["active", "corrected"];
    assert.equal(declared.length, 2);

    const periodLists = sqlInLists(MIGRATION_LIVE, "period");
    const expected = uniqueSorted(["pre", "first", "half_time", "second", "extra_first", "extra_second", "shootout", "done", "interrupted", "unknown"]);
    assert.ok(
      periodLists.some((list) => uniqueSorted(list).join(",") === expected.join(",")),
      `the period CHECK list must be the MatchPeriod union plus 'unknown' (saw ${JSON.stringify(periodLists)})`,
    );
  });

  it("sequence and idempotency are enforced by unique indexes, not by application hope", () => {
    assert.match(MIGRATION_LIVE, /create unique index if not exists match_events_client_event_key\s+on public\.match_events \(match_id, client_event_id\)/);
    assert.match(MIGRATION_LIVE, /create unique index if not exists match_events_match_sequence_key\s+on public\.match_events \(match_id, sequence\)/);
    assert.match(MIGRATION_LIVE, /create index if not exists match_events_match_sequence_idx/);
    assert.match(MIGRATION_LIVE, /add column if not exists sequence\s+integer,/);
    assert.match(MIGRATION_LIVE, /set sequence = ranked\.rn/, "legacy rows must be backfilled, oldest first, or replay starts from nothing");
  });

  it("each RPC the Worker calls exists with the same parameter names", () => {
    const persistence = read("workers/src/services/matchPersistence.ts");
    const calls: [string, string][] = [];
    for (const found of persistence.matchAll(/"(kicklive_[a-z_]+)",\s*\{/g)) {
      const open = (found.index ?? 0) + found[0].length - 1;
      calls.push([found[1] ?? "", balanced(persistence, open)]);
    }
    assert.equal(calls.length, 8, "the eight engine RPCs, and no more (this is the surface the SPA mirrors)");

    const signatures = new Map<string, string[]>();
    for (const m of MIGRATION_LIVE.matchAll(/create or replace function public\.(kicklive_[a-z_]+)\(([\s\S]*?)\)\s*\nreturns/g)) {
      const params = (m[2] ?? "")
        .split(",")
        .map((p) => (p.trim().split(/\s+/)[0] ?? "").trim())
        .filter((p) => p.startsWith("p_"));
      signatures.set(m[1] ?? "", params);
    }
    for (const [fn, body] of calls) {
      const args = [...(body ?? "").matchAll(/(?:^|[{,\s])(p_[a-z_]+):/g)].map((a) => a[1] ?? "");
      const declared = signatures.get(fn);
      assert.ok(declared, `${fn} is not defined by the migration`);
      assert.ok(args.length > 0, `${fn} was called with no readable arguments`);
      assert.deepEqual(args.slice().sort(), declared.slice().sort(), `${fn}: the Worker sends ${args.join(", ")}, the function accepts ${declared.join(", ")}`);
    }
  });

  it("the mutation result the functions return is what MutationResult reads", () => {
    const persistence = read("workers/src/services/matchPersistence.ts");
    const shape = /export interface MutationResult \{([\s\S]*?)\n\}/.exec(persistence)?.[1] ?? "";
    const keys = [...shape.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1] ?? "");
    assert.deepEqual(keys.slice().sort(), ["clock", "duplicate", "event", "rejected", "score", "sequence", "status"]);
    for (const fn of ["kicklive_record_match_event", "kicklive_transition_match", "kicklive_correct_match_event", "kicklive_finalize_match"]) {
      const body = sqlFunction(fn);
      for (const key of ["'sequence'", "'status'", "'score'", "'clock'", "'event'"]) {
        assert.ok(body.includes(key), `${fn} must return ${key} so the room can broadcast it`);
      }
    }
    // The stale-controller path exists on the two functions that accept an expected sequence.
    for (const fn of ["kicklive_record_match_event", "kicklive_transition_match", "kicklive_correct_match_event"]) {
      assert.ok(sqlFunction(fn).includes("'rejected'"), `${fn} must be able to say "you lost the race"`);
    }
  });

  it("the snapshot and event frames carry exactly the fields the app is written against", () => {
    const snapshotFn = sqlFunction("kicklive_match_live_state");
    // The DO's `rebuild()` reads these off the top level, and `LiveStateSnapshot` promises them.
    for (const key of ["status", "sequence", "score", "clock", "match", "events", "rebuilt_from_database", "controllers_online", "viewers_online"]) {
      assert.ok(snapshotFn.includes(`'${key}',`), `live_state is missing a top-level '${key}'`);
    }
    for (const key of [
      "id",
      "home_team_id",
      "away_team_id",
      "home_team_name",
      "away_team_name",
      "home_team_color",
      "away_team_color",
      "competition",
      "round",
      "venue",
      "kickoff_at",
      "is_locked",
      "attendance",
    ]) {
      assert.ok(snapshotFn.includes(`'${key}',`), `live_state.match is missing '${key}'`);
    }
    const live = read("workers/src/types/live.ts");
    for (const key of ["home_team_name", "away_team_color", "kickoff_at", "attendance"]) assert.ok(live.includes(key), "LiveMatchInfo no longer declares " + key);
    assert.match(snapshotFn, /limit 60/, "the snapshot must be bounded: a room that reads 40 000 events cannot be rehydrated in a request");

    const frame = sqlFunction("kicklive_event_frame");
    assert.ok(frame.includes("select to_jsonb(e)"), "kicklive_event_frame must project a named column list, not ev.*");
    const persistence = read("workers/src/services/matchPersistence.ts");
    const shaped = /export function shapeEvent[\s\S]*?\n\}/.exec(persistence)?.[0] ?? "";
    assert.ok(shaped.length > 600, "shapeEvent must be readable by this test");
    for (const field of [
      "team_name",
      "player_name",
      "assist_player_name",
      "extra_minute",
      "period",
      "metadata",
      "client_event_id",
      "recorded_by_name",
      "recorded_at",
      "status",
      "corrects_event_id",
      "correction_reason",
      "sequence",
      "event_type",
      "card_reason",
      "goal_type",
      "description",
    ]) {
      assert.ok(frame.includes(field), `the frame omits ${field}, which the LiveEvent shape promises`);
    }
    assert.ok(frame.includes("created_at as recorded_at"), "recorded_at must be produced by the frame, not invented in TypeScript");
    assert.match(frame, /left join public\.profiles\s+pr\s+on\s+pr\.id\s*=\s*ev\.recorded_by/);
    // An official's username is not fan content: the frame only names them to an admin.
    assert.match(frame, /case when public\.is_admin\(\) then pr\.username else null end/i);
    assert.equal(PROTOCOL_VERSION, 1);
    // The REST read path does not embed profiles at all, so the recorder stays an id there.
    assert.ok(shaped.includes("recorded_by_name: null"), "shapeEvent must keep the recorder anonymous on the REST read path too");
    const selected = /"([^"]*\bid, match_id, event_type[^"]*)"/.exec(persistence)?.[1] ?? "";
    assert.ok(selected.length > 0, "loadEvents must select from one place");
    assert.ok(!selected.includes("profiles"), "loadEvents must not embed profiles");
  });

  it("the derived-score rule is written the same way in SQL as in the fold", () => {
    const scoreFn = sqlFunction("kicklive_match_score");
    assert.ok(scoreFn.includes("'goal','penalty_goal'"), "the SQL fold must count goal and penalty_goal");
    assert.ok(scoreFn.includes("'own_goal'"), "the SQL fold must credit own goals to the other side");
    assert.ok(scoreFn.includes("'shootout'"), "the SQL fold must keep the shoot-out tally out of the match score");
    assert.ok(scoreFn.includes("event_status = 'active'"), "the SQL fold must skip corrected rows");
    assert.deepEqual(SCORING_TYPES.slice().sort(), ["goal", "own_goal", "penalty_goal"]);
  });

  it("the minute ceiling and period mapping match lib/matchLifecycle.ts", () => {
    const ceilingFn = sqlFunction("kicklive_minute_ceiling");
    const parsed = new Map<string, number>();
    for (const m of ceilingFn.matchAll(/when '([a-z_]+)' then (\d+)/g)) parsed.set(m[1] ?? "", Number(m[2]));
    const fallback = Number(/else (\d+) end/.exec(ceilingFn)?.[1] ?? Number.NaN);
    for (const status of MATCH_STATUS_VALUES) {
      const period = periodOf(status);
      assert.equal(parsed.get(period) ?? fallback, minuteCeiling(status), `${status}: SQL ceiling for ${period} differs from minuteCeiling()`);
    }
    const periodFn = sqlFunction("kicklive_period_of");
    const periodPairs = new Map<string, string>();
    for (const m of periodFn.matchAll(/when\s+'([a-z_]+)'\s+then\s+'([a-z_]+)'/g)) periodPairs.set(m[1] ?? "", m[2] ?? "");
    const periodFallback = /else\s+'([a-z_]+)'\s+end/.exec(periodFn)?.[1] ?? "";
    for (const status of MATCH_STATUS_VALUES) {
      assert.equal(periodPairs.get(status) ?? periodFallback, periodOf(status), `kicklive_period_of disagrees with periodOf() about ${status}`);
    }
    assert.equal(periodFallback, "done", "the SQL fallback is 'done': an unknown status is treated as finished, never as live");
  });

  it("the statistics the events can answer are recomputed, and the ones they cannot are left alone", () => {
    const sync = sqlFunction("kicklive_sync_match_statistics");
    for (const column of ["home_corners", "away_corners", "home_offsides", "away_offsides", "home_yellow_cards", "away_yellow_cards", "home_red_cards", "away_red_cards"]) {
      assert.ok(sync.includes(column), `${column} should be derived`);
    }
    for (const untouched of ["possession", "shots", "saves", "passes", "fouls"]) {
      assert.ok(!new RegExp(`set[\\s\\S]{0,400}${untouched}`, "i").test(sync), `${untouched} is not derivable from the ledger and must not be invented`);
    }
  });
});

describe("phase3 · migration hygiene", () => {
  it("is one transaction with balanced dollar quotes", () => {
    assert.equal((MIGRATION_LIVE.match(/^begin;$/gm) ?? []).length, 1, "exactly one begin;");
    assert.equal((MIGRATION_LIVE.match(/^commit;$/gm) ?? []).length, 1, "exactly one commit;");
    assert.equal((MIGRATION.match(/\$\$/g) ?? []).length % 2, 0, "every $$ must be closed");
    assert.match(MIGRATION, /notify pgrst, 'reload schema';/);
  });

  it("never destroys match history outside the commented rollback", () => {
    const destructive = /\b(drop table|drop column|truncate|delete from public\.matches|delete from public\.match_activity)/gi;
    const offenders = MIGRATION_LIVE.split("\n").filter((line) => destructive.test(line));
    assert.deepEqual(offenders, [], `the executable part of the migration must not destroy data — saw ${offenders.join(" | ")}`);
    // The one DELETE that is allowed is the reference table's own reseed.
    const deletes = MIGRATION_LIVE.split("\n").filter((line) => /delete from/i.test(line));
    assert.deepEqual(
      deletes.map((d) => d.trim()),
      ["delete from public.kicklive_match_transitions;"],
    );
  });

  it("each new table is closed before its policies are opened", () => {
    for (const table of ["match_assignments", "kicklive_match_transitions"]) {
      const revokeAt = MIGRATION_LIVE.indexOf(`revoke all on public.${table} from`);
      const policyAt = MIGRATION_LIVE.indexOf(`create policy`, revokeAt);
      assert.ok(revokeAt > 0, `${table} must be revoked before anything is granted`);
      assert.ok(policyAt > revokeAt, `${table} must get its policies after the revoke/grant block`);
    }
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    const defs = [...MIGRATION_LIVE.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]{0,2000}?as \$\$/g)];
    assert.ok(defs.length >= 12, `only ${String(defs.length)} function definitions were found`);
    for (const m of defs) {
      if (!/security definer/i.test(m[0])) continue;
      assert.match(m[0], /set search_path = public, pg_temp/i, `${m[1]} is SECURITY DEFINER without a pinned search_path`);
    }
  });

  it("no engine function is callable by `public`, and internal helpers are granted to nobody", () => {
    const revoked = new Set([...MIGRATION_LIVE.matchAll(/revoke all on function public\.([a-z_]+)/g)].map((m) => m[1] ?? ""));
    const granted = new Set([...MIGRATION_LIVE.matchAll(/grant execute on function public\.([a-z_]+)/g)].map((m) => m[1] ?? ""));
    const defined = new Set([...MIGRATION_LIVE.matchAll(/create or replace function public\.(kicklive_[a-z_]+)/g)].map((m) => m[1] ?? ""));
    // Plumbing: called by the definer functions (which run as the owner) or by a trigger, never a surface.
    const internal = new Set([
      "kicklive_period_of",
      "kicklive_minute_ceiling",
      "kicklive_lifecycle_event_for",
      "kicklive_guard_match_result_columns",
      "kicklive_guard_match_events_append_only",
      "kicklive_sequence_on_insert",
    ]);
    assert.ok(defined.size >= 14, `only ${String(defined.size)} engine functions were defined`);
    for (const fn of defined) {
      assert.ok(revoked.has(fn), `${fn} must be revoked from public before anything else`);
      if (internal.has(fn)) {
        assert.ok(!granted.has(fn), `${fn} is internal and must stay ungranted`);
        continue;
      }
      assert.ok(granted.has(fn), `${fn} is defined but granted to nobody`);
    }
    // The public fan snapshot is the one function anon may call, and only because it returns public rows.
    assert.match(MIGRATION_LIVE, /grant execute on function public\.kicklive_match_live_state\(integer\) to anon, authenticated;/);
    assert.ok(!/grant execute on function public\.kicklive_record_match_event[^;]*anon/.test(MIGRATION_LIVE), "anon must not be able to record a match event");
  });

  it("the browser-authored columns are guarded, with the ratchet spelled out", () => {
    const guard = sqlFunction("kicklive_guard_match_result_columns");
    for (const column of ["home_score", "away_score", "minute", "status", "match_start_time", "elapsed_seconds_before_pause", "is_locked", "confirmed_at", "live_seq"]) {
      assert.ok(guard.includes(`new.${column} is distinct from old.${column}`), `${column} must be guarded`);
    }
    assert.match(guard, /current_setting\('kicklive\.engine', true\)/, "the guard must recognise the engine's own writes");
    assert.match(guard, /session_user/, "the guard must distinguish a browser session by session_user, not current_user");
    assert.match(guard, /coalesce\(old\.live_seq, 0\) = 0/, "the ratchet: a match the engine never wrote keeps today's behaviour");
    // After the engine-owned columns are refused, everything else must fall through to `return new` — a
    // guard that blocked the whole row would break the venue/lineup editors for no security gain.
    assert.match(guard, /kicklive: this match is live-engine owned/);
    assert.match(guard, /return new;\s*\nend;/);
    assert.equal((guard.match(/raise exception/g) ?? []).length, 2, "the guard raises exactly twice: the delete refusal and the column refusal");
    // Triggers are attached to the right tables and operations.
    assert.match(MIGRATION_LIVE, /create trigger kicklive_guard_match_result_columns\s+before update or delete on public\.matches/);
    assert.match(MIGRATION_LIVE, /create trigger kicklive_guard_match_events_append_only\s+before update or delete on public\.match_events/);
    assert.match(MIGRATION_LIVE, /create trigger kicklive_sequence_on_insert\s+before insert on public\.match_events/);
  });

  it("the engine marks its own writes transaction-locally, never session-locally", () => {
    const enter = sqlFunction("kicklive_enter_engine");
    assert.match(enter, /set_config\('kicklive\.engine', 'on', true\)/, "the third argument (is_local) is what stops a pooled connection staying flagged");
    const records = sqlFunction("kicklive_record_match_event").concat(
      sqlFunction("kicklive_transition_match"),
      sqlFunction("kicklive_correct_match_event"),
      sqlFunction("kicklive_finalize_match"),
      sqlFunction("kicklive_set_match_lock"),
      sqlFunction("kicklive_assign_match"),
      sqlFunction("kicklive_stand_down_assignment"),
    );
    assert.equal((records.match(/kicklive_enter_engine\(\)/g) ?? []).length, 7, "every write function must declare itself, or its own write trips the guard");
    assert.match(MIGRATION_LIVE, /select coalesce\(bool_or\(u\.usesuper\), false\) into v_superuser from pg_user u where u\.usename = session_user;/);
  });

  it("RLS is enabled but not forced where the definer functions must read", () => {
    assert.ok(!/alter table public\.match_assignments force row level security/i.test(MIGRATION), "forcing RLS here makes the definer functions read zero assignments and reject every official");
    assert.match(MIGRATION_LIVE, /alter table public\.match_assignments enable row level security;/);
    assert.match(MIGRATION_LIVE, /create policy "match_assignments: own rows readable"/);
    assert.match(MIGRATION_LIVE, /create policy "match_assignments: admin reads all"/);
    assert.ok(!/create policy.*on public\.match_assignments\s+for insert/i.test(MIGRATION_LIVE), "assignments are writable only through kicklive_assign_match()");
  });

  it("the append-only ledger and the assignment-based insert policy are both stated", () => {
    const append = sqlFunction("kicklive_guard_match_events_append_only");
    assert.match(append, /append-only ledger/);
    assert.match(append, /if tg_op = 'DELETE' then/, "NEW is unassigned in a DELETE trigger, so the two messages must be separate");
    assert.match(MIGRATION_LIVE, /revoke update, delete on public\.match_events from authenticated;/);
    assert.match(MIGRATION_LIVE, /create policy "match_events: officials insert" on public\.match_events\s+for insert to authenticated/);
    assert.match(MIGRATION_LIVE, /kicklive_match_rights\(match_id\)->>'can_control'\) = 'true'/);
    assert.ok(!/alter default privileges[^\n]*from authenticated/i.test(MIGRATION_LIVE), "default privileges are schema-wide; that would break tables this migration does not own");
  });

  it("the verification block refuses a half-built engine", () => {
    const verify = /do \$\$([\s\S]*?)\n\$\$;/.exec(MIGRATION_LIVE)?.[1] ?? "";
    assert.ok(verify.length > 500, "the verification block must exist before commit;");
    for (const needle of ["match_assignments", "match_events", "kicklive_match_transitions", "has_function_privilege", "has_table_privilege", "has_column_privilege", "pg_policies", "pg_trigger"]) {
      assert.ok(verify.includes(needle), `the verification block never checks ${needle}`);
    }
    assert.ok(verify.indexOf("raise exception") < verify.indexOf("commit;") || verify.includes("raise exception"), "failures must be raised, not logged");
  });
});

describe("phase3 · the score fold", () => {
  const event = (over: Partial<EventLike> & { event_type: string }): EventLike => ({ team_id: 1, player_id: null, minute: 10, period: "first", event_status: "active", sequence: 1, ...over });

  it("counts goals for the named side and own goals for the other one", () => {
    const score = scoreFromEvents([event({ event_type: "goal" }), event({ event_type: "own_goal", team_id: 2 }), event({ event_type: "penalty_goal" })], 1, 2);
    assert.deepEqual({ home: score.home, away: score.away }, { home: 3, away: 0 });
  });

  it("ignores corrected rows, so a correction recalculates instead of needing a second edit", () => {
    assert.equal(scoreFromEvents([event({ event_type: "goal" })], 1, 2).home, 1);
    assert.equal(scoreFromEvents([event({ event_type: "goal", event_status: "corrected" })], 1, 2).home, 0);
  });

  it("keeps shoot-out tallies out of the match score", () => {
    const score = scoreFromEvents([event({ event_type: "penalty_goal", period: "shootout" }), event({ event_type: "goal", period: "first" })], 1, 2);
    assert.deepEqual({ home: score.home, away: score.away, shootout: score.shootout }, { home: 1, away: 0, shootout: { home: 1, away: 0 } });
  });

  it("a team that is not in the match contributes nothing, and no score is ever negative", () => {
    const score = scoreFromEvents([event({ event_type: "goal", team_id: 99 }), event({ event_type: "own_goal", team_id: 1 })], 1, 2);
    assert.deepEqual({ home: score.home, away: score.away }, { home: 0, away: 1 });
    assert.ok(score.home >= 0 && score.away >= 0);
  });
});
