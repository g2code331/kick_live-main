/**
 * KICKLIVE · read-path diagnostics (Phase 4 §"measure frontend load performance")
 *
 * A cache you cannot observe is a cache you cannot defend. Every read the data layer issues reports here,
 * and the counters answer the four questions that actually decide whether this phase worked: how many
 * round trips happened, how many were avoided, how old was the data a visitor saw, and how often the
 * Worker transport fell back to a direct Supabase read.
 *
 * It is a ring buffer, not a telemetry pipeline: nothing leaves the browser, there is no upload, and in a
 * production build the summary is only reachable from the console (`window.__KICKLIVE_PERF__`). A perf
 * monitor that phones home would be a second product, with a privacy policy to match.
 */

export type PerfEventType =
  | "fetch"
  | "fetched"
  | "hit"
  | "coalesced"
  | "restore"
  | "prime"
  | "invalidate"
  | "fetch-error"
  | "transport-worker"
  | "transport-supabase"
  | "fallback"
  | "boot"
  | "first-data"
  | "stale-serve";

export interface PerfEvent {
  type: PerfEventType;
  key?: string;
  ms?: number;
  ageMs?: number;
  count?: number;
  detail?: string;
  at: number;
}

export interface PerfSink {
  record(event: Omit<PerfEvent, "at"> & { at?: number }): void;
}

export interface PerfSummary {
  sinceMs: number;
  /** Fetches that actually went out. */
  reads: number;
  /** Reads answered from cache instead of going out. */
  hits: number;
  /** Callers that joined a read already in flight (F-02's overlap, counted). */
  coalesced: number;
  invalidations: number;
  errors: number;
  fallbacks: number;
  workerReads: number;
  supabaseReads: number;
  /** Reads answered with data past its TTL — the "was this too old" counter. */
  staleServes: number;
  totalFetchMs: number;
  slowestMs: number;
  /** Sum of `ageMs` over cached serves, divided by their count — "how old was what we showed". */
  medianAgeMs: number | null;
  perKey: Record<string, { reads: number; hits: number; lastMs: number; lastAgeMs: number }>;
  events: PerfEvent[];
}

const RING = 200;

export function createPerf(now: () => number = () => Date.now()): Required<PerfSink> & {
  summary(): PerfSummary;
  reset(): void;
  window: () => PerfEvent[];
} {
  const events: PerfEvent[] = [];
  const startedAt = now();
  const perKey = new Map<string, { reads: number; hits: number; lastMs: number; lastAgeMs: number; ages: number[] }>();
  let counters = empty();

  function empty() {
    return { reads: 0, hits: 0, coalesced: 0, invalidations: 0, errors: 0, fallbacks: 0, workerReads: 0, supabaseReads: 0, staleServes: 0, totalFetchMs: 0, slowestMs: 0 };
  }

  function keyRow(key: string) {
    let row = perKey.get(key);
    if (!row) {
      row = { reads: 0, hits: 0, lastMs: 0, lastAgeMs: 0, ages: [] };
      perKey.set(key, row);
    }
    return row;
  }

  return {
    record(event) {
      const full: PerfEvent = { ...event, at: event.at ?? now() };
      events.push(full);
      if (events.length > RING) events.shift();
      const key = full.key ?? "-";
      switch (full.type) {
        case "fetch":
          counters.reads += 1;
          keyRow(key).reads += 1;
          break;
        case "fetched":
          counters.totalFetchMs += full.ms ?? 0;
          counters.slowestMs = Math.max(counters.slowestMs, full.ms ?? 0);
          keyRow(key).lastMs = full.ms ?? 0;
          break;
        case "hit":
          counters.hits += 1;
          keyRow(key).hits += 1;
          if ((full.ageMs ?? 0) > 0) keyRow(key).lastAgeMs = full.ageMs ?? 0;
          break;
        case "stale-serve":
          // A serve of data past its TTL: allowed (it is the stale half of stale-while-revalidate), but it
          // is the number to look at first when somebody says "the score was behind".
          counters.staleServes += 1;
          break;
        case "coalesced":
          counters.coalesced += 1;
          break;
        case "invalidate":
          counters.invalidations += full.count ?? 1;
          break;
        case "fetch-error":
          counters.errors += 1;
          break;
        case "fallback":
          counters.fallbacks += 1;
          break;
        case "transport-worker":
          counters.workerReads += 1;
          break;
        case "transport-supabase":
          counters.supabaseReads += 1;
          break;
        default:
          break;
      }
    },
    window: () => [...events],
    summary(): PerfSummary {
      const ages = events.filter((e) => e.type === "hit" && typeof e.ageMs === "number").map((e) => e.ageMs as number).sort((a, b) => a - b);
      const median = ages.length ? ages[Math.floor(ages.length / 2)] : null;
      return {
        ...counters,
        sinceMs: now() - startedAt,
        medianAgeMs: median,
        perKey: Object.fromEntries([...perKey.entries()].map(([k, v]) => [k, { reads: v.reads, hits: v.hits, lastMs: v.lastMs, lastAgeMs: v.lastAgeMs }])),
        events: [...events],
      };
    },
    reset() {
      events.length = 0;
      perKey.clear();
      counters = empty();
    },
  };
}

/** The app-wide sink. Importable by name so a test can reset it between cases. */
export const perf = createPerf();

/**
 * A console handle, dev builds only. `__KICKLIVE_PERF__()` is how a reviewer checks the cache's hit rate on a
 * real device without a profiler attached, and it is deliberately absent from a production bundle: exposing
 * read counts to a stranger on a shared browser buys nothing.
 */
export function installPerfGlobals(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>, dev = true): void {
  if (!dev || target.__KICKLIVE_PERF__) return;
  target.__KICKLIVE_PERF__ = () => perf.summary();
}
