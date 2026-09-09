/**
 * `GET /api/me` — the route whose job is to prove the chain works end to end:
 *
 *   browser → Worker → verified Supabase token → authoritative role from `profiles` → response
 *
 * Read-only, answered from what `authenticate` already resolved, and with the caller's own token for
 * the identity read, so RLS applies exactly as it does to the SPA today. If this route works, every
 * future route can be built on the same middleware without a new authorisation idea. The companion
 * that proves the *row-level* half is `routes/teams.ts`.
 */
import { ok } from "../lib/response.ts";
import { toSafeProfile } from "../services/profiles.ts";
import type { MeData } from "../types/api.ts";
import type { HandlerContext } from "./index.ts";

export async function handleMe(ctx: HandlerContext): Promise<Response> {
  // `authenticate` already resolved the role from `profiles`; re-reading it here would add a query
  // and change nothing. The payload is the safe projection, not the row.
  const data: MeData = toSafeProfile(ctx.principal);
  return ok(data, { requestId: ctx.requestId });
}
