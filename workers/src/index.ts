/**
 * Kick Live API Worker — entry point.
 *
 * The order below *is* the design, and it is enforced once, here, rather than per route:
 *
 *   1. preflight (CORS) — answered without touching the router;
 *   2. route match — an unmatched path 404s before anything else is consulted;
 *   3. authenticate — `Authorization: Bearer` → verified JWT → authoritative role from Postgres;
 *   4. authorize — the route's capability, via the matrix. Runs **before** the 501 stub, so a fan
 *      probing an admin route that is declared but not built gets 403, never a "not implemented";
 *   5. rate limit — per route class, bucketed by identity (or IP when anonymous);
 *   6. validate — inside the handler, on every mutation (`routes/*` never forwards a raw body);
 *   7. handler → `services/*` → Supabase;
 *   8. finalize headers (cache class, security, request id, CORS echo) — on success *and* on error.
 *
 * Every throw, including an unexpected one, leaves through `fail()` in `lib/response.ts`: the client
 * sees `{ success: false, error: { code, message } }`, and the detail stays in the Worker log. The one thing
 * Phase 9 adds to that path is a response header (`x-error-category`, from `lib/errors.ts`) — a header, not a
 * body field, so a client that reads the envelope is untouched while a dashboard can group by layer.
 *
 * Steps 9 and 10 are the observability tail, and they run on both the success and the failure path:
 * `observeRequest` (one folded log line plus the metric samples) and `maybeFlush` (a throttled hand-off of
 * buffered samples to the database, never on the request's critical path).
 */
import type { Env } from "./env.ts";
import { isProduction } from "./env.ts";
import { logError } from "./lib/debug.ts";
import { cacheHeadersFor, newRequestId, requestIdFrom, withSecurityHeaders, type CacheClass } from "./lib/headers.ts";
import { ApiError } from "./lib/response.ts";
import { failWithCategory } from "./lib/errors.ts";
import { authenticate, type Principal } from "./middleware/auth.ts";
import { authorizeForRoute } from "./middleware/authorization.ts";
import { applyCors, corsOriginFor, preflightResponse } from "./middleware/cors.ts";
import { BUDGETS, clientAddress, createRateLimiter, limitKeyFor, rateLimitHeaders, type RateDecision } from "./middleware/ratelimit.ts";
import { maybeFlush, observe, observeRequest, probeDependencies, runObservabilityMaintenance, subsystemFor } from "./lib/observability.ts";
import { classify } from "./lib/errors.ts";
import { auditRouteOutcome, shouldAuditRoute } from "./middleware/audit.ts";
import { handleNotificationQueue, sweepNotifications, type QueueBatch } from "./queues/notifications.ts";
import { handleAdEventQueue, runAdMaintenance } from "./queues/ads.ts";
import { MEDIA_SWEEP_CRON, sweepMedia } from "./services/mediaStore.ts";
import { matchRoute, stripApiPrefix, type RouteDef } from "./router.ts";
import { dispatchRoute } from "./routes/index.ts";

interface Finalised {
  readonly response: Response;
  readonly corsOrigin: string | null;
  readonly requestId: string;
  readonly cache: CacheClass;
  readonly rate?: RateDecision;
  /** Filled in by `handle` as it goes, so the catch path can describe a request that never reached a handler. */
  readonly trace?: RequestTrace;
}

/**
 * What the middleware layer knows about a request before a handler is involved: which route matched, who the
 * caller was, whether the edge already had the answer. A handler never writes to it, which is what keeps the
 * metrics honest — an instrumented route and an uninstrumented one are counted identically.
 */
interface RequestTrace {
  pattern?: string;
  method: string;
  role?: string | null;
  rateClass?: string;
  /** The caller's own id when it sent one. Carried, never trusted — `requestIdFrom` already decided that. */
  clientRequestId?: string | null;
}

