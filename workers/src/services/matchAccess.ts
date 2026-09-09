/**
 * Who may control this match — and the fact that "may control" is not a profile role.
 *
 * The database has four application roles (`fan`, `team_manager`, `media`, `admin`). None of them means
 * "referee": `admin` is the whole platform, `team_manager` owns a club, `media` publishes. So match
 * control comes from an **assignment row** (`public.match_assignments`, created by the Phase 3
 * migration), read per request, and the rules the product needs fall out of that:
 *
 *   - `admin` controls any match (including reopening a finished one, with a reason);
 *   - an assigned official controls only the match they are assigned to, and only while their
 *     assignment is `assigned`;
 *   - `team_manager` gets no control from owning a club — explicitly, by omission — and cannot be
 *     assigned to officiate a match involving their own club (`kicklive_assign_match` refuses it);
 *   - `media` and `fan` watch. The console renders read-only, and the API refuses their writes.
 *
 * Fail-closed rule, shared with Phase 1: if `match_assignments` does not exist yet (the migration has
 * been prepared, not applied), nobody is an official, `canControl` is false for everyone except an
 * admin, and the `reason` says why. A missing table must never degrade into "allow it".
 */
import type { AppRole } from "../env.ts";
import { ApiError } from "../lib/response.ts";
import type { Principal } from "../middleware/auth.ts";
import type { SupabaseRest } from "./supabase.ts";

export type AssignmentRole = "head_referee" | "assistant_referee" | "fourth_official" | "var_official" | "match_commissioner" | "data_operator";

/** Roles that may record live events. `match_commissioner`/`data_operator` are reporting-only. */
export const CONTROLLING_ASSIGNMENTS: readonly AssignmentRole[] = ["head_referee", "assistant_referee", "fourth_official", "var_official"];

/** Roles that may finalize/lock (a stand-in referee may not close a match). */
export const CLOSING_ASSIGNMENTS: readonly AssignmentRole[] = ["head_referee", "match_commissioner"];

export const ALL_ASSIGNMENT_ROLES: readonly AssignmentRole[] = ["head_referee", "assistant_referee", "fourth_official", "var_official", "match_commissioner", "data_operator"];

export interface MatchRow {
  id: number;
  status: string;
  home_score: number | null;
  away_score: number | null;
  minute: number | null;
  home_team_id: number | null;
  away_team_id: number | null;
  venue: string | null;
  start_time: string | null;
  match_start_time: string | null;
  elapsed_seconds_before_pause: number | null;
  is_locked: boolean | null;
  confirmed_at: string | null;
  live_seq: number | null;
  attendance: number | null;
  round: string | null;
  referee: string | null;
  competition_id: number | null;
  competitions: { name: string } | null;
  home_team: { name: string; short_name: string; primary_color: string | null } | null;
  away_team: { name: string; short_name: string; primary_color: string | null } | null;
}

export interface MatchRights {
  canWatch: true;
  canControl: boolean;
  canFinalize: boolean;
  canLock: boolean;
  /** Correct an event this account recorded, while the match is still running. */
  canCorrectOwn: boolean;
  /** Correct anyone's event, at any time — the greater authority admins are given. */
  canCorrectAny: boolean;
  /** Change the status of a finished match (reopen / un-finalize). */
  canReopen: boolean;
  assignments: AssignmentRole[];
  isAdmin: boolean;
  /** Why control is unavailable, in the words the console shows. Never a stack trace. */
  reason: string | null;
}

export interface MatchAccess {
  match: MatchRow;
  rights: MatchRights;
  /** True when the caller owns one of the two clubs (used for "your club's match" framing, never for control). */
  ownsAClubInThisMatch: boolean;
}

const MATCH_SELECT =
  "id, status, home_score, away_score, minute, home_team_id, away_team_id, venue, start_time, match_start_time, elapsed_seconds_before_pause, is_locked, confirmed_at, live_seq, attendance, round, referee, competition_id, competitions(name), home_team:teams!home_team_id(name, short_name, primary_color), away_team:teams!away_team_id(name, short_name, primary_color)";

export async function loadMatch(rest: SupabaseRest, matchId: number): Promise<MatchRow | null> {
  return rest.from("matches").select(MATCH_SELECT).eq("id", matchId).maybeSingle<MatchRow>();
}

