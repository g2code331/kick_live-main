/**
 * Phase 6: the media store — the pipeline every object goes through, and the
 * only module in the Worker that touches the bucket.
 *
 * Two seams, both injectable, for the same reason as Phase 5's `NotifierDeps`:
 *   `MediaBucket`      the four R2 operations this app uses (put/head/get/delete
 *                      /list), so a test can be a Map and a deploy can be R2;
 *   `MediaRepository`  the registry, i.e. the `kicklive_*` functions.
 *
 * The order of operations is the whole design and is not negotiable:
 *
 *   1. sniff the bytes, and refuse anything the format check rejects;
 *   2. ask the database to *reserve* — authorization, quota, dedupe, version
 *      number and the key all come back from there;
 *   3. write to exactly the key the database named;
 *   4. confirm the size the bucket reports matches what was sent;
 *   5. only then publish (finalize 'stored'), which is the moment the entity
 *      URL starts pointing at the object.
 *
 * A failure at step 3 or 4 closes the reservation as `failed`, so the entity
 * keeps its previous image and the orphan is visible to diagnostics. There is no
 * step in which a client sees a URL that does not resolve.
 */

import { ApiError } from "../lib/response.ts";
import { probeImage, sha256Hex } from "../lib/imageProbe.ts";
import { ACCEPTED_TYPES, MEDIA_CATEGORIES, assetPathFor, cacheControlFor, type MediaKind } from "../lib/mediaPolicy.ts";
import { supabaseAdmin, supabaseAsUser, type SupabaseRest } from "./supabase.ts";
import type { Env } from "../env.ts";

export interface AssetMeta {
  readonly id: number;
  readonly objectKey: string;
  readonly visibility: "public" | "private";
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly etag: string | null;
  readonly entityKind: string;
  readonly entityId: string;
}

export interface ReserveInput {
  readonly kind: MediaKind;
  readonly entityId: string;
  readonly variant: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
}

/** Exactly as `kicklive_reserve_asset_upload` answers it. One literal per arm so
 *  the caller's narrowing is a discriminant check and not a guess. */
export type ReserveOutcome =
  | { status: "proceed"; asset: ReservedAsset }
  | { status: "skip_upload"; asset: ReservedAsset }
  | { status: "rejected"; reason: string; quota_bytes?: number; used_bytes?: number; requested_bytes?: number }
  | { status: "forbidden"; reason: string }
  | { status: "unauthenticated" };

export interface ReservedAsset {
  id: number;
  object_key: string;
  version: number;
  visibility: "public" | "private";
  status: string;
}

export type FinalizeOutcome = { status: "ok" | "failed" | "rejected"; url?: string; attached?: boolean; idempotent?: boolean; reason?: string };

/** The subset of `R2Bucket` this module needs. Declared rather than imported
 *  from worker types so a test can hand over a Map and TypeScript is satisfied
 *  either way. */
export interface MediaBucket {
  put(
    key: string,
    value: ArrayBufferView | ArrayBuffer,
    options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string>; checksums?: Record<string, string> },
  ): Promise<{ etag?: string } | void>;
  head(key: string): Promise<{ etag?: string; contentType?: string; size?: number } | null>;
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number } },
  ): Promise<{ body: ReadableStream<Uint8Array> | ArrayBuffer | null; etag?: string; contentType?: string; size?: number; range?: { offset: number; length: number } | null } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface MediaRepository {
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  finalize(assetId: number, outcome: "stored" | "existing" | "failed", extra?: { etag?: string; actualSize?: number; reason?: string }): Promise<FinalizeOutcome>;
  resolve(objectKey: string): Promise<AssetMeta | null>;
  isAuthorizedFor(objectKey: string): Promise<boolean>;
  history(kind: MediaKind, entityId: string): Promise<readonly unknown[]>;
  remove(assetId: number, purge: boolean): Promise<{ status: string; reason?: string; object_key?: string; delete_object?: boolean; action?: string }>;
  restore(assetId: number): Promise<{ status: string; reason?: string }>;
  sweep(limit?: number): Promise<{ status: string; expired_reservations?: number; keys_to_delete?: readonly { object_key: string }[] }>;
  reconcile(liveKeys: readonly string[], prefix: string | null): Promise<unknown>;
  diagnostics(): Promise<unknown>;
  recordMigrated(input: Record<string, unknown>): Promise<unknown>;
  /** Has this legacy storage URL been through the migration? Answers with the object
   *  key it produced, or null. The cheap reply that keeps a re-run from re-fetching
   *  anything, which is what makes "run it again" the recovery step. */
  seen(sourceUrl: string): Promise<string | null>;
}

