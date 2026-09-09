/**
 * The live-match wire contract, as the browser sees it — version 1.
 *
 * This file is a **mirror** of `workers/src/types/live.ts`, deliberately re-declared rather than shared:
 * the SPA and the Worker are built by different toolchains (`DOM` vs `@cloudflare/workers-types`), and a
 * shared directory would need its own project reference and build order for a few dozen lines. That
 * mirrors-the-same-thing risk is handled the way Phase 2 handled it for `src/lib/api/types.ts`: a test
 * (`tests/unit/live-client.test.ts`) compares the field names and unions on both sides, so drift is a
 * failing build rather than a wrong score on a fan's screen.
 *
 * Three rules are load-bearing for everything in `src/lib/live/`:
 *
 *   1. `sequence` is allocated by Postgres, never by a client. A client only ever reports the highest
 *      sequence it has applied.
 *   2. The match's status is read from `clock.status`, which every frame carries. There is no separate
 *      "status" subscription that could lag behind the score.
 *   3. A frame with an unknown `version` is ignored, not fatal: the desktop shell and a phone can be
 *      older than the Worker.
 */

export const PROTOCOL_VERSION = 1 as const;

/** The 14 statuses `matches.status` allows. Pinned against `workers/src/lib/matchLifecycle.ts`. */
export type MatchStatus = "scheduled" | "waiting" | "first_half" | "half_time" | "second_half" | "extra_time" | "penalty_shootout" | "full_time" | "suspended" | "postponed" | "cancelled" | "abandoned" | "completed" | "live";

/** Which phase of the match a moment belongs to; decides the minute ceiling and the clock's behaviour. */
export type MatchPeriod = "pre" | "first" | "half_time" | "second" | "extra_first" | "extra_second" | "shootout" | "done" | "interrupted";

export type LiveMessageKind = "MATCH_SNAPSHOT" | "MATCH_EVENT" | "MATCH_STATUS" | "MATCH_CLOCK" | "MATCH_ERROR" | "SYNC_CONFLICT" | "PING" | "PONG" | "CONTROLLERS";

export interface LiveEnvelope {
  version: typeof PROTOCOL_VERSION;
  matchId: number;
  /** Highest sequence this frame reflects. Monotonic per match; clients resume from it. */
  sequence: number;
  /** Server instant, so a client can measure its own skew without trusting its clock for the score. */
  at: string;
  type: LiveMessageKind;
}

/** Exactly the two states `match_events.event_status` allows; a reversal is a correction, not a third one. */
export type EventRowStatus = "active" | "corrected";

export interface LiveEvent {
  id: number;
  event_type: string;
  team_id: number | null;
  team_name: string | null;
  player_id: number | null;
  player_name: string | null;
  assist_player_id: number | null;
  assist_player_name: string | null;
  minute: number;
  extra_minute: number;
  period: MatchPeriod | string;
  description: string | null;
  goal_type: string | null;
  card_reason: string | null;
  metadata: Record<string, unknown> | null;
  /** The controller's own idempotency key — echoed back so a draft queue can settle its entries. */
  client_event_id: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  recorded_at: string;
  status: EventRowStatus;
  corrects_event_id: number | null;
  correction_reason: string | null;
  sequence: number;
}

export interface LiveScore {
  home: number;
  away: number;
  /** Present only once a shoot-out has started; a shoot-out never touches home/away. */
  shootout?: { home: number; away: number } | null;
}

export interface LiveClock {
  kind: "wallclock" | "paused" | "none";
  /** The authoritative instant play started, for the period currently running. */
  started_at: string | null;
  /** Seconds banked from earlier periods (so a suspension does not reset the clock). */
  elapsed_before_pause: number;
  /** The minute the server believes we are on. Derived, never accepted from a client. */
  minute: number;
  /** Announced stoppage time for the running period, if the controller set it. */
  stoppage: number | null;
  period: MatchPeriod;
  status: MatchStatus;
}

export interface LiveMatchInfo {
  id: number;
  home_team_id: number | null;
  away_team_id: number | null;
  home_team_name: string | null;
  away_team_name: string | null;
  home_team_color: string | null;
  away_team_color: string | null;
  competition: string | null;
  round: string | null;
  venue: string | null;
  kickoff_at: string | null;
  is_locked: boolean;
  attendance: number | null;
}

