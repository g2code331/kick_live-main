/**
 * The browser's typed surface for the live match engine.
 *
 * Every call goes through `src/lib/api` — the one path the SPA is allowed to use to reach the Worker
 * (Phase 2 doctrine). Nothing here assembles a Supabase URL, sends a service-role key, or decides that a
 * write is allowed: `assertOnlyDeclared()` and the database's own guards decide that. What this file adds
 * is the client half of the contract: the payload types mirror `workers/src/types/api.ts`, and the field
 * names are pinned against it by `tests/unit/live-client.test.ts` so the copy cannot drift silently.
 *
 * Two consequences of that separation are worth stating, because they look like missing features:
 *
 *   - **No `home_score`/`away_score`/`minute`/`status` on a write.** The engine derives all four from the
 *     ledger and the server clock. A field the client must not send is a field that is absent from these
 *     types, not merely ignored at runtime.
 *   - **`expected_sequence` is a concurrency hint, not authority.** It says "I last saw N"; if that is
 *     wrong the server answers 409 with the real state rather than overwriting someone else's work.
 */
import { api, API_ROOT } from "@/lib/api";
import type { ApiFailure, ApiResult } from "@/lib/api";
import { getApiBaseUrl } from "@/lib/env.ts";
import type { LiveEvent, LiveMessage, LiveScore, MatchSnapshot, MatchStatus } from "./protocol.ts";

/** `POST /matches/:id/events` body. `client_event_id` is required: the same tap twice must not be two goals. */
export interface RecordEventInput {
  event_type: string;
  client_event_id: string;
  team_id?: number | null;
  player_id?: number | null;
  assist_player_id?: number | null;
  minute: number;
  extra_minute?: number;
  description?: string | null;
  goal_type?: string | null;
  card_reason?: string | null;
  metadata?: Record<string, unknown> | null;
  allow_duplicate_content?: boolean;
  expected_sequence?: number;
}

/** `PUT /matches/:id/state`. The only browser-visible way a status changes, and it names a target, not an opinion. */
export interface TransitionInput {
  status: MatchStatus;
  reason?: string;
  stoppage?: number;
  confirm?: boolean;
  expected_sequence?: number;
}

/** `POST /matches/:id/corrections`. The original row is never deleted; a replacement is optional. */
export interface CorrectionInput {
  event_id: number;
  reason: string;
  replacement?: Partial<RecordEventInput> | null;
  expected_sequence?: number;
  confirm?: boolean;
}

/** `POST /matches/:id/finalize`. The score is derived, so there is no score in this body. */
export interface FinalizeInput {
  confirm: true;
  note?: string;
}

export interface LockInput {
  locked: boolean;
  reason?: string;
}

export interface AssignInput {
  user_id: string;
  role: string;
  note?: string;
}

export type AssignmentRole = "head_referee" | "assistant_referee" | "fourth_official" | "var_official" | "match_commissioner" | "data_operator";

/** Mirrors `MatchRights` in `workers/src/services/matchAccess.ts`. */
export interface MatchRights {
  canWatch: true;
  canControl: boolean;
  canFinalize: boolean;
  canLock: boolean;
  canCorrectOwn: boolean;
  canCorrectAny: boolean;
  canReopen: boolean;
  assignments: AssignmentRole[];
  isAdmin: boolean;
  reason: string | null;
}

/** Mirrors `MatchMutationData`. */
export interface MatchMutationData {
  accepted: boolean;
  duplicate?: boolean;
  match_id: number;
  sequence: number | null;
  /** Exactly what the room broadcast, so a controller's own screen runs the same reducer as a fan's. */
  frame?: LiveMessage;
}

/** Mirrors `MatchEventsPageData`. */
export interface MatchEventsPageData {
  match_id: number;
  after_sequence: number;
  events: LiveEvent[];
  next_after_sequence: number | null;
  server_time: string;
}

/** Mirrors `MatchAccessData`. */
export interface MatchAccessData {
  match_id: number;
  status: MatchStatus;
  status_label: string;
  is_locked: boolean;
  protocol_version: number;
  rights: MatchRights;
  allowed_transitions: { to: MatchStatus; label: string; requires_confirmation: boolean; requires_closing_authority: boolean }[];
  assignments: { id: string; role: string; status: string; user_id: string; username: string | null; assigned_at: string }[];
  reason: string | null;
}