// Durable Object classes must be exported from the entrypoint module itself — a binding in the TOML
// whose class is only reachable through the fetch handler's imports is a build-time throw ("not
// exported in your entrypoint file"), not a runtime surprise. `tests/unit/phase2-api-boundary.test.ts`
// pins the pairing.
export { MatchRoom } from "./do/MatchRoom.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const requestId = requestIdFrom(request.headers.get("x-request-id"));
    const corsOrigin = corsOriginFor(request, env);
    const trace: RequestTrace = { method: request.method, clientRequestId: request.headers.get("x-request-id") };
    try {
      const out = await handle(request, env, ctx, requestId, corsOrigin, trace);
      const response = finalise(out);
      observeRequest(
        {
          requestId,
          clientRequestId: trace.clientRequestId,
          method: request.method,
          pattern: trace.pattern ?? "unmatched",
          status: response.status,
          durationMs: Date.now() - started,
          cacheClass: out.cache,
          cacheState: cacheStateFrom(request, response),
          rateClass: trace.rateClass,
          role: trace.role,
          subsystem: subsystemFor(trace.pattern ?? ""),
          bytes: contentLengthOf(response),
        },
        env,
      );
      maybeFlush(env, ctx);
      return response;
    } catch (err) {
      // One log line carrying the request id; the response carries the safe envelope and nothing else.
      logError(requestId, err);
      const response = finalise({
        response: failWithCategory(err, { exposeDetail: !isProduction(env), requestId }),
        corsOrigin,
        requestId,
        cache: "none",
      });
      observeRequest(
        {
          requestId,
          clientRequestId: trace.clientRequestId,
          method: request.method,
          pattern: trace.pattern ?? "unmatched",
          status: response.status,
          durationMs: Date.now() - started,
          cacheClass: "none",
          rateClass: trace.rateClass,
          role: trace.role,
          subsystem: subsystemFor(trace.pattern ?? ""),
          category: classify(err).category,
          bytes: contentLengthOf(response),
          // No message here on purpose. `logError` above already wrote the detailed one with this request id;
          // copying the sentence into the structured line would put a driver's error text in the log twice,
          // and the second copy is the one that gets shipped to a third-party log drain.
        },
        env,
      );
      maybeFlush(env, ctx);
      return response;
    }
  },

  // Phase 5 adds two non-HTTP entry points, and they are here rather than in a second Worker because a second
  // Worker would need its own secrets, its own CORS story and its own deploy — for a job that shares all of
  // this Worker's configuration. A queue failure is invisible to a user (the push arrives late, or the sweep
  // finds it), so neither handler may turn into an unhandled rejection: they log with a join key and rethrow,
  // which leaves the messages un-acked for redelivery instead of swallowing them.

  /** Fan-out for notification jobs. `queues.consumers` in wrangler.toml decides what a failure costs. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const queueStarted = Date.now();
    // Which consumer a batch goes to has to be decided by the queue it arrived on, because one Worker now
    // serves two `queue.consumer` bindings. `MessageBatch#queue` is the queue's *name*, and the names are the
    // vars below rather than strings duplicated from wrangler.toml: a test asserts each pair agrees, which is
    // the only defence against renaming a queue in one file and silently sending measurements to the
    // notification fan-out. An unrecognised name is a config error, and says so, rather than acking.
    const queueName = (batch as unknown as { queue?: string }).queue;
    const adQueue = env.AD_EVENTS_QUEUE_NAME;
    // One sample per batch, whichever consumer takes it: depth and duration of the *queue* is the thing an
    // operator needs when the fan-out is behind, and it is the only measurement that exists at this layer.
    observeRequestQueue(batch.messages.length, queueName, queueStarted, adQueue);
    if (adQueue && queueName === adQueue) {
      await handleAdEventQueue(batch as unknown as QueueBatch, env);
      return;
    }
    if (adQueue && queueName && env.NOTIFICATION_QUEUE_NAME && queueName !== env.NOTIFICATION_QUEUE_NAME) {
      throw new Error(`no consumer configured for queue ${queueName}`);
    }
    await handleNotificationQueue(batch as unknown as QueueBatch, env);
  },

  /**
   * The five-minute safety net: re-enqueue what the queue lost, prune dead device rows hourly.
   *
   * Phase 6 hangs media retention off the same entry point rather than adding a second Worker:
   * it needs the same secrets, the same bucket binding and the same queue, and a separate deploy
   * for nine lines of code would double the number of places a credential can leak from. The two
   * schedules are told apart by the cron expression itself — which is why `MEDIA_SWEEP_CRON` is a
   * constant both this file and `workers/wrangler.toml` refer to, and why a test asserts the two
   * agree (`tests/unit/phase2-api-boundary.test.ts`).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronStarted = Date.now();
    if (controller.cron === MEDIA_SWEEP_CRON) {
      try {
        // Advertising maintenance rides the hourly media sweep rather than getting its own cron line for the
        // same reason the notification sweep shares one: a second schedule is a second place for a deploy to
        // be wrong, and neither job is latency-sensitive. Expiry only has to be prompt-ish because `serve`
        // decides eligibility at request time and will not show a creative whose window has closed — this pass
        // exists so that the *tables* say what the *answer* said, and so retention actually prunes.
        await runAdMaintenance(env);
        await sweepMedia(env);
      } catch (err) {
        logError(`media-sweep-${controller.cron.replace(/\s+/g, "-")}`, err);
      }
      // The hourly pass also carries Phase 9's *heavy* work: the day's compaction and the retention sweep,
      // next to the dependency probes. Hourly rather than every five minutes because a rollup of a day that is
      // still in progress is wasted arithmetic, and because a second cron line for eleven lines of code would
      // be one more place for a deploy to be wrong.
      try {
        await runObservabilityMaintenance(env, { reason: "media-sweep" });
      } catch (err) {
        logError(`observability-maintenance-${controller.cron.replace(/\s+/g, "-")}`, err);
      }
      return;
    }
    try {
      await sweepNotifications(env, ctx);
      // The five-minute pass only asks "is it up", never "delete what is old": this is the beat that keeps
      // `system_health` fresh, which is what the staleness alert and the public panel read. A probe that
      // throws must not fail the sweep that already ran, so it is caught on its own and reported as itself.
      await probeDependencies(env).catch((err) => {
        logError("observability-probe", err);
        return { supabaseOk: false, r2: { component: "worker" as const, status: "unavailable" as const, reason: "PROBE_CRASHED" }, derived: null, durationMs: 0 };
      });
      observe({ subsystem: "system", metric: "cron", dimension: "notification-sweep", samples: 1, durationMs: Date.now() - cronStarted });
    } catch (err) {
      // A sweep that throws because the Phase 5 migration has not been applied is a configuration state, not an
      // outage: log it once per run with enough to name it, and let the next run try again.
      logError(controller.cron ? `notification-sweep-${controller.cron}` : "notification-sweep", err);
      throw err;
    }
  },
};

async function handle(request: Request, env: Env, ctx: ExecutionContext, requestId: string, corsOrigin: string | null, trace: RequestTrace): Promise<Finalised> {
  const url = new URL(request.url);

  // 1. Preflight. A disallowed origin gets 204 with no `access-control-allow-*` — the browser blocks
  //    it. Not a 403: a distinct answer on OPTIONS is an origin oracle.
  if (request.method === "OPTIONS") {
    return { response: preflightResponse(corsOrigin), corsOrigin, requestId, cache: "none" };
  }

  // 2. Route match.
  const matched = matchRoute(request.method, url.pathname);
  if (!matched) {
    const path = stripApiPrefix(url.pathname);
    const samePathOtherMethod = matchRoute("GET", url.pathname);
    throw new ApiError(
      samePathOtherMethod ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
      samePathOtherMethod ? 405 : 404,
      samePathOtherMethod ? `${request.method} is not allowed on ${path}.` : `No route for ${request.method} ${path}.`,
    );
  }
  const { route, params } = matched;
  // From here on, a failure is attributable to a route rather than to "the API", which is the difference
  // between a metric that says 3% of requests failed and one that says 3% of `PUT /matches/:matchId/state`
  // did. The trace is filled before authentication so that a 401 is still counted against its route.
  trace.pattern = route.pattern;
  trace.rateClass = route.rateLimit ?? "public";

  // 3. Authentication. No `Authorization` header → anonymous principal, no network call.
  const principal: Principal = await authenticate(request, env);

  // 4. Authorization. `orAssigned` routes keep an anonymous caller out and let an authenticated one
  // through to the handler, which must prove the per-match assignment before it touches anything.
  authorizeForRoute(principal, route.capability, { allowAssignment: route.orAssigned === true });
  trace.role = principal.role;

  // 5. Rate limit.
  const rate = await limitRequest(request, env, route, principal);

  // 6–7. Handler.
  const response = await dispatchRoute({ request, env, ctx, url, params, principal, requestId, clientAddress: clientAddress(request) }, matched);

  // 8. Audit, for the privileged mutations only. After the handler, so the status recorded is the status that
  //    was sent rather than one that was intended; off the response path, so a fan's score never waits for
  //    an insert. A route whose SQL function already wrote a richer row is skipped by `AUDITED_IN_SQL`, and a
  //    caller acting on their own account is skipped by the capability list. A request that threw before a
  //    handler ran is not audited at all: a denied attempt is a metric and a log line, not an entry in the
  //    evidence file, and an audit table an attacker can fill by trying is not evidence either.
  if (shouldAuditRoute(route)) {
    auditRouteOutcome(
      {
        env,
        method: route.method,
        pattern: route.pattern,
        status: response.status,
        requestId,
        principal,
        params,
        role: principal.role,
      },
      ctx,
    );
  }

  return { response, corsOrigin, requestId, cache: route.cache, rate, trace };
}

/**
 * Budget by route class, bucket by identity. `route.rateLimit` in `router.ts` is the whole
 * configuration surface for a new endpoint — which is deliberate: the dangerous version of this file is
 * one where protecting an endpoint is a per-handler decision.
 */
