/**
 * Metrics, structured logs and correlation for the Worker.
 *
 * This module is the only place the Worker writes anything about *itself*, and the shape of it follows from
 * one constraint: telemetry must never become the thing that breaks. So —
 *
 *   - **Every entry point is fire-and-forget.** `observe()` cannot throw, cannot await, and has no way to
 *     fail a request. The flush is awaited only by the cron and by `ctx.waitUntil`, and a failed flush
 *     counts itself as a dropped sample (`system.metrics.dropped`) rather than as an error to a user.
 *   - **The buffer is bounded, and bounded loudly.** At most `MAX_KEYS` distinct series per isolate; past
 *     that, new keys fold into `route: '*'` and the drop is counted. An unbounded Map keyed by a route string
 *     is how a metrics buffer turns into an outage: somebody points a fuzzer at an id and every id becomes a
 *     key.
 *   - **The dimensions are the closed vocabulary in `METRIC_CATALOGUE`, and nothing else.** The database
 *     re-validates (`kicklive_metrics_record` refuses a malformed route or a value that looks like a
 *     credential), which is why the catalogue here is a *list* rather than a `Record<string, any>`: the drift
 *     test compares the two files, and the SQL is the authority.
 *   - **No identity, ever.** No user id, no device token, no IP, no user agent, no match id, no request body.
 *     A route *pattern* (`/matches/:matchId/stream`) is a fact about the API; a path (`/matches/47/stream`) is
 *     a fact about a game, and the second one turns an operational table into a record of who watched what.
 *     `redact()` runs on every string that reaches a log line as well, so the rule is enforced twice: once
 *     by what we choose to measure and once by what survives the trip.
 *
 * Correlation works in one hop and one queue jump: the id a client sent (or that was minted here) goes into
 * the log line, into the audit row, and into every queue message's `trace.requestId`. It cannot go into
 * Postgres' own statement log — PostgREST forwards only the bearer token, so there is no header channel for
 * `x-request-id` (architecture note §6), which is why the audit table carries the id itself instead.
 */
import type { Env } from "../env.ts";
import { isProduction } from "../env.ts";
import { hasServiceRole, supabaseAdmin } from "../services/supabase.ts";
import { logDebug } from "./debug.ts";
import { categoryForStatus, classify, safeMessage, type ErrorCategory, type Severity } from "./errors.ts";

// ── the vocabulary ──────────────────────────────────────────────────────────

/** Histogram edges in ms. The eleventh bucket is `+Inf`, which is why this array is ten long and a
 *  `bigint[11]` is stored. `observability_config.latency_buckets_ms` holds the same ten numbers, and
 *  `tests/unit/phase9-observability.test.ts` fails if the two literals ever differ — a percentile computed
 *  against edges the writer did not use is a number with no meaning. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export const OBSERVABILITY_SUBSYSTEMS = ["api", "live", "notifications", "advertising", "media", "storage", "queue", "system"] as const;
export type ObservabilitySubsystem = (typeof OBSERVABILITY_SUBSYSTEMS)[number];

/** `subsystem.metric` → the closed set of dimensions it may carry. Mirrors
 *  `kicklive_observability_catalogue()`; `*` means "any shape the validators accept". */
