/**
 * KICKLIVE · the shared data layer (Phase 4)
 *
 * `src/lib/data` is where a page asks a question about the database. It exists because every screen used to
 * own its own `supabase.from(...)` call, its own timer and its own idea of how old data may be — see the
 * audit in `docs/PHASE4_DATA_ARCHITECTURE.md`. Import the hooks from here; import `queries.ts` when you need
 * a spec, and never build a `.from()` in a component again.
 *
 * Boot order matters and is short: `initDataLayer()` once from `App.tsx` (it starts the one ticker, binds the
 * cache to the signed-in identity, and installs the dev diagnostics handle), then `useQuery` in the pages.
 */
import { installPerfGlobals, perf } from "./perf.ts";
import { queryCache } from "./cache.ts";
import { ticker } from "./ticker.ts";

export { queryCache } from "./cache.ts";
export type { ReadOptions, ReadResult, ReadSource } from "./cache.ts";
export { perf, createPerf } from "./perf.ts";
export type { PerfEvent, PerfSummary } from "./perf.ts";
export { ticker, createTicker } from "./ticker.ts";
export { useQuery, readOnce, invalidate } from "./useResource.ts";
export type { UseQueryOptions, UseQueryResult } from "./useResource.ts";
export { defineQuery, runQuery, setCtx, loadCtx } from "./context.ts";
export type { DataCtx, Db, QuerySpec, QueryBuilder } from "./context.ts";
export * as queries from "./queries.ts";
export { FRESHNESS, describeAge, isDoneStatus, isLiveStatus, STATUS, LIVE_STATUSES, DONE_STATUSES, UPCOMING_STATUSES } from "./freshness.ts";
export { computeStandings, rankStandings, recentForm } from "./standings.ts";
export type { StandingRow, StandingsMatch, StandingTeam } from "./standings.ts";

const isDev = (): boolean => Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

/**
 * Start the data layer. Idempotent, and safe to call from the desktop renderer as well as the web shell:
 * everything in here is one `Map`, one timer and a set of counters.
 */
export function initDataLayer(): void {
  installPerfGlobals(globalThis as unknown as Record<string, unknown>, isDev());
  ticker.start();
  if (isDev()) {
    // One line a minute in a dev console is how a cache gets noticed before it gets defended.
    let last = 0;
    const report = () => {
      const summary = perf.summary();
      if (summary.reads + summary.hits === last) return;
      last = summary.reads + summary.hits;
      // eslint-disable-next-line no-console
      console.debug(
        `[data] reads ${summary.reads}, cache hits ${summary.hits}, coalesced ${summary.coalesced}, stale serves ${summary.staleServes}, slowest ${summary.slowestMs.toFixed(0)}ms`,
      );
    };
    globalThis.setInterval?.(report, 60_000);
  }
}

/**
 * Call from the auth layer whenever the signed-in identity changes. `null` means "nobody", and any change
 * drops the cache: a per-user RLS answer must never outlive the user who earned it.
 */
export function noteAuthIdentity(userId: string | null): void {
  queryCache.setIdentity(userId);
}
