import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Database, Gauge, Radio, RefreshCw, ScrollText, Settings2, Trash2, Bell, Megaphone } from "lucide-react";
import { isApiFailure, type ApiResult } from "../../../lib/api/index.ts";
import {
  formatPercentile,
  METRIC_WINDOWS,
  readAdminHealth,
  readAdvertisingMetrics,
  readAlerts,
  readAudit,
  readLiveMatchMetrics,
  readMetrics,
  readNotificationMetrics,
  runProbes,
  runRetention,
  statusTone,
  counterList,
  type AdminHealth,
  type AlertRow,
  type AuditPage,
  type MetricsSummary,
  type MetricWindowSeconds,
  type SectionMetrics,
  type LiveMatchMetrics,
} from "../../../lib/data/observability.ts";

/**
 * The monitoring desk (Phase 9).
 *
 * Five sections, one window control, and a rule that shapes all of them: **this screen renders numbers the
 * server produced.** It does not average, interpolate, extrapolate or re-derive anything, because a dashboard
 * that does arithmetic in the browser has two definitions of "error rate" — one here and one in the SQL — and
 * the disagreement is discovered during an incident. So:
 *
 *  - `GET /observability/metrics` returns totals, a latency block and grouped rows; the panel prints them.
 *  - percentiles are *bucket bounds* (`≤ 500 ms`, `> 5000 ms` for the open top bucket) and are labelled that
 *    way, because the record behind them is an 11-wide histogram and a smooth number would be a fiction.
 *  - live, notification and advertising sections read their own endpoint, which reads Phase 3/5/7's tables.
 *    Nothing here computes an impression count or a score from a socket.
 *  - **no caching, per section, with independent failure.** Every read is `no-store` server-side and refetched
 *    on demand; each panel holds its own error, because a monitoring page that blanks when the metrics table is
 *    empty is how you lose the one signal that told you why.
 *
 * What is deliberately absent: a chart library (five sections of numbers answer the questions asked, and a
 * bundle is for life), any per-viewer row (the live section shows *how many* sockets, never whose), and any
 * edit affordance. The only buttons that change state are "probe now", which writes health rows, and "run
 * retention", which deletes aged telemetry and asks twice before doing it.
 */
const btn = "inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-[11px] font-black uppercase tracking-widest transition";
const btnGhost = `${btn} border border-white/10 text-white/70 hover:text-white hover:bg-white/5`;
const btnDanger = `${btn} border border-red-400/30 text-red-200/80 hover:text-red-100 hover:bg-red-400/10`;

const toneClass: Record<string, string> = {
  ok: "bg-[#39FF14]",
  warn: "bg-amber-300",
  bad: "bg-red-400",
  unknown: "bg-white/25",
};

/** One fetch-and-hold slot: a section's data, its error, and the act of reloading it. */
function useSection<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    const result = await load();
    setBusy(false);
    if (isApiFailure(result)) {
      // `code` and `message` are all the Worker sends in production; there is no stack to leak here either.
      setError(`${result.code} — ${result.message}`);
      return;
    }
    setError(null);
    setData(result.data as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, busy, reload: run };
}

