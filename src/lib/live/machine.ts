/**
 * The one reducer both transports feed and both kinds of client run.
 *
 * A fan page, a controller console and the SSE fallback all end up here, which is the point: "what does
 * the screen show after frame N" has exactly one answer in the codebase. The Worker's Durable Object
 * applies the same rules to produce the frames, so a client that has been offline and a client that has
 * been watching live converge on the same state.
 *
 * What this file guarantees, and why each rule is there:
 *
 *   - **Monotonic sequence.** A frame at or below `state.sequence` is already applied, so it is dropped.
 *     That is what makes a retried broadcast harmless rather than a doubled goal.
 *   - **Gaps heal, they do not throw.** A frame that skips ahead is still applied (every frame carries
 *     its own authoritative `score`/`clock`, so the picture is never inconsistent), and `gapDetected` is
 *     set so the transport asks for the missing rows. The alternative — refusing to render until the gap
 *     is filled — means a fan sees nothing while the ground celebrates.
 *   - **Status only from `clock.status`.** There is no separate status field to go stale; every frame
 *     carries the clock, so the minute, the period and the status always change together.
 *   - **A snapshot replaces.** Snapshots are the server's answer to "I cannot trust your history" (cold
 *     room, retained-events buffer blown, a correction that changed the fold), so merging into them is
 *     wrong and replacing them is right.
 *
 * Pure and synchronous: no timers, no DOM, no fetch. `node --test` runs the whole thing.
 */
import type { ControllersMessage, LiveClock, LiveEvent, LiveMatchInfo, LiveMessage, LiveScore, MatchSnapshot, MatchStreamFrame, MatchStatus, SyncConflictMessage } from "./protocol.ts";

/** Timeline rows kept in memory per match. 200 is the same width the server's `limit` allows per page. */
export const MAX_EVENTS_KEPT = 200;

export type ConnectionMode = "idle" | "socket" | "stream" | "polling";

export interface RoomState {
  matchId: number;
  /** The highest sequence applied. `0` means "nothing has been applied yet", which is not the same as "the match is scoreless". */
  sequence: number;
  /** True once a snapshot (or a first frame) has painted anything. `false` must render a skeleton, not 0-0. */
  ready: boolean;
  status: MatchStatus;
  /** Human words for the status, from the server's own `describe()` — the browser has no label table. */
  statusLabel: string | null;
  score: LiveScore;
  clock: LiveClock | null;
  match: LiveMatchInfo | null;
  /** Newest first, for rendering. Snapshots arrive oldest-first and are reversed on the way in. */
  events: LiveEvent[];
  controllersOnline: number;
  viewersOnline: number;
  peerController: string | null;
  /** Set when the room had to be rehydrated from Postgres — worth showing an operator during an incident. */
  rebuiltFromDatabase: boolean;
  /** The sequence we were missing when it was noticed; cleared by the snapshot/resume that fixed it. */
  gapDetected: number | null;
  /** The last refusal, kept until the next successful frame so the console can explain itself. */
  lastError: { code: string; message: string } | null;
  conflict: { reason: SyncConflictMessage["reason"]; detail: string; client_event_id: string | null } | null;
  /** Wall-clock instant of the last applied frame, for the staleness rule in `useMatchRoom`. */
  lastFrameAt: number | null;
  /** Bumped on every applied frame: the dependency a React memo can trust, unlike an object identity. */
  revision: number;
}

export function emptyRoomState(matchId: number): RoomState {
  return {
    matchId,
    sequence: 0,
    ready: false,
    status: "scheduled",
    statusLabel: null,
    score: { home: 0, away: 0 },
    clock: null,
    match: null,
    events: [],
    controllersOnline: 0,
    viewersOnline: 0,
    peerController: null,
    rebuiltFromDatabase: false,
    gapDetected: null,
    lastError: null,
    conflict: null,
    lastFrameAt: null,
    revision: 0,
  };
}

/**
 * The single entry point for a frame from either transport. Returns the same object when the frame was
 * dropped as already-applied, so a caller can compare identities to tell "changed" from "ignored".
 */
