/**
 * KICKLIVE · one polling scheduler for the whole app (Phase 4 §4.5)
 *
 * Before this, six components each owned a `setInterval` that re-issued a Supabase read (F-04): three tabs
 * meant three times the load, and a backgrounded phone tab kept asking until the OS killed it. Now a read
 * asks to be *armed* with an interval, and this module keeps exactly one timer that sweeps the armed keys.
 *
 * Two behaviours worth the code they cost:
 *  - it does not run while the tab is hidden, and when the tab comes back it refreshes once if the data
 *    went stale, rather than resuming a cadence nobody was watching;
 *  - it is a no-op with nothing armed, so a static page (news, a team profile) never pays for a timer.
 */
import { queryCache, type QueryCache } from "./cache.ts";

export interface Ticker {
  start(): void;
  stop(): void;
  /** One sweep, exposed for tests and for a manual "refresh now". */
  tick(): void;
  readonly running: boolean;
}

export function createTicker(
  cache: QueryCache,
  env: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval; document?: { visibilityState: string; addEventListener?: Document["addEventListener"]; removeEventListener?: Document["removeEventListener"] } } = {},
  intervalMs = 1000,
): Ticker {
  let handle: ReturnType<typeof setInterval> | null = null;
  let sweptWhileHidden = false;

  const doc = env.document ?? (typeof document === "undefined" ? undefined : (document as unknown as { visibilityState: string; addEventListener?: Document["addEventListener"]; removeEventListener?: Document["removeEventListener"] }));
  const setTimer = env.setInterval ?? (typeof setInterval === "function" ? setInterval : undefined);
  const clearTimer = env.clearInterval ?? (typeof clearInterval === "function" ? clearInterval : undefined);

  function sweep(): void {
    const hidden = doc?.visibilityState === "hidden";
    if (hidden) {
      sweptWhileHidden = true;
      return;
    }
    if (sweptWhileHidden) {
      // The first tick back is a catch-up, then the cadence resumes normally.
      sweptWhileHidden = false;
    }
    if (!cache.armedKeys().length) return;
    void cache.sweep();
  }

  return {
    start() {
      if (handle !== null || !setTimer) return;
      handle = setTimer(sweep, intervalMs);
    },
    stop() {
      if (handle !== null && clearTimer) clearTimer(handle);
      handle = null;
    },
    tick: sweep,
    get running() {
      return handle !== null;
    },
  };
}

/** Started by `initDataLayer()` in `App.tsx`; the cache is the shared one so any armed key is swept. */
export const ticker = createTicker(queryCache);
