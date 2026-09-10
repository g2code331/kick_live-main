/**
 * Phase 6: the media policy table — one line per asset kind, and the single
 * place a category, a size cap, a visibility and a cache class are decided.
 *
 * Why this is a module and not a database comment: the Worker enforces these
 * rules *before* a byte is written, and the database enforces the same rules
 * again in `kicklive_reserve_asset_upload`. Two copies of a policy is normally a
 * smell, and the alternative — the caller telling the database what its limits
 * are — is the thing that makes a limit advisory. `tests/unit/phase6-media.test.ts`
 * asserts both sides agree so a drift fails a test instead of shipping a hole.
 *
 * Video is deliberately absent from the accepted types. A 45 MB highlight reel
 * turns one upload into a multi-minute synchronous Worker request, and the app
 * already links YouTube, which is free, transcodes itself, and carries its own
 * player. `video_url` columns therefore keep holding external links (Step 7).
 */

/** Kinds with a table the registry can attach to. `sponsors`/`advertisements`
 *  are reserved prefixes for Phase 7 and are not legal asset kinds yet. */
export const MEDIA_KINDS = ["teams", "players", "competitions", "seasons", "news", "team_news", "matches", "users"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Kinds a browser may upload to. `matches` is registry-only (its media is
 *  external links), so accepting an upload for it would create rows nothing can
 *  render; `seasons` likewise has no image column to point at. */
export const UPLOADABLE_KINDS = ["teams", "players", "competitions", "news", "team_news", "users"] as const;
export type UploadableKind = (typeof UPLOADABLE_KINDS)[number];

export interface MediaCategory {
  readonly kind: MediaKind;
  /** Entity table the URL column lives on, or "" when the kind is registry-only. */
  readonly table: string;
  /** Column that receives `/api/media/assets/<key>` when an upload is published. */
  readonly urlColumn: string;
  /** Column that identifies an entity row (they are not all the same name). */
  readonly idColumn: string;
  readonly visibility: "public" | "private";
  readonly maxBytes: number;
  /** Whether the browser may upload into this prefix at all. */
  readonly uploadable: boolean;
  readonly description: string;
}

/**
 * The table. Caps are per *uploaded file*, which is the unit a user reasons in;
 * the daily quota is per account and lives in the database, because only the
 * database can see everything one account stored today.
 */
export const MEDIA_CATEGORIES: Record<MediaKind, MediaCategory> = {
  teams: { kind: "teams", table: "teams", urlColumn: "logo_url", idColumn: "id", visibility: "public", maxBytes: 5 * 1024 * 1024, uploadable: true, description: "Club crest" },
  players: { kind: "players", table: "players", urlColumn: "photo_url", idColumn: "id", visibility: "public", maxBytes: 8 * 1024 * 1024, uploadable: true, description: "Player headshot" },
  competitions: {
    kind: "competitions",
    table: "competitions",
    urlColumn: "logo_url",
    idColumn: "id",
    visibility: "public",
    maxBytes: 5 * 1024 * 1024,
    uploadable: true,
    description: "Competition logo",
  },
  seasons: {
    kind: "seasons",
    table: "seasons",
    urlColumn: "",
    idColumn: "id",
    visibility: "public",
    maxBytes: 5 * 1024 * 1024,
    uploadable: false,
    description: "Season artwork (no image column today: registry only)",
  },
  news: { kind: "news", table: "media", urlColumn: "image_url", idColumn: "id", visibility: "public", maxBytes: 10 * 1024 * 1024, uploadable: true, description: "News and match-report images" },
  team_news: { kind: "team_news", table: "team_news", urlColumn: "image_url", idColumn: "id", visibility: "public", maxBytes: 10 * 1024 * 1024, uploadable: true, description: "Club news images" },
  matches: {
    kind: "matches",
    table: "matches",
    urlColumn: "",
    idColumn: "id",
    visibility: "public",
    maxBytes: 10 * 1024 * 1024,
    uploadable: false,
    description: "Match media (highlight video stays an external link)",
  },
  // Public, and not by oversight: an <img> carries no Authorization header, so an
  // avatar that was `private` would be a broken image on every profile page. The
  // private machinery exists (`visibility` is a column, the read route and the cache
  // class honour it, retention is shorter) for the first kind that cannot be shown
  // to the world — see §5 of docs/R2_MEDIA_ARCHITECTURE.md.
  users: { kind: "users", table: "profiles", urlColumn: "avatar_url", idColumn: "id", visibility: "public", maxBytes: 5 * 1024 * 1024, uploadable: true, description: "Profile avatars" },
};

/** Types accepted, keyed by the magic bytes that were actually read. A declared
 *  MIME type is never in this set: the client's `Content-Type` is an opinion. */
export const ACCEPTED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Longest time an upload reservation may stay unfinalised before the hourly
 *  sweep records it as failed. */
export const RESERVATION_TTL_HOURS = 24;
/** How long a superseded or soft-deleted object stays restorable. */
export const RETENTION_DAYS = 30;
/** Objects per page when a bucket is listed for reconciliation or migration. */
export const LIST_PAGE_SIZE = 1000;
/** Ceiling per migration run, so a first pass cannot turn one request into an
 *  unbounded copy of the whole bucket. */
export const MIGRATION_MAX_BYTES_PER_RUN = 64 * 1024 * 1024;
export const MIGRATION_MAX_OBJECTS_PER_RUN = 200;
export const MIGRATION_CONCURRENCY = 4;

/** Character set and length of an object key — the rule the database's CHECK enforces. */
export const OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{2,509}$/;

/**
 * The whole rule a key taken from a URL must satisfy. The character set is not enough on its own:
 * `..` is inside the allowed set, and while an R2 key is an opaque string (so `a/../b` is merely a
 * different object, nobody's file), that same string is also the tail of an HTTP path, where proxies
 * and `new URL()` normalise dot-segments. A key whose meaning changes when the path is resolved is
 * refused even though the bucket would have served it harmlessly — one cheap check, and it is the
 * reader of this route who benefits.
 */
export function isSafeObjectKey(value: string): boolean {
  if (!OBJECT_KEY_PATTERN.test(value)) return false;
  if (value.includes("..") || value.includes("//")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== ".");
}

/**
 * `<entity-kind>/<entity-id>/original/v<n>-<hash8>.<ext>`, mirroring
 * `public.kicklive_asset_object_key`. The `v<n>` segment is why an asset URL can
 * be cached as immutable forever: no two versions ever share a key, so
 * replacement never invalidates what an already-rendered page points at.
 */
export function buildObjectKey(input: { kind: MediaKind; entityId: string; variant?: string; version: number; sha256: string; extension: string }): string {
  const variant = input.variant ?? "original";
  return `${input.kind}/${input.entityId}/${variant}/v${input.version}-${input.sha256.slice(0, 8)}.${input.extension}`;
}

/** The path a client renders. Absolute-from-origin so an environment change
 *  never invalidates stored rows: the browser prefixes its own API base. */
export function assetPathFor(objectKey: string): string {
  return `/api/media/assets/${objectKey}`;
}

/**
 * Cache classes, decided by the *shape of the key*, not by a header the client
 * sent (Step 13):
 *   - a versioned key is immutable: the object at that key never changes, so a
 *     shared CDN may keep it for a year;
 *   - a public, unversioned key (only the migration path writes those) is
 *     short-lived instead;
 *   - a private key is never shared, and `no-store` rather than `private`
 *     because the bytes behind it may have been replaced since the last load.
 */
export function cacheControlFor(meta: { visibility: "public" | "private"; objectKey: string }): string {
  if (meta.visibility === "private") return "private, no-store";
  const versioned = /\/v\d+-[0-9a-f]{8}\.[a-z0-9]+$/.test(meta.objectKey);
  return versioned ? "public, max-age=31536000, immutable" : "public, max-age=300, stale-while-revalidate=86400";
}

/** The id shape an entity may be named by: a serial integer or a uuid. Anything
 *  else cannot be a row, and a key prefix built from prose is how `../teams`
 *  becomes somebody's idea of a path. */
export const ENTITY_ID_PATTERN = /^[0-9a-fA-F-]{1,64}$/;

/** The policy, as it is served to a client (`GET /media/config`). Copy a UI can
 *  show, and the reason a size cap is a rule rather than a surprise. */
export function mediaPolicyDocument(env: { MEDIA_MAX_BYTES?: unknown } = {}) {
  return {
    prefixes: MEDIA_KINDS.map((kind) => {
      const category = MEDIA_CATEGORIES[kind];
      return {
        kind,
        prefix: `${kind}/`,
        maxBytes: category.maxBytes,
        visibility: category.visibility,
        uploadable: category.uploadable,
        description: category.description,
      };
    }),
    acceptedTypes: Object.keys(ACCEPTED_TYPES),
    retention: { supersededDays: RETENTION_DAYS, reservationHours: RESERVATION_TTL_HOURS },
    dailyQuotaBytes: {
      note: "enforced per account by public.kicklive_upload_quota_bytes; admin is unlimited",
      roles: { media: 268435456, team_manager: 134217728, referee: 33554432, fan: 16777216, admin: null },
    },
    perRun: { migrationMaxBytes: MIGRATION_MAX_BYTES_PER_RUN, migrationMaxObjects: MIGRATION_MAX_OBJECTS_PER_RUN },
    limits: { maxBytesPerUpload: Number(env.MEDIA_MAX_BYTES ?? 26214400) },
  };
}