export const METRIC_CATALOGUE: Record<string, readonly string[]> = {
  "api.requests": ["2xx", "3xx", "4xx", "5xx"],
  "api.errors": [
    "AUTHENTICATION_ERROR",
    "AUTHORIZATION_ERROR",
    "VALIDATION_ERROR",
    "DATABASE_ERROR",
    "R2_ERROR",
    "QUEUE_ERROR",
    "FCM_ERROR",
    "WEBSOCKET_ERROR",
    "NOT_FOUND_ERROR",
    "INTERNAL_ERROR",
    "RATE_LIMITED",
  ],
  "api.cache": ["hit", "miss", "bypass", "stale", "revalid"],
  "api.rate_limited": ["public", "authenticated", "mutation", "auth-exchange", "admin-blast"],
  "api.payload": ["s_lt_1kb", "s_1_10kb", "s_10_100kb", "s_gt_100kb", "rejected"],
  "live.connections": ["room"],
  "live.reconnects": ["resume", "snapshot"],
  "live.event_failures": ["DATABASE_ERROR", "WEBSOCKET_ERROR", "VALIDATION_ERROR", "INTERNAL_ERROR"],
  "live.snapshots": ["push", "poll"],
  "live.rejected": ["SEQUENCE_GAP", "UNAUTHORISED", "MATCH_LOCKED", "RATE_LIMITED"],
  "live.lag": ["write_tail"],
  "notifications.jobs": ["sent", "partial", "failed", "retry", "not_claimable"],
  "notifications.attempts": ["first", "retry"],
  "notifications.deliveries": ["delivered", "invalid_token", "failure", "throttled"],
  "notifications.queue": ["published", "refused", "dlq"],
  "notifications.devices": ["registered", "pruned", "invalidated"],
  "advertising.served": ["ok", "no_fill", "all_paused", "slot_off", "expired"],
  "advertising.events": ["impression", "click"],
  "advertising.ingest": ["queued", "written", "refused"],
  "media.uploads": ["ok", "refused", "failed", "superseded"],
  "media.sweep": ["expired", "deleted", "error"],
  "media.bucket": ["get", "put", "head", "delete", "error"],
  "queue.depth": ["notifications", "ad-events", "dlq"],
  // The nine components `system_health` knows how to hold — the same list as the column CHECK and as
  // `HealthComponent` above, and a drift between the three is a failing test.
  "system.health": ["worker", "supabase", "durable_objects", "queues", "fcm", "r2", "metrics", "cron", "database_size"],
  "system.cron": ["notification-sweep", "media-sweep", "observability", "ad-maintenance"],
  "system.metrics": ["dropped", "overflow", "flush_failed"],
};

/** The keys this file writes in a metric sample, and the argument names `kicklive_metrics_record` expects. */
export interface MetricSample {
  readonly subsystem: ObservabilitySubsystem;
  readonly metric: string;
  readonly route?: string;
  readonly dimension?: string;
  readonly samples?: number;
  readonly errors?: number;
  readonly durationMs?: number;
  readonly value?: number;
}

// ── redaction ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(^|[^a-z])bearer\s+[a-z0-9._-]{8,}/gi, "bearer"],
  [/eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}/gi, "jwt"],
  [/eyJ[a-z0-9_-]{20,}/gi, "jwt"],
  [/service_role|serviceKey|SUPABASE_SERVICE/i, "service-key"],
  [/\bsk_[a-z0-9_]{12,}\b/gi, "api-key"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "aws-key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "pem"],
  [/(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|fcm[_-]?token)\s*[:=]\s*\S+/gi, "credential"],
];

/**
 * Replace anything shaped like a credential with `[redacted]`, and flatten the result to one line.
 *
 * Deliberately more aggressive than the SQL's refusal list: the database refuses a sample that looks like a
 * secret (so a mistake is loud), and the logger redacts one (so a mistake is harmless). Both, because the
 * cost of missing a token in a log is not a metric worth optimising against.
 */