async function limitRequest(request: Request, env: Env, route: RouteDef, principal: Principal): Promise<RateDecision> {
  const class_ = route.rateLimit ?? "public";
  const budget = BUDGETS[class_];
  const key = limitKeyFor(`${route.method} ${route.pattern}`, class_, principal.userId || null, clientAddress(request));
  const decision = await createRateLimiter(env).check(key, budget);
  if (!decision.allowed) {
    throw new ApiError("RATE_LIMITED", 429, `Too many requests. Try again in ${String(decision.retryAfterSeconds)}s.`, {
      detail: `route ${route.pattern}; budget ${String(budget.limit)}/${String(budget.windowSeconds)}s`,
    });
  }
  return decision;
}

/**
 * One sample per delivered batch: how many messages the consumer was handed and how long it took. `samples`
 * is the batch size, so a folded rollup answers "messages per minute" without a table of batches, and a
 * consumer that stops draining shows up as the count falling to zero rather than as an error rate.
 */
function observeRequestQueue(messages: number, queueName: string | undefined, started: number, adQueue: string | undefined): void {
  observe({
    subsystem: "queue",
    metric: "depth",
    dimension: queueName && adQueue && queueName === adQueue ? "ad-events" : "notifications",
    samples: Math.max(1, messages),
    durationMs: Date.now() - started,
  });
}

