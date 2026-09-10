/**
 * The advertising policy the Worker enforces, kept beside the SQL rules it mirrors.
 *
 * Like `mediaPolicy.ts`, this file is a copy of decisions made in the migration, and it is the copy that
 * faces the browser: the request is refused here before a definer function is called at all. Two rules
 * about that relationship, learned the hard way in Phase 6:
 *
 *   - **The Worker is not the security boundary.** Every value that reaches the database is checked again
 *       there (`kicklive_ad_record_event` re-validates the viewer key with its own regex, `kicklive_ad_serve`
 *       decides eligibility, the status functions walk the transition matrix). A Worker bug must be a bad
 *       experience, not a breach.
 *   - **Anything the Worker caches must be conservative.** The key derivation, the cache lifetime and the
 *       never-servable reasons are all deliberately short or closed: a wrong answer here is remembered for
 *       the length of a CDN entry, so the longest of them is ninety seconds.
 */

import type { Env } from "../env.ts";

// ── the viewer key ──────────────────────────────────────────────────────────────────────────────────

/**
 * `^[0-9a-f]{16}$` — the same shape the database demands, because a key the database would reject must not
 * survive a round trip through the queue. Sixteen hex characters is 64 bits, which is not a secret: it is a
 * bucket label, and the design says so out loud (`docs/PRIVACY.md`).
 */
export const VIEWER_KEY_PATTERN = /^[0-9a-f]{16}$/;