export function redact(value: unknown, max = 300): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : safeMessage(value, max);
  for (const [pattern, label] of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, before?: string) => {
      const prefix = typeof before === "string" && before.trim().length > 0 ? `${before.trim()} ` : "";
      return `${prefix}[redacted:${label}]`;
    });
  }
  text = text.replace(/[\r\n\t]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A path becomes a pattern by way of the route table, never by regex heroics: the caller already knows the
 *  matched pattern, and re-deriving it here would be a second implementation to disagree with. */
export const patternForLog = (pattern: string | undefined, method: string): string => (pattern ? `${method} ${pattern}` : `${method} *`);

// ── the buffer ──────────────────────────────────────────────────────────────

interface Accumulator {
  samples: number;
  errors: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  histogram: number[];
  value: number;
}

/**
 * How many distinct series one isolate holds before it starts folding: 400 real keys, plus one `*` fold key per
 * (subsystem, metric) pair that overflowed — the fold is allowed past the cap on purpose, because refusing it
 * would *drop* counts, and a metrics buffer's first duty is that the totals add up. The slack is therefore
 * bounded by the catalogue rather than by traffic, and `overflowed` says how much of it was needed.
 */
const MAX_KEYS = 400;
const HISTOGRAM_WIDTH = LATENCY_BUCKETS_MS.length + 1;
const emptyHistogram = (): number[] => new Array<number>(HISTOGRAM_WIDTH).fill(0);

let buffer = new Map<string, Accumulator>();
let dropped = 0;
let overflowed = 0;
let lastFlushAt = 0;
let flushes = 0;
let failures = 0;

const bucketFor = (ms: number | undefined): number => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return -1;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (ms <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return HISTOGRAM_WIDTH - 1;
};

/**
 * Record one sample. Total, cheap, and never throws: `observe` is called from the response path, the queue
 * consumer, the Durable Object and the cron, and a bug in telemetry must not be visible to a fan.
 */
export function observe(sample: MetricSample): void {
  try {
    const subsystem = sample.subsystem;
    const metric = typeof sample.metric === "string" ? sample.metric.trim() : "";
    if (!subsystem || !metric) {
      dropped++;
      return;
    }
    const route = sample.route && sample.route !== "*" ? sample.route : "*";
    // A route with a numeric run in it is a path, not a pattern, and it is the one dimension that would let
    // this map grow without bound. Fold it rather than store it, and let the overflow counter say why.
    const safeRoute = /[0-9]{3,}/.test(route) ? "*" : route;
    const dimension = sample.dimension ? redact(sample.dimension, 64) : "";
    const key = `${subsystem}|${metric}|${safeRoute}|${dimension}`;
    let acc = buffer.get(key);
    if (!acc) {
      if (buffer.size >= MAX_KEYS) {
        overflowed++;
        const fold = `${subsystem}|${metric}|*|`;
        acc = buffer.get(fold);
        if (!acc) {
          buffer.set(fold, (acc = { samples: 0, errors: 0, sumMs: 0, minMs: null, maxMs: null, histogram: emptyHistogram(), value: 0 }));
        }
        if (key !== fold) dropped++;
      } else {
        acc = { samples: 0, errors: 0, sumMs: 0, minMs: null, maxMs: null, histogram: emptyHistogram(), value: 0 };
        buffer.set(key, acc);
      }
    }
    const samples = Math.max(0, Math.floor(sample.samples ?? 1));
    const errors = Math.min(Math.max(0, Math.floor(sample.errors ?? 0)), samples);
    acc.samples += samples;
    acc.errors += errors;
    const ms = typeof sample.durationMs === "number" && Number.isFinite(sample.durationMs) ? Math.max(0, sample.durationMs) : undefined;
    if (ms !== undefined) {
      // `durationMs` on a sample is the *mean* of the interval it describes (the request path calls this once per
      // request with samples = 1; a re-send after a failed flush carries N). Adding the mean once would make the
      // rollup's average shrink as the buffer folded, which is the classic way a dashboard reports a latency
      // improvement that never happened — so the contribution is weighted before it is stored.
      acc.sumMs += ms * Math.max(1, samples);
      acc.minMs = acc.minMs === null ? ms : Math.min(acc.minMs, ms);
      acc.maxMs = acc.maxMs === null ? ms : Math.max(acc.maxMs, ms);
      const b = bucketFor(ms);
      if (b >= 0) acc.histogram[b] += samples;
    }
    if (typeof sample.value === "number" && Number.isFinite(sample.value)) acc.value += sample.value;
  } catch {
    // There is nothing useful to do here, and the absence of a `throw` is the point.
    dropped++;
  }
}

/**
 * A gauge, for the things that are counts of a state rather than of an event: open sockets in a room, jobs
 * waiting in a queue. `samples` counts the readings folded into this key and `value` carries what was seen, so
 * one minute bucket holds one reading per emitter — which is what makes the panel's "busiest minute" (a `max`
 * over per-bucket sums) mean what it says. An emitter that sampled on every event would turn a gauge into a
 * counter of its own eagerness; `MatchRoom.emitConnectionsGauge` is the one gate that keeps that honest.
 */
export function observeGauge(subsystem: ObservabilitySubsystem, metric: string, value: number, dimension = "room", route?: string): void {
  observe({ subsystem, metric, route, dimension, samples: 1, value });
}

/** What is buffered right now, in the shape `kicklive_metrics_record` wants. */
export function drainBuffer(): MetricSample[] {
  if (buffer.size === 0 && dropped === 0 && overflowed === 0) return [];
  const out: MetricSample[] = [];
  for (const [key, acc] of buffer) {
    const [subsystem, metric, route, dimension] = key.split("|");
    out.push({
      subsystem: subsystem as ObservabilitySubsystem,
      metric,
      route: route || "*",
      dimension: dimension || "",
      samples: acc.samples,
      errors: acc.errors,
      durationMs: acc.samples > 0 && acc.sumMs > 0 ? round(acc.sumMs / acc.samples) : undefined,
      value: acc.value,
    });
  }
  // The meta-metrics, and only when they are non-zero: a rollup row that says "0 samples were dropped" is
  // indistinguishable in SQL from a row that says nothing was dropped, so emitting it would put a permanent
  // series in the table for a thing that has not happened, and the alert on it would need a `> 0` guard
  // forever. Absence means fine, here as everywhere else in this design.
  if (dropped > 0) out.push({ subsystem: "system", metric: "metrics", dimension: "dropped", samples: dropped });
  if (overflowed > 0) out.push({ subsystem: "system", metric: "metrics", dimension: "overflow", samples: overflowed });
  buffer = new Map<string, Accumulator>();
  dropped = 0;
  overflowed = 0;
  return out;
}

/** Everything an operator can ask about the telemetry itself, from the same isolate. */
export function bufferStats(): { keys: number; dropped: number; overflowed: number; flushes: number; failures: number; sinceLastFlushSeconds: number } {
  return {
    keys: buffer.size,
    dropped,
    overflowed,
    flushes,
    failures,
    sinceLastFlushSeconds: lastFlushAt === 0 ? -1 : Math.round((Date.now() - lastFlushAt) / 1000),
  };
}

export function resetObservabilityForTests(): void {
  buffer = new Map<string, Accumulator>();
  dropped = 0;
  overflowed = 0;
  flushes = 0;
  failures = 0;
  lastFlushAt = 0;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

// ── flushing ────────────────────────────────────────────────────────────────

export interface FlushReport {
  readonly sent: number;
  readonly ok: boolean;
  readonly reason?: string;
  readonly refused?: unknown;
  /** Samples that could not be sent and went back into the buffer, so the next flush retries them. */
  readonly kept?: number;
}

/**
 * Send what is buffered, with the service client.
 *
 * The service key is the *only* right credential for this call, and that is not a contradiction of the
 * sponsorship phase's rule about forwarding the caller's token: `kicklive_metrics_record` decides nothing
 * about a caller — it has no subject to consult, and a metric written "as" a signed-in fan would either fail
 * or attribute a request to a person who did not make it. Phases 5 to 8 established the same split (the JWT
 * decides, so forward it; the machine decides, so there is nothing to forward).
 */
export async function flushObservations(env: Env, opts: { force?: boolean } = {}): Promise<FlushReport | null> {
  const samples = drainBuffer();
  if (samples.length === 0) return null;
  const intervalMs = 20_000;
  if (!opts.force && Date.now() - lastFlushAt < intervalMs) {
    // Too early to send. Put it back rather than dropping it: this function is called on every request by
    // `maybeFlush`, and a buffer that resets on a throttle would discard nearly everything.
    for (const s of samples) observe(s);
    return { sent: samples.length, ok: true, reason: "throttled" };
  }
  lastFlushAt = Date.now();
  if (!hasServiceRole(env)) {
    failures++;
    return { sent: samples.length, ok: false, reason: "NO_SERVICE_KEY" };
  }
  try {
    const reply = (await supabaseAdmin(env).call("kicklive_metrics_record", { p_samples: samples })) as {
      ok?: boolean;
      rows?: number;
      refused?: unknown[];
    };
    flushes++;
    return { sent: samples.length, ok: reply?.ok === true, refused: reply?.refused };
  } catch (err) {
    failures++;
    // A failed flush is counted and logged, and the samples go back into the buffer for the next attempt.
    // That is not an unbounded retry queue, because the buffer is: `observe` folds into the same 400 keys and
    // counts what it cannot hold, so a database that stays down costs a bounded amount of memory per isolate
    // and shows up as `system.metrics.flush_failed` rather than as silently missing numbers.
    for (const sample of samples) observe(sample);
    observe({ subsystem: "system", metric: "metrics", dimension: "flush_failed", samples: 1 });
    logDebug(
      JSON.stringify({
        ts: new Date().toISOString(),
        subsystem: "system",
        level: "warn",
        event: "metrics_flush_failed",
        category: classify(err).category,
        message: redact(safeMessage(err)),
        samples: samples.length,
      }),
    );
    return { sent: samples.length, ok: false, reason: redact(safeMessage(err), 120), refused: samples.length, kept: samples.length };
  }
}

/** The per-request entry point: flush when the interval has passed, otherwise do nothing. Never awaited. */
export function maybeFlush(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): void {
  if (buffer.size === 0) return;
  try {
    ctx.waitUntil(flushObservations(env));
  } catch {
    // `waitUntil` only throws when the request is already over, which is a state telemetry cannot improve on.
  }
}

// ── request observation ─────────────────────────────────────────────────────

export type LogMode = "off" | "errors" | "slow" | "all";

export function logMode(env: Env): LogMode {
  const configured = String((env as unknown as Record<string, unknown>)["LOG_MODE"] ?? "")
    .trim()
    .toLowerCase();
  if (configured === "off" || configured === "all" || configured === "errors" || configured === "slow") return configured;
  // The default is the middle setting, and it is the answer to "structured logs without excessive raw
  // request logs": every failure and every slow request is written, and a healthy 200 is a number in a
  // rollup rather than a line of text.
  return "errors";
}

export interface RequestObservation {
  readonly requestId: string;
  /** The client's own id, when it sent one. Never trusted, always carried. */
  readonly clientRequestId?: string | null;
  readonly method: string;
  readonly pattern: string;
  readonly status: number;
  readonly durationMs: number;
  readonly cacheClass?: string;
  readonly cacheState?: "hit" | "miss" | "bypass" | "stale" | "revalid";
  readonly rateClass?: string;
  readonly role?: string | null;
  readonly subsystem?: ObservabilitySubsystem;
  readonly category?: ErrorCategory;
  readonly message?: string;
  readonly severity?: Severity;
  /** Response bytes, when the handler knows them (a `content-length` header, or a computed body). */
  readonly bytes?: number | null;
  readonly extra?: Record<string, string | number | boolean | null>;
}

/**
 * The single log line per request that matters, and the metric samples behind it.
 *
 * Field set is fixed: `ts`, `level`, `requestId`, `clientRequestId`, `method`, `route`, `status`,
 * `durationMs`, `subsystem`, and optionally `category`, `cache`, `role`, `message`. There is no `path`, no
 * `query`, no `body`, no `headers`, no `ip` — each of which is a real thing an operator has asked for once
 * and regretted permanently.
 */
export function observeRequest(obs: RequestObservation, env: Env): void {
  const statusClass = `${String(Math.floor(obs.status / 100))}xx`;
  const failed = obs.status >= 400;
  // Every request counts against `api.requests`, whatever it was about. The owning subsystem appears in the
  // *log line* and in that subsystem's own counters (which the handlers write, because only they know what an
  // attempt or a delivery was), and never here: a world where a notification POST moves the number out of
  // `api` is a world where "requests per second" silently stops meaning requests per second.
  observe({
    subsystem: "api",
    metric: "requests",
    route: obs.pattern,
    dimension: statusClass,
    samples: 1,
    errors: obs.status >= 500 ? 1 : 0,
    durationMs: obs.durationMs,
  });
  if (failed) {
    observe({
      subsystem: "api",
      metric: "errors",
      route: obs.pattern,
      dimension: obs.category ?? (obs.status === 429 ? "RATE_LIMITED" : obs.status === 404 ? "NOT_FOUND" : categoryForStatus(obs.status)),
      samples: 1,
    });
  }
  if (obs.status === 304 || obs.cacheState) {
    observe({ subsystem: "api", metric: "cache", route: obs.pattern, dimension: obs.status === 304 ? "revalid" : (obs.cacheState ?? "miss"), samples: 1 });
  }
  if (obs.status === 429 && obs.rateClass) {
    observe({ subsystem: "api", metric: "rate_limited", route: obs.pattern, dimension: obs.rateClass, samples: 1 });
  }
  // Response size, in four buckets. Not the request body: the body was already parsed and discarded by the
  // time this runs, and anything that records payload sizes verbatim eventually records something private.
  if (typeof obs.bytes === "number" && Number.isFinite(obs.bytes)) {
    observe({ subsystem: "api", metric: "payload", route: obs.pattern, dimension: sizeClass(obs.bytes), samples: 1 });
  }

  const mode = logMode(env);
  const slow = obs.durationMs >= 500;
  const worthWriting = mode === "all" || (mode === "errors" && failed) || (mode === "slow" && (slow || failed)) || (mode === "off" && obs.status >= 500);
  if (!worthWriting) return;
  logDebug(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: obs.severity ?? (obs.status >= 500 ? "error" : failed ? "warn" : "info"),
      subsystem: obs.subsystem ?? "api",
      requestId: obs.requestId,
      ...(obs.clientRequestId ? { clientRequestId: obs.clientRequestId } : {}),
      method: obs.method,
      route: obs.pattern,
      status: obs.status,
      durationMs: round(obs.durationMs),
      ...(obs.category ? { category: obs.category } : {}),
      ...(obs.cacheClass ? { cache: obs.cacheClass } : {}),
      ...(obs.role ? { role: obs.role } : {}),
      ...(obs.message ? { message: redact(obs.message) } : {}),
      ...(obs.extra ? { extra: redactExtra(obs.extra) } : {}),
    }),
  );
}

