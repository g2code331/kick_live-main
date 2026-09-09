/**
 * Resource-level authorization: "authenticated as a team manager" is not "allowed to edit this team".
 *
 * The capability matrix (`lib/capabilities.ts`) answers role questions. It cannot answer
 * "is this club yours?" — that is a row predicate, and it is why `team_manager` is absent from the
 * row-scoped capabilities on purpose. Every route that takes a `:teamId`/`:matchId` must call through
 * here (or its match equivalent) before it touches data; the read is done **with the caller's own
 * token**, so PostgREST+RLS apply the same rule a second time and a Worker bug cannot outrun the
 * policy.
 *
 * The admin short-circuit is not a shortcut around ownership: admins act on other people's clubs by
 * design (approve a registration, fix a squad). What is *not* allowed is for a caller who lacks
 * `team.update_own` to reach this function at all — the route's capability check runs first.
 */
import { ApiError } from "../lib/response.ts";
import type { SupabaseRest } from "./supabase.ts";
import type { Principal } from "../middleware/auth.ts";

export interface TeamSummary {
  id: number;
  name: string;
  short_name: string;
  status: string;
  owner_id: string | null;
}

/** Teams whose `owner_id` is this user. RLS also hides everything else, so the filter is defence in depth. */
export async function teamsOwnedBy(rest: SupabaseRest, userId: string): Promise<TeamSummary[]> {
  return rest.from("teams").select("id, name, short_name, status, owner_id").eq("owner_id", userId).order("name").limit(50).rows<TeamSummary>();
}

/**
 * Ownership test for one team. `null` means "no such team, or not yours" — the same answer either way,
 * because confirming that a row exists is information a prober does not need.
 */
export async function managedTeamOrNull(rest: SupabaseRest, principal: Principal, teamId: number): Promise<TeamSummary | null> {
  if (principal.role === "admin") {
    return rest.from("teams").select("id, name, short_name, status, owner_id").eq("id", teamId).maybeSingle<TeamSummary>();
  }
  if (principal.role !== "team_manager") return null;
  return rest.from("teams").select("id, name, short_name, status, owner_id").eq("id", teamId).eq("owner_id", principal.userId).maybeSingle<TeamSummary>();
}

export async function requireManagedTeam(rest: SupabaseRest, principal: Principal, teamId: number): Promise<TeamSummary> {
  const team = await managedTeamOrNull(rest, principal, teamId);
  if (!team) {
    throw new ApiError("FORBIDDEN", 403, "No club matching that id is managed by this account.");
  }
  return team;
}