/** What the edge told the origin about the object it almost served, mapped to the four words we count. */
function cacheStateFrom(request: Request, response: Response): "hit" | "miss" | "bypass" | "stale" | "revalid" {
  if (response.status === 304) return "revalid";
  const edge = (request.headers.get("cf-cache-status") ?? "").toUpperCase();
  if (edge === "HIT" || edge === "STALE") return "hit";
  if (edge === "MISS" || edge === "EXPIRED") return "miss";
  if (edge === "BYPASS") return "bypass";
  // A response the route table says is private, or one that no cache may hold, never counts as a miss: it
  // was never eligible, and calling it a miss would make the hit ratio meaningless on every admin route.
  return "bypass";
}

/** `content-length` when a handler set one; SSE and streamed bodies have none, and are not sized. */
function contentLengthOf(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function finalise({ response, corsOrigin, requestId, cache, rate }: Finalised): Response {
  const extra = cacheHeadersFor(cache);
  // A `handler` route owns `cache-control` (media answers per object, so no static class fits).
  // The fallback keeps "the handler may set it" from meaning "it may be missing": with no header
  // at all, a shared cache is free to hold somebody's avatar until the CDN decides otherwise.
  if (cache === "handler" && !response.headers.has("cache-control")) extra["cache-control"] = "no-store";
  const headers = withSecurityHeaders(new Headers(response.headers), extra);
  headers.set("x-request-id", requestId || newRequestId());
  if (rate) for (const [k, v] of Object.entries(rateLimitHeaders(rate))) headers.set(k, v);
  applyCors(headers, corsOrigin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
