/**
 * Kick Live API Worker — entry point (Phase 1 skeleton).
 *
 * The order of operations below *is* the design: identity, then capability, then budget, then the
 * handler. Nothing in a handler may re-derive who the caller is, and nothing before `authenticate`
 * may look at the body.
 */
import type { Env } from "./env";
import { allowedOrigins, isProduction } from "./env";
import { matchRoute, ROUTES } from "./router";
import { roleHasCapability } from "./lib/capabilities";
import { ApiError, fail, health, json } from "./lib/response";
import { logError } from "./lib/debug";
import { authenticate } from "./middleware/auth";
import { BUDGETS, clientAddress, createRateLimiter } from "./middleware/ratelimit";
import { dispatchRoute } from "./routes";

const BUILD_VERSION = "0.0.0-phase1-skeleton";

/**
 * Headers the SPA's own CSP does not cover (that one protects the document; these protect the API
 * responses and any error page a browser might render for them).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "cache-control": "no-store",
};

function withSecurityHeaders(headers: Headers, corsOrigin: string | null): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (corsOrigin) {
    headers.set("access-control-allow-origin", corsOrigin);
    headers.set("vary", "origin");
  }
  return headers;
}

function corsOriginFor(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  // The desktop shell loads the renderer from `file://`, which arrives as no Origin at all for
  // same-origin requests; `null` as a string is what a sandboxed iframe sends. Neither is allowed.
  if (origin === "null") return null;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Public routes get an edge cache; anything else must never be shared between users. */
function cacheHeadersFor(cache: "edge" | "private" | "none"): Record<string, string> {
  if (cache === "edge") return { "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" };
  return { "cache-control": "no-store" };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id") ?? newRequestId();
    const corsOrigin = corsOriginFor(request, env);
    const limiter = createRateLimiter(env);

    // Preflight and health are outside the router: they exist for browsers and for monitoring, and
    // neither needs a principal.
    if (request.method === "OPTIONS") {
      const headers = new Headers();
      if (corsOrigin) {
        headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        headers.set("access-control-allow-headers", "authorization, content-type, x-request-id, turnstile-token, last-event-id");
        headers.set("access-control-max-age", "600");
      }
      return new Response(null, { status: 204, headers: withSecurityHeaders(headers, corsOrigin) });
    }

    if (url.pathname === "/v1/health" || url.pathname === "/health") {
      return new Response(health(BUILD_VERSION, ROUTES.length).body, {
        status: 200,
        headers: withSecurityHeaders(new Headers({ "content-type": "application/json; charset=utf-8", ...cacheHeadersFor("edge") }), corsOrigin),
      });
    }

    try {
      const matched = matchRoute(request.method, url.pathname);
      if (!matched) {
        throw new ApiError("not_found", 404, `No route for ${request.method} ${url.pathname}`);
      }
      const { route, params } = matched;

      const principal = await authenticate(request, env);
      if (route.capability && !roleHasCapability(principal.role, route.capability)) {
        // One message for "not allowed" and "not signed in", so the API does not enumerate who has
        // which role by probing routes.
        throw new ApiError("forbidden", 403, "This account is not permitted to perform that action.");
      }

      const budgetKey = route.capability ? `${route.capability}:${principal.userId || clientAddress(request)}` : `public:${clientAddress(request)}`;
      const budget = route.capability ? (BUDGETS[route.capability as keyof typeof BUDGETS] ?? BUDGETS["public.read"]) : BUDGETS["public.read"];
      const decision = await limiter.check(budgetKey, budget.limit, budget.windowSeconds);
      if (!decision.allowed) {
        throw new ApiError("rate_limited", 429, "Too many requests. Slow down.", `retry after ${String(decision.retryAfterSeconds)}s`);
      }

      const response = await dispatchRoute({ request, env, principal, params, requestId, limiter, route });
      const headers = withSecurityHeaders(new Headers(response.headers), corsOrigin);
      for (const [k, v] of Object.entries(cacheHeadersFor(route.cache))) headers.set(k, v);
      headers.set("x-request-id", requestId);
      headers.set("x-ratelimit-remaining", String(decision.remaining));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      logError(requestId, err);
      const response = fail(err, { exposeDetail: !isProduction(env), requestId });
      const headers = withSecurityHeaders(new Headers(response.headers), corsOrigin);
      headers.set("x-request-id", requestId);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  },

  /**
   * Queue consumer — Phase 4 owns the body (standings recompute, notification fan-out). Declared so
   * the binding shape and the failure semantics are decided now: retry with backoff, and a poison
   * message must go to a dead-letter queue rather than loop forever.
   */
  async queue(_batch: MessageBatch, _env: Env): Promise<void> {
    throw new ApiError("not_implemented", 501, "The queue consumer arrives with Phase 4 (background jobs).");
  },
};

/** Re-exported for the future integration tests and for `wrangler dev` debugging. */
export { ROUTES } from "./router";
export { capabilityTable } from "./lib/capabilities";
export { json };
