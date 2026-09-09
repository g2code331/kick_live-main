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
