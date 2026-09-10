/**
 * Wire types for the routes that exist.
 *
 * Kept separate from `services/*` because a service returns rows and a route returns a contract: when
 * `TeamSummary` grows a column, `ManagedTeamsData.teams` must not change shape by accident. The SPA
 * mirrors these in `src/lib/api/types.ts` (two files, deliberately, since a shared module across the
 * Worker and the Vite build would need its own tsconfig and buy nothing at this size).
 */
import type { SafeProfile } from "../services/profiles.ts";
import type { TeamSummary } from "../services/teamAccess.ts";

export interface HealthData {
  service: "kick-live-api";
  status: "healthy";
  version: string;
  environment: string;
  /** Route-table census, so a deploy can be checked for having shipped the phase it claims. */
  routes: { total: number; declared: number; implemented: number };
  /** ISO instant of this response — lets the SPA tell a stale edge response from a live one. */
  time: string;
}

export type MeData = SafeProfile;

export interface ManagedTeamsData {
  teams: TeamSummary[];
  /**
   * Why the list is empty. A fan and a manager with no club both get `teams: []`; without this the
   * client has to guess, and the guess usually becomes a second API call.
   */
  reason: "ok" | "role_has_no_clubs" | "no_clubs_registered";
}

/** Query contract for `GET /api/matches` — declared now so Phase 2+ routes reuse it verbatim. */
export interface MatchListQuery {
  status?: string;
  competitionId?: number;
  from?: string;
  to?: string;
  limit: number;
}

// ── live match engine (Phase 3) ─────────────────────────────────────────────
//
// These are the *REST* payloads around the live protocol frames, not the frames themselves: the frames
// live in `workers/src/types/live.ts` and are mirrored by `src/lib/live/protocol.ts` for the browser.
// The rule that keeps them honest is `data.frame` — a controller's POST answers with the same object the
// fans' sockets received, so both sides run one reducer.

import type { LiveClock, LiveEvent, LiveMessage, LiveScore, MatchSnapshot } from "./live.ts";
import type { MatchStatus } from "../lib/matchLifecycle.ts";
import type { MatchRights } from "../services/matchAccess.ts";

/** `POST /matches/:id/events` and friends: the accepted frame plus how it was treated. */
export interface MatchMutationData {
  accepted: boolean;
  /** The event already existed for that `client_event_id`; nothing changed, nothing was duplicated. */
  duplicate?: boolean;
  match_id: number;
  sequence: number | null;
  /** Exactly what the room broadcast. */
  frame?: LiveMessage;
}

/** The room's answer to a mutation, before the route wraps it in the envelope. */
export interface MutationAck {
  accepted: boolean;
  duplicate?: boolean;
  changed?: boolean;
  frame?: LiveMessage;
  snapshot?: MatchSnapshot;
  corrected_event_id?: number;
  replacement_event_id?: number | null;
  reason?: string;
  score?: LiveScore;
  is_locked?: boolean;
}

/** `GET /matches/:id/events` */
export interface MatchEventsPageData {
  match_id: number;
  after_sequence: number;
  events: LiveEvent[];
  next_after_sequence: number | null;
  server_time: string;
}

/** `GET /matches/:id/access` */
export interface MatchAccessData {
  match_id: number;
  status: MatchStatus;
  status_label: string;
  is_locked: boolean;
  protocol_version: number;
  rights: MatchRights;
  allowed_transitions: { to: MatchStatus; label: string; requires_confirmation: boolean; requires_closing_authority: boolean; reason_required: boolean }[];
  assignments: { id: string; role: string; status: string; user_id: string; username: string | null; assigned_at: string }[];
  reason: string | null;
}

/** `GET /matches/:id/audit` */
export interface MatchAuditData {
  match_id: number;
  entries: { id: number; created_at: string; action: string; entity_name: string | null; actor: string | null; actor_role: string | null; details: Record<string, unknown> | null }[];
}

/** `POST /matches/:id/live-ticket` */
export interface LiveTicketData {
  ticket: string;
  kind: "viewer" | "controller";
  match_id: number;
  expires_in: number;
  expires_at: string;
  /** Relative path for `new WebSocket(...)`, so the SPA never assembles a Worker URL by hand. */
  ws_path: string;
}

/** The room's replay answer, which is also what the SSE poller relays. */
export interface MatchStreamFrame {
  mode: "events" | "snapshot";
  sequence: number;
  events: LiveEvent[];
  status: MatchStatus;
  score: LiveScore;
  clock: LiveClock;
  reason?: string;
}

export type { LiveClock, LiveEvent, LiveMessage, LiveScore, MatchSnapshot };
