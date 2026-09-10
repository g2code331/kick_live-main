/**
 * Phase 3 · the browser half of the live engine, tested against the server half it has to match.
 *
 * `src/lib/live/` is four modules and a hook. The three pure ones (`protocol`, `machine`, `draftQueue`)
 * are behaviour-testable in plain `node --test`, and they are where the user-visible bugs live: a lost
 * frame, a doubled goal, a draft stranded by a crash, a clock that ticks past 90. The hook and the REST
 * wrappers cannot run here (React, and an alias resolver only Vite has), so they are covered two ways:
 * their *shape* is pinned against the Worker's own contract files, and the transport ladder they implement
 * is exercised live through `worker-local`'s SSE route. Stating that split is the honest version of
 * "the client is tested" — a UI test framework would be a new dependency for a phase that has one job.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { applyFrame, applySnapshot, applyStreamFrame, displayMinute, emptyRoomState, isStale, MAX_EVENTS_KEPT, mergeEvent, recoveryFor, type RoomState } from "../../src/lib/live/machine.ts";
import { backoffFor, classifyFailure, DraftQueue, localStorageDrafts, MAX_DRAFTS_PER_MATCH, memoryStorage, STUCK_SEND_MS, type DraftEntry } from "../../src/lib/live/draftQueue.ts";
import { isLiveMessage, parseFrame, PROTOCOL_VERSION, type LiveEvent, type MatchSnapshot } from "../../src/lib/live/protocol.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO, ...parts), "utf8");
const sread = read;

/** Re-parses `workers/src/lib/matchEvents.ts` so the catalogue is compared to the spec, not to a copy of it. */
function workerEventSpecs(): { type: string; recordable: boolean; lifecycle: boolean; team: string; players: string; group: string; goalType: boolean; cardReason: boolean }[] {
  const src = read("workers", "src", "lib", "matchEvents.ts");
  const out: { type: string; recordable: boolean; lifecycle: boolean; team: string; players: string; group: string; goalType: boolean; cardReason: boolean }[] = [];
  for (const m of src.matchAll(/^ {2}([a-z_]+): spec\("([a-z_]+)", \{/gm)) {
    const open = src.indexOf("{", (m.index ?? 0) + m[0].length - 1);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const inner = src.slice(open + 1, end);
    const grab = (re: RegExp, dflt: string): string => re.exec(inner)?.[1] ?? dflt;
    out.push({
      type: m[2] ?? "",
      recordable: !inner.includes("recordable: false"),
      lifecycle: inner.includes("lifecycle: true"),
      team: grab(/team: "([a-z_]+)"/, "required"),
      players: grab(/players: "([a-z_]+)"/, "none"),
      group: grab(/group: "([a-z_]+)"/, "play"),
      goalType: inner.includes("goalType: true"),
      cardReason: inner.includes("cardReason: true"),
    });
  }
  return out;
}

const SERVER_LIVE = read("workers", "src", "types", "live.ts");
const SERVER_API = read("workers", "src", "types", "api.ts");
const CLIENT_PROTOCOL = read("src", "lib", "live", "protocol.ts");
const CLIENT_API = read("src", "lib", "live", "api.ts");
const CLIENT_HOOK = read("src", "lib", "live", "useMatchRoom.ts");
const ROUTES_LIVE = read("workers", "src", "routes", "live.ts");
const DRAFT_SOURCE = read("src", "lib", "live", "draftQueue.ts");

/** Source without comments: prose must never satisfy (or break) a code assertion. */
const codeOnly = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The `{ field: type }` members of an `export interface`, from either side of the mirror. */
function interfaceFields(source: string, name: string): Map<string, string> {
  const found = new RegExp(`export interface ${name}[\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(found, `${name} is not declared`);
  const body = found[0].replace(/^export interface[^{]*\{/, "").replace(/\}\s*$/, "");
  const out = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = /^\s*(readonly\s+)?([a-zA-Z_][\w]*)(\??):\s*(.+?);?\s*$/.exec(line);
    if (m) out.set(m[2] ?? "", (m[4] ?? "").replace(/\s/g, ""));
  }
  return out;
}

function unionMembers(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} not found`);
  const chunk = source.slice(start, source.indexOf(";", start));
  return [...chunk.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

const sorted = (values: Iterable<string>): string[] => [...values].slice().sort();

// ── fixtures ─────────────────────────────────────────────────────────────────

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    event_type: "goal",
    team_id: 1,
    team_name: "Home",
    player_id: 11,
    player_name: "Striker",
    assist_player_id: null,
    assist_player_name: null,
    minute: 12,
    extra_minute: 0,
    period: "first",
    description: null,
    goal_type: null,
    card_reason: null,
    metadata: null,
    client_event_id: null,
    recorded_by: "u-1",
    recorded_by_name: null,
    recorded_at: "2026-09-09T18:00:00.000Z",
    status: "active",
    corrects_event_id: null,
    correction_reason: null,
    sequence: 1,
    ...over,
  };
}

const clock = (over: Record<string, unknown> = {}) => ({
  kind: "wallclock" as const,
  started_at: "2026-09-09T18:00:00.000Z",
  elapsed_before_pause: 0,
  minute: 12,
  stoppage: null,
  period: "first" as const,
  status: "first_half" as const,
  ...over,
});

const score = (home: number, away: number) => ({ home, away });

function snapshot(over: Record<string, unknown> = {}): MatchSnapshot {
  return {
    version: PROTOCOL_VERSION,
    matchId: 7,
    sequence: 5,
    at: "2026-09-09T18:00:00.000Z",
    type: "MATCH_SNAPSHOT",
    status: "first_half",
    score: score(1, 0),
    clock: clock(),
    body: {
      match: null,
      clock: clock(),
      score: score(1, 0),
      events: [event({ sequence: 4 }), event({ sequence: 5, id: 2, event_type: "corner" })],
      rebuilt_from_database: false,
      controllers_online: 1,
      viewers_online: 40,
    },
    ...over,
  } as unknown as MatchSnapshot;
}

const ready = (): RoomState => applySnapshot(emptyRoomState(7), snapshot(), Date.parse("2026-09-09T18:00:00.000Z"));

describe("live client · the protocol mirror cannot drift", () => {
  const mirrored = [
    "LiveEnvelope",
    "LiveEvent",
    "LiveScore",
    "LiveClock",
    "LiveMatchInfo",
    "MatchSnapshotBody",
    "MatchSnapshot",
    "MatchEventMessage",
    "MatchStatusMessage",
    "MatchClockMessage",
    "LiveError",
    "MatchErrorMessage",
    "SyncConflictMessage",
    "ControllersMessage",
  ];

  for (const name of mirrored) {
    it(`${name} has the same fields on both sides of the wire`, () => {
      const server = interfaceFields(SERVER_LIVE, name);
      const client = interfaceFields(CLIENT_PROTOCOL, name);
      assert.deepEqual(sorted(client.keys()), sorted(server.keys()), `${name}: the browser's copy has different field names`);
      // Types are compared loosely (the two sides import different unions), but optionality must match:
      // an extra `?` on the client is how `undefined` starts flowing into a render that assumed a value.
      for (const [field, type] of server) {
        const clientType = client.get(field) ?? "";
        const optionalMatches = type.endsWith("| null") === clientType.endsWith("| null") && type.endsWith("[]") === clientType.endsWith("[]");
        assert.ok(clientType.length > 0 && optionalMatches, `${name}.${field}: server \`${type}\` vs client \`${clientType}\``);
      }
    });
  }

  it("the replay frame both fallback transports read is the Worker's MatchStreamFrame", () => {
    const server = interfaceFields(SERVER_API, "MatchStreamFrame");
    const client = interfaceFields(CLIENT_PROTOCOL, "MatchStreamFrame");
    assert.deepEqual(sorted(client.keys()), sorted(server.keys()));
    assert.equal(client.get("mode"), server.get("mode"), "mode must stay the same two literal strings");
  });

  it("the message kinds, the event-row states and the status list are the same lists", () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.ok(SERVER_LIVE.includes("export const PROTOCOL_VERSION = 1 as const"), "the Worker must stay on version 1 until a real bump");
    assert.deepEqual(sorted(unionMembers(CLIENT_PROTOCOL, "export type LiveMessageKind =")), sorted(unionMembers(SERVER_LIVE, "export type LiveMessageKind =")));
    assert.deepEqual(sorted(unionMembers(CLIENT_PROTOCOL, "export type EventRowStatus =")), sorted(unionMembers(SERVER_LIVE, "export type EventRowStatus =")));
    assert.deepEqual(sorted(unionMembers(CLIENT_PROTOCOL, "export type MatchStatus =")), sorted(unionMembers(read("workers", "src", "lib", "matchLifecycle.ts"), "export type MatchStatus =")));
    assert.deepEqual(sorted(unionMembers(CLIENT_PROTOCOL, "export type MatchPeriod =")), sorted(unionMembers(read("workers", "src", "lib", "matchLifecycle.ts"), "export type MatchPeriod =")));
  });

  it("the client may only ever say what it has seen", () => {
    // `ClientFrame` is a union of inline object types, so it is compared as normalised text: the browser's
    // copy must be the same three shapes, character for character once whitespace is folded.
    const declaration = (source: string): string => {
      const start = source.indexOf("export type ClientFrame =");
      assert.ok(start >= 0, "ClientFrame must be declared on both sides");
      return source.slice(start, source.indexOf(";", start)).replace(/\s+/g, " ");
    };
    assert.equal(declaration(CLIENT_PROTOCOL), declaration(SERVER_LIVE));
    const frame = declaration(SERVER_LIVE);
    for (const forbidden of ["home_score", "away_score", "recorded_by", "event_status", "is_locked", "status:"]) {
      assert.ok(!frame.includes(forbidden), `ClientFrame must never carry ${forbidden}`);
    }
    assert.ok(CLIENT_HOOK.includes('"resume"') && CLIENT_HOOK.includes("after_sequence"), "the hook must resume with the sequence it last applied");
    assert.ok(CLIENT_HOOK.includes('"snapshot"'), "and must be able to ask for a whole snapshot when its history is not trustworthy");
  });

  it("the controller pad is the Worker's event spec, row for row", () => {
    const specs = workerEventSpecs();
    const recordable = specs
      .filter((r) => r.recordable && !r.lifecycle)
      .map((r) => r.type)
      .sort();
    const catalogue = [...sread("src", "lib", "live", "eventCatalog.ts").matchAll(/^  \{ type: "([a-z_]+)"/gm)].map((m) => m[1] ?? "");
    assert.deepEqual(catalogue.slice().sort(), recordable, "the pad must offer exactly the events a controller may submit");
    for (const type of recordable) {
      const server = specs.find((r) => r.type === type);
      const line = new RegExp(`  \\{ type: "${type}", .*\\},`).exec(sread("src", "lib", "live", "eventCatalog.ts"))?.[0] ?? "";
      assert.ok(line.length > 0, `${type} must be one line in the catalogue`);
      for (const field of ["team", "players"] as const) {
        const fromCatalogue = new RegExp(`${field}: "([^"]+)"`).exec(line)?.[1] ?? "";
        assert.equal(fromCatalogue, server?.[field], `${type}.${field}: the pad says ${fromCatalogue}, the spec says ${String(server?.[field])}`);
      }
      // `group` is the one field the pad may relabel, because its groups are the rows it renders and the
      // union they belong to. Exactly one type is affected: `extra_time_half_time`, lifecycle-shaped in the
      // spec and tappable in the UI. If a second one ever needs this, that is a decision to make in
      // `matchEvents.ts` first, not an allowance to widen here.
      const relabelled = ["extra_time_half_time"];
      const padGroup = /group: "([a-z_]+)"/.exec(line)?.[1] ?? "";
      if (relabelled.includes(type)) {
        assert.equal(server?.group, "lifecycle", `${type} must be lifecycle in the spec for the pad's "play" row to be the documented exception`);
        assert.equal(padGroup, "play");
      } else {
        assert.equal(padGroup, server?.group, `${type}.group: the pad says ${padGroup}, the spec says ${String(server?.group)}`);
      }
      for (const flag of ["goalType", "cardReason"] as const) {
        const fromCatalogue = new RegExp(`${flag}: (true|false)`).exec(line)?.[1];
        assert.equal(String(fromCatalogue), String(Boolean(server?.[flag])), `${type}.${flag} differs between the pad and the spec`);
      }
    }
    // The types a tap may never write must be absent from the pad, not merely greyed out.
    for (const r of specs.filter((x) => !x.recordable || x.lifecycle)) {
      assert.ok(!catalogue.includes(r.type), `${r.type} is written by the state machine, so the pad must not offer it`);
    }
  });

  it("the REST payloads the SPA reads are the Worker's, field for field", () => {
    const pairs: [string, string, string][] = [
      ["MatchMutationData", SERVER_API, CLIENT_API],
      ["MatchEventsPageData", SERVER_API, CLIENT_API],
      ["MatchAccessData", SERVER_API, CLIENT_API],
      ["MatchAuditData", SERVER_API, CLIENT_API],
      ["LiveTicketData", SERVER_API, CLIENT_API.replace("LiveTicketResponse", "§§").replace("§§", "LiveTicketResponse")],
      ["MatchRights", read("workers", "src", "services", "matchAccess.ts"), CLIENT_API],
    ];
    for (const [name, serverSource, clientSource] of pairs) {
      const server = interfaceFields(serverSource, name);
      const client = interfaceFields(clientSource, name === "LiveTicketData" ? "LiveTicketResponse" : name);
      assert.deepEqual(sorted(client.keys()), sorted(server.keys()), `${name}: the browser's copy has different field names`);
    }
  });

  it("a write body may only name the keys the Worker declares", () => {
    const declared = /const EVENT_KEYS = \[([^\]]*)\]/.exec(ROUTES_LIVE)?.[1] ?? "";
    const allowed = new Set((declared.match(/"[a-z_]+"/g) ?? []).map((v) => v.replace(/"/g, "")));
    assert.ok(allowed.size >= 10, "EVENT_KEYS must be parseable, or this test is asserting nothing");
    const fields = interfaceFields(CLIENT_API, "RecordEventInput");
    for (const field of fields.keys()) assert.ok(allowed.has(field), `RecordEventInput sends ${field}, which POST /events would refuse`);
    for (const forbidden of ["home_score", "away_score", "sequence", "recorded_by", "event_status", "status"]) {
      assert.ok(!fields.has(forbidden), `the browser must never send ${forbidden}; the engine derives it`);
    }
    const transition = interfaceFields(CLIENT_API, "TransitionInput");
    assert.deepEqual(sorted(transition.keys()), ["confirm", "expected_sequence", "reason", "status", "stoppage"], "a status change names a target and a reason, nothing else");
    const correction = interfaceFields(CLIENT_API, "CorrectionInput");
    assert.deepEqual(sorted(correction.keys()), ["confirm", "event_id", "expected_sequence", "reason", "replacement"]);
    assert.deepEqual(sorted(interfaceFields(CLIENT_API, "FinalizeInput").keys()), ["confirm", "note"], "finalizing takes a confirmation and a note, never a score");
  });

  it("the transports point at routes that exist, in one origin-relative shape", () => {
    const patterns = new Set([...ROUTES_LIVE.matchAll(/handle[A-Za-z]+/g)].map(() => ""));
    void patterns;
    const routePaths = [...read("workers", "src", "router.ts").matchAll(/pattern: "([^"]+)"/g)].map((m) => m[1] ?? "");
    for (const path of [
      "/matches/:matchId/snapshot",
      "/matches/:matchId/events",
      "/matches/:matchId/state",
      "/matches/:matchId/corrections",
      "/matches/:matchId/finalize",
      "/matches/:matchId/lock",
      "/matches/:matchId/access",
      "/matches/:matchId/audit",
      "/matches/:matchId/assignments",
      "/matches/:matchId/assignments/stand-down",
      "/matches/:matchId/live-ticket",
      "/matches/:matchId/stream",
      "/matches/:matchId",
      "/matches/:matchId/diagnostics",
    ]) {
      assert.ok(routePaths.includes(path), `the SPA calls ${path}, which the Worker does not route`);
    }
    assert.ok(CLIENT_API.includes("`/matches/${String(matchId)}/live-ticket`"), "the ticket call must exist");
    assert.ok(!CLIENT_API.includes("http://") && !CLIENT_API.includes("https://"), "no hard-coded origin in the API layer: the base URL comes from src/lib/env.ts");
    assert.ok(!/\bsupabase\b/i.test(CLIENT_API.replace(/Supabase/g, "")), "the SPA reaches the engine only through the Worker");
    assert.ok(CLIENT_API.includes('from "@/lib/api"'), "and through the one client that adds auth, envelopes and error codes");
  });
});

describe("live client · parsing and the reducer", () => {
  it("a frame is only a frame if it is versioned, numbered and ours", () => {
    assert.equal(parseFrame("not json"), null);
    assert.equal(parseFrame(JSON.stringify({ hello: "world" })), null);
    assert.equal(parseFrame(JSON.stringify({ version: 2, matchId: 7, sequence: 1, at: "x", type: "MATCH_EVENT" })), null, "an unknown protocol version must be ignorable, not fatal");
    const frame = { version: PROTOCOL_VERSION, matchId: 99, sequence: 3, at: "x", type: "MATCH_EVENT" };
    assert.equal(parseFrame(JSON.stringify(frame), 7), null, "another match's frame must not paint this match");
    assert.ok(isLiveMessage({ version: PROTOCOL_VERSION, matchId: 7, sequence: 0, at: "x", type: "MATCH_CLOCK" }));
    assert.equal(parseFrame(JSON.stringify({ ...frame, matchId: 7 }), 7)?.type, "MATCH_EVENT");
  });

  it("a snapshot paints the room and orders the timeline newest-first", () => {
    const state = ready();
    assert.equal(state.ready, true);
    assert.equal(state.sequence, 5);
    assert.deepEqual(state.score, score(1, 0));
    assert.equal(state.status, "first_half");
    assert.deepEqual(
      state.events.map((e) => e.sequence),
      [5, 4],
    );
    assert.equal(state.viewersOnline, 40);
    assert.equal(state.rebuiltFromDatabase, false);
    assert.equal(state.gapDetected, null);
  });

  it("frames at or below the applied sequence are dropped without a copy, so a replay is harmless", () => {
    const state = ready();
    const late = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 5, at: "x", type: "MATCH_EVENT", event: event({ sequence: 5, id: 99 }), score: score(9, 9), clock: clock() });
    assert.equal(late, state, "a duplicate broadcast must return the identical state object");
    const other = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 8, sequence: 6, at: "x", type: "MATCH_EVENT", event: event({ sequence: 6 }), score: score(9, 9), clock: clock() });
    assert.equal(other, state, "a frame for another match is ignored by the reducer as well as the parser");
  });

  it("an event applies the server's score and clock, and a gap is flagged rather than fatal", () => {
    const state = ready();
    const next = applyFrame(state, {
      version: PROTOCOL_VERSION,
      matchId: 7,
      sequence: 6,
      at: "x",
      type: "MATCH_EVENT",
      event: event({ sequence: 6, id: 3 }),
      score: score(2, 0),
      clock: clock({ minute: 31 }),
    });
    assert.equal(next.sequence, 6);
    assert.deepEqual(next.score, score(2, 0));
    assert.equal(next.clock?.minute, 31);
    assert.equal(next.status, "first_half");
    assert.equal(next.events[0]?.id, 3, "the new event goes on top");
    assert.equal(next.gapDetected, null, "sequence 6 after 5 is not a gap");

    const jumped = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 9, at: "x", type: "MATCH_EVENT", event: event({ sequence: 9, id: 4 }), score: score(3, 0), clock: clock() });
    assert.equal(jumped.gapDetected, 6, "the client must notice it missed 6, 7 and 8");
    assert.deepEqual(jumped.score, score(3, 0), "and it must still show the score the server derived, not freeze");
    assert.deepEqual(recoveryFor(jumped), { frame: "snapshot", afterSequence: 0 }, "a client with a hole asks for the whole picture");
  });

  it("a status change moves the status, the label and its lifecycle event together", () => {
    const state = ready();
    const next = applyFrame(state, {
      version: PROTOCOL_VERSION,
      matchId: 7,
      sequence: 6,
      at: "x",
      type: "MATCH_STATUS",
      status: "half_time",
      previous_status: "first_half",
      label: "Half time",
      reason: null,
      clock: clock({ kind: "paused", status: "half_time", minute: 45 }),
      score: score(1, 0),
      event: event({ sequence: 6, id: 5, event_type: "half_time", minute: 45 }),
    });
    assert.equal(next.status, "half_time");
    assert.equal(next.statusLabel, "Half time");
    assert.equal(next.clock?.kind, "paused");
    assert.equal(next.events[0]?.event_type, "half_time");
  });

  it("a clock frame from behind the cursor is dropped whole, not half-applied", () => {
    const state = ready();
    const stale = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 4, at: "x", type: "MATCH_CLOCK", clock: clock({ minute: 20 }), score: score(9, 9) });
    assert.equal(stale, state, "a stale tick must not rewind the cursor or paint a 9-9 score");
    const same = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 5, at: "x", type: "MATCH_CLOCK", clock: clock({ minute: 20 }), score: score(1, 0) });
    assert.equal(same.clock?.minute, 20, "a tick at the current sequence is how a pause or resume arrives");
    assert.equal(same.sequence, 5);
  });

  it("keepalive frames carry no state, and an error frame only carries words", () => {
    const state = ready();
    assert.equal(applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 8, at: "x", type: "PONG" }), state);
    assert.equal(applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 8, at: "x", type: "PING" }), state);
    const errored = applyFrame(state, { version: PROTOCOL_VERSION, matchId: 7, sequence: 1, at: "x", type: "MATCH_ERROR", error: { code: "RATE_LIMITED", message: "Slow down." } });
    assert.deepEqual(errored.lastError, { code: "RATE_LIMITED", message: "Slow down." });
    assert.equal(errored.sequence, 5, "an error must not move the cursor or the score");
  });

  it("a conflict keeps the reason and adopts the server's snapshot", () => {
    const state = ready();
    const next = applyFrame(state, {
      version: PROTOCOL_VERSION,
      matchId: 7,
      sequence: 7,
      at: "x",
      type: "SYNC_CONFLICT",
      reason: "closed_match",
      client_event_id: "c-1",
      detail: "The match is finished.",
      snapshot: snapshot({ sequence: 7, status: "completed", score: score(2, 1) }),
    });
    assert.deepEqual(next.conflict, { reason: "closed_match", detail: "The match is finished.", client_event_id: "c-1" });
    assert.deepEqual(next.score, score(2, 1), "the controller's screen shows what happened, not what it tried to do");
    assert.equal(next.sequence, 7);
  });

  it("the timeline merges by id and by idempotency key, so a pending tap becomes the accepted row", () => {
    const pending = event({ id: 0, client_event_id: "c-9", sequence: 6, event_type: "goal" });
    let events = mergeEvent(ready().events, pending);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.client_event_id, "c-9");
    events = mergeEvent(events, event({ id: 77, client_event_id: "c-9", sequence: 6, player_name: "Striker (the real one)" }));
    assert.equal(events.length, 3, "the accepted row replaces the pending one instead of joining it");
    assert.equal(events[0]?.id, 77);
    assert.equal(events[0]?.player_name, "Striker (the real one)");

    const many = Array.from({ length: MAX_EVENTS_KEPT + 30 }, (_, i) => event({ id: i + 1, sequence: i + 1 }));
    let wide = emptyRoomState(7);
    for (const e of many) wide = { ...wide, events: mergeEvent(wide.events, e) };
    assert.equal(wide.events.length, MAX_EVENTS_KEPT, "memory is bounded: a match that ran two seasons of events cannot grow the tab forever");
    assert.equal(wide.events[0]?.sequence, MAX_EVENTS_KEPT + 30);
  });

  it("a replay page merges into the same picture, and an empty page still refreshes the clock", () => {
    const state = ready();
    const replayed = applyStreamFrame(state, { mode: "events", sequence: 6, events: [event({ sequence: 6, id: 8 })], status: "first_half", score: score(2, 0), clock: clock({ minute: 40 }) });
    assert.equal(replayed.sequence, 6);
    assert.equal(replayed.events.length, 3);
    const empty = applyStreamFrame(state, { mode: "events", sequence: 5, events: [], status: "first_half", score: score(1, 0), clock: clock({ minute: 41 }) });
    assert.equal(empty.clock?.minute, 41, "silence in a window is not staleness: the clock still updates");
    assert.equal(empty.revision, state.revision + 1);
    const snapshotMode = applyStreamFrame(state, {
      mode: "snapshot",
      sequence: 12,
      events: [event({ sequence: 11 }), event({ sequence: 12 })],
      status: "second_half",
      score: score(3, 2),
      clock: clock({ status: "second_half", period: "second", minute: 55 }),
    });
    assert.equal(snapshotMode.sequence, 12);
    assert.equal(snapshotMode.status, "second_half");
    assert.deepEqual(
      snapshotMode.events.map((e) => e.sequence),
      [12, 11],
    );
    assert.equal(snapshotMode.match, null, "a replay carries no match identity, so the one from the snapshot is kept, not invented");
  });

  it("the minute ticks between frames from the server's clock, and never past the ceiling", () => {
    const at = (iso: string) => Date.parse(iso);
    const running = clock({ started_at: "2026-09-09T18:00:00.000Z", elapsed_before_pause: 0, minute: 1 });
    assert.deepEqual(displayMinute(running, at("2026-09-09T18:00:30.000Z")), { minute: 1, running: true, stoppage: 0, extra: 0 }, "0:30 is the 1st minute, the football label the server uses too");
    assert.equal(displayMinute(running, at("2026-09-09T18:44:30.000Z")).minute, 45);
    const stoppage = displayMinute(running, at("2026-09-09T18:47:10.000Z"));
    assert.deepEqual(stoppage, { minute: 45, running: true, stoppage: 0, extra: 3 }, "45+3, not 48 — and the ceiling still holds");
    const banked = clock({ started_at: "2026-09-09T19:00:00.000Z", elapsed_before_pause: 2700, minute: 45, period: "second" as const, status: "second_half" as const });
    // 45:00 banked + 3:00 played is the 49th minute — the server's `floor(seconds/60) + 1` label rule,
    // restated here only to animate the digits between frames.
    assert.equal(displayMinute(banked, at("2026-09-09T19:03:00.000Z")).minute, 49);
    const paused = clock({ kind: "paused" as const, started_at: null, minute: 45 });
    assert.deepEqual(displayMinute(paused, at("2026-09-09T19:59:00.000Z")), { minute: 45, running: false, stoppage: 0, extra: 0 }, "a paused clock is the server's minute, full stop");
    assert.deepEqual(displayMinute(null), { minute: 0, running: false, stoppage: 0, extra: 0 });
    assert.equal(displayMinute(clock({ started_at: "not a date" }), Date.now()).minute, 12, "a corrupt instant falls back to the last authoritative minute rather than NaN");
    assert.equal(displayMinute(clock({ started_at: "2026-09-09T18:00:00.000Z" }), at("2026-09-09T21:00:00.000Z")).minute, 45, "a tab backgrounded for three hours shows 45, not 180");
  });

  it("staleness is only claimed while the match is moving, and recovery follows from it", () => {
    const t0 = Date.parse("2026-09-09T18:00:00.000Z");
    const state = { ...ready(), lastFrameAt: t0 };
    assert.equal(isStale(state, t0 + 1_000), false);
    assert.equal(isStale(state, t0 + 19_000), false);
    assert.equal(isStale(state, t0 + 21_000), true);
    assert.equal(isStale(state, t0 + 21_000, "polling"), false, "a 15 s poll is not stale at 21 s");
    assert.equal(isStale(state, t0 + 46_000, "polling"), true);
    assert.equal(isStale({ ...state, clock: clock({ kind: "paused" }) }, t0 + 60_000), false, "a half-time interval is silence by design");
    assert.equal(isStale(emptyRoomState(7), t0 + 60_000), false, "before the first frame there is nothing to be stale about");
    assert.deepEqual(recoveryFor(state), { frame: "resume", afterSequence: 5 });
    assert.deepEqual(recoveryFor(emptyRoomState(7)), { frame: "snapshot", afterSequence: 0 });
  });
});