/** `extra` is where a handler may add a fact (an outcome code, a count). Values only, redacted, no nesting. */
function redactExtra(extra: Record<string, string | number | boolean | null>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(extra).slice(0, 8)) {
    if (value === null || value === undefined) continue;
    out[key.replace(/[^a-zA-Z0-9_.]/g, "").slice(0, 32)] = typeof value === "string" ? redact(value, 96) : value;
  }
  return out;
}

/** Which subsystem a route belongs to, for the log line and for subsystem-scoped alerting. */
export function subsystemFor(pattern: string): ObservabilitySubsystem {
  if (pattern.startsWith("/notifications") || pattern.startsWith("/admin/notifications")) return "notifications";
  if (pattern.startsWith("/advertising")) return "advertising";
  if (pattern.startsWith("/sponsorship")) return "advertising";
  if (pattern.startsWith("/media")) return "media";
  if (pattern.startsWith("/live/") || pattern.startsWith("/matches/")) return "live";
  if (pattern.startsWith("/observability")) return "system";
  return "api";
}

/** Four buckets, because "how big are our responses" is the question, not "which byte count". */
export function sizeClass(bytes: number): "s_lt_1kb" | "s_1_10kb" | "s_10_100kb" | "s_gt_100kb" {
  if (bytes < 1024) return "s_lt_1kb";
  if (bytes < 10240) return "s_1_10kb";
  if (bytes < 102400) return "s_10_100kb";
  return "s_gt_100kb";
}

