/**
 * KICKLIVE · the shared read cache (Phase 4)
 *
 * One `Map`, keyed by the *question* rather than by the component that asked it, so that the two things the
 * audit found (F-02: 217 call sites asking overlapping questions; F-03: nowhere for a response to live) stop
 * being true. Deliberately framework-free and clock-injectable: `App.tsx`, a test and — if a page ever needs
 * it — the desktop renderer all use the same instance, and "is this stale?" must be answerable without
 * waiting four minutes to find out.
 *
 * What it is NOT:
 *  - not a second data layer for writes. A mutation invalidates by tag; it never patches an entry in place,
 *    because an optimistic score in a list and the engine's derived score disagreeing is the exact bug the
 *    live engine exists to remove;
 *  - not a persistence layer beyond an opt-in `sessionStorage` mirror of a named key (see `persist`), and
 *    never a place live state waits — `useMatchRoom` owns that, per docs/PRODUCTION_ARCHITECTURE.md §17;
 *  - not a cache that can lie by omission: `stale` is computed and returned, `error` survives a failed
 *    refresh, and a caller that shows a number can show its age with it.
 */
import { perf, type PerfSink } from "./perf.ts";

export type ReadSource = "fresh" | "hit" | "stale" | "revalidated" | "coalesced" | "persisted" | "error";

export interface ReadResult<T> {
  data: T | null;
  /** When the data in `data` was fetched, not when this result object was produced. */
  fetchedAt: number;
  ageMs: number;
  /** `fetchedAt + ttlMs < now`. `true` on a cold miss so a UI can show a skeleton, not last week. */
  stale: boolean;
  error: string | null;
  source: ReadSource;
  /** Monotonic per key; a component can ignore a response that raced a newer one. */
  version: number;
}

export interface ReadOptions<T> {
  /** The question: `scope|sort|filters`, built by `src/lib/data/queries.ts`, never hand-typed in a page. */
  key: string;
  fetch: () => Promise<T | null>;
  /** Floor on how young data must be to be returned without re-reading. `0` = always re-read. */
  ttlMs?: number;
  /** What a mutation invalidates this by. A tag is `teams`, `squad:12`, `standings:3`; a key also invalidates itself. */
  tags?: readonly string[];
  /** Floor between two actual fetches of this key, however many callers ask. Defaults to 1 s. */
  minIntervalMs?: number;
  /** Mirror to `sessionStorage` so a reload or a cold boot starts warm. Off unless the read is safe to show. */
  persist?: boolean;
  /** Serve the old value while the new one is in flight (the default for everything with a `ttlMs`). */
  staleWhileRevalidate?: boolean;
  /** Caller cancellation: an abort drops *this* caller's wait; it never cancels another's identical read. */
  signal?: AbortSignal;
  /** "Pull to refresh": ignore TTL *and* the polling floor, because a person asked. */
  force?: boolean;
}

/** The part of `Storage` this cache uses, so a test can hand it a Map with two methods. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface CacheOptions {
  now?: () => number;
  storage?: StorageLike | null;
  perfSink?: PerfSink;
  /** Injected so a test can count `fetch` calls; production uses `globalThis.setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

interface Entry {
  data: unknown;
  fetchedAt: number;
  ttlMs: number;
  tags: readonly string[];
  error: string | null;
  version: number;
  inflight: Promise<ReadResult<unknown>> | null;
  lastFetchAt: number;
  /** Polling floor armed by `arm()`; 0 = not polled. See `src/lib/data/ticker.ts`. */
  everyMs: number;
  subscribers: Set<(r: ReadResult<unknown>) => void>;
}