describe("live client · the draft queue", () => {
  const open = (storage = memoryStorage()) => new DraftQueue(storage);
  const tap = (q: DraftQueue, minute = 1, payload: Record<string, unknown> = { event_type: "goal", team_id: 1, player_id: 11, minute: 12 }) => {
    const result = q.enqueue(7, "event", { ...payload, minute: minute * 1 });
    assert.ok(result.ok, "enqueue must succeed in these fixtures");
    return result.entry;
  };

  it("a tap is durable before it is sent, and survives a reload with its idempotency key intact", () => {
    const storage = memoryStorage();
    const q = open(storage);
    const entry = tap(q);
    assert.equal(entry.state, "pending");
    assert.match(entry.clientEventId, /^c-[A-Za-z0-9_-]+$/, "the key is minted here, once");
    const reopened = open(storage);
    assert.equal(reopened.list(7).length, 1);
    assert.equal(reopened.list(7)[0]?.clientEventId, entry.clientEventId, "a retry after a crash must reuse the key, or it becomes a second goal");
    const persisted = storage.read() as { version: number; entries: DraftEntry[] };
    assert.equal(persisted.version, 1, "the storage shape is versioned so a future migration can tell a foreign blob from its own");
    assert.equal(persisted.entries[0]?.key, entry.key);
  });

  it("keys and payloads are validated on the way in, so a half-written blob cannot brick the console", () => {
    const junk = {
      read: () => ({ version: 1, entries: [{ key: "a" }, null, { key: "b", matchId: 7, kind: "event", clientEventId: "c-1", payload: {}, createdAt: "2026-09-09T18:00:00.000Z" }] }),
      write: () => undefined,
    };
    const q = new DraftQueue(junk);
    assert.equal(q.list(7).length, 1, "malformed rows are dropped, not thrown at render");
    const unparseable = {
      read: () => {
        throw new Error("unreadable");
      },
      write: () => undefined,
    };
    assert.equal(new DraftQueue(unparseable).all().length, 0, "storage that throws on read must still leave a usable queue");
  });

  it("a full queue refuses the next tap out loud instead of dropping the oldest", () => {
    const q = open();
    for (let i = 0; i < MAX_DRAFTS_PER_MATCH; i++) assert.ok(q.enqueue(7, "event", { event_type: "corner", minute: i, team_id: 1 }).ok);
    const overflow = q.enqueue(7, "event", { event_type: "goal", minute: 90, team_id: 1, player_id: 11 });
    assert.equal(overflow.ok, false);
    assert.ok(!overflow.ok && overflow.reason === "queue_full" && /already waiting/.test(overflow.detail), "the message must say what to do");
    assert.equal(q.list(7).length, MAX_DRAFTS_PER_MATCH, "no entry was replaced, reordered or deleted to make room");
  });

  it("only what the schedule allows is eligible, and backoff never busy-loops", () => {
    const q = open();
    const entry = tap(q);
    assert.equal(q.next(7)?.key, entry.key);
    const { retryInMs } = q.scheduleRetry(entry.key, "no signal");
    assert.ok(q.next(7, Date.now()) === null, "a retried entry must not be picked again immediately");
    assert.ok(q.next(7, Date.now() + retryInMs) !== null, "and it must come back when its time arrives");
    let previous = 0;
    for (const attempts of [1, 2, 3, 4, 5, 6, 7, 8, 40]) {
      const wait = backoffFor(attempts);
      assert.ok(wait >= previous && wait <= 60_000, `backoff must grow and stay bounded, got ${String(wait)}`);
      previous = wait;
    }
  });

  it("a send interrupted by a crash is retried, not left in flight forever", () => {
    const storage = memoryStorage();
    const q = open(storage);
    const entry = tap(q);
    q.markSending(entry.key);
    assert.ok(q.next(7) === null, "an in-flight entry is not double-sent by the same tab");
    assert.ok(q.next(7, Date.now() + STUCK_SEND_MS + 1) !== null, "but after the stuck window it is fair game");
    const reloaded = open(storage);
    assert.deepEqual(reloaded.recover(), { recovered: 1, expired: 0 });
    assert.equal(reloaded.list(7)[0]?.state, "pending");
    assert.equal(reloaded.list(7)[0]?.clientEventId, entry.clientEventId, "recovering keeps the key");
  });

  it("a draft that outlives its meaning is surfaced as expired, never deleted", () => {
    const q = open();
    const entry = tap(q);
    const future = Date.parse("2026-09-13T18:00:00.000Z");
    const aged = new DraftQueue({ read: () => ({ version: 1, entries: [{ ...entry, createdAt: "2026-09-09T18:00:00.000Z" }] }), write: () => undefined });
    assert.deepEqual(aged.recover(future), { recovered: 0, expired: 1 });
    assert.equal(aged.list(7)[0]?.state, "refused");
    assert.equal(aged.list(7)[0]?.conflictReason, "expired");
    assert.equal(aged.list(7)[0]?.permanent, true, "it stops retrying and says why, instead of looping until the browser throttles it");
    assert.equal(aged.count(7, future).expired, 1);
    assert.equal(aged.list(7).length, 1, "expired is a state, not a deletion: the row stays for a human");
  });

  it("the difference between 'retry me' and 'a human must decide' is decided in one function", () => {
    assert.equal(classifyFailure("NETWORK_ERROR", 0), "retry");
    assert.equal(classifyFailure("TIMEOUT", 0), "retry");
    assert.equal(classifyFailure("DEPENDENCY_FAILED", 503), "retry");
    assert.equal(classifyFailure("RATE_LIMITED", 429), "retry");
    assert.equal(classifyFailure("INTERNAL_ERROR", 500), "retry");
    assert.equal(classifyFailure("CONFLICT", 409), "conflict");
    assert.equal(classifyFailure("VALIDATION_FAILED", 400), "refuse");
    assert.equal(classifyFailure("FORBIDDEN", 403), "refuse");
    assert.equal(classifyFailure("SOMETHING_NEW", 418), "retry", "an unrecognised code retries: an unknown failure must never mean a lost event");
    const q = open();
    const entry = tap(q);
    assert.deepEqual(q.recordConflict(entry.key, "closed_match", "The match is finished."), { permanent: true });
    assert.equal(q.list(7)[0]?.state, "refused");
    assert.equal(q.next(7, Date.now() + 10_000), null, "a permanent refusal is never auto-retried");
    const other = tap(q, 2, { event_type: "corner", team_id: 1, minute: 4 });
    q.recordConflict(other.key, "sequence_gap", "Reordered.");
    assert.equal(q.list(7).find((e) => e.key === other.key)?.permanent, false, "a gap is a timing accident, so it stays retryable");
  });

  it("settling removes the entry, and a duplicate ack settles it too", () => {
    const q = open();
    const entry = tap(q);
    q.markSending(entry.key);
    q.settle(entry.key);
    assert.equal(q.list(7).length, 0);
    const second = tap(q);
    assert.equal(q.settleByClientEventId(7, second.clientEventId), true);
    assert.equal(q.list(7).length, 0);
    assert.equal(q.settleByClientEventId(7, "c-nope"), false);
  });

  it("revising a refused draft is a new claim, with a new key", () => {
    const q = open();
    const entry = tap(q, 1, { event_type: "goal", team_id: 1, player_id: 11, minute: 12 });
    q.recordConflict(entry.key, "validation", "That minute is past the ceiling.");
    const revised = q.revise(entry.key, { event_type: "goal", team_id: 1, player_id: 11, minute: 41 });
    assert.ok(revised);
    assert.notEqual(revised.clientEventId, entry.clientEventId, "an edited event is a different event");
    assert.equal(revised.state, "pending");
    assert.equal(q.list(7)[0]?.payload.minute, 41);
    assert.equal(q.retry(entry.key), undefined, "retrying by the old key must be harmless");
  });

  it("a quota-exceeded or private-mode storage degrades to memory and says so once", () => {
    const store = localStorageDrafts({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const q = new DraftQueue(store);
    const entry = tap(q);
    assert.equal(q.list(7)[0]?.key, entry.key, "the tap still works in memory");
    assert.equal(store.unavailable, true, "and the caller can render 'not persisted' instead of implying durability");
  });

  it("queues are per match: a draft for one fixture never rides along on another", () => {
    const q = open();
    tap(q);
    assert.equal(q.list(8).length, 0);
    assert.ok(q.enqueue(8, "event", { event_type: "corner", team_id: 1, minute: 1 }).ok);
    assert.equal(q.list(7).length, 1);
    assert.equal(q.discardAll(8), 1);
    assert.equal(q.list(8).length, 0);
    assert.equal(q.list(7).length, 1);
  });

  it("only time-insensitive claims may wait in a pocket", () => {
    const q = open();
    const kinds = [...read("src", "lib", "live", "draftQueue.ts").matchAll(/kind: DraftKind/g)];
    assert.ok(kinds.length >= 1);
    assert.match(read("src", "lib", "live", "draftQueue.ts"), /export type DraftKind = "event" \| "correction";/, "a queued status change would move the match at the wrong moment");
    assert.match(CLIENT_HOOK, /status change is never queued/);
    assert.ok(!CLIENT_HOOK.includes('enqueueAndSend("transition"'), "the hook must not offer a transition draft");
  });
});

describe("live client · the transport ladder in useMatchRoom", () => {
  it("is a documented three-step descent, with the same reducer at every rung", () => {
    for (const needle of ["openSocket", "openStream", "pollOnce", "DOWNGRADE_AFTER_FAILURES", "recoveryFor(stateRef.current)", "isStale", "displayMinute"]) {
      assert.ok(CLIENT_HOOK.includes(needle), `the hook must implement ${needle}`);
    }
    assert.ok(CLIENT_HOOK.includes("liveStreamUrl(matchId, stateRef.current.sequence)"), "SSE resumes from the applied sequence, like the socket does");
    assert.ok(CLIENT_HOOK.includes("withCredentials: false"), "an EventSource must not widen the credential surface");
    assert.match(CLIENT_HOOK, /type: "resume"/);
    assert.match(CLIENT_HOOK, /type: "snapshot"/);
    assert.ok(CLIENT_HOOK.includes("POLL_MS[mode]"), "a controller polls faster than a fan");
    assert.ok(!/setInterval\([^)]*fetch/.test(CLIENT_HOOK), "no unbounded interval loop: polling is a chained timeout, so a slow request cannot stack");
  });

  it("keeps a page from owning a second source of truth", () => {
    const hook = codeOnly(CLIENT_HOOK);
    const clientApi = codeOnly(CLIENT_API);
    for (const needle of ["home_score", "away_score", "elapsed_seconds_before_pause", "matches.update", "supabase.from", ".update(", ".insert("]) {
      assert.ok(!hook.includes(needle) && !clientApi.includes(needle), `the live client must never write ${needle}`);
    }
    // Every write the live client can make is one of the engine's own endpoints, and there are no others.
    const mutationPaths = [...clientApi.matchAll(/api\.(post|put)<[^>]*>\(`([^`]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(
      mutationPaths.slice().sort(),
      [
        "post /matches/${String(matchId)}/assignments",
        "post /matches/${String(matchId)}/assignments/stand-down",
        "post /matches/${String(matchId)}/corrections",
        "post /matches/${String(matchId)}/events",
        "post /matches/${String(matchId)}/finalize",
        "post /matches/${String(matchId)}/live-ticket",
        "post /matches/${String(matchId)}/lock",
        "put /matches/${String(matchId)}/state",
      ].sort(),
      "these are the writes, and no others",
    );
  });
});

describe("phase3 · the console is the one implementation, and the fan page is on the room", () => {
  const console = read("src", "pages", "portals", "admin", "MatchControlCenter.tsx");
  const details = codeOnly(read("src", "pages", "MatchDetails.tsx"));
  const fixtures = read("src", "pages", "portals", "admin", "FixturesViewer.tsx");
  const queue = read("src", "pages", "portals", "admin", "MultiMatchQueue.tsx");
  const portal = read("src", "pages", "portals", "AdminPortal.tsx");

  it("every reachable entry point lands on the canonical console", () => {
    assert.ok(fixtures.includes("import MatchControlCenter from './MatchControlCenter';"), "FixturesViewer must render the canonical console");
    assert.ok(fixtures.includes("<MatchControlCenter"), "and pass it the same props");
    assert.ok(queue.includes("import MatchControlCenter from './MatchControlCenter';"), "the multi-match queue must not keep a second implementation");
    assert.ok(queue.includes("<MatchControlCenter match={selectedMatch} onBack="), "including its navigate-instead-of-overlay shape");
    for (const file of [fixtures, queue, portal]) {
      assert.ok(!/MatchControlComplete|MatchControlFull|MatchControlPro|MatchControlRoom|MatchControlDashboard/.test(file), "no superseded console may still be wired in");
    }
  });

  it("the console writes through the engine and never to a row", () => {
    const body = codeOnly(console);
    assert.ok(body.includes('useMatchRoom(matchId, { mode: "controller"'), "the console must be built on the room, not on its own polling");
    for (const forbidden of [".update(", ".insert(", ".delete(", "supabase.from('matches')", 'supabase.from("matches")', "setInterval"]) {
      assert.ok(!body.includes(forbidden), `the console must not ${forbidden === "setInterval" ? "own a timer" : `write ${forbidden}`}`);
    }
    assert.ok(body.includes('supabase.from("players")'), "squad reads stay on the legacy read path (the Worker has no squad route yet) — documented, not hidden");
    for (const needle of ["actions.record(", "actions.transition(", "actions.correct(", "actions.finalize(", "actions.lock(", "actions.assign("]) {
      assert.ok(body.includes(needle), `the console must offer ${needle.split(".")[1]}`);
    }
    assert.ok(body.includes("rights?.canFinalize !== true") && body.includes("rights?.canLock !== true"), "authority gates are rendered disabled with the server's words");
    assert.ok(body.includes("access?.allowed_transitions"), "and its lifecycle buttons come from the server's legal moves, not a client list");
    assert.ok(body.includes("reason_required"), "the reason a transition needs is demanded by the server's flag");
  });

  it("the fan page reads live state from the room, with no timer of its own", () => {
    assert.ok(details.includes("useMatchRoom("), "the page must use the room");
    assert.ok(!details.includes("setInterval"), "the 10-second poll is gone");
    assert.ok(!/supabase\s*\.from\(['"]match_events/.test(details), "the timeline no longer comes from a direct table read");
    assert.ok(!/from\(['"]matches['"]\)\s*\.\s*select\(\s*\*\s*,/.test(details), "the live columns are no longer read off the row with `*`");
    assert.ok(details.includes("state.score.home") && details.includes("clock.minute"), "score and minute come from the room");
    assert.ok(details.includes("connection.stale"), "and a stalled pipe is admitted on screen rather than showing a confident lie");
    assert.ok(details.includes("state.sequence"), "the non-engine panels refresh from the sequence, not a clock");
  });

  it("the access payload the console renders is the payload the Worker sends", () => {
    const server = interfaceFields(read("workers", "src", "types", "api.ts"), "MatchAccessData").get("allowed_transitions") ?? "";
    const client = interfaceFields(CLIENT_API, "MatchAccessData").get("allowed_transitions") ?? "";
    assert.ok(server.length > 0 && server === client, "allowed_transitions must be declared identically on both sides");
    assert.ok(server.includes("reason_required"), "the reason flag must be part of the contract, not inferred by the UI");
    assert.ok(read("workers", "src", "routes", "live.ts").includes("reason_required: move?.reasonRequired === true"), "and filled from the transition table");
  });
});