// ── health ──────────────────────────────────────────────────────────────────

export type HealthComponent = "worker" | "supabase" | "durable_objects" | "queues" | "fcm" | "r2" | "metrics" | "cron" | "database_size";
export type HealthStatus = "ok" | "degraded" | "unavailable" | "unknown";

export interface HealthReport {
  readonly component: HealthComponent;
  readonly status: HealthStatus;
  readonly reason?: string;
  readonly detail?: Record<string, string | number | boolean>;
  readonly success?: boolean;
}

/**
 * Ask the database to remember what we saw. Awaited only from the cron and from explicit admin actions; a
 * request path that wants to report a problem uses `reportHealthBestEffort` so a dying dependency cannot make
 * the response slower.
 */
export async function reportHealth(env: Env, report: HealthReport): Promise<boolean> {
  if (!hasServiceRole(env)) return false;
  try {
    await supabaseAdmin(env).call("kicklive_health_write", {
      p_component: report.component,
      p_status: report.status,
      p_reason: report.reason
        ? redact(report.reason, 48)
            .toUpperCase()
            .replace(/[^A-Z0-9_]/g, "")
            .slice(0, 48)
        : null,
      p_detail: report.detail ?? {},
      p_success: report.success !== false,
    });
    return true;
  } catch (err) {
    failures++;
    logDebug(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        subsystem: "system",
        event: "health_write_failed",
        category: classify(err).category,
        component: report.component,
        message: redact(safeMessage(err)),
      }),
    );
    return false;
  }
}

