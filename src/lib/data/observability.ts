/**
 * KICKLIVE · observability reads (Phase 9)
 *
 * Five sections of the admin monitoring panel and one public status page, all reading the same endpoints the
 * Worker exposes — no Supabase client here, deliberately:
 *
 *  - **The rollups are only readable through the definer functions.** `metric_rollups` has row-level security
 *    enabled with no policies, which means *nobody* can select from it in a browser, not because the key is
 *    hidden but because the policy set is empty. `kicklive_metrics_summary` is the door, and it is the door
 *    that also decides what a window means (minute rows, day rows, or "older than retention — ask the daily
 *    table").
 *  - **Percentiles arrive as bucket bounds.** `{ p95: { boundMs: 500, open: false } }` means "the 95th
 *    percentile is somewhere between 250 ms and 500 ms" — the last bucket's bound — because the underlying
 *    record is an 11-wide histogram, not a list of durations. This file does not interpolate a prettier number
 *    and neither does the UI: an estimate presented as a measurement is how a latency budget gets signed off
 *    against a value nobody took.
 *  - **A failure here is never fatal to the page.** Every read returns the `ApiResult` union rather than
 *    throwing, and each panel renders its own error. Monitoring that disappears when the thing it monitors
 *    breaks is monitoring that lies by omission.
 */
import { api, type ApiResult } from "../api/index.ts";

/** The windows the panel offers, in seconds. The keys are what the endpoints accept as `from`/`to` maths. */
export const METRIC_WINDOWS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 21600, label: "6 hours" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 604800, label: "7 days" },
] as const;

export type MetricWindowSeconds = (typeof METRIC_WINDOWS)[number]["seconds"];

export interface HealthComponentRow {
  component: string;
  status: string;
  ageSeconds: number | null;
  /** Admin reads only. The public endpoint's projection has no reason and no detail, and never will. */
  reason?: string | null;
  detail?: Record<string, unknown> | null;
  consecutiveFailures?: number;
  stale?: boolean;
}

export interface PublicHealth {
  status: string;
  observedAt: string | null;
  components: HealthComponentRow[];
  reason?: string;
}

export interface AdminHealthComponent extends HealthComponentRow {
  checkedAt?: string | null;
  stale?: boolean;
}

/**
 * `kicklive_health_read_admin`'s projection: the public snapshot *inside* `public`, plus the parts an operator
 * needs and a stranger must not have — a reason code, the probe's detail document, how many checks in a row
 * have failed, and whether the row is older than three TTLs. The nesting is not decoration: the public half is
 * the same object `/observability/health` returns, so the panel can show that the two agree.
 */
export interface AdminHealth {
  ok: boolean;
  ttlSeconds?: number;
  public?: PublicHealth;
  components: AdminHealthComponent[];
  telemetry?: { lastBucket?: string | null; ageSeconds?: number | null; reporting?: boolean };
  alerts?: AlertRow[];
  code?: string;
  reason?: string;
}

export interface PercentileValue {
  boundMs: number | null;
  open?: boolean;
}

export interface MetricsSummary {
  ok: boolean;
  window?: { from?: string; to?: string; seconds?: number; granularity?: string; source?: string };
  /** `{samples, errors, errorRate}` — the rate is `errors / samples`, computed in SQL, once, in one place. */
  totals?: { samples?: number; errors?: number; errorRate?: number };
  /**
   * `p50`/`p95`/`p99` are `{boundMs, open, samples}` from the stored histogram. `open: true` means the
   * quantile landed in the last, unbounded bucket — the real latency is worse than anything the histogram can
   * show, and the UI says so instead of printing a number that looks like a measurement.
   */
  latency?: {
    p50?: PercentileValue;
    p95?: PercentileValue;
    p99?: PercentileValue;
    meanMs?: number | null;
    maxMs?: number | null;
    latencySamples?: number;
    bucketsMs?: number[];
    samples?: number;
  };
  /** `dimension -> count`, for the cache metric: `hit`, `miss`, `bypass`, `stale`, `revalid`. */
  cache?: Record<string, number>;
  groups?: { subsystem?: string; metric?: string; route?: string; dimension?: string; samples?: number; errors?: number; value?: number; p95?: PercentileValue; [key: string]: unknown }[];
  series?: unknown[];
  code?: string;
  reason?: string;
}

export interface LiveRoomRow {
  match_id: number;
  status: string;
  live_updated_at: string | null;
  seconds_since_update: number | null;
}

export interface LiveMatchMetrics {
  ok: boolean;
  activeMatches?: number;
  /** The busiest minute in the window, summed across rooms — `max` over buckets, not a sum, because the
   *  rooms' gauges are already sums and adding them over time would count the same audience twice. */
  peakConnectionsPerMinute?: number;
  /** `metric.dimension -> count`, e.g. `reconnects.resume`, `event_failures.DATABASE_ERROR`. */
  counters?: Record<string, number>;
  rooms?: LiveRoomRow[];
  window?: { from?: string; to?: string };
  note?: string;
  code?: string;
  reason?: string;
}

/**
 * The notification and advertising sections share this shape because their SQL functions share theirs: a
 * `counters`/`operational` map of `metric.dimension -> count` from the rollups, one authoritative block from
 * the owning phase (`jobs` for notifications, `measurement` for advertising), and a note about what the numbers
 * are not. There is no `rows` to page through: an admin panel that received raw events would eventually be
 * asked to display them, and the rollups exist so that nobody has to.
 */
export interface SectionMetrics {
  ok: boolean;
  window?: { from?: string; to?: string };
  counters?: Record<string, number>;
  operational?: Record<string, number>;
  jobs?: Record<string, number>;
  measurement?: { campaign?: string; impressions?: number; clicks?: number; ctr?: number; [key: string]: unknown }[];
  note?: string;
  code?: string;
  reason?: string;
}

