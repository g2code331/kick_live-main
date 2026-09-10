/**
 * Phase 6 · the media endpoints — R2 behind the Worker, with the registry in
 * Supabase.
 *
 * Three rules shape every handler here, and they are the reason the endpoints
 * are not just `supabase.storage.from(bucket).upload()` moved to a server:
 *
 *   1. **A client never names a key.** It names a *kind* and an *entity*, and
 *      `kicklive_reserve_asset_upload` returns the key, the version, the bucket
 *      and the visibility. Path traversal is not filtered out; it is not
 *      constructible — `../` cannot be a kind, and an entity id is matched
 *      against `[0-9a-fA-F-]{1,64}` before it is ever concatenated (Step 16).
 *   2. **A declared content type is an opinion.** The accepted type is what the
 *      first bytes of the body say, the file is refused before it is stored, and
 *      the sniffed type is what gets served back (see `lib/imageProbe.ts`).
 *   3. **Publication is one database call.** The object is written, confirmed
 *      with a head, and only then does `kicklive_finalize_asset_upload` move the
 *      entity's URL column. A failed upload therefore has nothing to undo.
 *
 * Reads are a Worker read-through rather than a public bucket link (Step 9), so
 * visibility is enforced per request and the cache policy is ours. The cost is a
 * subrequest per asset and the gain is that "private" means something; both sides
 * of that trade are in docs/R2_MEDIA_ARCHITECTURE.md.
 *
 * Nothing in this file holds a credential. The bucket is a *binding*
 * (`env.MEDIA_BUCKET`), which is what makes a public bucket safe — a leaked
 * binding cannot list other buckets, sign URLs for them, or outlive the deploy.
 */
import type { Env } from "../env.ts";
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readQuery } from "../lib/validation.ts";
import {
  MEDIA_CATEGORIES,
  MEDIA_KINDS,
  MIGRATION_MAX_BYTES_PER_RUN,
  MIGRATION_MAX_OBJECTS_PER_RUN,
  isSafeObjectKey,
  UPLOADABLE_KINDS,
  mediaPolicyDocument,
  type MediaKind,
} from "../lib/mediaPolicy.ts";
import { probeImage, sha256Hex } from "../lib/imageProbe.ts";
import { listKeys, publicRepositoryFor, publishAsset, readAsset, repositoryFor, sweepMedia, type MediaBucket, type MediaRepository } from "../services/mediaStore.ts";
import { supabaseAdmin } from "../services/supabase.ts";
import type { HandlerContext } from "./index.ts";

const UPLOAD_KEYS = ["kind", "entityId", "variant", "alt"] as const;
const MIGRATION_KEYS = ["entityKind", "after", "dryRun"] as const;
const ENTITY_QUERY_KEYS = ["kind", "entityId"] as const;

/** The copy a refusal deserves. Every arm names what the user can actually
 *  change, because "upload failed" is not actionable. */
function refusalMessage(reason: string, detail?: Record<string, unknown>): string {
  switch (reason) {
    case "TOO_LARGE":
      return `That file is larger than the ${String(detail?.kind ?? "media")} limit of ${String(Math.round(Number(detail?.maxBytes ?? 0) / 1024 / 1024))} MB.`;
    case "QUOTA_EXCEEDED":
      return "You have used today's storage allowance. Try again tomorrow, or remove an older upload.";
    case "UNSUPPORTED_TYPE":
      return "Only PNG, JPEG, WebP and GIF images can be stored.";
    case "MARKUP_REJECTED":
      return "That file starts with markup rather than image data. SVG and HTML cannot be stored.";
    case "TOO_MANY_PIXELS":
      return "That image is larger than 8192 pixels on a side or 40 megapixels in total.";
    case "DIMENSIONS_UNAVAILABLE":
      return "The image dimensions could not be read, which usually means the file is truncated. Try saving it again.";
    case "EMPTY_FILE":
      return "The file was empty.";
    case "TOO_SMALL":
      return "That file is too small to be an image.";
    case "NOT_YOUR_CLUB":
      return "You can only change media for a club you manage.";
    case "NOT_YOUR_ARTICLE":
      return "You can only change media for an article you wrote.";
    case "NOT_SELF":
      return "You can only change your own avatar.";
    case "NOT_OWNER":
      return "That asset belongs to somebody else.";
    case "ADMIN_REQUIRED":
      return "That media category is managed by an administrator.";
    case "NO_PROFILE":
      return "Your account has no profile yet, so media cannot be attributed to you.";
    case "ENTITY_NOT_FOUND":
      return "That team, player or article does not exist yet. Save it before adding media.";
    case "RESERVATION_REFUSED":
      return "The media registry refused this upload.";
    case "PURGE_ADMIN_ONLY":
      return "Only an administrator can permanently delete a stored object.";
    default:
      return "The media upload could not be accepted.";
  }
}