/** The publish pipeline's result, as a discriminated union so the route can map
 *  each arm to an HTTP status without guessing from a message string. */
export type PublishResult =
  | {
      outcome: "stored" | "existing";
      assetId: number;
      objectKey: string;
      url: string;
      version: number;
      bytes: number;
      contentType: string;
      width: number | null;
      height: number | null;
      sha256: string;
    }
  | { outcome: "refused"; status: 400 | 403 | 413 | 429; code: "VALIDATION_FAILED" | "FORBIDDEN" | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED"; reason: string; detail?: Record<string, unknown> };

const FORBIDDEN_REASONS = new Set(["NOT_YOUR_CLUB", "NOT_YOUR_ARTICLE", "NOT_SELF", "NOT_OWNER", "NOT_RESERVER", "ADMIN_REQUIRED", "NO_PROFILE", "PURGE_ADMIN_ONLY"]);

export interface PublishDeps {
  bucket: MediaBucket;
  repo: MediaRepository;
  /** Overridable so a test can prove the order without a clock. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * One file, one entity slot. `bytes` must be the exact body that was read from
 * the request — the digest and the sniffing are both computed here so no caller
 * can pass a hash of something other than what it wrote.
 */
export async function publishAsset(input: { kind: MediaKind; entityId: string; variant?: string; alt?: string | null; bytes: Uint8Array }, deps: PublishDeps): Promise<PublishResult> {
  const category = MEDIA_CATEGORIES[input.kind];
  const log = deps.log ?? (() => {});
  const bytes = input.bytes;

  if (bytes.byteLength === 0) return { outcome: "refused", status: 400, code: "VALIDATION_FAILED", reason: "EMPTY_FILE" };
  // Checked here as well as in the database: refusing a 40 MB body before it is
  // hashed and re-uploaded to the bucket is cheaper for everyone, and the error
  // the user gets names their own file rather than a server-side limit.
  if (bytes.byteLength > category.maxBytes) {
    return { outcome: "refused", status: 413, code: "PAYLOAD_TOO_LARGE", reason: "TOO_LARGE", detail: { maxBytes: category.maxBytes, bytes: bytes.byteLength, kind: input.kind } };
  }

  const probe = probeImage(bytes);
  if (!probe.mime || !(probe.mime in ACCEPTED_TYPES) || (probe.reason && probe.reason !== "DIMENSIONS_UNAVAILABLE")) {
    return {
      outcome: "refused",
      status: 400,
      code: "VALIDATION_FAILED",
      reason: probe.reason && probe.reason in { TOO_MANY_PIXELS: 1, MARKUP_REJECTED: 1, TOO_SMALL: 1, UNSUPPORTED_TYPE: 1, DIMENSIONS_UNAVAILABLE: 1 } ? probe.reason : "UNSUPPORTED_TYPE",
      detail: { declaredType: null, detectedType: probe.mime, maxDimension: 8192 },
    };
  }
  const extension = ACCEPTED_TYPES[probe.mime];

  const digest = await sha256Hex(bytes);
  const reserve = await deps.repo.reserve({
    kind: input.kind,
    entityId: input.entityId,
    variant: input.variant ?? "original",
    // The sniffed type is what gets stored. The declared one is dropped, because
    // storing an attacker's `content_type` is how a stored file becomes a
    // served file with a browser-sniffable type.
    contentType: probe.mime,
    byteSize: bytes.byteLength,
    sha256: digest,
    width: probe.width,
    height: probe.height,
    alt: input.alt ?? null,
  });

  if (reserve.status === "unauthenticated") return { outcome: "refused", status: 403, code: "FORBIDDEN", reason: "UNAUTHENTICATED" };
  if (reserve.status !== "proceed" && reserve.status !== "skip_upload") {
    const reason = reserve.reason ?? "REFUSED";
    // One lookup table for the whole refusal mapping. A quota refusal answers 429
    // and a rejected file answers 400 or 413 precisely because a client that sees
    // 5xx will retry, and retrying a file that will never be accepted is a
    // self-inflicted outage.
    const status: 400 | 403 | 413 | 429 = reason === "QUOTA_EXCEEDED" ? 429 : reason === "TOO_LARGE" ? 413 : FORBIDDEN_REASONS.has(reason) ? 403 : 400;
    const code = status === 429 ? "RATE_LIMITED" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 403 ? "FORBIDDEN" : "VALIDATION_FAILED";
    return {
      outcome: "refused",
      status,
      code,
      reason,
      detail:
        reserve.status === "rejected" && reserve.quota_bytes !== undefined ? { quotaBytes: reserve.quota_bytes, usedBytes: reserve.used_bytes, requestedBytes: reserve.requested_bytes } : undefined,
    };
  }

  const objectKey = reserve.asset.object_key;

  if (reserve.status === "skip_upload") {
    // Nothing to write; close the reservation so it does not surface as an
    // orphan, and let finalize's idempotent branch report the existing asset.
    const done = await deps.repo.finalize(reserve.asset.id, "existing");
    if (done.status !== "ok") throw new ApiError("DEPENDENCY_FAILED", 502, "The duplicate upload could not be recorded.", { detail: done.reason });
    return {
      outcome: "existing",
      assetId: reserve.asset.id,
      objectKey,
      url: assetPathFor(objectKey),
      version: reserve.asset.version,
      bytes: bytes.byteLength,
      contentType: probe.mime,
      width: probe.width,
      height: probe.height,
      sha256: digest,
    };
  }

  try {
    // R2 verifies this itself: a write whose bytes do not match the digest we
    // computed is rejected by the bucket, not by us afterwards.
    await deps.bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: probe.mime, "cache-control": "public, max-age=31536000, immutable" },
      customMetadata: { sha256: digest, entityKind: input.kind, entityId: input.entityId, version: String(reserve.asset.version) },
      checksums: { webSha256: digest },
    });
  } catch (cause) {
    // Step 17's failure mode: the row exists, the object does not, and the
    // entity URL must not have moved. Recorded as failed and reported.
    const why = cause instanceof Error ? cause.name || "BUCKET_PUT_FAILED" : "BUCKET_PUT_FAILED";
    log("media.bucket_put_failed", { assetId: reserve.asset.id, key: objectKey, error: why });
    await deps.repo.finalize(reserve.asset.id, "failed", { reason: "BUCKET_PUT_FAILED" });
    throw new ApiError("DEPENDENCY_FAILED", 502, "Storage accepted the upload and then refused it. Your file was not published.", { detail: why });
  }

  const head = await deps.bucket.head(objectKey);
  if (!head) {
    log("media.head_missing", { assetId: reserve.asset.id, key: objectKey });
    await deps.repo.finalize(reserve.asset.id, "failed", { reason: "OBJECT_MISSING_AFTER_WRITE" });
    throw new ApiError("DEPENDENCY_FAILED", 502, "Storage reported a write that is not there. Your file was not published.");
  }
  if (typeof head.size === "number" && head.size !== bytes.byteLength) {
    await deps.repo.finalize(reserve.asset.id, "failed", { reason: "SIZE_MISMATCH" });
    throw new ApiError("DEPENDENCY_FAILED", 502, "Stored size does not match the upload. Your file was not published.", {
      detail: JSON.stringify({ expected: bytes.byteLength, stored: head.size }),
    });
  }

  const done = await deps.repo.finalize(reserve.asset.id, "stored", { etag: head.etag ?? undefined, actualSize: head.size ?? bytes.byteLength });
  if (done.status !== "ok") {
    // The object is in the bucket and the row says `failed`: that is an orphan by
    // definition, and diagnostics is how it gets seen. Leaving the reservation
    // open would hide it.
    log("media.finalize_failed", { assetId: reserve.asset.id, key: objectKey, reason: done.reason });
    throw new ApiError("DEPENDENCY_FAILED", 502, "The file was stored but could not be published. Ask an administrator to run reconciliation.");
  }

  return {
    outcome: "stored",
    assetId: reserve.asset.id,
    objectKey,
    url: done.url ?? assetPathFor(objectKey),
    version: reserve.asset.version,
    bytes: bytes.byteLength,
    contentType: probe.mime,
    width: probe.width,
    height: probe.height,
    sha256: digest,
  };
}