/**
 * An alert, as `kicklive_observability_alerts` builds it: a code, a severity, and whichever numbers produced
 * it. The index signature is deliberate — each alert carries its own evidence (`count`, `threshold`,
 * `connections`, `seconds`), and a fixed type here would silently hide the field that mattered when someone
 * added a tenth alert code.
 */
export interface AlertRow {
  code: string;
  severity: string;
  [evidence: string]: unknown;
}

/**
 * One row of `kicklive_audit_list`'s `entries`, i.e. exactly the projection that function selects: the
 * subject's *username* and id, never the `ip_address` or `user_agent` columns the table also holds. An audit
 * reader is entitled to who did what, and an admin panel is not the place where an admin's IP becomes a
 * column somebody learns to expect.
 */
export interface AuditRow {
  id: number;
  occurred_at: string;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  entity_name: string | null;
  actor_id: string | null;
  actor_username: string | null;
  details?: Record<string, unknown> | null;
  request_id?: string | null;
}

/** A `metric.dimension -> count` map as a list, newest-first by value: the one transform this file allows,
 *  because rendering an object's keys in insertion order is a different order in every browser. */
export function counterList(counters: Record<string, number> | undefined, limit = 12): { metric: string; value: number }[] {
  return Object.entries(counters ?? {})
    .map(([metric, value]) => ({ metric, value: Number(value) || 0 }))
    .sort((a, b) => b.value - a.value || a.metric.localeCompare(b.metric))
    .slice(0, limit);
}

function windowQuery(seconds: number, extra: Record<string, string | number | undefined> = {}): string {
  const to = new Date();
  const from = new Date(to.getTime() - seconds * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, String(value));
  return `?${params.toString()}`;
}

/** The public answer: overall colour and one line per component. No reason strings, and no way to ask for them. */
export const readPublicHealth = (): Promise<ApiResult<PublicHealth>> => api.get<PublicHealth>("/observability/health");

export const readAdminHealth = (): Promise<ApiResult<AdminHealth>> => api.get<AdminHealth>("/observability/admin/health");

export const readMetrics = (seconds: MetricWindowSeconds, subsystem?: string): Promise<ApiResult<MetricsSummary>> =>
  api.get<MetricsSummary>(`/observability/metrics${windowQuery(seconds, subsystem ? { subsystem } : {})}`);

export const readLiveMatchMetrics = (seconds: MetricWindowSeconds): Promise<ApiResult<LiveMatchMetrics>> =>
  api.get<LiveMatchMetrics>(`/observability/live-matches${windowQuery(seconds)}`);

export const readNotificationMetrics = (seconds: MetricWindowSeconds): Promise<ApiResult<SectionMetrics>> =>
  api.get<SectionMetrics>(`/observability/notifications${windowQuery(seconds)}`);

export const readAdvertisingMetrics = (seconds: MetricWindowSeconds): Promise<ApiResult<SectionMetrics>> =>
  api.get<SectionMetrics>(`/observability/advertising${windowQuery(seconds)}`);

export const readAlerts = (windowSeconds = 900): Promise<ApiResult<{ ok: boolean; alerts: AlertRow[] }>> =>
  api.get<{ ok: boolean; alerts: AlertRow[] }>(`/observability/alerts?windowSeconds=${String(windowSeconds)}`);

export interface AuditPage {
  ok: boolean;
  total: number;
  entries: AuditRow[];
  retention?: string;
  code?: string;
  reason?: string;
  detail?: string;
}

export const readAudit = (limit = 25, action?: string): Promise<ApiResult<AuditPage>> => {
  // No `from`/`to` here on purpose: the audit list is "the newest entries", and a window computed from `now`
  // would be an empty answer that reads as "nobody has done anything today".
  const params = new URLSearchParams({ limit: String(limit) });
  if (action) params.set("action", action);
  return api.get<AuditPage>(`/observability/audit?${params.toString()}`);
};

export const readCatalogue = (): Promise<ApiResult<CatalogueResponse>> => api.get<CatalogueResponse>("/observability/admin/catalogue");

export interface CatalogueResponse {
  ok: boolean;
  entries?: { subsystem: string; metric: string; dimensions: string; purpose: string }[];
}

/** Probe now, without touching retention. Bounded by an `admin-blast` budget on the server. */
export const runProbes = (): Promise<ApiResult<Record<string, unknown>>> => api.post<Record<string, unknown>>("/observability/admin/probe", {});

/** Compact one day and apply retention. It asks for `confirm` because it deletes rows. */
export const runRetention = (confirm = true): Promise<ApiResult<Record<string, unknown>>> => api.post<Record<string, unknown>>("/observability/admin/maintenance", { confirm });

/**
 * A latency percentile as an operator wants to read it: `≤ 500 ms`, or `> 5000 ms` for the open top bucket.
 * Exported because the panel and the match diagnostics screen both show this and must not disagree about it.
 */
export function formatPercentile(value: PercentileValue | undefined): string {
  if (!value || value.boundMs === null || value.boundMs === undefined) return "—";
  if (value.open) return `> ${String(value.boundMs)} ms`;
  return `≤ ${String(value.boundMs)} ms`;
}

/** The colour a status maps to, in one place: five sections would otherwise each invent their own shade. */
export function statusTone(status: string | undefined): "ok" | "warn" | "bad" | "unknown" {
  switch ((status ?? "").toLowerCase()) {
    case "ok":
    case "healthy":
      return "ok";
    case "degraded":
    case "warn":
      return "warn";
    case "unavailable":
    case "down":
      return "bad";
    default:
      return "unknown";
  }
}
