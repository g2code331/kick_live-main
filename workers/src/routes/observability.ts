/**
 * The observability routes (Phase 9).
 *
 * One public door and a row of staff doors behind it, and the difference between them is not a filter in
 * this file — it is which database function the route is allowed to call. `GET /observability/health` is the
 * only route here an anonymous caller reaches, and the function behind it (`kicklive_health_read`) returns
 * seven columns that say "green, amber, red, how old". The reason it is that thin is that it is the one
 * endpoint an attacker will definitely read: a health page that names components, versions, latencies and
 * row counts is a map of the system handed to whoever asks. Depth lives in the `admin.audit_read` routes,
 * which return the reason strings, the per-route numbers and the audit trail.
 *
 * Three rules shape every handler here:
 *
 *   - **No aggregation in JavaScript.** A route forwards a window and a filter and returns the JSON the
 *     database built. Percentiles are computed by `kicklive_observability_percentile` over a stored
 *     histogram because the histogram is the only latency record that survives the request; summing it in
 *     the Worker would mean shipping every bucket to the browser and adding up floats there.
 *   - **The Worker never answers a health question from its own feelings.** `/observability/health` reads
 *     `system_health`, which a cron and every probe write. If the read fails, the route says so as a status
 *     (`TELEMETRY_UNAVAILABLE`, `degraded`) rather than inventing `ok` — and rather than 503-ing, because a
 *     503 from a health route is indistinguishable from the Worker being down, and the two need different
 *     responses from whoever is awake at 03:00.
 *   - **Numbers out, nothing in.** No route here accepts a metric value. The only way a number enters the
 *     rollups is `kicklive_metrics_record`, called by the Worker's own instrumentation, so a client cannot
 *     inflate its own traffic or hide an error by POST-ing a sample.
 */
import { ApiError, ok } from "../lib/response.ts";
import { readJsonBody, readQuery, type Fields } from "../lib/validation.ts";
import { supabaseAsUser } from "../services/supabase.ts";
import { probeDependencies, readHealthSnapshot, redact, runObservabilityMaintenance } from "../lib/observability.ts";
import { logDebug } from "../lib/debug.ts";
import type { HandlerContext } from "./index.ts";

const METRIC_KEYS = ["from", "to", "subsystem", "route", "metric", "limit", "groupBy"] as const;
const DAILY_KEYS = ["from", "to", "subsystem", "route", "limit"] as const;
const WINDOW_KEYS = ["from", "to"] as const;
const ALERT_KEYS = ["windowSeconds"] as const;
const AUDIT_KEYS = ["action", "entityType", "actorId", "from", "to", "limit", "offset"] as const;

/** The subsystems a caller may filter by. Anything else is a typo, and a typo must not read as "no data". */
/** The eight, in the order the migration's CHECK lists them. `tests/unit/phase9-observability.test.ts`
 *  diffs this list against the SQL, so a subsystem added on one side and not the other is a failed test. */
const SUBSYSTEMS = ["api", "live", "notifications", "advertising", "media", "storage", "queue", "system"] as const;
const GROUP_BY = ["route", "subsystem", "metric", "status", "dimension", "cache", "role"] as const;

/**
 * `GET /observability/health` — the public, high-level answer.
 *
 * Anonymously callable, `no-store` (a cached green panel is worse than no panel), and it still returns 200
 * when the database cannot be read: the body carries `"status":"degraded"`, so a monitor alerts on content
 * while an availability probe does not fire for a database restart. `components[].status` and `ageSeconds`
 * are the whole vocabulary — no reasons, no latencies, no counts, no versions.
 */
export async function handleObservabilityHealth(ctx: HandlerContext): Promise<Response> {
  const raw = (await readHealthSnapshot(ctx.env)) as { status?: unknown; observedAt?: unknown; components?: unknown };
  const unreadable = typeof raw.status !== "string" || !Array.isArray(raw.components);
  return ok(
    {
      status: unreadable ? "degraded" : String(raw.status),
      observedAt: unreadable ? null : String(raw.observedAt ?? ""),
      components: Array.isArray(raw.components) ? raw.components : [],
      // Two words only ever appear here: `ok`, or `degraded` with the reason the telemetry itself is
      // unreadable. A caller who needs to know *which* dependency is unhappy is an admin, and there is a
      // route for them below.
      ...(unreadable ? { reason: "TELEMETRY_UNAVAILABLE" } : {}),
      // Deliberate omission, in case the shape tempts a later edit: there is no `reason`, no `detail`,
      // no `consecutiveFailures` and no row counts on this route. Those exist on
      // `GET /observability/admin/health`, which an admin reads.
    },
    { requestId: ctx.requestId },
  );
}

/**
 * `GET /observability/metrics` — request counts, latency, status codes, cache behaviour, top routes.
 *
 * `p_limit` bounds the number of groups, which bounds the response: a day of traffic folded to 11-wide
 * histograms is a few hundred rows, and the 40-group default keeps an accidental "give me everything" from
 * returning a spreadsheet.
 */