export function reportHealthBestEffort(ctx: { waitUntil(promise: Promise<unknown>): void }, env: Env, report: HealthReport): void {
  try {
    ctx.waitUntil(reportHealth(env, report));
  } catch {
    // The request is already failing; a health write that also fails is information for the log, not for the fan.
  }
}

/** The one probe the public health route runs on its own: can we ask the database for the snapshot at all. */
export async function readHealthSnapshot(env: Env, opts: { admin?: boolean } = {}): Promise<Record<string, unknown>> {
  const fn = opts.admin ? "kicklive_health_read_admin" : "kicklive_health_read";
  try {
    const reply = await supabaseAdmin(env).call(fn, {});
    return (reply ?? {}) as Record<string, unknown>;
  } catch (err) {
    const classified = classify(err);
    return {
      status: "unavailable",
      components: [],
      error: { code: classified.code, category: classified.category },
    };
  }
}

/**
 * Steps 1–3 of the scheduled pass: the three checks no other component can perform for us. Written to
 * `system_health` as a side effect, so the public panel and the alert query see them without this having to
 * return anything interesting. `POST /observability/admin/probe` runs exactly this and nothing else, because
 * "is it up" must never be the same verb as "delete what is old".
 */
export async function probeDependencies(env: Env): Promise<{ supabaseOk: boolean; r2: HealthReport; derived: unknown; durationMs: number }> {
  const started = Date.now();

  // 1 · the dependency only this isolate can see (a bucket binding either resolves or it does not).
  const r2 = await probeR2(env);
  await reportHealth(env, r2);

  // 2 · SQL-side derived components: queue pressure, telemetry age, database size, DO staleness.
  let derived: unknown = null;
  try {
    derived = await supabaseAdmin(env).call("kicklive_health_recompute_derived", {});
  } catch (err) {
    derived = { error: classify(err).category };
    await reportHealth(env, { component: "supabase", status: "unavailable", reason: "DATABASE_UNREACHABLE", success: false });
  }

  // 3 · a round trip that measures the thing the panel claims to measure, rather than trusting the call above.
  const ping = Date.now();
  let supabaseOk = false;
  try {
    await supabaseAdmin(env).call("kicklive_health_read", {});
    supabaseOk = true;
  } catch {
    supabaseOk = false;
  }
  await reportHealth(env, {
    component: "supabase",
    status: supabaseOk ? "ok" : "unavailable",
    reason: supabaseOk ? undefined : "ROUNDTRIP_FAILED",
    detail: { latencyMs: Date.now() - ping },
    success: supabaseOk,
  });
  return { supabaseOk, r2, derived, durationMs: Date.now() - started };
}

