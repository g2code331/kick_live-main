/**
 * The live-match wire contract, version 1.
 *
 * Versioned on purpose: the mobile app and the desktop shell ship independently of the Worker, so a
 * message a future version adds must be ignorable rather than fatal. `version` is on every frame, and
 * the client ignores frames with a version it does not know.
 *
 * Two rules make reconnect and offline recovery possible, and both are visible here rather than hidden
 * in an implementation:
 *
 *   - every state-changing frame carries a `sequence`, allocated by Postgres (via the recording
 *     function) and mirrored by the Durable Object. Clients detect gaps and ask to resume;
 *   - a client that cannot resume gets a `MATCH_SNAPSHOT` instead. **A gap is always closable by the
 *     server**, so a fan's screen can never be stuck showing minute 61 with the ground having scored two
 *     more.
 *
 * `src/lib/live/protocol.ts` mirrors these field names for the browser build; a test compares the two.
 */
import type { MatchPeriod, MatchStatus } from "../lib/matchLifecycle.ts";

export const PROTOCOL_VERSION = 1 as const;

export type LiveMessageKind =
  | "MATCH_SNAPSHOT"
  | "MATCH_EVENT"
  | "MATCH_STATUS"
  | "MATCH_CLOCK"
  | "MATCH_ERROR"
  | "SYNC_CONFLICT"
  | "PING"
  | "PONG"
  | "CONTROLLERS";

export interface LiveEnvelope {
  version: typeof PROTOCOL_VERSION;
  matchId: number;
  /** Highest sequence this frame reflects. Monotonic per match; clients resume from it. */
  sequence: number;
  /** Server instant, so a client can measure its own skew without trusting its clock for the score. */
  at: string;
  type: LiveMessageKind;
}

/**
 * Exactly two states, matching `match_events.event_status`'s CHECK. A "reversal" is not a third state: it
 * is the original row marked `corrected` plus a replacement row linked by `corrects_event_id`, so the
 * sequence of what was believed stays readable.
 */
export type EventRowStatus = "active" | "corrected";

export interface LiveEvent {
  /** Postgres id. */
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
  /** Present only once a shoot-out has started; a shoot-off never touches home/away. */
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
  /** Newest first in the UI; sent oldest-first and reversed client-side to keep the frame small. */
  events: LiveEvent[];
  /** True when the DO had to rebuild from Postgres (after eviction) — useful in incident triage. */
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
 * Sent to a controller (not to fans) when something it queued was refused — a duplicate, an event for a
 * closed match, a stale draft. The client surfaces it as `SYNC CONFLICT` with the reason; nothing is
 * discarded silently, and the server's snapshot rides along so the controller can re-decide.
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

/** Client → server frames. Kept tiny: the only client-authored thing is "what have I seen". */
export type ClientFrame = { type: "resume"; after_sequence: number } | { type: "ping" } | { type: "snapshot" };

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === PROTOCOL_VERSION && typeof v.matchId === "number" && typeof v.type === "string" && typeof v.sequence === "number";
}