export function applyFrame(state: RoomState, message: LiveMessage, now: number = Date.now()): RoomState {
  if (message.matchId !== state.matchId) return state;
  switch (message.type) {
    case "MATCH_SNAPSHOT":
      return applySnapshot(state, message, now);
    case "MATCH_EVENT": {
      if (message.sequence <= state.sequence) return state;
      const event = message.event;
      // A goal arrives as an event plus the score the server derived from the ledger — not a delta the
      // client computes. If the event was later corrected, the same frame shape carries `status: corrected`.
      return {
        ...state,
        sequence: message.sequence,
        ready: true,
        score: message.score,
        clock: message.clock,
        status: message.clock.status,
        events: mergeEvent(state.events, event),
        gapDetected: message.sequence > state.sequence + 1 ? state.sequence + 1 : state.gapDetected,
        conflict: null,
        lastFrameAt: now,
        revision: state.revision + 1,
      };
    }
    case "MATCH_STATUS": {
      if (message.sequence <= state.sequence) return state;
      return {
        ...state,
        sequence: message.sequence,
        ready: true,
        status: message.status,
        statusLabel: message.label,
        score: message.score,
        clock: message.clock,
        events: message.event ? mergeEvent(state.events, message.event) : state.events,
        gapDetected: message.sequence > state.sequence + 1 ? state.sequence + 1 : state.gapDetected,
        conflict: null,
        lastFrameAt: now,
        revision: state.revision + 1,
      };
    }
    case "MATCH_CLOCK": {
      // The clock is broadcast on its own only for a pause/resume, which carries no sequence-worthy
      // change; `<=` here would drop a legitimate tick, so the guard is `<` and the sequence still moves.
      if (message.sequence < state.sequence) return state;
      return { ...state, ready: true, sequence: Math.max(state.sequence, message.sequence), clock: message.clock, status: message.clock.status, score: message.score, gapDetected: message.sequence > state.sequence + 1 ? state.sequence + 1 : state.gapDetected, lastFrameAt: now, revision: state.revision + 1 };
    }
    case "MATCH_ERROR":
      return { ...state, lastError: { code: message.error.code, message: message.error.message }, lastFrameAt: now, revision: state.revision + 1 };
    case "SYNC_CONFLICT": {
      // The console's own write was refused. Keep the reason for the banner, then take the server's
      // snapshot: the controller's screen must show what actually happened, not what it tried to do.
      const reason = { reason: message.reason, detail: message.detail, client_event_id: message.client_event_id };
      // The snapshot in the message is the repair; the reason is what the controller still has to read
      // afterwards ("your goal was refused: the match is finished"), so it must survive the replacement.
      const after = applySnapshot({ ...state, lastFrameAt: now, revision: state.revision + 1 }, message.snapshot, now);
      return { ...after, conflict: reason };
    }
    case "CONTROLLERS":
      return applyControllers(state, message);
    case "PING":
    case "PONG":
      // Keepalive: proof the pipe is alive, which is information for the reconnect logic (it resets the
      // no-activity timer) and for nothing else. It must never touch the score, so it does not return a
      // new state.
      return state;
    default:
      return state;
  }
}

/**
 * Replaces everything. Used on connect, on a gap too wide to bridge, on a correction (which can change
 * the derived score of rows already applied) and after a `SYNC_CONFLICT`.
 */
export function applySnapshot(state: RoomState, snapshot: MatchSnapshot, now: number = Date.now()): RoomState {
  if (snapshot.matchId !== state.matchId) return state;
  const body = snapshot.body;
  return {
    ...state,
    sequence: Math.max(snapshot.sequence, body?.events?.at(-1)?.sequence ?? 0),
    ready: true,
    status: snapshot.clock?.status ?? snapshot.status,
    // `statusLabel` deliberately survives a snapshot: a snapshot carries no label, and inventing one from
    // a status token is exactly the duplicate vocabulary this phase is meant to remove.
    score: snapshot.score,
    clock: snapshot.clock ?? null,
    match: body?.match ?? state.match,
    events: normaliseOrder(body?.events ?? []),
    controllersOnline: body?.controllers_online ?? 0,
    viewersOnline: body?.viewers_online ?? 0,
    rebuiltFromDatabase: body?.rebuilt_from_database === true,
    gapDetected: null,
    conflict: null,
    lastFrameAt: now,
    revision: state.revision + 1,
  };
}

/**
 * Applies the `{mode, events}` replay object that `GET /matches/:id/events` and the SSE poller answer
 * with. `mode: "snapshot"` means "your history is not trustworthy" — the same recovery rule as a socket
 * snapshot, so both transports converge.
 */
export function applyStreamFrame(state: RoomState, frame: MatchStreamFrame, now: number = Date.now()): RoomState {
  if (frame.mode === "snapshot") {
    // "I cannot bridge your history" in HTTP form: replace the picture and keep the identity of the
    // match, which a replay response deliberately does not resend.
    return {
      ...state,
      ready: true,
      sequence: frame.sequence,
      status: frame.status,
      clock: frame.clock,
      score: frame.score,
      events: normaliseOrder(frame.events),
      gapDetected: null,
      conflict: null,
      lastFrameAt: now,
      revision: state.revision + 1,
    };
  }
  if (frame.events.length === 0) {
    // A replay with no rows is not a gap; it is "nothing happened in that window". The clock and status
    // still refresh, or a paused match would look frozen in time even though the server agrees with it.
    return { ...state, clock: frame.clock, status: frame.status, score: frame.score, sequence: Math.max(state.sequence, frame.sequence), lastFrameAt: now, revision: state.revision + 1 };
  }
  let events = state.events;
  for (const event of frame.events) events = mergeEvent(events, event);
  return {
    ...state,
    ready: true,
    sequence: Math.max(state.sequence, frame.sequence),
    events,
    clock: frame.clock,
    status: frame.status,
    score: frame.score,
    gapDetected: null,
    lastFrameAt: now,
    revision: state.revision + 1,
  };
}

