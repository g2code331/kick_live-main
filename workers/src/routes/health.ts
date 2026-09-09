/**
 * `GET /api/health` — the one route that answers before authentication, because a probe that needs a
 * token is a probe that fails during a deploy.
 *
 * What it says is limited on purpose: version, environment, route census. It does not report whether
 * Supabase is reachable, which keys are set, or how many rows exist — a 200 with that in the body is a
 * reconnaissance gift. Deep checks live in `GET /api/admin/health/deep` (admin capability, Phase 2+).
 *
 * `cache: "edge"` in the route table means the edge may answer this for 60 s without waking the
 * Worker, which is why the limiter deliberately does not budget public reads.
 */
import { APP_VERSION } from "../env.ts";
import { ROUTES } from "../router.ts";
import { ok } from "../lib/response.ts";
import type { HealthData } from "../types/api.ts";
import type { HandlerContext } from "./index.ts";

export function healthPayload(env: { APP_ENV?: string }): HealthData {
  const implemented = ROUTES.filter((route) => route.implemented).length;
  return {
    service: "kick-live-api",
    status: "healthy",
    version: APP_VERSION,
    environment: env.APP_ENV ?? "development",
    routes: { total: ROUTES.length, declared: ROUTES.length, implemented },
    time: new Date().toISOString(),
  };
}

export async function handleHealth(ctx: HandlerContext): Promise<Response> {
  return ok(healthPayload(ctx.env), { requestId: ctx.requestId });
}