/** The caller's live assignments for one match. RLS exposes their own rows, and admins' view of all. */
async function myAssignments(rest: SupabaseRest, matchId: number, userId: string): Promise<{ roles: AssignmentRole[]; error: string | null }> {
  try {
    const rows = await rest
      .from("match_assignments")
      .select("role, status")
      .eq("match_id", matchId)
      .eq("user_id", userId)
      .eq("status", "assigned")
      .limit(12)
      .rows<{ role: string; status: string }>();
    return { roles: rows.map((r) => r.role as AssignmentRole).filter((r) => ALL_ASSIGNMENT_ROLES.includes(r)), error: null };
  } catch (err) {
    if (err instanceof ApiError && (err.detail ?? "").match(/42P01|relation .* does not exist|Could not find the table|PGRST205/)) {
      return { roles: [], error: "match_assignments is missing: apply supabase/migrations/20260909210000_phase3_live_match_engine.sql to enable referee control" };
    }
    throw err;
  }
}

async function ownsOneOfTheseClubs(rest: SupabaseRest, userId: string, teamIds: number[]): Promise<boolean> {
  if (teamIds.length === 0) return false;
  const rows = await rest.from("teams").select("id").eq("owner_id", userId).in("id", teamIds).limit(2).rows<{ id: number }>();
  return rows.length > 0;
}

/**
 * Resolve the match *and* the rights in one call, so a route cannot accidentally act on a row it never
 * checked. The 404 vs 403 split matters: a match that does not exist is a 404 for everyone; a match the
 * caller may not control still 404s on the *read* path only when it is genuinely invisible to them.
 */
export async function resolveMatchAccess(rest: SupabaseRest, principal: Principal, matchId: number): Promise<MatchAccess> {
  const match = await loadMatch(rest, matchId);
  if (!match) throw new ApiError("NOT_FOUND", 404, "No match with that id.");

  const role: AppRole | null = principal.role;
  const isAdmin = role === "admin";
  const { roles: assignments, error } = isAdmin ? { roles: [], error: null } : await myAssignments(rest, matchId, principal.userId);
  const ownsAClubInThisMatch = !isAdmin && role === "team_manager" && principal.userId !== "" ? await ownsOneOfTheseClubs(rest, principal.userId, [match.home_team_id, match.away_team_id].filter((v): v is number => typeof v === "number")) : false;

  const controls = isAdmin || assignments.some((a) => CONTROLLING_ASSIGNMENTS.includes(a));
  const closes = isAdmin || assignments.some((a) => CLOSING_ASSIGNMENTS.includes(a));

  const rights: MatchRights = {
    canWatch: true,
    canControl: controls,
    canFinalize: closes,
    canLock: isAdmin,
    canCorrectOwn: controls,
    canCorrectAny: isAdmin,
    canReopen: isAdmin,
    assignments,
    isAdmin,
    reason: controls ? error : (error ?? (role === "team_manager" && ownsAClubInThisMatch ? "You manage a club in this match, so you may not control it." : "You are not an assigned official for this match.")),
  };

  return { match, rights, ownsAClubInThisMatch };
}

export function assertCanControl(access: MatchAccess, action = "record events in"): void {
  if (access.rights.canControl) return;
  throw new ApiError("FORBIDDEN", 403, `This account may not ${action} match ${String(access.match.id)}. ${access.rights.reason ?? ""}`.trim());
}

export function assertCanClose(access: MatchAccess): void {
  if (access.rights.canFinalize) return;
  throw new ApiError("FORBIDDEN", 403, "Only the head referee, the match commissioner or an admin may close or finalize this match.");
}

export function assertNotLocked(access: MatchAccess): void {
  if (!access.match.is_locked || access.rights.canLock) return;
  throw new ApiError("CONFLICT", 409, "This match is locked. A platform admin must unlock it before anything else is recorded.", {
    detail: `is_locked=true on match ${String(access.match.id)}`,
  });
}

export function isAssignmentRole(value: unknown): value is AssignmentRole {
  return typeof value === "string" && (ALL_ASSIGNMENT_ROLES as readonly string[]).includes(value);
}