export async function handleObservabilityMetrics(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, METRIC_KEYS);
  const args = metricArgs(fields);
  const reply = await call(ctx, "kicklive_metrics_summary", args);
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/metrics/daily` — the day table, which outlives the 14-minute-grain rollups. */
export async function handleObservabilityDaily(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, DAILY_KEYS);
  const reply = await call(ctx, "kicklive_metrics_daily", {
    p_from: day(fields, "from"),
    p_to: day(fields, "to"),
    p_subsystem: subsystem(fields),
    p_route: route(fields),
    p_limit: fields.integer("limit", { min: 1, max: 500, default: 60 }),
  });
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/live-matches` — rooms, sockets, reconnects, failures, staleness. Never a fan. */
export async function handleObservabilityLive(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, WINDOW_KEYS);
  const reply = await call(ctx, "kicklive_live_match_metrics", windowArgs(fields));
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/notifications` — Phase 5's job, attempt, delivery and token counters. */
export async function handleObservabilityNotifications(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, WINDOW_KEYS);
  const reply = await call(ctx, "kicklive_notification_metrics", windowArgs(fields));
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/advertising` — Phase 7's impressions, clicks and CTR, read from its own function. */
export async function handleObservabilityAdvertising(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, WINDOW_KEYS);
  const reply = await call(ctx, "kicklive_advertising_metrics", windowArgs(fields));
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/alerts` — the list a human would act on. Alert *readiness*, not a pager. */
export async function handleObservabilityAlerts(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, ALERT_KEYS);
  const reply = await call(ctx, "kicklive_observability_alerts", { p_window_seconds: fields.integer("windowSeconds", { min: 60, max: 86400, default: 900 }) });
  return ok(reply, { requestId: ctx.requestId });
}

/**
 * `GET /observability/audit` — recent privileged actions, from the table the append-only trigger protects.
 *
 * Read-only by construction twice over: this route only ever calls `kicklive_audit_list`, and the admin
 * policy on `activity_logs` is `for select`, so even a Worker bug that assembled an UPDATE through the
 * REST layer would be refused by the browser-less path it used to have.
 */
export async function handleObservabilityAudit(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, AUDIT_KEYS);
  const action = fields.string("action", { max: 64, pattern: /^[a-z][a-z0-9_.]{2,63}$/ });
  const entityType = fields.string("entityType", { max: 40, pattern: /^[a-z][a-z0-9_]{1,39}$/ });
  const reply = await call(ctx, "kicklive_audit_list", {
    p_action: action ?? null,
    p_entity_type: entityType ?? null,
    p_actor_id: fields.uuid("actorId") ?? null,
    p_from: fields.timestamp("from") ?? null,
    p_to: fields.timestamp("to") ?? null,
    p_limit: fields.integer("limit", { min: 1, max: 200, default: 50 }),
    p_offset: fields.integer("offset", { min: 0, max: 100000, default: 0 }),
  });
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/admin/health` — the same components, with reasons, ages and consecutive failures. */
export async function handleObservabilityAdminHealth(ctx: HandlerContext): Promise<Response> {
  const reply = await call(ctx, "kicklive_health_read_admin", {});
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/admin/diagnostics` — coverage and self-checks: rows, retention, grants, catalogue. */
export async function handleObservabilityDiagnostics(ctx: HandlerContext): Promise<Response> {
  const reply = await call(ctx, "kicklive_observability_diagnostics", {});
  return ok(reply, { requestId: ctx.requestId });
}

/** `GET /observability/admin/catalogue` — every metric name the system knows how to record and read. */
export async function handleObservabilityCatalogue(ctx: HandlerContext): Promise<Response> {
  const reply = await call(ctx, "kicklive_observability_catalogue", {});
  return ok(reply, { requestId: ctx.requestId });
}

/**
 * `POST /observability/admin/probe` — run the dependency probes now, instead of waiting for the cron.
 *
 * Bounded and idempotent: one HEAD/GET per component, results written through `kicklive_health_write`. A
 * probe never returns 500 for a red component — the point of the route is the verdict, so an unhappy
 * dependency is `ok: true` with `"status":"down"` in the body.
 */
export async function handleObservabilityProbe(ctx: HandlerContext): Promise<Response> {
  const probes = await probeDependencies(ctx.env);
  return ok(
    {
      probedAt: new Date().toISOString(),
      durationMs: probes.durationMs,
      supabase: probes.supabaseOk ? "ok" : "unavailable",
      r2: probes.r2.status,
      derived: probes.derived,
    },
    { requestId: ctx.requestId },
  );
}

/**
 * `POST /observability/admin/maintenance` — compact one day and drop what retention says to drop.
 *
 * The same code path the cron runs, exposed for the two moments it matters: immediately after the migration
 * (so the first day's rollup exists while the minute rows are still there) and during an incident review
 * (so a day can be compacted before its retention window closes). Idempotent: the rollup deletes and rewrites
 * one day, and the purge ages by `created_at` rather than by wall-clock guesses.
 */
export async function handleObservabilityMaintenance(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, ["confirm"], { maxBytes: 2048 });
  // Destructive-ish (it deletes rows), so it asks for the same word the media sweep does, and an operator
  // cannot trigger a purge by pasting a URL into a browser extension.
  if (fields.boolean("confirm", { default: false }) !== true) {
    throw new ApiError("VALIDATION_FAILED", 400, "Set `confirm: true` to run retention on the rollup tables.", { fields: [{ field: "confirm", message: "required" }] });
  }
  const result = await runObservabilityMaintenance(ctx.env);
  logDebug(`observability maintenance by ${ctx.principal.userId ?? "?"}: ${JSON.stringify(result)}`);
  return ok({ ranAt: new Date().toISOString(), ...result }, { requestId: ctx.requestId });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function metricArgs(fields: Fields): Record<string, unknown> {
  const groupBy = fields.string("groupBy", { max: 16 });
  if (groupBy !== undefined && !GROUP_BY.includes(groupBy as (typeof GROUP_BY)[number])) {
    throw new ApiError("VALIDATION_FAILED", 400, `groupBy must be one of ${GROUP_BY.map((v) => `\`${v}\``).join(", ")}.`, { fields: [{ field: "groupBy", message: "unknown" }] });
  }
  return {
    p_from: fields.timestamp("from") ?? null,
    p_to: fields.timestamp("to") ?? null,
    p_subsystem: subsystem(fields),
    p_route: route(fields),
    p_metric: fields.string("metric", { max: 64, pattern: /^[a-z][a-z0-9_.]{1,63}$/ }) ?? null,
    p_limit: fields.integer("limit", { min: 1, max: 200, default: 40 }),
    // `groupBy` is not a database argument: the function already returns every grouping it can (groups[]
    // plus series[]), and `metrics_summary` orders by it. Refusing an unknown value above is the point.
  };
}

function subsystem(fields: Fields): string | null {
  const value = fields.string("subsystem", { max: 24, pattern: /^[a-z][a-z0-9_]{1,23}$/ });
  if (value !== undefined && !SUBSYSTEMS.includes(value as (typeof SUBSYSTEMS)[number])) {
    throw new ApiError("VALIDATION_FAILED", 400, `subsystem must be one of ${SUBSYSTEMS.join(", ")}.`, { fields: [{ field: "subsystem", message: "unknown" }] });
  }
  return value ?? null;
}

/** A route *pattern*, never a concrete path — the same rule the rollup table enforces in a CHECK. */
function route(fields: Fields): string | null {
  const value = fields.string("route", { max: 120, pattern: /^\/[A-Za-z0-9:_/.-]*$/ });
  if (value !== undefined && value.includes(":") === false && value.length > 60) {
    throw new ApiError("VALIDATION_FAILED", 400, "A concrete path longer than this is not a route pattern.", { fields: [{ field: "route", message: "malformed" }] });
  }
  return value ?? null;
}

function day(fields: Fields, key: "from" | "to"): string | null {
  return fields.string(key, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }) ?? null;
}

function windowArgs(fields: Fields): Record<string, unknown> {
  return { p_from: fields.timestamp("from") ?? null, p_to: fields.timestamp("to") ?? null };
}

/**
 * Every read here is a `security definer` function that re-checks `is_admin()` from the caller's JWT, so
 * the call goes out on the service-role client for its RLS-bypassing read of the rollup tables and carries
 * the caller's token for the identity check. A read with no subject is refused by the function, not here.
 */
/**
 * Every read here is a `security definer` function that decides the caller's role from their own JWT
 * (`is_admin()` reads `profiles where id = auth.uid()`), so the call goes out on the caller's token and not
 * on the service-role key — a service call has no subject at all and would be refused by the function's own
 * check, exactly as in Phase 8. The RLS story does not contradict that: the four new tables are readable by
 * nobody through the REST layer (RLS on, no policies), and a definer function runs as its owner, which is how
 * a caller with `admin.audit_read` can read a table they could never `select` from directly.
 */
async function call(ctx: HandlerContext, fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (!ctx.principal.token) {
    throw new ApiError("UNAUTHENTICATED", 401, "A monitoring read needs the caller's own session.");
  }
  try {
    return await supabaseAsUser(ctx.env, ctx.principal.token).call(fn, args);
  } catch (err) {
    // PostgREST's message can name a column, a constraint or a row count. It goes to the log with the
    // request id; the browser gets the category and nothing else.
    logDebug(`${ctx.requestId} ${fn} failed: ${redact(err instanceof Error ? err.message : String(err), 200)}`);
    throw new ApiError("DEPENDENCY_FAILED", 502, `The monitoring read \`${fn}\` is unavailable.`);
  }
}
