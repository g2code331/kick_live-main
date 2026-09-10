/**
 * KICKLIVE · the React side of the data layer (Phase 4)
 *
 * One hook replaces the pattern in nine pages: an effect that fetches, a `setInterval` that re-fetches, a
 * `cancelled` boolean, and a `loading` flag that cannot tell "on its way" from "old" from "failed but here is
 * what we had". The cache owns all four; the component reads them.
 *
 * `poll` is an option rather than a default on purpose: a screen asks for a key to be kept warm while it is
 * mounted, unmounting disarms it, and the shared ticker (§4.5) decides how many timers that adds up to —
 * one, however many keys.
 *
 * Note what is *not* a dependency: `args` and `spec` are held in refs, so the inline object literal every
 * React page passes (`{ filter, page }`) cannot re-trigger a fetch on an unrelated render. Only `key` —
 * which is a function of `args`, and therefore changes exactly when the question changes — restarts the read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { queryCache, type ReadResult, type ReadSource } from "./cache.ts";
import { loadCtx, runQuery, type QuerySpec } from "./context.ts";
import { ticker } from "./ticker.ts";

export interface UseQueryResult<T> {
  data: T | null;
  error: string | null;
  /** Nothing cached and a request outstanding; a warm cache means `false` on the first paint. */
  loading: boolean;
  /** Past its TTL: the value may have moved, so a score surface can label it. */
  stale: boolean;
  ageMs: number;
  source: ReadSource;
  refetch(): Promise<void>;
}

export interface UseQueryOptions {
  /** Keep this key warm while the component is mounted: `true` uses `spec.pollMs`, a number overrides it. */
  poll?: boolean | number;
  enabled?: boolean;
}

function toResult<T>(r: ReadResult<T> | null): UseQueryResult<T> {
  return {
    data: r?.data ?? null,
    error: r?.error ?? null,
    loading: !r || (r.data === null && !r.error),
    stale: r?.stale ?? true,
    ageMs: r?.ageMs ?? 0,
    source: r?.source ?? "persisted",
    refetch: async () => undefined,
  };
}

export function useQuery<T, A>(spec: QuerySpec<T, A>, args: A, options: UseQueryOptions = {}): UseQueryResult<T> {
  const key = useMemo(() => spec.key(args), [spec, args]);
  const enabled = options.enabled !== false;
  const [result, setResult] = useState<ReadResult<T> | null>(() => (enabled ? queryCache.peek<T>(key) : null));

  const specRef = useRef(spec);
  specRef.current = spec;
  const argsRef = useRef(args);
  argsRef.current = args;

  /** A user-visible refresh: past the TTL floor *and* past the polling floor, because a person asked. */
  const refetch = useCallback(async () => {
    const ctx = await loadCtx();
    const settled = await queryCache.read<T>({
      key,
      tags: specRef.current.tags(argsRef.current),
      ttlMs: specRef.current.ttlMs,
      minIntervalMs: 0,
      persist: specRef.current.persist,
      fetch: () => specRef.current.fetch(ctx, argsRef.current),
      force: true,
    });
    setResult(settled as ReadResult<T>);
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const apply = (r: ReadResult<unknown>) => {
      if (alive) setResult(r as ReadResult<T>);
    };
    const unsubscribe = queryCache.subscribe(key, apply);
    void runQuery(specRef.current, argsRef.current).then(apply, () => undefined);

    const pollMs = options.poll === true ? (specRef.current.pollMs ?? 30_000) : typeof options.poll === "number" ? options.poll : 0;
    let stopPolling: (() => void) | null = null;
    if (pollMs > 0) {
      const unregister = queryCache.registerRefetcher(key, async () => {
        const ctx = await loadCtx();
        await queryCache.read<T>({
          key,
          tags: specRef.current.tags(argsRef.current),
          ttlMs: specRef.current.ttlMs,
          minIntervalMs: Math.min(pollMs, 1000),
          fetch: () => specRef.current.fetch(ctx, argsRef.current),
        });
      });
      const disarm = queryCache.arm(key, pollMs);
      ticker.start();
      stopPolling = () => {
        disarm();
        unregister();
      };
    }

    return () => {
      alive = false;
      unsubscribe();
      if (stopPolling) stopPolling();
    };
  }, [key, enabled, options.poll]);

  return { ...toResult(result), refetch };
}

/**
 * Read a spec once, imperatively — for a handler that needs the freshest value and is not rendering it
 * (the header's "open the panel, refresh the panel" case is the one that uses this).
 */
export async function readOnce<T, A>(spec: QuerySpec<T, A>, args: A): Promise<T | null> {
  const settled = await runQuery(spec, args);
  return settled.data;
}

/**
 * Invalidate after a mutation, from wherever the mutation happened. Returns how many entries were dropped,
 * so a test can prove that editing a squad did not clear the news cache (§4.2's targeted invalidation).
 */
export function invalidate(...tagsOrKeys: string[]): number {
  let dropped = 0;
  for (const tagOrKey of tagsOrKeys) dropped += queryCache.invalidate(tagOrKey);
  return dropped;
}