export interface MatchSnapshotBody {
  match: LiveMatchInfo;
  clock: LiveClock;
  score: LiveScore;
  /** Sent oldest-first and reversed client-side; `RoomState.events` is newest-first for rendering. */
  events: LiveEvent[];
  /** True when the Durable Object had to rebuild from Postgres (after eviction) — useful in triage. */
  rebuilt_from_database: boolean;
  controllers_online: number;
  viewers_online: number;
}

export interface MatchSnapshot extends LiveEnvelope {
  type: "MATCH_SNAPSHOT";
  status: MatchStatus;
  score: LiveScore;
  clock: LiveClock;
  body: MatchSnapshotBody;
}

export interface MatchEventMessage extends LiveEnvelope {
  type: "MATCH_EVENT";
  event: LiveEvent;
  score: LiveScore;
  clock: LiveClock;
}

export interface MatchStatusMessage extends LiveEnvelope {
  type: "MATCH_STATUS";
  status: MatchStatus;
  previous_status: MatchStatus;
  label: string;
  reason: string | null;
  clock: LiveClock;
  score: LiveScore;
  /** The lifecycle event written alongside the transition (kickoff, half_time, full_time…). */
  event: LiveEvent | null;
}

export interface MatchClockMessage extends LiveEnvelope {
  type: "MATCH_CLOCK";
  clock: LiveClock;
  score: LiveScore;
}

export interface LiveError {
  code: string;
  message: string;
  field?: string;
  /** Set when the client's expected sequence lost a race: the payload shows what actually happened. */
  conflict?: { expected_sequence: number; actual_sequence: number };
}

export interface MatchErrorMessage extends LiveEnvelope {
  type: "MATCH_ERROR";
  error: LiveError;
}

/**
 * Sent to a controller (never to fans) when something it queued was refused. Nothing is discarded
 * silently: the reason is shown and the server's snapshot rides along so the console can re-decide.
 */
export interface SyncConflictMessage extends LiveEnvelope {
  type: "SYNC_CONFLICT";
  reason: "duplicate" | "closed_match" | "invalid_for_state" | "not_assigned" | "sequence_gap" | "database_unavailable";
  client_event_id: string | null;
  detail: string;
  snapshot: MatchSnapshot;
}

export interface ControllersMessage extends LiveEnvelope {
  type: "CONTROLLERS";
  controllers_online: number;
  /** Two controllers editing at once is worth showing before it becomes a lost write. */
  peer_controller: string | null;
}

export interface PingMessage extends LiveEnvelope {
  type: "PING" | "PONG";
}

export type LiveMessage = MatchSnapshot | MatchEventMessage | MatchStatusMessage | MatchClockMessage | MatchErrorMessage | SyncConflictMessage | ControllersMessage | PingMessage;

/** Client → server frames. The only client-authored thing is "what have I already seen". */
export type ClientFrame = { type: "resume"; after_sequence: number } | { type: "ping" } | { type: "snapshot" };

/** The room's replay answer, which is also what the SSE poller relays. Mirrors `MatchStreamFrame`. */
export interface MatchStreamFrame {
  mode: "events" | "snapshot";
  sequence: number;
  events: LiveEvent[];
  status: MatchStatus;
  score: LiveScore;
  clock: LiveClock;
  reason?: string;
}

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === PROTOCOL_VERSION && typeof v.matchId === "number" && typeof v.type === "string" && typeof v.sequence === "number";
}

/**
 * Parses one text frame, returning `null` for anything that is not a frame this client understands.
 *
 * Both transports go through here — the WebSocket and the SSE fallback emit the same JSON (`event:
 * MATCH_EVENT`, `data: {…}`) — so there is one reducer, one gap rule and one set of bugs.
 */
export function parseFrame(text: string, forMatchId?: number): LiveMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isLiveMessage(value)) return null;
  // A future protocol version must be ignorable rather than fatal (already handled by `isLiveMessage`),
  // and `matchId` must be the match this page is about: a broadcast that leaked another match's frame
  // would otherwise paint the wrong score on this screen.
  if (forMatchId !== undefined && value.matchId !== forMatchId) return null;
  return value;
}
