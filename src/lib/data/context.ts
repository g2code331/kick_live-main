/**
 * KICKLIVE · data layer context (Phase 4)
 *
 * `queries.ts` never imports `supabase` at module scope and never reaches for `src/lib/api` itself: it is
 * handed a `DataCtx`. That is not ceremony, it is what makes this phase's headline claim testable — "the
 * home page used to fire 6 reads, now it fires 1" is only a sentence unless the same query spec can be run
 * against a `db` that counts calls in `node --test`, where `src/lib/supabase.ts` cannot be imported at all
 * (it throws on a missing project, by design — see `docs/SECURITY_AUDIT_PHASE1.md` F-03).
 *
 * A spec is `{ key, tags, ttlMs, fetch }` rather than a function that calls `cache.read`, so the key is
 * knowable synchronously (React needs it to subscribe before the first await) while the fetch stays async.
 */
import type { ApiClient } from "../api/client.ts";
import { perf, type PerfSink } from "./perf.ts";
import { queryCache, type QueryCache, type ReadResult } from "./cache.ts";

/**
 * The subset of the PostgREST builder the reads use, plus the result shape they unwrap.
 *
 * Every modifier widens to `QueryBuilder<any>` rather than threading `T` through the chain: the type that
 * matters here is the one at `rows<T>()`/`one<T>()`, where the caller states what the page expects. Chaining
 * generics would buy nothing and cost a cast at every call site — exactly the noise this layer exists to
 * remove. A fake `db` in a test only has to implement these methods.
 */
export interface PostgrestResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
  count: number | null;
}

export interface QueryBuilder<T = any> extends PromiseLike<PostgrestResult<T>> {
  select(columns: string, options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<any>;
  neq(column: string, value: unknown): QueryBuilder<any>;
  in(column: string, values: readonly unknown[]): QueryBuilder<any>;
  gte(column: string, value: unknown): QueryBuilder<any>;
  lte(column: string, value: unknown): QueryBuilder<any>;
  ilike(column: string, pattern: string): QueryBuilder<any>;
  or(filter: string, options?: { referencedTable?: string }): QueryBuilder<any>;
  filter(column: string, op: string, value: unknown): QueryBuilder<any>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string }): QueryBuilder<any>;
  limit(n: number): QueryBuilder<any>;
  range(from: number, to: number): QueryBuilder<any>;
  single(): QueryBuilder<T>;
  maybeSingle(): QueryBuilder<T>;
}

export interface Db {
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface DataCtx {
  db: Db;
  /** The Worker boundary, or `undefined` when no API root is configured for this build. */
  api?: ApiClient;
}

export interface QuerySpec<T, A = void> {
  /** The name of the question. Two callers with the same key share one request and one entry. */
  key(args: A): string;
  /** What a mutation invalidates this by. Include the parent tag (`standings`) as well as the specific
   *  one (`standings:7`) so "the competition changed" and "match 7 was finalised" both land. */
  tags(args: A): readonly string[];
  ttlMs: number;
  /** Floor between fetches of this key however many callers ask. */
  minIntervalMs?: number;
  /** Mirror to `sessionStorage`: only for reads that are safe to show before they are revalidated. */
  persist?: boolean;
  /** Cadence for a screen that wants this kept warm while it is open (`usePolledQuery`). */
  pollMs?: number;
  fetch(db: DataCtx, args: A, signal?: AbortSignal): Promise<T | null>;
}

export function defineQuery<T, A = void>(spec: QuerySpec<T, A>): QuerySpec<T, A> {
  return spec;
}

let ctxPromise: Promise<DataCtx> | null = null;
let forced: DataCtx | null = null;

/** The browser's context, resolved lazily so importing this module never needs a configured project. */
export function loadCtx(): Promise<DataCtx> {
  if (forced) return Promise.resolve(forced);
  ctxPromise ??= (async () => {
    const [{ supabase }, { api }] = await Promise.all([import("../supabase.ts"), import("../api/index.ts")]);
    return {
      // One structural cast at the boundary instead of `as any` in forty files.
      db: supabase as unknown as Db,
      api,
    };
  })();
  return ctxPromise;
}

/** Test seam: hand the layer a fake `db` (and optionally a fake `api`) with no network at all. */
export function setCtx(ctx: DataCtx | null): void {
  forced = ctx;
}

/** Run a spec through a cache. Pages call this through `useQuery`; tests call it directly. */
export async function runQuery<T, A>(spec: QuerySpec<T, A>, args: A, options: { cache?: QueryCache; ctx?: DataCtx; signal?: AbortSignal; sink?: PerfSink } = {}): Promise<ReadResult<T>> {
  const cache = options.cache ?? queryCache;
  const ctx = options.ctx ?? (await loadCtx());
  return await cache.read<T>({
    key: spec.key(args),
    tags: spec.tags(args),
    ttlMs: spec.ttlMs,
    minIntervalMs: spec.minIntervalMs,
    persist: spec.persist,
    fetch: () => spec.fetch(ctx, args, options.signal),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Await a builder and turn a PostgREST error into a throw the cache records as `error` + keeps the old data. */
export async function rows<T>(builder: QueryBuilder<any>): Promise<T> {
  const res = await builder;
  if (res.error) throw new Error(`${res.error.code ?? "PGRST"}: ${res.error.message}`);
  return (res.data ?? ([] as unknown as T)) as T;
}

export async function one<T>(builder: QueryBuilder<any>): Promise<T | null> {
  const res = await builder;
  if (res.error) throw new Error(`${res.error.code ?? "PGRST"}: ${res.error.message}`);
  return (res.data ?? null) as T | null;
}

/**
 * `true` when an error means "this is not deployed yet" — a reason to fall back — as opposed to "the
 * database said no", which is a reason to show the error.
 *
 * The patterns are deliberately specific. An earlier draft matched bare `501|503`, and `42501 permission
 * denied` contains `501`: a permission error would have been read as "not deployed" and answered by
 * falling back to the very table read the policy just refused. Codes are matched as codes.
 */
export function isMissingOnServer(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "object" && err !== null ? String((err as { message?: unknown }).message ?? (err as { code?: unknown }).code ?? "") : String(err ?? "");
  return /\bPGRST202\b|Could not find the function|\bNOT_IMPLEMENTED\b|\bDEPENDENCY_FAILED\b|\b404\b.*not (found|deployed)/i.test(message);
}

/** A fetcher that must not fail the whole page: log, count, return the fallback. */
export async function soft<T>(label: string, run: () => Promise<T>, fallback: T, sink: PerfSink = perf): Promise<T> {
  try {
    return await run();
  } catch (err) {
    sink.record({ type: "fetch-error", key: label, detail: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

export { queryCache };
export type { ReadResult };
