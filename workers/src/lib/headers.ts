/**
 * Response headers, kept out of the entry point so the pipeline reads as a pipeline.
 *
 * `SECURITY_HEADERS` protects the API's own responses (the SPA's CSP covers the document; an error
 * page a browser might render for a JSON body has none). `cacheHeadersFor` encodes one rule that
 * matters more than it looks: a per-user response cached at the edge is a cross-account leak with the
 * cache layer's stamp of approval, so only public, non-personal routes may be cached.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

/** Default for anything that is not explicitly edge-cacheable. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Declared by a route in `router.ts`; decides whether a shared cache may hold the response.
 *
 * `handler` was added for Phase 6's read-through: a stored object's policy depends on the
 * object (an immutable versioned key for a year, `private, no-store` for somebody's avatar),
 * and no class a route can name statically describes that. The handler therefore sets
 * `cache-control` itself and the entry point leaves it alone — see `finalise`, which still
 * forces `no-store` when a `handler` route forgets to say anything.
 */
export type CacheClass = "edge" | "private" | "none" | "handler";

export function cacheHeadersFor(cache: CacheClass): Record<string, string> {
  if (cache === "handler") return {};
  if (cache === "edge") {
    // 30 s browser / 60 s edge, and stale-while-revalidate so a fixture list keeps answering while it
    // refreshes. Scores are fresher than this only via the Phase 3 stream, never via this route.
    return { "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" };
  }
  return { "cache-control": "no-store" };
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Trust the caller's id only as a correlation token; regenerate when it is missing or absurd. */
export function requestIdFrom(header: string | null): string {
  if (header && /^[A-Za-z0-9._-]{8,64}$/.test(header)) return header;
  return newRequestId();
}

export function withSecurityHeaders(headers: Headers, extra: Record<string, string> = {}): Headers {
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) headers.set(k, v);
  return headers;
}
