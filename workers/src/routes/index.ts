/**
 * Route handlers and the single dispatch point.
 *
 * `router.ts` declares the surface; this file implements what exists and answers 501 for everything
 * else. Keeping both in one dispatcher is deliberate: an undeclared path cannot be reached, and a
 * declared path cannot silently 404 — the two ways an API drifts away from its documentation.
 *
 * A route becomes real by (1) adding `implemented: true` and `handler` to its entry in `router.ts` and
 * (2) adding one line to `HANDLERS` below. Everything before those two lines — authentication,
 * capability check, rate limit, CORS, error envelope — already applies to it.
 */
import type { Env } from "../env.ts";
import { notImplemented } from "../lib/response.ts";
import type { Matched } from "../router.ts";
import type { Principal } from "../middleware/auth.ts";
import { handleHealth } from "./health.ts";
import { handleMe } from "./me.ts";
import { handleMyTeams } from "./teams.ts";

export interface HandlerContext {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly principal: Principal;
  readonly requestId: string;
  readonly clientAddress: string;
}

export type RouteHandler = (ctx: HandlerContext) => Promise<Response>;

/** Keyed by the same `pattern` strings used in `router.ts`. */
export const HANDLERS: Record<string, RouteHandler> = {
  "/health": handleHealth,
  "/me": handleMe,
  "/teams/mine": handleMyTeams,
};

export async function dispatchRoute(ctx: HandlerContext, match: Matched): Promise<Response> {
  const handler = HANDLERS[match.route.pattern];
  if (!handler || !match.route.implemented) {
    // Thrown rather than returned so the entry point's catch applies CORS + security headers to it too.
    throw notImplemented(match.route.summary, match.route.phase, "The route is declared in router.ts; its handler is not written yet.");
  }
  return handler(ctx);
}