function bucketFor(ctx: HandlerContext): MediaBucket {
  const bucket = ctx.env.MEDIA_BUCKET as MediaBucket | undefined;
  if (!bucket) {
    // A configuration error, reported as one. Answering 200 with an object that
    // was never stored, or falling back to Supabase Storage "so it works", is how
    // a media system ends up with two sources of truth.
    throw new ApiError("DEPENDENCY_FAILED", 503, "This deployment has no media bucket bound (MEDIA_BUCKET).", {
      detail: "wrangler deploy needs the [[r2_buckets]] binding from workers/wrangler.toml",
    });
  }
  return bucket;
}

/** The one place a captured wildcard path becomes a key or a refusal. */
function capturedObjectKey(ctx: HandlerContext): string {
  const raw = ctx.params["*"] ?? "";
  // Rejected as a bad request rather than answered with 404: `..`, an empty
  // segment or a colon is not "an object that does not exist", it is a malformed
  // path, and the difference is what a log reader needs to see.
  if (!raw || !isSafeObjectKey(raw)) {
    throw new ApiError("BAD_REQUEST", 400, "That is not a valid asset path.");
  }
  return raw;
}

/**
 * `POST /api/media/uploads` — multipart, one file, and the only route in the
 * Worker that reads a request body bigger than 64 KiB.
 *
 * A form field cannot carry a key, a bucket, a content type or a version. `kind`
 * and `entityId` are the whole vocabulary, and even those are only requests: the
 * registry decides whether the caller may write to that entity.
 */