/** The scheduled pass: probe what only the Worker can see, write it down, and roll the day forward.
 *  Returns a small report so the route that triggers it by hand can show something honest. */
export async function runObservabilityMaintenance(env: Env, opts: { reason?: string } = {}): Promise<Record<string, unknown>> {
  const started = Date.now();
  const out: Record<string, unknown> = { reason: opts.reason ?? "cron" };

  const probes = await probeDependencies(env);
  const supabaseOk = probes.supabaseOk;
  out["r2"] = probes.r2.status;
  out["derived"] = probes.derived;

  // 4 · the rollups, retention, and this pass's own accounting.
  try {
    // No arguments, so the function's own default (yesterday, UTC) picks the day. Sending `p_day: null`
    // through PostgREST would arrive as an explicit null and be refused as "not a finished day yet".
    out["rollup"] = await supabaseAdmin(env).call("kicklive_metrics_rollup_daily", {});
  } catch (err) {
    out["rollupError"] = classify(err).category;
  }
  try {
    out["purge"] = await supabaseAdmin(env).call("kicklive_metrics_purge", {});
  } catch (err) {
    out["purgeError"] = classify(err).category;
  }

  const flush = await flushObservations(env, { force: true });
  out["flush"] = flush;
  const durationMs = Date.now() - started;
  observe({ subsystem: "system", metric: "cron", dimension: "observability", samples: 1, durationMs, errors: supabaseOk ? 0 : 1 });
  await reportHealth(env, {
    component: "cron",
    status: supabaseOk ? "ok" : "degraded",
    reason: supabaseOk ? undefined : "LAST_RUN_DEGRADED",
    detail: { durationMs },
    success: supabaseOk,
  });
  out["durationMs"] = durationMs;
  return out;
}