/**
 * The read side, including the range request an HTML5 video and a large image
 * both rely on. R2 answers `get({range})` itself; what is done here is the
 * visibility decision, the header set, and the 304/206 shapes.
 */
export interface ReadInput {
  objectKey: string;
  ifNoneMatch: string | null;
  range: string | null;
  principalId: string | null;
  staff: boolean;
}

export async function readAsset(
  input: ReadInput,
  deps: { bucket: MediaBucket; resolve: (objectKey: string) => Promise<AssetMeta | null>; authorize?: (objectKey: string) => Promise<boolean> },
): Promise<Response> {
  const meta = await deps.resolve(input.objectKey);
  if (!meta) throw new ApiError("NOT_FOUND", 404, "No asset is registered under this path.");
  if (meta.visibility === "private") {
    // Two checks, because they answer different questions. "Is the subject of
    // this asset the caller?" is cheap and covers the avatar case; "may this
    // session see this row?" is decided in Postgres against auth.uid(), so a
    // Worker bug about who the caller is cannot serve a stranger's file. A
    // request with no session never reaches the second one and is refused.
    if (!(input.principalId && (input.staff || meta.entityId === input.principalId))) {
      throw new ApiError("FORBIDDEN", 403, "This asset is private.");
    }
    if (!(await deps.authorize?.(input.objectKey))) {
      throw new ApiError("FORBIDDEN", 403, "This asset is private.");
    }
  }

  const headers = new Headers({
    "content-type": meta.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
    // One rule, one owner: `cacheControlFor` is the same function the policy document quotes, so
    // what a test asserts, what the docs state and what a CDN receives cannot disagree.
    "cache-control": cacheControlFor({ visibility: meta.visibility, objectKey: meta.objectKey }),
    "x-asset-visibility": meta.visibility,
  });
  if (meta.etag) headers.set("etag", meta.etag.startsWith("W/") || meta.etag.startsWith('"') ? meta.etag : `"${meta.etag}"`);

  // Ranged and conditional responses are built on the *registry's* etag rather than the object's, because
  // the registry's is the value the previous response advertised; a second opinion from the bucket would
  // make an `If-None-Match` from a client that has never seen this object answer 304 for a stranger.
  if (meta.byteSize) headers.set("content-length", String(meta.byteSize));
  if (headers.get("cache-control")?.includes("immutable")) headers.set("last-modified", new Date(0).toUTCString());

  if (input.ifNoneMatch && meta.etag && (input.ifNoneMatch === "*" || normalizeEtag(input.ifNoneMatch) === normalizeEtag(meta.etag))) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(input.range, meta.byteSize);
  let object: Awaited<ReturnType<MediaBucket["get"]>>;
  try {
    object = await deps.bucket.get(input.objectKey, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  } catch (cause) {
    throw new ApiError("DEPENDENCY_FAILED", 502, "Storage could not be reached.", { detail: cause instanceof Error ? cause.name : String(cause) });
  }
  if (!object) throw new ApiError("NOT_FOUND", 404, "The registry lists this object but storage does not have it. Reconciliation will be asked to look.");

  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.byteSize ?? "*"}`);
    headers.set("content-length", String(range.length));
  }
  const body = object.body instanceof ArrayBuffer ? object.body : (object.body as ReadableStream<Uint8Array> | null);
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** `bytes=START-END` and `bytes=START-` only; anything else is ignored rather
 *  than answered with 416, because the alternative is a broken player for a
 *  client that sent one unexpected header. */
function normalizeEtag(value: string): string {
  return value.replace(/^W\//, "").replace(/\"/g, "").trim();
}

export function parseRange(header: string | null, total: number | null): { offset: number; length: number } | null {
  if (!header || !total) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Math.min(Number(rawEnd), total);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { offset: total - suffix, length: suffix };
  }
  const offset = Number(rawStart);
  if (!Number.isFinite(offset) || offset >= total) return null;
  const end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  return { offset, length: end - offset + 1 };
}

/** Read every key under a prefix, bounded: an unbounded listing in a request
 *  handler is how a 2-million-object bucket becomes a timeout. */
export async function listKeys(bucket: MediaBucket, prefix: string | null, limit: number): Promise<{ keys: string[]; complete: boolean; truncatedAt: number }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let complete = true;
  for (let page = 0; page < 50; page += 1) {
    const listed = await bucket.list({ prefix: prefix ?? undefined, limit: Math.min(1000, limit - keys.length), cursor });
    for (const object of listed.objects) {
      keys.push(object.key);
      if (keys.length >= limit) return { keys, complete: false, truncatedAt: keys.length };
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
    complete = false; // more pages exist; the caller reports partial results
  }
  return { keys, complete, truncatedAt: keys.length };
}

/**
 * The registry read for `GET /media/assets/*`. Resolution is a service-role call
 * because it must answer for anonymous readers too, and it is safe only because of
 * what the function returns: `kicklive_asset_for_key` yields serving metadata and
 * nothing else — no row list, no other object's data, and no status but
 * ready/superseded. The private decision is NOT made here; it is made by
 * `kicklive_asset_authorized`, running as the caller, in `readAsset`.
 */
export function publicRepositoryFor(env: Env): Pick<MediaRepository, "resolve"> {
  const db = supabaseAdmin(env);
  return {
    resolve: async (objectKey) => {
      const data = (await db.call<Record<string, unknown> | null>("kicklive_asset_for_key", { p_object_key: objectKey })) ?? null;
      if (!data || data["status"] !== "ok") return null;
      return {
        id: Number(data["id"]),
        objectKey,
        visibility: data["visibility"] === "private" ? "private" : "public",
        contentType: (data["content_type"] as string | undefined) ?? null,
        byteSize: data["byte_size"] == null ? null : Number(data["byte_size"]),
        etag: (data["etag"] as string | undefined) ?? null,
        entityKind: String(data["entity_kind"]),
        entityId: String(data["entity_id"]),
      };
    },
  };
}

/**
 * The hourly retention step, shared by the cron entry point and by
 * `POST /media/sweep`, so "what the schedule does" is a function a test can call
 * rather than a code path that only exists at runtime.
 *
 * Order matters: the database decides what is old enough to forget and hands back
 * the keys, then the bucket is asked to drop them. Deleting first would mean an
 * object is gone while the row still says it exists — the one inconsistency a
 * media system must never have, because it produces a broken image and no
 * explanation.
 */
export async function sweepMedia(
  env: Env,
  deps: { bucket?: MediaBucket; limit?: number } = {},
): Promise<{ expiredReservations: number; purged: number; objectsDeleted: number; bucketBound: boolean }> {
  const swept = await sweepRepositoryFor(env).sweep(deps.limit ?? 500);
  const keys = (swept.keys_to_delete ?? []).map((row) => row.object_key).filter((key) => typeof key === "string" && key.length > 0);
  const bucket = deps.bucket ?? (env.MEDIA_BUCKET as MediaBucket | undefined);
  let objectsDeleted = 0;
  if (bucket) {
    for (const key of keys) {
      await bucket.delete(key);
      objectsDeleted += 1;
    }
  }
  return {
    expiredReservations: Number(swept.expired_reservations ?? 0),
    purged: keys.length,
    objectsDeleted,
    bucketBound: Boolean(bucket),
  };
}

/** The schedule this Worker expects for retention, as declared in `wrangler.toml`. Exported so the config
 *  test can assert the two sides name the same string instead of trusting a comment. */
export const MEDIA_SWEEP_CRON = "17 * * * *";

/**
 * The repository a *request* uses: built from the caller's own access token, so
 * `auth.uid()` inside the `kicklive_*` functions is the real actor. That is not
 * a convenience — every authorization decision in this phase is made against
 * `auth.uid()`, and presenting the service role here would make every one of
 * them "admin", which is the exact failure mode Phase 1 was written to prevent.
 */
/**
 * A caller-supplied `reserve`. Phase 8's sponsor upload and Phase 7's creative upload both need a reservation
 * that is authorized by *their* rules — "may this admin write a logo onto this sponsor" is not the same
 * question as "may this manager store a crest on this team", and each table answers it in its own function.
 * Everything else in the pipeline is shared: the same finalize, the same resolve, the same retention, the
 * same history. That is why the override is one function and not a second repository — a forked repository
 * is a forked media contract, and the two copies would drift on exactly the steps that matter (the order of
 * supersede-then-publish, and the fact that a failed write must close the reservation).
 *
 * The `call` it is handed is the *same* one the repository uses, on the same authenticated PostgREST client,
 * so an override cannot escalate: it runs with the caller's token, not a service-role one.
 */
export type ReserveOverride = (input: ReserveInput, call: <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<T>) => Promise<ReserveOutcome>;

export function repositoryFor(env: Env, token: string | null, reserve?: ReserveOverride): MediaRepository {
  if (!token) throw new ApiError("UNAUTHENTICATED", 401, "A signed-in user is required to store or remove media.");
  return repositoryFrom(supabaseAsUser(env, token), reserve);
}

/**
 * The repository the *cron* uses. Justification, in the words
 * `supabaseAdmin`'s own comment demands: `kicklive_sweep_media` is the one media
 * function that must run without a user present, and it refuses every table
 * mutation except retention bookkeeping on `media_assets`. It is reached only
 * from a scheduled trigger, never from a route, and the function itself still
 * requires that any identified caller be an admin.
 */
export function sweepRepositoryFor(env: Env): Pick<MediaRepository, "sweep"> {
  const db = supabaseAdmin(env);
  return {
    sweep: async (limit) => (await db.call("kicklive_sweep_media", { p_limit: limit ?? 500 })) as { status: string; expired_reservations?: number; keys_to_delete?: readonly { object_key: string }[] },
  };
}

function repositoryFrom(db: SupabaseRest, reserve?: ReserveOverride): MediaRepository {
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    // `call` throws an ApiError carrying the upstream text in `detail`, so a
    // Postgres RAISE becomes a structured 502 rather than a stack trace.
    return (await db.call<T>(fn, args)) as T;
  };
  return {
    reserve: (input) =>
      reserve
        ? reserve(input, call)
        : call<ReserveOutcome>("kicklive_reserve_asset_upload", {
            p_entity_kind: input.kind,
            p_entity_id: input.entityId,
            p_variant: input.variant,
            p_content_type: input.contentType,
            p_byte_size: input.byteSize,
            p_sha256: input.sha256,
            p_width: input.width,
            p_height: input.height,
            p_alt_text: input.alt,
          }),
    finalize: (assetId, outcome, extra) =>
      call<FinalizeOutcome>("kicklive_finalize_asset_upload", {
        p_asset_id: assetId,
        p_outcome: outcome,
        p_etag: extra?.etag ?? null,
        p_actual_size: extra?.actualSize ?? null,
        p_reason: extra?.reason ?? null,
      }),
    resolve: async (objectKey) => {
      const row = await call<{ status: string } | null>("kicklive_asset_for_key", { p_object_key: objectKey });
      if (!row || row.status !== "ok") return null;
      const data = row as unknown as Record<string, unknown>;
      return {
        id: Number(data.id),
        objectKey,
        visibility: data.visibility === "private" ? "private" : "public",
        contentType: (data.content_type as string) ?? null,
        byteSize: data.byte_size == null ? null : Number(data.byte_size),
        etag: (data.etag as string) ?? null,
        entityKind: String(data.entity_kind),
        entityId: String(data.entity_id),
      };
    },
    isAuthorizedFor: async (objectKey) => {
      const allowed = await call<boolean | null>("kicklive_asset_authorized", { p_object_key: objectKey });
      return allowed === true;
    },
    history: (kind, entityId) => call<readonly unknown[]>("kicklive_entity_assets", { p_entity_kind: kind, p_entity_id: entityId }),
    remove: (assetId, purge) => call("kicklive_delete_asset", { p_asset_id: assetId, p_purge: purge }),
    restore: (assetId) => call("kicklive_restore_asset", { p_asset_id: assetId }),
    sweep: (limit) => call("kicklive_sweep_media", { p_limit: limit ?? 500 }),
    reconcile: (liveKeys, prefix) => call("kicklive_reconcile_assets", { p_live_keys: liveKeys, p_prefix: prefix }),
    diagnostics: () => call("kicklive_asset_diagnostics", {}),
    recordMigrated: (input) => call("kicklive_record_migrated_asset", input),
    seen: async (sourceUrl) => {
      const key = await call<string | null>("kicklive_migration_seen", { p_source_url: sourceUrl });
      return typeof key === "string" && key.length > 0 ? key : null;
    },
  };
}