export async function handleMediaUpload(ctx: HandlerContext): Promise<Response> {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new ApiError("BAD_REQUEST", 400, "Expected a multipart/form-data upload with a `file` field.");
  }
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch (cause) {
    throw new ApiError("BAD_REQUEST", 400, "The upload body could not be parsed as multipart form data.", {
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const scalars: Record<string, unknown> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") {
      // A part holding a filename is the file. Any other part must be text, and a
      // file named something other than `file` is refused rather than ignored:
      // silently dropping a second attachment is how an upload stores the wrong
      // half of a form.
      if (key !== "file") {
        throw new ApiError("VALIDATION_FAILED", 400, "Only a `file` part may carry binary content.", { fields: [{ field: key, message: "expected a text field" }] });
      }
      file = value as File;
      continue;
    }
    scalars[key] = value;
  }
  const fields = new Fields(scalars, UPLOAD_KEYS);
  fields.assertOnlyDeclared();
  const kind = fields.enumValue("kind", UPLOADABLE_KINDS as unknown as readonly string[], { required: true, label: `one of ${UPLOADABLE_KINDS.join(", ")}` }) as MediaKind | undefined;
  // The id is the only other thing a client may point at, and it may not look
  // like a path: `entityId` becomes one segment of the object key.
  const entityId = fields.string("entityId", {
    required: true,
    max: 64,
    pattern: /^[0-9a-fA-F-]{1,64}$/,
    patternMessage: "must be a numeric id or a uuid",
  });
  const variant = fields.string("variant", { max: 32 });
  const alt = fields.prose("alt", { max: 300 });
  fields.throwIfInvalid();
  if (!kind || !entityId) throw new ApiError("VALIDATION_FAILED", 400, "A media upload must name a kind and an entity.");
  if (variant !== undefined && variant !== "" && variant !== "original") {
    throw new ApiError("VALIDATION_FAILED", 400, "Only the original variant can be uploaded.", {
      fields: [{ field: "variant", message: "derived variants are written by a producer, not by a browser" }],
    });
  }
  if (!file) throw new ApiError("VALIDATION_FAILED", 400, "No `file` part was found in the upload.", { fields: [{ field: "file", message: "is required" }] });

  const category = MEDIA_CATEGORIES[kind];
  const declared = Number(file.size ?? 0);
  // The declared size is checked before the body is read into memory at all:
  // `content-length` lies, but a lie upward costs a rejected request rather than
  // 40 MB of buffering, and the real bound is re-applied to the bytes below.
  if (declared > category.maxBytes) {
    return refuse({ status: 413, code: "PAYLOAD_TOO_LARGE", reason: "TOO_LARGE", detail: { maxBytes: category.maxBytes, bytes: declared, kind } });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await publishAsset(
    { kind, entityId, variant: variant || "original", alt: alt ?? null, bytes },
    {
      bucket: bucketFor(ctx),
      repo: repositoryFor(ctx.env, ctx.principal.token),
    },
  );
  if (result.outcome === "refused") return refuse(result);
  return ok(
    {
      assetId: result.assetId,
      url: result.url,
      objectKey: result.objectKey,
      version: result.version,
      bytes: result.bytes,
      contentType: result.contentType,
      width: result.width,
      height: result.height,
      sha256: result.sha256,
      reused: result.outcome === "existing",
      visibility: category.visibility,
      kind,
      entityId,
    },
    { status: 201, requestId: ctx.requestId },
  );
}

function refuse(result: { status: number; code: "VALIDATION_FAILED" | "FORBIDDEN" | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED"; reason: string; detail?: Record<string, unknown> }): never {
  throw new ApiError(result.code, result.status, refusalMessage(result.reason, result.detail), {
    // The reason is the machine-readable half (`UNSUPPORTED_TYPE`), the message is
    // the human half, and the numbers behind a size refusal ride along in `detail`
    // so a form can render "12 MB of a 10 MB allowance" without another request.
    fields: [{ field: "file", message: result.reason }],
    detail: result.detail ? JSON.stringify(result.detail) : undefined,
  });
}

/**
 * `GET /api/media/assets/*` — the read-through.
 *
 * Public assets are answered to anybody, so a `<img>` tag works with no session
 * and no CORS preflight; private ones need the caller to be its owner or staff,
 * decided against `auth.uid()` in Postgres. Both shapes get the cache policy from
 * the *key*: a versioned key is immutable forever, so a replacement (a new key)
 * never has to invalidate what an already-rendered page is holding.
 */
export async function handleMediaAssetRead(ctx: HandlerContext): Promise<Response> {
  const objectKey = capturedObjectKey(ctx);
  const env = ctx.env;
  const token = ctx.principal.token;
  return readAsset(
    {
      objectKey,
      ifNoneMatch: ctx.request.headers.get("if-none-match"),
      range: ctx.request.headers.get("range"),
      principalId: ctx.principal.userId ?? null,
      staff: ctx.principal.role === "admin" || ctx.principal.role === "media",
    },
    {
      bucket: bucketFor(ctx),
      resolve: (key) => publicRepositoryFor(env).resolve(key),
      authorize: token ? (key) => repositoryFor(env, token).isAuthorizedFor(key) : undefined,
    },
  );
}

/** `GET /api/media/entities/:kind/:id` — the version history a management screen
 *  needs to offer "restore the previous logo". Ownership is the same predicate
 *  that authorized the upload, so a list can never enumerate another club's
 *  drafts: an outsider gets `[]`, not a 403 they can probe with. */
export async function handleMediaEntityAssets(ctx: HandlerContext): Promise<Response> {
  const params = new Fields({ kind: ctx.params["kind"], entityId: ctx.params["entityId"] }, ENTITY_QUERY_KEYS);
  const kind = params.enumValue("kind", MEDIA_KINDS as unknown as readonly string[], { required: true, label: `one of ${MEDIA_KINDS.join(", ")}` }) as MediaKind | undefined;
  const entityId = params.string("entityId", { required: true, max: 64, pattern: /^[0-9a-fA-F-]{1,64}$/, patternMessage: "must be a numeric id or a uuid" });
  params.throwIfInvalid();
  if (!kind || !entityId) throw new ApiError("VALIDATION_FAILED", 400, "An asset list must name a kind and an entity.");
  const rows = await repositoryFor(ctx.env, ctx.principal.token).history(kind, entityId);
  return ok({ kind, entityId, assets: rows }, { requestId: ctx.requestId });
}

/** `DELETE /api/media/assets/:id` — soft by default, purge only for an admin,
 *  and the object is deleted only after the registry has said so. */
export async function handleMediaAssetDelete(ctx: HandlerContext): Promise<Response> {
  const purge = new URL(ctx.request.url).searchParams.get("purge") === "true";
  const id = new Fields({ id: ctx.params["id"] }, []).integer("id", { required: true, min: 1 });
  if (!id) throw new ApiError("VALIDATION_FAILED", 400, "An asset id is required.", { fields: [{ field: "id", message: "must be a positive integer" }] });
  const repo = repositoryFor(ctx.env, ctx.principal.token);
  const result = await repo.remove(id, purge);
  if (result.status !== "ok") {
    const status = result.reason === "NOT_OWNER" || result.reason === "PURGE_ADMIN_ONLY" ? 403 : result.reason === "ASSET_NOT_FOUND" ? 404 : 400;
    throw new ApiError(status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "VALIDATION_FAILED", status, refusalMessage(result.reason ?? "REFUSED"), {
      fields: [{ field: "id", message: result.reason ?? "REFUSED" }],
    });
  }
  let objectDeleted = false;
  if (result.delete_object && result.object_key) {
    // Best-effort *after* the registry decision, in that order: an object that
    // outlives its row is an orphan reconciliation can find and report, while a
    // row that says "purged" for bytes nobody can reach would be a lie about data
    // that is still there.
    await bucketFor(ctx).delete(result.object_key);
    objectDeleted = true;
  }
  return ok({ id, action: result.action ?? "soft_deleted", objectDeleted }, { requestId: ctx.requestId });
}

/** `POST /api/media/assets/:id/restore` — undo a soft delete or take back a
 *  superseded version. The reason this exists is Step 15's "avoid accidental
 *  irreversible deletion": a delete that cannot be undone is not a safety
 *  feature, it is a support queue. */
export async function handleMediaAssetRestore(ctx: HandlerContext): Promise<Response> {
  const id = new Fields({ id: ctx.params["id"] }, []).integer("id", { required: true, min: 1 });
  if (!id) throw new ApiError("VALIDATION_FAILED", 400, "An asset id is required.", { fields: [{ field: "id", message: "must be a positive integer" }] });
  const result = await repositoryFor(ctx.env, ctx.principal.token).restore(id);
  if (result.status !== "ok") {
    throw new ApiError(
      result.reason === "NOT_RESTORABLE" ? "CONFLICT" : "VALIDATION_FAILED",
      result.reason === "NOT_RESTORABLE" ? 409 : 400,
      result.reason === "NOT_RESTORABLE" ? "That version is not in a state that can be restored." : "The asset could not be restored.",
      {
        fields: [{ field: "id", message: result.reason ?? "REFUSED" }],
      },
    );
  }
  return ok({ id, restored: true, url: null }, { requestId: ctx.requestId });
}

/** `GET /api/media/config` — the policy, so an upload form can state the limit it
 *  will enforce and a reviewer can read the rules without reading SQL. Public
 *  because nothing in it is secret and everything in it prevents a surprise. */
export async function handleMediaConfig(ctx: HandlerContext): Promise<Response> {
  return ok(mediaPolicyDocument(ctx.env), { requestId: ctx.requestId });
}

/** `GET /api/media/diagnostics` — counts, never content. */
export async function handleMediaDiagnostics(ctx: HandlerContext): Promise<Response> {
  const repo = repositoryFor(ctx.env, ctx.principal.token);
  const diagnostics = (await repo.diagnostics()) as Record<string, unknown>;
  let listing: { keys: string[]; complete: boolean } | null = null;
  let reconciliation: unknown = null;
  const bucket = ctx.env.MEDIA_BUCKET as MediaBucket | undefined;
  if (bucket) {
    // Bounded and reported as bounded. A `complete: false` here is the difference
    // between "we checked" and "we checked a page and a half".
    const listed = await listKeys(bucket, null, 2000);
    listing = { keys: listed.keys, complete: listed.complete };
    reconciliation = await repo.reconcile(listing.keys, null);
  }
  return ok(
    {
      ...diagnostics,
      bucketBound: Boolean(bucket),
      listed: listing ? { objects: listing.keys.length, complete: listing.complete } : null,
      reconciliation,
    },
    { requestId: ctx.requestId, headers: { "cache-control": "no-store" } },
  );
}

/** `POST /api/media/sweep` — the retention step on demand. The same function runs
 *  from the hourly cron; an operator gets a button so a deployment can prove the
 *  sweep works without waiting for the hour. */
export async function handleMediaSweep(ctx: HandlerContext): Promise<Response> {
  const limit = readQuery(ctx.url, ["limit"]).integer("limit", { min: 1, max: 500, default: 500 }) ?? 500;
  const swept = await sweepMedia(ctx.env, { limit });
  return ok(swept, { requestId: ctx.requestId });
}

// ── the migration ───────────────────────────────────────────────────────────

/** The eight legacy columns, and the two buckets that produced them. */
const MIGRATION_TARGETS: readonly { kind: MediaKind; table: string; column: string }[] = [
  { kind: "news", table: "media", column: "image_url" },
  { kind: "team_news", table: "team_news", column: "image_url" },
  { kind: "teams", table: "teams", column: "logo_url" },
  { kind: "players", table: "players", column: "photo_url" },
  { kind: "competitions", table: "competitions", column: "logo_url" },
  { kind: "users", table: "profiles", column: "avatar_url" },
];

const LEGACY_BUCKETS = new Set(["media", "avatars"]);

/**
 * Parse a legacy Supabase Storage URL into the object path inside that bucket.
 *
 * The host check is not belt-and-braces padding: this route fetches a URL, so
 * without it an administrator who pasted a row value into `entityKind`-adjacent
 * data could point the Worker at an internal endpoint. Only
 * `https://<SUPABASE_PROJECT_REF>.supabase.co` is fetched, and nothing else in a
 * row can make the Worker ask a different host.
 */
export function parseLegacyStorageUrl(raw: string, projectRef: string): { bucket: string; path: string } | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== `${projectRef}.supabase.co`) return null;
  const match = /^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return null;
  const bucket = match[1] ?? "";
  const path = match[2] ?? "";
  if (!LEGACY_BUCKETS.has(bucket) || !path || path.includes("..")) return null;
  return { bucket, path };
}

