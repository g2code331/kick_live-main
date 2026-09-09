/**
 * Where route handlers will live. In Phase 1 the table is empty on purpose.
 *
 * A route is added here in the same commit that moves the matching browser call site off the direct
 * Supabase path — never before, because a half-moved write is the worst state this product can be in
 * (two code paths, two validation rules, one of them unenforced). `workers/README.md` maps each route
 * to its phase; `docs/PRODUCTION_MIGRATION_PLAN.md` says what the SPA stops doing in that phase.
 *
 * Contracts worth freezing now, because they are the ones the SPA has to code against:
 *
 * POST /v1/matches/:matchId/events
 *   in : { client_event_id: string(uuid, idempotency key), event_type, minute, extra_minute?,
 *          team_id?, player_id?, assist_player_id?, description?, goal_type?, card_reason? }
 *   out: { event: {...}, match: { home_score, away_score, minute, status } }
 *   rules: `event_type` must be in the profile's CHECK list; `minute` 0..(90 + added, or 120 for
 *          extra time) — an event after full time is a data-entry bug and is refused, not clamped;
 *          a goal event *derives* the score change server-side instead of trusting a score in the
 *          body; replays of the same client_event_id return the original row (200, not 201).
 *
 * PUT /v1/matches/:matchId/state
 *   in : { status: 'scheduled'|'live'|'half_time'|'finished'|'abandoned'|'postponed', minute?, clock_action?: 'start'|'stop'|'reset' }
 *   out: { match: {...}, allowed: true }
 *   rules: illegal transitions (finished → live) are 409 unless the caller holds match_control.lock;
 *          writes to a locked match are 409 with the lock reason so the UI can explain itself.
 *
 * POST /v1/auth/access-requests
 *   in : { requested_role: 'team_manager'|'media', reason: string(10..1000) }
 *   out: { request: { id, status: 'pending', created_at } }
 *   rules: the RPC owns validation; the Worker only adds Turnstile + rate limit + the audit row.
 *
 * All handlers share these rules: parse the body into a typed shape before touching the database;
 * never accept a role, an author id, or an owner id from the body; write the audit row for anything
 * privileged; return `400 bad_request` with a per-field `detail` in non-production only.
 */
import type { RouteDef } from "../router";
import type { Env } from "../env";
import type { Principal } from "../middleware/auth";
import type { RateLimiter } from "../middleware/ratelimit";
import { notImplemented } from "../lib/response";

export interface HandlerContext {
  request: Request;
  env: Env;
  principal: Principal;
  params: Record<string, string>;
  requestId: string;
  limiter: RateLimiter;
  route: RouteDef;
}

export type Handler = (ctx: HandlerContext) => Promise<Response>;

/** Filled in Phase 2+, keyed by the exact `RouteDef.pattern`. */
export const HANDLERS: Readonly<Record<string, Handler>> = {};

export async function dispatchRoute(ctx: HandlerContext): Promise<Response> {
  const handler = HANDLERS[ctx.route.pattern] as Handler | undefined;
  if (handler) return handler(ctx);
  throw notImplemented(`${ctx.route.method} /v1${ctx.route.pattern}`, ctx.route.phase, `${ctx.route.summary}${ctx.route.invariants ? ` — invariants: ${ctx.route.invariants}` : ""}`);
}
