/**
 * Authorization: may this caller do this thing.
 *
 * Authentication (`middleware/auth.ts`) says who, this module says whether, and resource ownership
 * (`services/teamAccess.ts`) says whether *this row*. A route composes the three and never writes its
 * own role comparison — that is how the portals ended up with eleven slightly different `isAdmin`
 * checks in Phase 1.
 *
 * Message policy: the same wording for "not allowed" and "not found but not yours". A distinct
 * 404-vs-403 answer turns the API into an oracle for enumerating ids and roles.
 */
import type { AppRole, Env } from "../env.ts";
import type { Capability } from "../lib/capabilities.ts";
import { roleHasCapability } from "../lib/capabilities.ts";
import { ApiError } from "../lib/response.ts";
import { requireAuth } from "./auth.ts";
import type { Principal } from "./auth.ts";

export const DENIED = "This account is not permitted to perform that action.";

/**
 * The entry point's single authorization step for a route: no capability → public; capability + no
 * session → 401; capability the role does not hold → 403. Ordering matters more than the code — this
 * runs before `dispatchRoute`, so a declared-but-unbuilt admin route still refuses a fan instead of
 * advertising which routes exist.
 */
export function authorizeForRoute(principal: Principal, capability: Capability | null): void {
  if (capability === null) return;
  // Anything that is not the one capability an anonymous caller holds goes through the reusable guard
  // first, so the 401 comes from `requireAuth` (the same call a handler may repeat defensively) and the
  // 403 comes from the matrix. Order matters: an unauthenticated probe should not learn that a route
  // exists and is merely closed to it.
  if (capability !== "public.read") requireAuth(principal);
  decide(principal, capability);
}

/** A caller whose identity is verified *and* whose role the database confirmed a moment ago. */
export type Authorized = Principal & { role: AppRole; userId: string };

export function requireCapability(principal: Principal, capability: Capability): Authorized {
  decide(principal, capability);
  if (principal.userId === "" || principal.role === null) {
    // Only reachable for a capability anonymous callers do not hold — `public.read` passes below.
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }
  return principal as Authorized;
}

/**
 * The matrix is the only authority here, including for "no session": `public.read` is held by
 * anonymous callers on purpose (see `roleHasCapability`), because the public read paths stay reachable
 * without a token and a declared-but-unbuilt public route must answer 501 rather than pretend to be
 * private. A route that needs a session names a capability no anonymous role holds, and gets 401 from
 * the same two lines.
 */
function decide(principal: Principal, capability: Capability): void {
  if (roleHasCapability(principal.role, capability)) return;
  throw new ApiError(principal.userId === "" ? "UNAUTHENTICATED" : "FORBIDDEN", principal.userId === "" ? 401 : 403, principal.userId === "" ? "Authentication required." : DENIED);
}

/**
 * Coarse role checks for the rare route where "which role" genuinely is the question (an admin-only
 * settings screen, say). Prefer `requireCapability`: naming a capability keeps the matrix the single
 * place roles are defined.
 */
export function requireRole(principal: Principal, ...roles: readonly AppRole[]): Authorized {
  if (principal.userId === "" || principal.role === null) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }
  if (!roles.includes(principal.role)) throw new ApiError("FORBIDDEN", 403, DENIED);
  return principal as Authorized;
}

/** A user may act on their own rows; nobody may act on someone else's by naming their id. */
export function requireSameUser(principal: Principal, subjectUserId: string): Authorized {
  if (principal.userId === "") throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  if (principal.userId !== subjectUserId) throw new ApiError("FORBIDDEN", 403, DENIED);
  return principal as Authorized;
}

/** For handlers that need the service-role client: prove the caller was entitled before you use it. */
export function assertElevatedWrite(env: Env, actor: Authorized, reason: string): void {
  if (actor.role !== "admin") {
    throw new ApiError("FORBIDDEN", 403, DENIED);
  }
  // `reason` exists so every `supabaseAdmin()` write carries a one-line justification in review.
  if (reason.trim().length < 12) {
    throw new ApiError("INTERNAL_ERROR", 500, "A service-role write must document why RLS was not enough.");
  }
}
