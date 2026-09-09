/**
 * The write path for live match state: every mutation goes through one Postgres function, and the
 * function is the authority.
 *
 * Why a function instead of `supabase.from('match_events').insert(...)`:
 *
 *   - the caller's **own token** is in play (`supabaseAsUser`), so `auth.uid()` is real and the
 *     `SECURITY DEFINER` function re-checks the assignment inside the database. A Worker bug cannot
 *     write a match the caller is not officiating, because the row-level policy says no anyway;
 *   - the sequence number, the derived score, the `matches` status guard and the append-only rule are
 *     one atomic statement, so a crash cannot leave a goal recorded with the score stale;
 *   - idempotency (`client_event_id`) is enforced by a unique index rather than by a check-then-write
 *     race in JavaScript, which is exactly how duplicate goals happen on mobile;
 *   - the browser keeps the same path when it calls these later, so "works in the app" and "works in
 *     the API" stay the same sentence.
 *
 * SQLSTATE → API mapping (the contract both sides of this file obey):
 *   42501 insufficient_privilege  → FORBIDDEN
 *   23514 check_violation         → CONFLICT  (illegal transition, event for a closed match)
 *   23505 unique_violation        → CONFLICT  (only when the function could not resolve a duplicate)
 *   P0001 raise_exception         → VALIDATION_FAILED / CONFLICT, by message prefix
 *   PGRST202 (function absent)    → DEPENDENCY_FAILED + "apply the Phase 3 migration"
 */
import { ApiError } from "../lib/response.ts";
import type { SupabaseRest } from "./supabase.ts";
import type { LiveClock, LiveEvent, LiveScore, MatchSnapshotBody } from "../types/live.ts";
import type { MatchStatus } from "../lib/matchLifecycle.ts";

const MIGRATION_HINT = "Live match functions are missing on this project: apply supabase/migrations/20260909210000_phase3_live_match_engine.sql.";

function toApiError(err: unknown, what: string): unknown {
  if (!(err instanceof ApiError)) return err;
  const detail = err.detail ?? err.message;
  if (/PGRST202|Could not find the function|does not exist/.test(detail) && /kicklive_/.test(detail)) return new ApiError("DEPENDENCY_FAILED", 503, `${MIGRATION_HINT} (${what})`, { detail });
  if (/42501|insufficient_privilege|permission denied/i.test(detail)) return new ApiError("FORBIDDEN", 403, "The database refused this change for your account.", { detail });
  // The functions raise their own vetoes (`P0001` with a `kicklive:` prefix) so the message a controller
  // reads is the sentence written here, not a Postgres internal. Every such message is operator-facing by
  // construction: never append user input to one.
  if (/P0001/.test(detail) && /kicklive:/.test(detail)) return new ApiError("VALIDATION_FAILED", 400, "The database refused this event: it does not fit the match as it stands.", { detail });
  if (/23514|check_violation|invalid_transition|not allowed while/i.test(detail)) return new ApiError("CONFLICT", 409, "That change is not allowed in the match's current state.", { detail });
  if (/23505|duplicate key|unique/.test(detail)) return new ApiError("CONFLICT", 409, "That event is already recorded.", { detail });
  return err;
}

async function call<T>(rest: SupabaseRest, fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await rest.call<T>(fn, args);
  } catch (err) {
    throw toApiError(err, fn);
  }
}

export interface MutationResult {
  sequence: number;
  status: MatchStatus;
  score: LiveScore;
  clock: LiveClock;
  event: LiveEvent | null;
  /** True when the RPC found an existing row for the same `client_event_id` and returned it. */
  duplicate?: boolean;
  /** The server's current sequence, sent to a controller whose `expected_sequence` was stale. */
  rejected?: { reason: string; actual_sequence: number } | null;
}

export interface RecordEventArgs {
  matchId: number;
  clientEventId: string;
  eventType: string;
  teamId: number | null;
  playerId: number | null;
  assistPlayerId: number | null;
  minute: number;
  extraMinute: number;
  description: string | null;
  goalType: string | null;
  cardReason: string | null;
  metadata: Record<string, unknown> | null;
  expectedSequence: number | null;
  /** Explicit override for a legitimate repeat (same player, same minute, two goals is not a thing — but a double entry is). */
  allowDuplicateContent: boolean;
}

export async function recordEvent(rest: SupabaseRest, args: RecordEventArgs): Promise<MutationResult> {
  return call<MutationResult>(rest, "kicklive_record_match_event", {
    p_match_id: args.matchId,
    p_client_event_id: args.clientEventId,
    p_event_type: args.eventType,
    p_team_id: args.teamId,
    p_player_id: args.playerId,
    p_assist_player_id: args.assistPlayerId,
    p_minute: args.minute,
    p_extra_minute: args.extraMinute,
    p_description: args.description,
    p_goal_type: args.goalType,
    p_card_reason: args.cardReason,
    p_metadata: args.metadata ?? {},
    p_expected_sequence: args.expectedSequence,
    p_allow_duplicate_content: args.allowDuplicateContent,
  });
}

export interface TransitionArgs {
  matchId: number;
  toStatus: MatchStatus;
  reason: string | null;
  /** Announced stoppage for the running period, in minutes (0–15); null leaves it alone. */
  stoppage: number | null;
  expectedSequence: number | null;
}

export async function transitionMatch(rest: SupabaseRest, args: TransitionArgs): Promise<MutationResult> {
  return call<MutationResult>(rest, "kicklive_transition_match", {
    p_match_id: args.matchId,
    p_to_status: args.toStatus,
    p_reason: args.reason,
    p_stoppage: args.stoppage,
    p_expected_sequence: args.expectedSequence,
  });
}