/** Mirrors `MatchAuditData`. */
export interface MatchAuditData {
  match_id: number;
  entries: { id: number; created_at: string; action: string; entity_name: string | null; actor: string | null; actor_role: string | null; details: Record<string, unknown> | null }[];
}

export interface MatchAssignmentListData {
  match_id: number;
  assignments: { id: string; role: string; status: string; user_id: string; username: string | null; assigned_at: string }[];
  you: { id: string; role: string; status: string; user_id: string; username: string | null; assigned_at: string } | null;
}

/** `GET /matches/:id` — the fan page's single round trip: the room's snapshot plus the timeline behind it. */
export interface MatchDetailData {
  match_id: number;
  snapshot: MatchSnapshot;
  /** Oldest first, unlike a snapshot's newest-first UI order. The reducer normalises it. */
  events: LiveEvent[];
  status: MatchStatus;
  clock: MatchSnapshot["clock"];
  score: LiveScore;
  server_time: string;
}

export interface MatchDiagnosticsData {
  match_id: number;
  [key: string]: unknown;
}

/**
 * `POST /matches/:id/live-ticket`.
 *
 * A browser cannot put an Authorization header on a WebSocket handshake, so the Worker mints a
 * short-lived, single-match, signed ticket and the socket presents that instead. `kind: "controller"` is
 * refused unless the assignment rows say so — the ticket is not a place to ask for more rights than the
 * session already has.
 */
export async function requestLiveTicket(matchId: number, kind: "viewer" | "controller"): Promise<LiveTicketResponse> {
  const result = await api.post<LiveTicketResponse>(`/matches/${String(matchId)}/live-ticket`, { kind });
  if (!result.ok) throw apiFailure(result);
  return result.data;
}

export interface LiveTicketResponse {
  ticket: string;
  kind: "viewer" | "controller";
  match_id: number;
  expires_in: number;
  expires_at: string;
  /** Relative path for `new WebSocket(...)`, so this file never has to know where the Worker is mounted. */
  ws_path: string;
}