const PERSIST_PREFIX = "kicklive:cache:v1:";
const DISPATCH_GUARD_MS = 1000;
const DEFAULT_MIN_INTERVAL_MS = 1000;

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export class QueryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly store: StorageLike | null;
  private readonly sink: PerfSink;
  private readonly delay: (ms: number) => Promise<void>;
  /** Restored from storage on first touch, so a boot does not pay for reads it already has. */
  private hydrated = false;
  /**
   * Whose token produced the rows in this cache. Supabase answers a `select` with what RLS allows *that*
   * user, so a shared cache is only safe if it is single-identity: signing out clears it (and the mirror in
   * `sessionStorage`) rather than letting the next person in the tab read the previous one's rows.
   */
  private identity: string | null | undefined = undefined;

  constructor(options: CacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.storage === undefined ? defaultStorage() : options.storage;
    this.sink = options.perfSink ?? perf;
    this.delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** The one knob that decides whether a page shows a number while it re-reads it. */
  private entry(key: string, tags: readonly string[], ttlMs: number): Entry {
    const existing = this.entries.get(key);
    if (existing) {
      // A descriptor may add tags over time; widen rather than replace, so an invalidation cannot be lost
      // by whichever caller happened to arrive second.
      if (tags.length && !sameTags(existing.tags, tags)) existing.tags = [...new Set([...existing.tags, ...tags])];
      if (ttlMs > 0) existing.ttlMs = ttlMs;
      return existing;
    }
    const created: Entry = {
      data: null,
      fetchedAt: 0,
      ttlMs,
      tags: [...new Set(tags)],
      error: null,
      version: 0,
      inflight: null,
      lastFetchAt: 0,
      everyMs: 0,
      subscribers: new Set(),
    };
    this.entries.set(key, created);
    return created;
  }

  private hydrateAllowed = true;

  private hydratedFromStorage(): void {
    if (this.hydrated || !this.store || !this.hydrateAllowed) return;
    this.hydrated = true;
    const size = typeof this.store.length === "number" ? this.store.length : 0;
    for (let i = 0; i < size; i++) {
      const key = this.store.key(i);
      if (!key || !key.startsWith(PERSIST_PREFIX)) continue;
      try {
        const raw = this.store.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { data: unknown; fetchedAt: number; ttlMs: number; tags: string[] };
        if (typeof parsed.fetchedAt !== "number") continue;
        const entry = this.entry(key.slice(PERSIST_PREFIX.length), parsed.tags ?? [], parsed.ttlMs ?? 0);
        if (entry.version > 0) continue; // a live fetch already won; do not overwrite it with a snapshot
        entry.data = parsed.data;
        entry.fetchedAt = parsed.fetchedAt;
        entry.version += 1;
        this.sink.record({ type: "restore", key: entry.tags[0] ?? key });
      } catch {
        this.store.removeItem(key);
      }
    }
  }

  private isStale(entry: Entry, at: number): boolean {
    if (entry.ttlMs <= 0) return true;
    return at - entry.fetchedAt > entry.ttlMs;
  }

  private result(key: string, entry: Entry, source: ReadSource, at = this.now()): ReadResult<unknown> {
    return {
      data: entry.data,
      fetchedAt: entry.fetchedAt,
      ageMs: entry.fetchedAt ? Math.max(0, at - entry.fetchedAt) : at,
      stale: entry.fetchedAt === 0 || this.isStale(entry, at),
      error: entry.error,
      source,
      version: entry.version,
    };
  }

  /** Current value without fetching, for a render path that must never await. */
  peek<T>(key: string): ReadResult<T> | null {
    this.hydratedFromStorage();
    const entry = this.entries.get(key);
    if (!entry) return null;
    return this.result(key, entry, entry.fetchedAt === 0 ? "error" : this.isStale(entry, this.now()) ? "stale" : "hit") as ReadResult<T>;
  }

  /**
   * Read `key`, fetching only when the entry is missing, stale or errored.
   *
   * Two callers, one request: the in-flight promise is shared, and the second caller's result is labelled
   * `coalesced` — that count is the proof that deduplication is happening, so it is worth a word in the
   * diagnostics rather than an implementation detail. A caller that passes `signal` gets its own promise
   * chain: aborting drops the wait, and the fetch keeps running for whoever else needs it.
   */
  async read<T>(options: ReadOptions<T>): Promise<ReadResult<T>> {
    this.hydratedFromStorage();
    const at = this.now();
    const ttlMs = options.ttlMs ?? 0;
    const entry = this.entry(options.key, options.tags ?? [], ttlMs);
    const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

    const fresh = !options.force && entry.fetchedAt > 0 && !this.isStale(entry, at) && !entry.error;
    const servesStale = !fresh && entry.fetchedAt > 0;
    if (fresh) {
      this.sink.record({ type: "hit", key: options.key, ageMs: at - entry.fetchedAt });
      return this.result(options.key, entry, "hit", at) as ReadResult<T>;
    }

    if (entry.inflight) {
      this.sink.record({ type: "coalesced", key: options.key });
      const shared = entry.inflight;
      if (options.staleWhileRevalidate !== false && entry.fetchedAt > 0) {
        this.sink.record({ type: "stale-serve", key: options.key });
        return this.result(options.key, entry, "stale", at) as ReadResult<T>;
      }
      return (await awaitWithAbort(shared, options.signal)) as ReadResult<T>;
    }

    // A refresh for data we already have is allowed to wait for the polling floor: the value on screen is
    // not wrong yet, and 3 subscribers mounting in one React pass must not become 3 round trips.
    if (!options.force && entry.fetchedAt > 0 && at - entry.lastFetchAt < minInterval) {
      this.sink.record({ type: "stale-serve", key: options.key });
      return this.result(options.key, entry, "stale", at) as ReadResult<T>;
    }

    const run = this.fetch<T>(options, entry);
    entry.inflight = run as Promise<ReadResult<unknown>>;
    try {
      if (entry.fetchedAt > 0 && options.staleWhileRevalidate !== false) {
        // Resolve with the old value now; `notify` wakes everyone when the new one lands.
        this.sink.record({ type: "stale-serve", key: options.key });
        return this.result(options.key, entry, "stale", at) as ReadResult<T>;
      }
      return (await awaitWithAbort(run, options.signal)) as ReadResult<T>;
    } finally {
      // Only the owner of the promise clears it — a stale `finally` would strand a later caller.
      if (entry.inflight === (run as Promise<ReadResult<unknown>>)) entry.inflight = null;
    }
  }

  private async fetch<T>(options: ReadOptions<T>, entry: Entry): Promise<ReadResult<T>> {
    const started = this.now();
    entry.lastFetchAt = started;
    this.sink.record({ type: "fetch", key: options.key });
    try {
      const data = await options.fetch();
      const done = this.now();
      entry.data = data;
      entry.fetchedAt = done;
      entry.error = null;
      entry.version += 1;
      this.sink.record({ type: "fetched", key: options.key, ms: done - started });
      if (options.persist) this.writeThrough(options.key, entry);
      const result = this.result(options.key, entry, "fresh", done) as ReadResult<T>;
      this.notify(options.key, entry);
      return result;
    } catch (err) {
      const done = this.now();
      // The previous value stays. F-03's rule: a failed refresh may be old, it may not be absent, and it
      // may never be presented as if it had just been read.
      entry.error = err instanceof Error ? err.message : String(err);
      entry.version += 1;
      this.sink.record({ type: "fetch-error", key: options.key, ms: done - started });
      const result = this.result(options.key, entry, "error", done) as ReadResult<T>;
      this.notify(options.key, entry);
      return result;
    }
  }

  /** Wake the key's subscribers after the entry settles, and only if the version actually moved. */
  private notify(key: string, entry: Entry): void {
    if (!entry.subscribers.size) return;
    const snapshot = this.result(key, entry, "revalidated");
    for (const cb of [...entry.subscribers]) {
      try {
        cb(snapshot);
      } catch {
        // A render callback that throws must not break the cache for the others; the page already has its own error handling.
      }
    }
  }

  subscribe(key: string, cb: (r: ReadResult<unknown>) => void): () => void {
    const entry = this.entry(key, [], 0);
    entry.subscribers.add(cb as (r: ReadResult<unknown>) => void);
    return () => entry.subscribers.delete(cb as (r: ReadResult<unknown>) => void);
  }

  /**
   * Drop by tag or by key; pass `"*"` for everything. Returns how many entries were dropped.
   *
   * Targeted invalidation is the point of the tag list (`docs/PHASE4_DATA_ARCHITECTURE.md` §4.2): a squad
   * edit that clears the news cache is not a cache, it is a re-fetch generator.
   */
  invalidate(tagOrKey: string): number {
    let dropped = 0;
    for (const [key, entry] of [...this.entries]) {
      if (tagOrKey !== "*" && key !== tagOrKey && !entry.tags.includes(tagOrKey)) continue;
      entry.data = null;
      entry.fetchedAt = 0;
      entry.error = null;
      entry.version += 1;
      this.entries.delete(key);
      this.forgetPersisted(key);
      dropped += 1;
      for (const cb of [...entry.subscribers]) cb(this.result(key, entry, "stale"));
    }
    if (dropped) this.sink.record({ type: "invalidate", key: tagOrKey, count: dropped });
    return dropped;
  }

  /**
   * Mark data as known-good without a round trip — for a read that arrives from somewhere that is already
   * authoritative. Only the live engine uses it (the room's snapshot warming the list cache), and only for
   * a key it can name exactly.
   */
  prime<T>(key: string, data: T, options: { ttlMs?: number; tags?: readonly string[] } = {}): void {
    const entry = this.entry(key, options.tags ?? [], options.ttlMs ?? 0);
    entry.data = data;
    entry.fetchedAt = this.now();
    entry.error = null;
    entry.version += 1;
    this.sink.record({ type: "prime", key });
    this.notify(key, entry);
  }

  /** Polling is armed per key, so N components wanting the same live list share one timer (§4.5). */
  arm(key: string, everyMs: number): () => void {
    const entry = this.entry(key, [], 0);
    entry.everyMs = entry.everyMs === 0 ? everyMs : Math.min(entry.everyMs, everyMs);
    this.armed.add(key);
    return () => {
      this.armed.delete(key);
      if (!this.armed.has(key)) entry.everyMs = 0;
    };
  }

  private readonly armed = new Set<string>();

  armedKeys(): string[] {
    return [...this.armed];
  }

  /**
   * One tick of the shared scheduler: refresh what is armed and out of date. Called from
   * `ticker.ts` on a single interval, and never while the tab is hidden.
   */
  async sweep(now = this.now()): Promise<number> {
    let fired = 0;
    for (const key of [...this.armed]) {
      const entry = this.entries.get(key);
      if (!entry || !entry.everyMs) continue;
      if (now - entry.fetchedAt < entry.everyMs) continue;
      // At most one dispatch per interval bucket per key: two sweeps in the same tick (a visibility
      // catch-up landing next to the cadence) must not both decide this key is due.
      if (entry.lastFetchAt && now - entry.lastFetchAt < Math.min(entry.everyMs, DISPATCH_GUARD_MS)) continue;
      if (entry.inflight) continue;
      const fetcher = this.refetchers.get(key);
      if (!fetcher) continue;
      // Marked before it is dispatched, so two sweeps in the same tick (a visibility catch-up next to the
      // cadence) cannot both decide this key is due and double-fire.
      entry.lastFetchAt = now;
      fired += 1;
      await fetcher();
    }
    return fired;
  }

  /** `arm()` needs a way to re-issue the original question; the hook registers it here. */
  private readonly refetchers = new Map<string, () => Promise<void>>();

  registerRefetcher(key: string, fn: () => Promise<void>): () => void {
    this.refetchers.set(key, fn);
    return () => {
      if (this.refetchers.get(key) === fn) this.refetchers.delete(key);
    };
  }

  private writeThrough(key: string, entry: Entry): void {
    if (!this.store) return;
    try {
      this.store.setItem(
        PERSIST_PREFIX + key,
        JSON.stringify({ data: entry.data, fetchedAt: entry.fetchedAt, ttlMs: entry.ttlMs, tags: entry.tags }),
      );
    } catch {
      // Quota or privacy mode: a warm boot is an optimisation, never a requirement.
    }
  }

  private forgetPersisted(key: string): void {
    this.store?.removeItem(PERSIST_PREFIX + key);
  }

  /** Diagnostics view: what is cached, how old it is, and who polls it. */
  snapshot(): { key: string; ageMs: number; ttlMs: number; stale: boolean; tags: readonly string[]; everyMs: number; subscribers: number; error: string | null }[] {
    const at = this.now();
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      ageMs: entry.fetchedAt ? at - entry.fetchedAt : -1,
      ttlMs: entry.ttlMs,
      stale: entry.fetchedAt === 0 || this.isStale(entry, at),
      tags: entry.tags,
      everyMs: entry.everyMs,
      subscribers: entry.subscribers.size,
      error: entry.error,
    }));
  }

  /** Bind the cache to an auth identity. A change means the whole cache — memory and storage — is dropped. */
  setIdentity(id: string | null): void {
    if (this.identity === id) return;
    const first = this.identity === undefined;
    this.identity = id;
    if (first) {
      this.hydrateAllowed = true;
      return;
    }
    this.clear();
    if (this.store) {
      const size = typeof this.store.length === "number" ? this.store.length : 0;
      for (let i = size - 1; i >= 0; i--) {
        const key = this.store.key(i);
        if (key?.startsWith(PERSIST_PREFIX)) this.store.removeItem(key);
      }
    }
  }

  get boundIdentity(): string | null | undefined {
    return this.identity;
  }

  /** Test seam: forget everything, including what came back from storage. */
  clear(): void {
    this.entries.clear();
    this.armed.clear();
    this.refetchers.clear();
    this.hydrated = false;
  }

  /** Exposed for the delay-based tests; production never reaches past the cache. */
  get scheduler(): (ms: number) => Promise<void> {
    return this.delay;
  }
}

/**
 * `await` a promise that someone else may abandon. The shared fetch continues either way — cancelling it
 * would make one unmounted component responsible for another's missing data.
 */
async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // SSR / tests / privacy mode
  }
}

/** The instance the whole app shares. Created lazily so a unit test can build its own with a fake clock. */
export const queryCache = new QueryCache();