export async function correctEvent(
  rest: SupabaseRest,
  args: { eventId: number; reason: string; replacement: Record<string, unknown> | null; expectedSequence: number | null },
): Promise<MutationResult> {
  return call<MutationResult>(rest, "kicklive_correct_match_event", {
    p_event_id: args.eventId,
    p_reason: args.reason,
    p_replacement: args.replacement,
    p_expected_sequence: args.expectedSequence,
  });
}

export async function finalizeMatch(rest: SupabaseRest, matchId: number, confirmed: boolean): Promise<MutationResult> {
  return call<MutationResult>(rest, "kicklive_finalize_match", { p_match_id: matchId, p_confirm: confirmed });
}

export async function setMatchLock(rest: SupabaseRest, matchId: number, locked: boolean, reason: string | null): Promise<{ is_locked: boolean }> {
  return call<{ is_locked: boolean }>(rest, "kicklive_set_match_lock", { p_match_id: matchId, p_locked: locked, p_reason: reason });
}

/**
 * What `kicklive_match_live_state` returns: the public snapshot body plus the two numbers the Durable
 * Object must not lose across an eviction — the status and the highest sequence allocated. The SQL side
 * builds exactly these keys; `tests/unit/live-match-engine.test.ts` pins the names on both sides.
 */
export interface LiveStateSnapshot extends MatchSnapshotBody {
  status: MatchStatus;
  sequence: number;
}

/** The single read the Durable Object uses to (re)build state, including after eviction or a restart. */
export async function liveState(rest: SupabaseRest, matchId: number): Promise<LiveStateSnapshot | null> {
  return call<LiveStateSnapshot | null>(rest, "kicklive_match_live_state", { p_match_id: matchId });
}

/** Paged event history for the timeline and for dispute review, oldest first, including corrections. */
export async function loadEvents(rest: SupabaseRest, matchId: number, opts: { afterSequence?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const builder = rest
    .from("match_events")
    .select(
      "id, match_id, event_type, team_id, player_id, assist_player_id, minute, extra_minute, description, goal_type, card_reason, video_url, created_at, client_event_id, sequence, period, event_status, corrects_event_id, correction_reason, corrected_by, recorded_by, metadata, team:teams(name, short_name), player:players(name), assist_player:players!match_events_assist_player_id_fkey(name)",
    )
    .eq("match_id", matchId)
    .order("sequence", { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.afterSequence !== undefined) builder.gt("sequence", opts.afterSequence);
  const rows = await builder.rows<Record<string, unknown>>();
  return rows.map(shapeEvent);
}

/** Postgres stores ids; the wire shape wants display names, which the embeds above supply. */
export function shapeEvent(row: Record<string, unknown>): LiveEvent {
  const team = row.team as { name?: string; short_name?: string } | null;
  const player = row.player as { name?: string } | null;
  const assist = row.assist_player as { name?: string } | null;
  return {
    id: Number(row.id),
    event_type: String(row.event_type),
    team_id: row.team_id === null ? null : Number(row.team_id),
    team_name: team?.name ?? team?.short_name ?? null,
    player_id: row.player_id === null ? null : Number(row.player_id),
    player_name: player?.name ?? null,
    assist_player_id: row.assist_player_id === null ? null : Number(row.assist_player_id),
    assist_player_name: assist?.name ?? null,
    minute: Number(row.minute ?? 0),
    extra_minute: Number(row.extra_minute ?? 0),
    period: String(row.period ?? "unknown"),
    description: (row.description as string | null) ?? null,
    goal_type: (row.goal_type as string | null) ?? null,
    card_reason: (row.card_reason as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    client_event_id: (row.client_event_id as string | null) ?? null,
    recorded_by: (row.recorded_by as string | null) ?? null,
    recorded_by_name: null,
    recorded_at: String(row.created_at ?? new Date().toISOString()),
    status: ((row.event_status as LiveEvent["status"]) ?? "active") as LiveEvent["status"],
    corrects_event_id: row.corrects_event_id === null || row.corrects_event_id === undefined ? null : Number(row.corrects_event_id),
    correction_reason: (row.correction_reason as string | null) ?? null,
    sequence: Number(row.sequence ?? 0),
  };
}

// ── assignments (admin surface; the referee path only ever reads its own rows) ──────
export interface AssignmentRow {
  id: string;
  match_id: number;
  user_id: string;
  role: string;
  status: string;
  note: string | null;
  assigned_at: string;
  username: string | null;
  email: string | null;
}

export async function listAssignments(rest: SupabaseRest, matchId: number): Promise<AssignmentRow[]> {
  try {
    return await rest
      .from("match_assignments")
      .select("id, match_id, user_id, role, status, note, assigned_at, profiles(username, email)")
      .eq("match_id", matchId)
      .order("assigned_at", { ascending: true })
      .limit(50)
      .rows<AssignmentRow & { profiles?: { username: string; email: string | null } }>()
      .then((rows) => rows.map((r) => ({ ...r, username: r.profiles?.username ?? null, email: r.profiles?.email ?? null })));
  } catch (err) {
    throw toApiError(err, "match_assignments");
  }
}

export async function assignMatch(rest: SupabaseRest, args: { matchId: number; userId: string; role: string; note: string | null }): Promise<{ id: string }> {
  return call<{ id: string }>(rest, "kicklive_assign_match", { p_match_id: args.matchId, p_user_id: args.userId, p_role: args.role, p_note: args.note });
}

export async function standDownAssignment(rest: SupabaseRest, assignmentId: string): Promise<{ status: string }> {
  return call<{ status: string }>(rest, "kicklive_stand_down_assignment", { p_assignment_id: assignmentId });
}
