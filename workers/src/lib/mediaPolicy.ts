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

/** Kinds with a table the registry can attach to. `advertisements` (Phase 7) and `sponsors` (Phase 8) were
 *  reserved prefixes in Phase 6 and each became legal in the migration that created the table it points at —
 *  a kind that is legal before its table exists is an invitation to write objects nothing can authorize or
 *  render. The list is pinned against the *final* `media_assets_kind_check` (across every later migration) by
 *  `tests/unit/phase6-media.test.ts`, so adding an entity table without saying so here fails a test. */
export const MEDIA_KINDS = [
  "teams",
  "players",
  "competitions",
  "seasons",
  "news",
  "team_news",
  "matches",
  "users",
  // A registry-only kind, added by the same migration that creates the table it points at: `advertisements`
  // widens `media_assets_kind_check` in Phase 7 for exactly that reason, and `sponsors` did the same in
  // Phase 8. Both are registry-only for the same reason: their URL column is written by a function that knows
  // whose entity it is, not by the generic publish path.
  "advertisements",
  "sponsors",
] as const;
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
  // Registry-only kinds: they exist so that an asset row can name its entity and be *authorized* by a
  // function that knows the table, and so `kicklive_entity_assets` can answer for them. None is uploadable
  // from the generic media route — an advertisement's creative is reserved through
  // `kicklive_ad_reserve_creative`, which checks that the caller owns the flight's advertiser, and a
  // sponsor's logo through `kicklive_sponsor_reserve_asset`, which checks the sponsorship desk. A
  // `urlColumn` of "" is the type-level statement of that: there is no entity column for a publish to
  // repoint, so the generic path physically cannot attach one by accident.
  sponsors: {
    // Phase 8. Two slots per sponsor — `logo` and `banner` — and both are public, because a badge on a
    // competition page is shown to everybody who can see the page. `urlColumn` is "" because
    // `kicklive_asset_url_column` deliberately has no `sponsors` arm: Phase 6's publish path must not be able
    // to repoint a sponsor's logo, since the only writer of `logo_url`/`banner_url` is
    // `kicklive_sponsor_attach_asset`, which checks that the asset was reserved *for that sponsor*. The caps
    // here mirror that function (5 MiB logo, 10 MiB banner), and the sizes are the reason the entry is not the
    // generic 5 MiB — a wide banner is the one asset a sponsor reliably sends that is larger than a crest.
    kind: "sponsors",
    table: "sponsors",
    urlColumn: "",
    idColumn: "id",
    visibility: "public",
    maxBytes: 10 * 1024 * 1024,
    uploadable: false,
    description: "Sponsor logo and banner (reserved per slot by kicklive_sponsor_reserve_asset)",
  },
  advertisements: {
    kind: "advertisements",
    table: "advertisements",
    urlColumn: "image_url",
    idColumn: "id",
    visibility: "public",
    maxBytes: 10 * 1024 * 1024,
    uploadable: false,
    description: "Advertisement creatives (image format only; HTML is stored as text, not bytes)",
  },
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

/** Character set of an object key — the rule the database's CHECK enforces. */
export const OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{2,}$/;
/**
 * …which is only half of that CHECK. The length bound is a separate predicate on both sides because
 * Postgres' regex engine refuses a repetition count above 255 (`{2,509}` is rejected at *evaluation*
 * time, so the failure would surface as every insert erroring rather than as a bad migration), and a
 * key this long is not a thing this app produces: the longest real one is ~70 characters.
 */
export const OBJECT_KEY_MIN_LENGTH = 3;
export const OBJECT_KEY_MAX_LENGTH = 512;

/**
 * The whole rule a key taken from a URL must satisfy. The character set is not enough on its own:
 * `..` is inside the allowed set, and while an R2 key is an opaque string (so `a/../b` is merely a
 * different object, nobody's file), that same string is also the tail of an HTTP path, where proxies
 * and `new URL()` normalise dot-segments. A key whose meaning changes when the path is resolved is
 * refused even though the bucket would have served it harmlessly — one cheap check, and it is the
 * reader of this route who benefits.
 */
export function isSafeObjectKey(value: string): boolean {
  if (value.length < OBJECT_KEY_MIN_LENGTH || value.length > OBJECT_KEY_MAX_LENGTH) return false;
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