/**
 * `POST /api/media/migration` — copy one table's already-published objects into
 * R2, one bounded page at a time, and only record what actually landed.
 *
 * Dry run by default, because the first question an operator asks is "how many and
 * how big", and that question should not require doing the thing. External links
 * (unsplash placeholders, YouTube) are not storage URLs and are skipped forever by
 * the host check above — they were never ours to copy.
 */
export async function handleMediaMigration(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, MIGRATION_KEYS);
  const kind = fields.enumValue("entityKind", MIGRATION_TARGETS.map((t) => t.kind) as string[], { required: true, label: `one of ${MIGRATION_TARGETS.map((t) => t.kind).join(", ")}` }) as
    MediaKind | undefined;
  const after = fields.integer("after", { min: 0, default: 0 }) ?? 0;
  const dryRun = (fields.string("dryRun", { max: 8 }) ?? "true") !== "false";
  fields.throwIfInvalid();
  if (!kind) throw new ApiError("VALIDATION_FAILED", 400, "A migration run must name one entity kind.", { fields: [{ field: "entityKind", message: "required" }] });
  const target = MIGRATION_TARGETS.find((t) => t.kind === kind);
  if (!target) throw new ApiError("VALIDATION_FAILED", 400, `"${kind}" has no media column to migrate.`);

  const projectRef = (ctx.env.SUPABASE_PROJECT_REF ?? "").trim();
  if (!projectRef) throw new ApiError("INTERNAL_ERROR", 500, "SUPABASE_PROJECT_REF is not set, so legacy storage URLs cannot be recognised.");
  const bucket = bucketFor(ctx);
  const db = supabaseAdmin(ctx.env);
  const repo = repositoryFor(ctx.env, ctx.principal.token);

  const rows = await db.from(target.table).select(`id, ${target.column}`).gt("id", after).order("id").limit(MIGRATION_MAX_OBJECTS_PER_RUN).rows<Record<string, unknown>>();

  const candidates = rows
    .map((row) => ({
      id: String(row["id"] ?? ""),
      url: typeof row[target.column] === "string" ? String(row[target.column]) : "",
      source: parseLegacyStorageUrl(typeof row[target.column] === "string" ? String(row[target.column]) : "", projectRef),
    }))
    .filter((row) => row.source !== null);

  const report = {
    scanned: rows.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    bytesCopied: 0,
    nextCursor: rows.length > 0 ? Number(rows[rows.length - 1]?.["id"] ?? after) : after,
    hasMore: rows.length === MIGRATION_MAX_OBJECTS_PER_RUN,
    details: [] as Record<string, unknown>[],
  };

  if (dryRun) {
    return ok(
      {
        dryRun: true,
        kind: target.kind,
        candidates: candidates.length,
        sample: candidates.slice(0, 20).map((c) => ({ id: c.id, from: c.url, to: c.source ? `${target.kind}/${c.id}/original/…` : null })),
        ...report,
      },
      { requestId: ctx.requestId },
    );
  }

  let index = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (index < candidates.length) {
      if (report.bytesCopied >= MIGRATION_MAX_BYTES_PER_RUN) return;
      const candidate = candidates[index] as (typeof candidates)[number];
      index += 1;
      const outcome = await migrateOneObject({ kind: target.kind, entityId: candidate.id, url: candidate.url, source: candidate.source!, bucket, repo, projectRef });
      report[outcome.state as "migrated" | "skipped" | "failed"] += 1;
      report.bytesCopied += outcome.bytes;
      if (report.details.length < 50) report.details.push({ id: candidate.id, state: outcome.state, reason: outcome.reason ?? null, key: outcome.objectKey ?? null });
    }
  });
  await Promise.all(workers);

  return ok({ dryRun: false, kind: target.kind, budget: MIGRATION_MAX_BYTES_PER_RUN, ...report }, { requestId: ctx.requestId });
}

