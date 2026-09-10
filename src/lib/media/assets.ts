/**
 * Phase 6: resolving a stored media URL to something a browser can load.
 *
 * Why this module exists at all: an R2 key belongs to one environment, and a URL
 * that embeds a key belongs to none. So the database stores the *path*
 * (`/api/media/assets/teams/7/original/v3-9f2c1a4d.png`) and this file turns it
 * into an absolute URL at render time using the same `VITE_API_BASE_URL` the API
 * client uses. The consequence is the point: a staging row copied into
 * production renders correctly without a data migration, and a deploy that changes
 * the API origin does not break ten thousand stored URLs.
 *
 * The second half of the job is that **nothing else changes shape**. A legacy
 * Supabase Storage URL, an unsplash hotlink, a `data:` URI, a `blob:` preview and
 * a relative bundled path (`/placeholder-team-logo.png`) all pass through
 * untouched, because they were never ours to rewrite. Phase 6 is additive: no
 * column was migrated, so no renderer may assume only the new form exists.
 *
 * Keep the two rules in sync with the Worker:
 *   - `MEDIA_ASSET_PATH` matches `assetPathFor()` in `workers/src/lib/mediaPolicy.ts`;
 *   - the base resolution matches `joinUrl()` in `src/lib/api/client.ts`, so an
 *     image and the JSON that describes it can never be fetched from different hosts.
 */
import { getApiBaseUrl } from "../env.ts";

/** The prefix the Worker serves read-through media under (API_ROOT + `/media/assets`). */
export const MEDIA_ASSET_PATH = "/api/media/assets/";

/** Is this value one of ours? `assetUrl` is called on data from six tables, and a
 *  wrong answer here is a broken image rather than an error, so the test is exact. */
export function isManagedAssetPath(value: string): boolean {
  return value.startsWith(MEDIA_ASSET_PATH) || value.startsWith("/media/assets/");
}

let cachedBase: string | null = null;

/**
 * The API origin, or "" for same-origin.
 *
 * `getApiBaseUrl()` throws when the configuration is wrong, and an image `src` is
 * the worst place for a thrown error: it does not surface in an error boundary, it
 * just shows a broken icon. So a failure here degrades to "" (relative URL, which
 * is what a correctly configured same-origin app would have produced anyway) and
 * the API call the user makes next is where the real error surfaces.
 */
export function mediaAssetBase(): string {
  if (cachedBase !== null) return cachedBase;
  try {
    cachedBase = getApiBaseUrl().replace(/\/+$/, "");
  } catch {
    cachedBase = "";
  }
  return cachedBase;
}

/** Test seam: the base is cached because it is read once per image on a page with
 *  forty of them, and a test that changes the environment must be able to say so. */
export function resetMediaAssetBaseForTests(): void {
  cachedBase = null;
}

/**
 * Turn a stored value into a renderable URL.
 *
 * Non-string input, an empty string and a whitespace-only value all answer
 * `fallback` (usually the app's placeholder), so a caller never has to guard
 * before use and a null image does not become the string "null".
 *
 * The default fallback is `undefined` rather than `null` for one concrete reason: the overwhelmingly
 * common call is `src={assetUrl(row.image_url)}`, and React's DOM/`ImgHTMLAttributes` prop type is
 * `string | undefined`. A `null` here would be the same thing at runtime — React omits the attribute
 * either way — but it would make every one of those call sites a type error, and the fix people reach
 * for under that pressure is `String(assetUrl(...))`, which is exactly how a missing image becomes the
 * literal text "null" on a page. Use `assetUrlOrEmpty` where an empty string is wanted instead.
 */
export function assetUrl(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (isManagedAssetPath(trimmed)) {
    const rooted = trimmed.startsWith("/api/") ? trimmed : `/api${trimmed}`;
    const base = mediaAssetBase();
    // No base means the app and the API share an origin, which is how the deployed
    // SPA and the Vite dev server (which proxies /api to `wrangler dev`) both work:
    // a relative URL keeps the request on whatever host the page is on.
    return base ? `${base}${rooted}` : rooted;
  }
  return trimmed;
}

/** For a `<picture>`/`srcSet` case or any list built from the same row: same rule,
 *  but it never returns nothing, because srcSet strings cannot contain that. */
export function assetUrlOrEmpty(value: unknown): string {
  return assetUrl(value) ?? "";
}

/** Where an upload is posted. Relative when the app is same-origin with the API, so
 *  a preview deployment needs no extra configuration. */
export function mediaUploadEndpoint(): string {
  const base = mediaAssetBase();
  return `${base}/api/media/uploads`;
}

/** And the read endpoint, for the `?purge=true` case and for a restore call. */
export function mediaAssetEndpoint(assetId: number | string): string {
  return `${mediaAssetBase()}/api/media/assets/${encodeURIComponent(String(assetId))}`;
}

export function mediaEntityAssetsEndpoint(kind: string, entityId: string | number): string {
  return `${mediaAssetBase()}/api/media/entities/${encodeURIComponent(kind)}/${encodeURIComponent(String(entityId))}`;
}