/** A browser-supplied first-party id: long enough to be stable, boring enough to be loggable. */
export const VIEWER_SEED_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** The day the key is derived for. UTC, because the rollups are UTC days and the two must agree. */
export function viewerKeyDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function deriveKey(secret: string, subject: string, day: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${subject}|${day}`)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

/**
 * Derive today's key for a subject. A signed-in caller's subject is their user id and nothing else — never a
 * device fingerprint — so the same person on two devices gets two keys, which is the price of not being able
 * to say they are one person. An anonymous caller's subject is the id they generated themselves.
 *
 * The key is derived, not stored, which is what makes "delete this viewer's history" answerable without a
 * purge job: rotating `AD_VIEWER_KEY_SECRET` invalidates every key ever issued, and the rows they appear in
 * can no longer be joined to a person by anyone — including us.
 */
export function deriveViewerKey(env: Env, subject: string, day = viewerKeyDay()): Promise<string> {
  const secret = env.AD_VIEWER_KEY_SECRET;
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("AD_VIEWER_KEY_SECRET is missing or shorter than 16 characters");
  }
  return deriveKey(secret, subject, day);
}

/**
 * Whether a key the browser presented belongs to this subject today. Compared in constant time against the
 * derived value, which is the same thing as comparing the two strings without a branch that leaks where they
 * diverge — and it means a bug in `deriveKey` shows up as a refusal, not as an accept of a stale key.
 */
export async function verifyViewerKey(env: Env, subject: string, day: string, presented: string): Promise<boolean> {
  if (!VIEWER_KEY_PATTERN.test(presented)) return false;
  const expected = await deriveViewerKey(env, subject, day);
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

// ── the events ──────────────────────────────────────────────────────────────────────────────────────

export const AD_EVENT_NAMES = ["impression", "click"] as const;
export type AdEventName = (typeof AD_EVENT_NAMES)[number];

/**
 * One batch per page view is the intent; twenty is the cap, and it exists so that a body cannot make the
 * Worker issue an arbitrarily large insert. A creative that legitimately needs more than this is a page
 * redesign conversation, not an API argument: the four slots are all a browser sees at once.
 */
export const MAX_EVENTS_PER_BODY = 20;

/**
 * Query parameters a click-through is allowed to carry over to the advertiser. `utm_*` and the two click ids
 * in the list: the *advertiser's* attribution, not ours. Everything else is dropped, because a parameter we
 * do not control is how a click link turns into a tracking pixel with our domain on it.
 */
export const TRACKING_PARAM_ALLOWLIST = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"] as const;
export const MAX_TRACKING_PARAMS = 8;

export function filterTrackingParams(search: string): string {
  const kept: string[] = [];
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return "";
  }
  for (const [name, value] of params) {
    const allowed = (TRACKING_PARAM_ALLOWLIST as readonly string[]).includes(name) || /^utm_[a-z]+$/.test(name);
    if (allowed && value.length <= 128) kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    if (kept.length >= MAX_TRACKING_PARAMS) break;
  }
  return kept.join("&");
}

// ── caching ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The default lifetime of a placement response. The database may shorten it to zero (a slot with targeting,
 * or nothing eligible to serve); it may never lengthen it past this, so the cacheable window is bounded in
 * code and not only in configuration. Ninety seconds is "a pause is visible in the next minute and a half"
 * at the top end, and one fetch per page view at the bottom.
 */
export const DEFAULT_CACHE_TTL_SECONDS = 90;
export const MAX_CACHE_TTL_SECONDS = DEFAULT_CACHE_TTL_SECONDS;

/**
 * The header value the cache-control parser accepts, and nothing else. `mediaPolicy.ts` refuses to share its
 * regex for a reason worth repeating: a response that says `private` must never be re-read as a request for
 * `public, immutable`, and two different grammars in one file is how that happens.
 */
export const AD_CACHE_HEADER_RE = /^(?:(?:public|private|max-age=\d+|s-maxage=\d+|stale-while-revalidate=\d+|must-revalidate|no-cache)(?:,\s*)?)+$/;

/**
 * How long a placement response may be held, given what it contains.
 *
 * A response built for one viewer must not be served to another, so a personalisation signal (a targeting
 * context the caller supplied) forces `private, no-store` regardless of what the database asked for. This is
 * the whole reason the serve route looks at the session before it looks at the cache header.
 */
export function adCacheControl(opts: { ttlSeconds: number | null | undefined; personalised: boolean; empty: boolean }): Record<string, string> {
  if (opts.personalised) return { "cache-control": "private, no-store" };
  // An empty answer is cached too, and briefly: a slot with nothing eligible is the common case, and an
  // un-cacheable empty answer is one origin fetch per page view for the privilege of showing nothing.
  const ttl = Math.max(0, Math.min(MAX_CACHE_TTL_SECONDS, Math.trunc(opts.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS)));
  return { "cache-control": `public, max-age=${ttl}, stale-while-revalidate=${Math.max(ttl, 30)}` };
}

// ── the reasons ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Reasons a viewer cannot be served anything, and which therefore refuse *events* too. Mirrors
 * `kicklive_ad_never_servable_reason` in the migration; the database is authoritative and this list only
 * decides what the Worker logs at what level, so a missing entry costs verbosity and not correctness.
 */
export const NEVER_SERVABLE_REASONS = ["not_placed_in_slot", "slot_disabled", "placement_disabled", "no_creative", "slot_refuses_this_format", "advertisement_not_found"] as const;
export type NeverServableReason = (typeof NEVER_SERVABLE_REASONS)[number];

export function isNeverServable(reason: string | null | undefined): boolean {
  return typeof reason === "string" && (NEVER_SERVABLE_REASONS as readonly string[]).includes(reason);
}

/** Refusal codes a client may be told about, and what each one costs the caller. */
export const AD_ERROR_STATUS: Record<string, number> = {
  ADMIN_ONLY: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CAMPAIGN_NOT_FOUND: 404,
  CAMPAIGN_NOT_READY: 409,
  NO_ELIGIBLE_CREATIVE: 409,
  ACTIVE_CREATIVE_EXISTS: 409,
  CREATIVES_NOT_READY: 409,
  TRANSITION_NOT_ALLOWED: 409,
  CONFLICT: 409,
  DUPLICATE_TITLE_IN_CAMPAIGN: 409,
  IDENTITY_REQUIRED: 401,
  PLACE_CODE_IMMUTABLE: 400,
  KIND_UNKNOWN: 400,
  UNKNOWN_GROUP_BY: 400,
  INVALID_UUID: 400,
  INVALID_EVENT: 400,
  MALFORMED_VIEWER_KEY: 400,
  UNKNOWN_PLACEMENT: 400,
  PLACEMENT_UNKNOWN: 400,
  UNKNOWN_DISCLOSURE_LABEL: 400,
  UNKNOWN_STATUS: 400,
  WINDOW_NOT_ORDERED: 400,
  WINDOW_TOO_WIDE: 400,
  LIMIT_UNBOUNDED: 400,
  HTTPS_URL_WITH_HOST_REQUIRED: 400,
  FORMAT_NOT_ALLOWED_IN_SLOT: 400,
  FORMAT_INCOMPATIBLE: 400,
  PLACEMENT_NOT_ALLOWED: 400,
  DUPLICATE_PLACEMENT: 400,
  TARGETING_KEYS: 400,
  TARGETING_TOO_LARGE: 400,
  BAD_KEY_SET: 400,
  NOT_A_PLACEMENT: 400,
  TOO_MANY_EVENTS: 413,
  VALIDATION_FAILED: 400,
};

export function adErrorStatus(code: string | null | undefined): number {
  if (!code) return 400;
  return AD_ERROR_STATUS[code] ?? 400;
}

// ── the disclosure ──────────────────────────────────────────────────────────────────────────────────

/**
 * What a slot may say above an advertisement. The set is closed and short on purpose — a label like
 * "More from KickLive" would be a disclosure in name only, and the database rejects everything else — so a
 * client that renders the label verbatim cannot be the place a misleading one appears.
 */
export const DISCLOSURE_LABELS = ["Sponsored", "Advertisement", "Promoted", "Partner content"] as const;
export const DEFAULT_DISCLOSURE_LABEL = "Sponsored";

/** The relationship a sponsored link declares, and the reason each token is there. */
export const SPONSORED_LINK_REL = "sponsored nofollow noopener" as const;

/**
 * A destination must be https with a host and no credentials. The database holds the same rule in a CHECK and
 * will refuse the row anyway; this copy turns the refusal into a field error before an upload or a form
 * submission is lost. `no credentials` is not decoration: `https://user@host/` is a password prompt waiting
 * to happen on an advertiser's page.
 */
export function isSafeDestination(raw: string): boolean {
  if (!/^https:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (!url.hostname || url.username || url.password) return false;
    if (url.hostname.includes("://")) return false;
    return url.href.length <= 2048;
  } catch {
    return false;
  }
}

/** Slot codes are `[A-Z][A-Z0-9_]{1,31}` — a shape, not a registry; `ad_placements` owns which ones exist. */
export const PLACEMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
export const ADVERTISEMENT_FORMATS = ["image", "html"] as const;
