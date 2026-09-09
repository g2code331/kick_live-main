/**
 * `GET /api/teams/mine` — resource-level authorization, demonstrated rather than described.
 *
 * The capability matrix can say "this account is a team_manager". Only a row predicate can answer
 * "and these are *your* clubs", which is the half that the browser was previously trusted with. Two
 * mechanisms do the work here, deliberately redundant:
 *
 *   1. the handler filters on `owner_id = <caller>` itself (`services/teamAccess.ts`);
 *   2. the read runs **with the caller's token**, so PostgREST+RLS applies the same predicate again —
 *      a bug in (1) cannot widen the result set, because the key in play has no more rights than the
 *      caller does.
 *
 * A fan is not rejected: the truthful answer to "which clubs do I manage" is an empty list plus a
 * `reason`, so the client can render "no club registered yet" instead of an error state. `501`
 * territory this is not — the route is real and returns real rows.
 */
import { ok } from "../lib/response.ts";
import { supabaseAsUser } from "../services/supabase.ts";
import { teamsOwnedBy } from "../services/teamAccess.ts";
import type { ManagedTeamsData } from "../types/api.ts";
import type { HandlerContext } from "./index.ts";

export async function handleMyTeams(ctx: HandlerContext): Promise<Response> {
  const token = ctx.principal.token;
  const role = ctx.principal.role;

  if (!token || (role !== "team_manager" && role !== "admin")) {
    return ok<ManagedTeamsData>({ teams: [], reason: "role_has_no_clubs" }, { requestId: ctx.requestId });
  }

  const teams = await teamsOwnedBy(supabaseAsUser(ctx.env, token), ctx.principal.userId);
  return ok<ManagedTeamsData>({ teams, reason: teams.length > 0 ? "ok" : "no_clubs_registered" }, { requestId: ctx.requestId });
}