/** Exported for the integration test: one object, end to end, against an injected bucket
 * and repository. It is the whole migration in miniature — check the registry first, fetch only
 * from the one allowed host, refuse what is not an image, write, record, and never let a failure
 * touch the entity's working URL. */
export async function migrateOneObject(input: {
  kind: MediaKind;
  entityId: string;
  url: string;
  source: { bucket: string; path: string };
  bucket: MediaBucket;
  repo: MediaRepository;
  projectRef: string;
}): Promise<{ state: "migrated" | "skipped" | "failed"; bytes: number; reason?: string; objectKey?: string }> {
  // Already recorded for this source URL: the registry answers before any bytes
  // move, which is what makes a re-run cheap instead of merely safe.
  // Already recorded for this source URL: the registry answers before any bytes move,
  // which is what makes a re-run cheap instead of merely safe. A migration that
  // re-copies the same 400 logos on every attempt is one nobody runs twice, and the
  // second run is where a half-finished one gets finished.
  const prior = await input.repo.seen(input.url);
  if (prior) return { state: "skipped", bytes: 0, reason: "ALREADY_RECORDED", objectKey: prior };

  let response: Response;
  try {
    response = await fetch(`https://${input.projectRef}.supabase.co/storage/v1/object/public/${input.source.bucket}/${input.source.path}`);
  } catch {
    return { state: "failed", bytes: 0, reason: "SOURCE_UNREACHABLE" };
  }
  if (response.status === 401 || response.status === 403) return { state: "skipped", bytes: 0, reason: "SOURCE_NOT_PUBLIC" };
  if (!response.ok) return { state: "failed", bytes: 0, reason: `SOURCE_${String(response.status)}` };
  const declared = Number(response.headers.get("content-length") ?? 0);
  const cap = MEDIA_CATEGORIES[input.kind].maxBytes;
  if (declared > cap) return { state: "skipped", bytes: 0, reason: "TOO_LARGE" };

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) return { state: "failed", bytes: 0, reason: "SOURCE_EMPTY" };
  if (bytes.byteLength > cap) return { state: "skipped", bytes: 0, reason: "TOO_LARGE" };
  const probe = probeImage(bytes);
  if (!probe.mime) return { state: "skipped", bytes: 0, reason: "NOT_AN_ACCEPTED_IMAGE" };
  const digest = await sha256Hex(bytes);
  const objectKey = `${input.kind}/${input.entityId}/original/v1-${digest.slice(0, 8)}.${probe.mime === "image/jpeg" ? "jpg" : probe.mime.split("/")[1]}`;

  try {
    await input.bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: probe.mime, "cache-control": "public, max-age=31536000, immutable" },
      customMetadata: { sha256: digest, migratedFrom: input.url },
      checksums: { webSha256: digest },
    });
  } catch (cause) {
    // Recorded as failed, so the entity keeps working through its existing URL:
    // a migration that breaks a live page is a migration that gets rolled back
    // by somebody in a hurry.
    await input.repo
      .recordMigrated({
        p_entity_kind: input.kind,
        p_entity_id: input.entityId,
        p_object_key: objectKey,
        p_content_type: probe.mime,
        p_byte_size: bytes.byteLength,
        p_sha256: digest,
        p_source_url: input.url,
        p_outcome: "failed",
        p_reason: cause instanceof Error ? cause.name || "BUCKET_PUT_FAILED" : "BUCKET_PUT_FAILED",
      })
      .catch(() => undefined);
    return { state: "failed", bytes: 0, reason: "BUCKET_PUT_FAILED", objectKey };
  }

  const recorded = (await input.repo.recordMigrated({
    p_entity_kind: input.kind,
    p_entity_id: input.entityId,
    p_object_key: objectKey,
    p_content_type: probe.mime,
    p_byte_size: bytes.byteLength,
    p_sha256: digest,
    p_source_url: input.url,
    p_outcome: "migrated",
    p_reason: null,
  })) as Record<string, unknown> | null;
  if (!recorded || (recorded["status"] !== "migrated" && recorded["status"] !== "ok")) {
    return { state: "failed", bytes: bytes.byteLength, reason: "RECORD_REFUSED", objectKey };
  }
  return { state: "migrated", bytes: bytes.byteLength, objectKey };
}