export default function SystemMonitoring() {
  const [windowSeconds, setWindowSeconds] = useState<MetricWindowSeconds>(86400);
  const [action, setAction] = useState<string | null>(null);
  const [confirmRetention, setConfirmRetention] = useState(false);

  const health = useSection<AdminHealth>(() => readAdminHealth(), []);
  const alerts = useSection<{ ok: boolean; windowSeconds?: number; alerts: AlertRow[] }>(() => readAlerts(900), []);
  const metrics = useSection<MetricsSummary>(() => readMetrics(windowSeconds), [windowSeconds]);
  const live = useSection<LiveMatchMetrics>(() => readLiveMatchMetrics(windowSeconds), [windowSeconds]);
  const notifications = useSection<SectionMetrics>(() => readNotificationMetrics(windowSeconds), [windowSeconds]);
  const advertising = useSection<SectionMetrics>(() => readAdvertisingMetrics(windowSeconds), [windowSeconds]);
  const audit = useSection<AuditPage>(() => readAudit(25), []);

  const reloadAll = () => {
    for (const section of [health, alerts, metrics, live, notifications, advertising, audit]) void section.reload();
  };

  const probeNow = async () => {
    setAction("probing…");
    const result = await runProbes();
    setAction(isApiFailure(result) ? `probe failed: ${result.code}` : "probes written");
    void health.reload();
    setTimeout(() => setAction(null), 6000);
  };

  const runRetentionNow = async () => {
    if (!confirmRetention) {
      // Two clicks, deliberately: this deletes telemetry older than the retention settings, and a mis-click on
      // a monitoring page should cost a second, not fourteen days of history.
      setConfirmRetention(true);
      setAction("this deletes aged rollup rows — click again to confirm");
      setTimeout(() => {
        setConfirmRetention(false);
        setAction(null);
      }, 8000);
      return;
    }
    setConfirmRetention(false);
    setAction("running…");
    const result = await runRetention(true);
    setAction(isApiFailure(result) ? `retention failed: ${result.code}` : "retention applied");
    void metrics.reload();
    setTimeout(() => setAction(null), 8000);
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        <Gauge size={18} className="text-[#39FF14]" />
        <h2 className="mr-auto text-sm font-black uppercase tracking-[0.2em] text-white/80">System monitoring</h2>
        <div className="flex items-center gap-1" role="group" aria-label="Time window">
          {METRIC_WINDOWS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              onClick={() => setWindowSeconds(option.seconds)}
              aria-pressed={windowSeconds === option.seconds}
              className={`${btn} ${windowSeconds === option.seconds ? "bg-[#39FF14] text-black" : "border border-white/10 text-white/60 hover:text-white"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={reloadAll} className={btnGhost}>
          <RefreshCw size={13} /> Refresh
        </button>
        <button type="button" onClick={() => void probeNow()} className={btnGhost}>
          <Activity size={13} /> Probe now
        </button>
        <button type="button" onClick={() => void runRetentionNow()} className={btnDanger}>
          <Trash2 size={13} /> {confirmRetention ? "Confirm retention" : "Run retention"}
        </button>
        {action ? <p className="w-full text-[11px] text-white/50">{action}</p> : null}
      </header>

      {alerts.data?.alerts && alerts.data.alerts.length > 0 ? (
        <section className="rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-3" aria-label="Active alerts">
          <h3 className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-amber-100">
            <AlertTriangle size={13} /> {alerts.data.alerts.length} alert{alerts.data.alerts.length === 1 ? "" : "s"} in the last 15 minutes
          </h3>
          <ul className="space-y-1">
            {alerts.data.alerts.map((row, index) => (
              <li key={`${row.code}-${String(index)}`} className="flex flex-wrap items-baseline gap-2 text-xs text-white/75">
                <span className={`h-2 w-2 rounded-full ${toneClass[row.severity === "critical" ? "bad" : "warn"]}`} aria-hidden="true" />
                <span className="font-mono text-[11px] uppercase tracking-wider text-amber-100">{row.code}</span>
                {/* No prose from the server: an alert is a code plus the numbers that fired it, which is what makes
                    it safe to forward. The sentence an operator wants belongs in this file, not in a SQL string. */}
                <span className="text-white/40">{alertEvidence(row)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="System health" icon={<Database size={13} />} section={health}>
          <ComponentList health={health.data} />
          {health.data?.public?.status ? (
            <p className="mt-2 text-[11px] text-white/35">
              The public endpoint currently says <span className="font-mono">{health.data.public.status}</span> — the same
              components, without reasons.
            </p>
          ) : null}
        </Panel>

        <Panel title="API" icon={<Gauge size={13} />} section={metrics}>
          <ApiSummary summary={metrics.data} />
        </Panel>

        <Panel title="Live matches" icon={<Radio size={13} />} section={live}>
          <LiveSummary data={live.data} />
        </Panel>

        <Panel title="Notifications" icon={<Bell size={13} />} section={notifications}>
          <CountGrid counters={notifications.data?.counters} />
          <CountGrid counters={notifications.data?.jobs} />
        </Panel>

        <Panel title="Advertising" icon={<Megaphone size={13} />} section={advertising}>
          <CountGrid counters={advertising.data?.operational} />
          <CampaignTable rows={advertising.data?.measurement} />
        </Panel>

        <Panel title="Recent privileged actions" icon={<ScrollText size={13} />} section={audit}>
          <AuditList page={audit.data} />
        </Panel>
      </div>

      <footer className="flex items-center gap-2 text-[11px] text-white/40">
        <Settings2 size={12} />
        Retention: minute rollups 14 days, daily rollups 400 days, audit rows never deleted by this system. Fan
        identity is not collected here — the live section reports socket counts, not sockets.
      </footer>
    </div>
  );
}

function Panel({ title, icon, section, children }: { title: string; icon: ReactNode; section: { readonly error: string | null; readonly busy: boolean; readonly reload: () => void }; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-white/60">
        {icon} {title}
        {section.busy ? <span className="ml-auto text-[10px] font-medium normal-case tracking-normal text-white/35">loading…</span> : null}
      </h3>
      {section.error ? (
        <div className="space-y-2">
          <p className="rounded-xl border border-red-400/25 bg-red-400/[0.07] px-3 py-2 text-xs text-red-100/85">{section.error}</p>
          <button type="button" onClick={section.reload} className={btnGhost}>
            <RefreshCw size={12} /> Retry this panel
          </button>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function ComponentList({ health }: { health: AdminHealth | null }) {
  const components = health?.components ?? [];
  if (components.length === 0) return <Empty text="No health rows yet — the cron writes the first ones." />;
  const telemetry = health?.telemetry;
  return (
    <ul className="space-y-1">
      {components.map((row) => (
        <li key={row.component} className="flex flex-wrap items-baseline gap-2 text-xs text-white/75">
          <span className={`h-2 w-2 rounded-full ${toneClass[statusTone(row.status)]}`} aria-hidden="true" />
          <span className="font-mono text-[11px] uppercase tracking-wider text-white/60">{row.component}</span>
          <span>{row.status}</span>
          {row.reason ? <span className="text-white/45">{row.reason}</span> : null}
          {typeof row.consecutiveFailures === "number" && row.consecutiveFailures > 0 ? <span className="text-amber-100/80">{String(row.consecutiveFailures)} in a row</span> : null}
          <span className="ml-auto text-white/35">
            {row.stale ? "stale · " : ""}
            {row.ageSeconds === null || row.ageSeconds === undefined ? (row.checkedAt ? `checked ${new Date(row.checkedAt).toLocaleTimeString()}` : "never measured") : `${String(Math.round(row.ageSeconds))}s ago`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ApiSummary({ summary }: { summary: MetricsSummary | null }) {
  if (!summary || summary.ok !== true) return <Empty text={summary?.reason === "WINDOW_BEYOND_ROLLUP_RETENTION" ? "That window is older than rollup retention — use the daily table." : "No samples in this window."} />;
  const totals = summary.totals ?? {};
  const latency = summary.latency ?? {};
  const groups = summary.groups ?? [];
  // The open-bucket signal is read from the percentile object itself rather than a flag: `open: true` is what
  // the histogram says, and a derived boolean in SQL would be one more thing that can disagree with it.
  const topBucket = latency.p99?.open === true || latency.p95?.open === true;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="requests" value={totals.samples} />
        <Stat label="errors" value={totals.errors} />
        <Stat label="error rate" value={typeof totals.errorRate === "number" ? `${(totals.errorRate * 100).toFixed(2)}%` : undefined} />
        <Stat label="cache hits" value={summary.cache?.hit} />
        <Stat label="p50" value={formatPercentile(latency.p50)} />
        <Stat label="p95" value={formatPercentile(latency.p95)} />
        <Stat label="p99" value={formatPercentile(latency.p99)} />
        <Stat label="mean" value={typeof latency.meanMs === "number" ? `${latency.meanMs.toFixed(0)} ms` : undefined} />
      </div>
      {topBucket ? <p className="text-[11px] text-amber-100/80">A percentile sits in the open top bucket — real latency is worse than anything this histogram can show.</p> : null}
      {groups.length > 0 ? (
        <table className="w-full text-left text-[11px]">
          <thead className="text-white/35">
            <tr>
              <th className="py-1 font-medium">metric</th>
              <th className="py-1 font-medium">route</th>
              <th className="py-1 text-right font-medium">n</th>
              <th className="py-1 text-right font-medium">errors</th>
            </tr>
          </thead>
          <tbody>
            {groups.slice(0, 12).map((row, index) => (
              <tr key={`${row.subsystem}-${row.metric}-${row.route}-${index}`} className="border-t border-white/5 text-white/70">
                <td className="py-1 font-mono">
                  {row.subsystem}.{row.metric}
                  {row.dimension ? <span className="text-white/35"> · {row.dimension}</span> : null}
                </td>
                <td className="py-1 font-mono text-white/45">{row.route}</td>
                <td className="py-1 text-right">{String(row.samples ?? 0)}</td>
                <td className="py-1 text-right">{String(row.errors ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function LiveSummary({ data }: { data: LiveMatchMetrics | null }) {
  if (!data || data.ok !== true) return <Empty text="No live-match telemetry in this window." />;
  const matches = data.rooms ?? [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="live rooms" value={data.activeMatches} />
        <Stat label="peak sockets/min" value={data.peakConnectionsPerMinute} />
        <Stat label="snapshots" value={data.counters?.["snapshots.push"]} />
      </div>
      <CountGrid counters={data.counters} />
      {matches.length === 0 ? (
        <Empty text="Nothing marked live right now." />
      ) : (
        <ul className="space-y-1">
          {matches.map((row) => (
            <li key={row.match_id} className="flex flex-wrap items-baseline gap-2 text-xs text-white/75">
              <span className="font-mono text-[11px] text-white/45">#{String(row.match_id)}</span>
              <span>{row.status}</span>
              <span className="ml-auto text-white/35">{row.seconds_since_update === null || row.seconds_since_update === undefined ? "no write yet" : `${String(Math.round(row.seconds_since_update))}s since last write`}</span>
              {/* No fan appears here, and cannot: the row's columns are the match id, its status and its age. */}
            </li>
          ))}
        </ul>
      )}
      {data.note ? <p className="text-[10px] italic text-white/30">{data.note}</p> : null}
    </div>
  );
}

/** The `metric.dimension -> count` maps, rendered as they arrive: sorted by size, capped at twelve. */
function CountGrid({ counters }: { counters?: Record<string, number> }) {
  const rows = counterList(counters);
  if (rows.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {rows.map((row) => (
        <Stat key={row.metric} label={row.metric} value={row.value} />
      ))}
    </div>
  );
}

/**
 * Phase 7's own numbers, verbatim. There is no CTR maths in this file on purpose: `kicklive_ad_analytics`
 * decides what an impression is (including the distinct-viewer-day floor), and a second definition in the
 * browser is how an advertising report and a monitoring panel start disagreeing about the same campaign.
 */
function CampaignTable({ rows }: { rows: SectionMetrics["measurement"] }) {
  if (!rows || rows.length === 0) return <Empty text="No campaign measurement in this window." />;
  return (
    <table className="w-full text-left text-[11px]">
      <thead className="text-white/35">
        <tr>
          <th className="py-1 font-medium">campaign</th>
          <th className="py-1 text-right font-medium">impressions</th>
          <th className="py-1 text-right font-medium">clicks</th>
          <th className="py-1 text-right font-medium">ctr</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((row, index) => (
          <tr key={`${String(row.campaign ?? "row")}-${String(index)}`} className="border-t border-white/5 text-white/70">
            <td className="py-1 font-mono">{String(row.campaign ?? row.code ?? "—")}</td>
            <td className="py-1 text-right">{String(row.impressions ?? 0)}</td>
            <td className="py-1 text-right">{String(row.clicks ?? 0)}</td>
            <td className="py-1 text-right">{typeof row.ctr === "number" ? `${(row.ctr * 100).toFixed(2)}%` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** An alert carries whichever numbers proved it; render those, in key order, and nothing else. */
function alertEvidence(row: AlertRow): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === "code" || key === "severity" || key === "message") continue;
    if (typeof value === "number") parts.push(`${key} ${Math.round(value * 1000) / 1000}`);
    else if (typeof value === "string") parts.push(`${key} ${value.slice(0, 40)}`);
  }
  return parts.slice(0, 5).join(" · ");
}

function AuditList({ page }: { page: AuditPage | null }) {
  const rows = page?.entries ?? [];
  if (rows.length === 0) return <Empty text="No privileged actions recorded yet." />;
  return (
    <>
      <ul className="space-y-1">
        {rows.map((row) => {
          const via = typeof row.details?.via === "string" ? row.details.via : null;
          return (
            <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs text-white/75">
              <span className="font-mono text-[11px] uppercase tracking-wider text-white/60">{row.action}</span>
              <span className="text-white/45">
                {row.entity_type}
                {row.entity_id ? ` #${String(row.entity_id)}` : ""}
                {row.entity_name ? ` · ${row.entity_name}` : ""}
              </span>
              {row.actor_username ? <span className="text-white/55">@{row.actor_username}</span> : null}
              {via ? <span className="text-white/30">via {via}</span> : null}
              <span className="ml-auto text-white/35">{new Date(row.occurred_at).toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
      {page?.retention ? <p className="mt-2 text-[10px] italic text-white/30">{page.retention}</p> : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-2.5 py-2">
      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="text-sm font-semibold text-white/85">{value === undefined || value === null || value === "" ? "—" : String(value)}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-[11px] italic text-white/35">{text}</p>;
}