async function probeR2(env: Env): Promise<HealthReport> {
  const bucket = (env as unknown as { MEDIA_BUCKET?: { head(key: string): Promise<unknown> } }).MEDIA_BUCKET;
  if (!bucket) return { component: "r2", status: "unknown", reason: "NO_BUCKET_BINDING", detail: {} };
  const started = Date.now();
  try {
    await bucket.head("observability/health");
    return { component: "r2", status: "ok", detail: { latencyMs: Date.now() - started } };
  } catch (err) {
    return { component: "r2", status: "unavailable", reason: classify(err).category, detail: { latencyMs: Date.now() - started }, success: false };
  }
}

/** A head of a key that may not exist is a successful probe; `head` answers `null`, it does not throw. Only a
 *  thrown error means the binding is broken, which is why this is exported for the media route's use too. */
export const probeLatency = (started: number): number => Date.now() - started;

// ── correlation ─────────────────────────────────────────────────────────────

/**
 * The trace object a queue message carries.
 *
 * `requestId` is the join key into the log stream; `origin` is the route pattern that produced the job, which
 * is what turns "the queue is behind" into "the queue is behind because match finals started firing".
 * Nothing else: no user, no payload copy, no token.
 */
export interface Trace {
  readonly requestId: string;
  readonly origin: string;
  readonly at: string;
}

export const traceFor = (requestId: string, origin: string): Trace => ({ requestId, origin, at: new Date().toISOString() });

/** Pull a trace back out of a message body without trusting any of it. */
export const traceFrom = (payload: unknown): Trace | null => {
  const raw = (payload as { trace?: unknown } | null)?.trace as Partial<Trace> | undefined;
  if (!raw || typeof raw.requestId !== "string") return null;
  const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(raw.requestId) ? raw.requestId : "";
  if (!requestId) return null;
  return {
    requestId,
    origin: typeof raw.origin === "string" ? raw.origin.slice(0, 128) : "",
    at: typeof raw.at === "string" ? raw.at : "",
  };
};

/** Whether the log line for a request should be written at all, outside `observeRequest`'s own rules — used
 *  by the queue consumer, which has no status code to reason about. */
export const shouldLog = (env: Env, severity: Severity): boolean => {
  const mode = logMode(env);
  if (mode === "all") return true;
  if (mode === "off") return severity === "error";
  if (mode === "errors") return severity !== "info";
  return severity === "error";
};

export const isProductionLogMode = (env: Env): boolean => isProduction(env) && logMode(env) !== "all";