/** Absolute `wss://`/`ws://` URL for a ticket's path, honouring an API base URL on another origin. */
export function liveSocketUrl(ticket: LiveTicketResponse): string {
  // The page's own origin, unless the SPA is built to talk to a Worker somewhere else. No literal host
  // appears in this file, so no build can quietly ship a fallback origin to the wrong place.
  const base = getApiBaseUrl() || (typeof location === "object" && location.origin ? location.origin : "");
  if (base.length === 0) throw new Error("liveSocketUrl: no origin available (no location, and VITE_API_BASE_URL is unset).");
  const url = new URL(ticket.ws_path.startsWith("/") ? ticket.ws_path : `/${ticket.ws_path}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket.ticket);
  return url.toString();
}

/**
 * The SSE fallback's URL. Deliberately a *relative* path: it is the same-origin `/api` the dev server
 * proxies and the Worker serves, so no environment variable can point a fan's browser at the wrong place.
 */
export function liveStreamUrl(matchId: number, afterSequence: number): string {
  const query = afterSequence > 0 ? `?after=${String(afterSequence)}` : "";
  return `${API_ROOT}/matches/${String(matchId)}/stream${query}`;
}

// ── reads ─────────────────────────────────────────────────────────────────────

export async function fetchMatchDetail(matchId: number): Promise<MatchDetailData> {
  return unwrap(await api.get<MatchDetailData>(`/matches/${String(matchId)}`));
}

export async function fetchSnapshot(matchId: number): Promise<MatchSnapshot> {
  return unwrap(await api.get<MatchSnapshot>(`/matches/${String(matchId)}/snapshot`));
}

export async function fetchEvents(matchId: number, afterSequence = 0, limit = 100): Promise<MatchEventsPageData> {
  return unwrap(await api.get<MatchEventsPageData>(`/matches/${String(matchId)}/events`, { query: { after_sequence: afterSequence, limit } }));
}

export async function fetchAccess(matchId: number): Promise<MatchAccessData> {
  return unwrap(await api.get<MatchAccessData>(`/matches/${String(matchId)}/access`));
}

export async function fetchAudit(matchId: number): Promise<MatchAuditData> {
  return unwrap(await api.get<MatchAuditData>(`/matches/${String(matchId)}/audit`));
}

export async function fetchAssignments(matchId: number): Promise<MatchAssignmentListData> {
  return unwrap(await api.get<MatchAssignmentListData>(`/matches/${String(matchId)}/assignments`));
}

export async function fetchDiagnostics(matchId: number): Promise<MatchDiagnosticsData> {
  return unwrap(await api.get<MatchDiagnosticsData>(`/matches/${String(matchId)}/diagnostics`));
}

// ── writes ────────────────────────────────────────────────────────────────────

export async function recordEvent(matchId: number, input: RecordEventInput): Promise<MatchMutationData> {
  return unwrap(await api.post<MatchMutationData>(`/matches/${String(matchId)}/events`, withoutNullish(input)));
}

export async function transitionMatch(matchId: number, input: TransitionInput): Promise<MatchMutationData> {
  return unwrap(await api.put<MatchMutationData>(`/matches/${String(matchId)}/state`, withoutNullish(input)));
}

export async function correctEvent(matchId: number, input: CorrectionInput): Promise<MatchMutationData> {
  return unwrap(await api.post<MatchMutationData>(`/matches/${String(matchId)}/corrections`, withoutNullish(input)));
}

export async function finalizeMatch(matchId: number, input: FinalizeInput): Promise<MatchMutationData> {
  return unwrap(await api.post<MatchMutationData>(`/matches/${String(matchId)}/finalize`, input));
}

export async function setMatchLock(matchId: number, input: LockInput): Promise<MatchMutationData> {
  return unwrap(await api.post<MatchMutationData>(`/matches/${String(matchId)}/lock`, input));
}

export async function assignOfficial(matchId: number, input: AssignInput): Promise<{ match_id: number; assignment_id: string; role: string }> {
  return unwrap(await api.post<{ match_id: number; assignment_id: string; role: string }>(`/matches/${String(matchId)}/assignments`, withoutNullish(input)));
}

export async function standDownAssignment(matchId: number, assignmentId: string): Promise<{ assignment_id: string; status: string }> {
  return unwrap(await api.post<{ assignment_id: string; status: string }>(`/matches/${String(matchId)}/assignments/stand-down`, { assignment_id: assignmentId }));
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Drops `undefined`/`null` keys.
 *
 * The Worker answers `assertOnlyDeclared()` failures with a 400 that names the offending key, and
 * `Fields` treats an explicit `null` differently from an absent key in a couple of places. Sending the
 * keys the controller actually chose keeps the audit trail honest too: `{player_id: null}` on a corner
 * would say "a player was chosen and it was nobody".
 */
function withoutNullish<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Unwraps the `{success,data}` envelope into a thrown `LiveApiError`.
 *
 * Throwing (rather than returning a result union) is what lets the draft queue's `classifyFailure` see one
 * shape for both a network failure and a server refusal, and it keeps every call site here three lines
 * instead of a branch that gets forgotten.
 */
export class LiveApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  readonly fields?: { field: string; message: string }[];
  /** A 409 from `expected_sequence` — the console shows the accepted state instead of the intended one. */
  readonly conflict: boolean;

  constructor(info: { code: string; status: number; message: string; detail?: string; fields?: { field: string; message: string }[] }) {
    super(info.message);
    this.name = "LiveApiError";
    this.code = info.code;
    this.status = info.status;
    this.detail = info.detail;
    this.fields = info.fields;
    this.conflict = info.status === 409;
  }
}

/**
 * One place that turns "something went wrong" into a sentence a controller can act on.
 *
 * `ApiFailure.message` is guaranteed safe to render (the Worker sanitises its own errors), and a thrown
 * non-`LiveApiError` is a programming fault — surfacing its text is still better than the generic line,
 * because the console is where those faults get noticed.
 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof LiveApiError) return err.message;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "The match server could not be reached.";
}

function apiFailure(failure: ApiFailure): LiveApiError {
  return new LiveApiError({ code: failure.code, status: failure.status, message: failure.message, detail: failure.detail, fields: failure.fields });
}

/** Every call in this file funnels through here, so one throw shape covers a 400, a 409 and a dead network. */
function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw apiFailure(result);
}

/** Re-exported so the hook does not import two modules for one job. */
export type { LiveEvent, LiveMessage, LiveScore, MatchSnapshot };