export function applyControllers(state: RoomState, message: ControllersMessage): RoomState {
  return { ...state, controllersOnline: message.controllers_online, peerController: message.peer_controller ?? null, lastFrameAt: Date.now(), revision: state.revision + 1 };
}

/**
 * Merges one event into the newest-first timeline.
 *
 * Identity is `id` when the row has come from Postgres, and `client_event_id` while a draft is still in
 * flight — otherwise a controller's own pending tap would sit next to the accepted row and the timeline
 * would show the goal twice, which is precisely the bug idempotency exists to prevent.
 */
export function mergeEvent(events: readonly LiveEvent[], incoming: LiveEvent): LiveEvent[] {
  const next = events.slice();
  const at = next.findIndex((e) => (incoming.id > 0 && e.id === incoming.id) || (incoming.client_event_id !== null && e.client_event_id === incoming.client_event_id));
  if (at >= 0) {
    next[at] = incoming;
  } else {
    next.unshift(incoming);
  }
  // Corrected rows stay (the timeline is the record of what was believed), but a replacement row must sit
  // above the row it corrects, so ordering is by sequence and not by arrival.
  next.sort((a, b) => b.sequence - a.sequence);
  return next.slice(0, MAX_EVENTS_KEPT);
}

/** Snapshots arrive oldest-first (`limit 60` from the DB); the UI wants newest-first without another sort. */
function normaliseOrder(events: readonly LiveEvent[]): LiveEvent[] {
  const oldestFirst = [...events].sort((a, b) => a.sequence - b.sequence);
  return oldestFirst.reverse().slice(0, MAX_EVENTS_KEPT);
}

/**
 * The minute to display *right now*, between frames.
 *
 * The server owns the minute: this function only extends the last authoritative `clock` along the wall
 * calendar for a smooth second hand, and clamps at the period's ceiling. If the tab was backgrounded the
 * result is still correct because it is computed from `started_at`, not from a count of missed ticks —
 * and if the clock is paused or absent it returns exactly what the server said.
 */
export function displayMinute(clock: LiveClock | null, now: number = Date.now()): { minute: number; running: boolean; stoppage: number; extra: number } {
  if (!clock) return { minute: 0, running: false, stoppage: 0, extra: 0 };
  if (clock.kind !== "wallclock" || clock.started_at === null) {
    return { minute: clock.minute, running: false, stoppage: clock.stoppage ?? 0, extra: 0 };
  }
  const started = Date.parse(clock.started_at);
  if (!Number.isFinite(started)) return { minute: clock.minute, running: false, stoppage: clock.stoppage ?? 0, extra: 0 };
  const elapsed = Math.max(0, Math.floor((now - started) / 1000) + clock.elapsed_before_pause);
  const ceiling = CEILINGS[clock.period] ?? 130;
  // `kicklive_match_clock` says `floor(seconds/60) + 1` while the clock runs: football labels 0:00–0:59
  // as the 1st minute. Clamping at the period's ceiling and reporting the overflow as `45+n` is the same
  // convention the server uses, restated here only to animate the digits between frames.
  const counted = Math.floor(elapsed / 60) + 1;
  return { minute: Math.min(counted, ceiling), running: true, stoppage: clock.stoppage ?? 0, extra: Math.max(0, counted - ceiling) };
}

/** Mirrors `kicklive_minute_ceiling` / `minuteCeiling()`. Pinned by test against both. */
const CEILINGS: Partial<Record<LiveClock["period"], number>> = { pre: 0, first: 45, half_time: 45, second: 90, extra_first: 105, extra_second: 120, shootout: 120, done: 130, interrupted: 130 };

/**
 * True when the screen has stopped being evidence. A fan view that is quietly frozen is worse than one
 * that says it is frozen: the ground can see a goal and the phone cannot.
 *
 * Thresholds are deliberately generous (they must survive a mobile handshake) and the caller decides
 * what to do about it — ask for a snapshot, fall back to SSE, then to polling.
 */
export function isStale(state: RoomState, now: number = Date.now(), mode: ConnectionMode = "socket"): boolean {
  if (!state.ready || state.lastFrameAt === null) return false;
  const running = state.clock?.kind === "wallclock";
  const budget = mode === "polling" ? 45_000 : 20_000;
  // A paused or finished match does not advance, so silence is not staleness.
  if (!running) return false;
  return now - state.lastFrameAt > budget;
}

/** Whether the next thing to do is resume from where we are or ask for a whole snapshot. */
export function recoveryFor(state: RoomState): { frame: "resume" | "snapshot"; afterSequence: number } {
  if (!state.ready || state.gapDetected !== null || state.conflict !== null) return { frame: "snapshot", afterSequence: 0 };
  return { frame: "resume", afterSequence: state.sequence };
}
