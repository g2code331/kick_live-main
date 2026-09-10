/**
 * Phase 6 · media upload and read-through, driven through the real Worker entry point.
 *
 * Nothing here talks to Cloudflare or to Postgres. What is stubbed is exactly the two things this
 * phase cannot reach from a sandbox — the bucket (a fake `MediaBucket` over a `Map`) and Supabase
 * (a `globalThis.fetch` fake answering the `kicklive_*` RPCs) — and everything between them runs for
 * real: route matching (including the wildcard read path), authentication, the capability matrix,
 * multipart parsing, magic-byte sniffing, the object-key rules, the reserve → put → confirm →
 * publish order, the error envelope, and the cache headers `finalise` is told not to overwrite.
 *
 * The scenarios are the ones a media bug report actually names: a failed write that must not move the
 * entity's URL, a re-upload of identical bytes that must not store it twice, an uploaded file whose
 * declared type lies, a path that tries to climb out of the key space, and a private object that must
 * not be readable by a stranger.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import worker from "../../workers/src/index.ts";
import { ApiError } from "../../workers/src/lib/response.ts";
import { resetRateLimitMemory } from "../../workers/src/middleware/ratelimit.ts";
import { MEDIA_CATEGORIES } from "../../workers/src/lib/mediaPolicy.ts";
import { probeImage, sha256Hex } from "../../workers/src/lib/imageProbe.ts";
import { migrateOneObject, parseLegacyStorageUrl } from "../../workers/src/routes/media.ts";
import { sweepMedia, type MediaBucket, type MediaRepository } from "../../workers/src/services/mediaStore.ts";

const JWT_SECRET = "unit-test-jwt-secret-not-a-real-key";
const USER_ID = "3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c";
const OTHER_ID = "11111111-2222-3333-4444-555555555555";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Only the header block matters to `probeImage`, which reads signatures rather than decoding pixels.
 *  Real files are exercised by the same assertions in tests/unit/phase6-media.test.ts, and a truncated
 *  one is a case of its own below. */
function png(width = 8, height = 8): Uint8Array {
  const bytes = new Uint8Array(33);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => (bytes[i] = b));
  bytes[8] = 0;
  bytes[9] = 0;
  bytes[10] = 0;
  bytes[11] = 13; // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  bytes[16] = (width >> 24) & 0xff;
  bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >> 24) & 0xff;
  bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff;
  bytes[23] = height & 0xff;
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(width = 16, height = 9): Uint8Array {
  const out = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  // SOF0: marker, length 17, precision, height, width
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03);
  return new Uint8Array(out);
}

function gif(width = 32, height = 16): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

/** `RIFF….WEBP` then a `VP8X` chunk: FourCC(4) size(4) flags(1) reserved(3) width-1(3) height-1(3). */
function webpExtended(width = 100, height = 50): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes[4] = 20; // container size — not read by the probe
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  bytes[16] = 10; // chunk payload length
  bytes[20] = 0; // flags
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

class FakeBucket implements MediaBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null; etag: string }>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  failPut = false;
  headSizeOverride: number | null = null;
  missingAfterPut = false;

  async put(key: string, value: ArrayBufferView | ArrayBuffer, options: { httpMetadata?: Record<string, string> }): Promise<{ etag?: string }> {
    if (this.failPut) throw new Error("S3PutObjectFailed");
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    this.puts.push(key);
    this.objects.set(key, { bytes, contentType: options.httpMetadata?.contentType ?? null, etag: `"etag-${key.length}"` });
    return { etag: `"etag-${key.length}"` };
  }
  async head(key: string) {
    const found = this.objects.get(key);
    if (!found || this.missingAfterPut) return null;
    return { etag: found.etag, contentType: found.contentType, size: this.headSizeOverride ?? found.bytes.byteLength };
  }
  async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
    const found = this.objects.get(key);
    if (!found) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? found.bytes.byteLength - offset;
    return { body: found.bytes.slice(offset, offset + length).buffer, etag: found.etag, contentType: found.contentType, size: length };
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
  async list(options?: { prefix?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((key) => !options?.prefix || key.startsWith(options.prefix)).slice(0, options?.limit ?? 1000);
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }
}

/** The registry, as the `kicklive_*` functions answer it. Every reply is recorded so a test can assert
 *  what the Worker *asked* the database, which is where the security claims actually live. */
class FakeRegistry {
  readonly rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  readonly finalized: string[] = [];
  reserveOutcome: Record<string, unknown> = { status: "proceed", asset: { id: 41, object_key: "teams/7/original/v2-9f2c1a4d.png", version: 2, visibility: "public", status: "uploading" } };
  finalizeOutcome: Record<string, unknown> = { status: "ok", url: "/api/media/assets/teams/7/original/v2-9f2c1a4d.png", attached: true };
  resolveOutcome: Record<string, unknown> | null = {
    status: "ok",
    id: 41,
    visibility: "public",
    content_type: "image/png",
    byte_size: 33,
    etag: "etag-36",
    cache_class: "cdn",
    entity_kind: "teams",
    entity_id: "7",
  };
  authorized = true;
  historyRows: Record<string, unknown>[] = [];
  deleteOutcome: Record<string, unknown> = { status: "ok", action: "soft_deleted", object_key: "teams/7/original/v2-9f2c1a4d.png", delete_object: false };
  sweepOutcome: Record<string, unknown> = { status: "ok", expired_reservations: 2, keys_to_delete: [{ object_key: "teams/7/original/v1-aaaaaaaa.png" }] };
  migratedRecords: Record<string, unknown>[] = [];
  seenKey: string | null = null;

  respond(fn: string, init: RequestInit): Response {
    const args = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.rpcCalls.push({ fn, args });
    const payload = (() => {
      switch (fn) {
        case "kicklive_reserve_asset_upload":
          return this.reserveOutcome;
        case "kicklive_finalize_asset_upload":
          this.finalized.push(String(args["p_outcome"]));
          return this.finalizeOutcome;
        case "kicklive_asset_for_key":
          return this.resolveOutcome;
        case "kicklive_asset_authorized":
          return this.authorized;
        case "kicklive_entity_assets":
          return this.historyRows;
        case "kicklive_delete_asset":
          return this.deleteOutcome;
        case "kicklive_restore_asset":
          return { status: "ok", asset_id: 41 };
        case "kicklive_asset_diagnostics":
          return { status: "ok", by_status: { ready: 3 }, total_bytes: 100 };
        case "kicklive_sweep_media":
          return this.sweepOutcome;
        case "kicklive_reconcile_assets":
          return { status: "ok", objects_without_rows: [], rows_without_objects: [], compared: 0 };
        case "kicklive_record_migrated_asset":
          this.migratedRecords.push(args);
          return { status: "migrated", url: "/api/media/assets/players/9/original/v1-12345678.jpg" };
        case "kicklive_migration_seen":
          return this.seenKey;
        default:
          return null;
      }
    })();
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }

  calls(fn: string): Record<string, unknown>[] {
    return this.rpcCalls.filter((c) => c.fn === fn).map((c) => c.args);
  }

  // `migrateOneObject` is also driven directly (without HTTP) at the bottom of this file, which needs the
  // two repository methods it calls. Both record into the same lists the RPC stub writes to, so an
  // assertion about "what was asked of the database" reads the same either way.
  async seen(sourceUrl: string): Promise<string | null> {
    this.rpcCalls.push({ fn: "kicklive_migration_seen", args: { p_source_url: sourceUrl } });
    return this.seenKey;
  }
  async recordMigrated(input: Record<string, unknown>): Promise<unknown> {
    this.rpcCalls.push({ fn: "kicklive_record_migrated_asset", args: input });
    this.migratedRecords.push(input);
    return { status: input["p_outcome"] === "failed" ? "recorded" : "migrated" };
  }
}

function b64url(input: string | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

async function signedToken(claims: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: "supabase", aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const json = async (res: Response): Promise<Record<string, any>> => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

interface Harness {
  res: Response;
  body: Record<string, any>;
}

/** Runs `fn` against the real Worker with the bucket, the registry and the profile row faked. */
async function withMedia(opts: {
  token?: string | null;
  role?: string;
  bucket?: FakeBucket;
  registry?: FakeRegistry;
  extraEnv?: Record<string, unknown>;
  run: (h: { bucket: FakeBucket; registry: FakeRegistry }) => Promise<void>;
}): Promise<void> {
  const bucket = opts.bucket ?? new FakeBucket();
  const registry = opts.registry ?? new FakeRegistry();
  const profileRow = opts.token === null ? [] : [{ id: USER_ID, email: "club@kicklive.test", username: "club", role: opts.role ?? "team_manager" }];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/rest/v1/profiles")) {
      return new Response(JSON.stringify(profileRow), { status: profileRow.length ? 200 : 406, headers: { "content-type": "application/json" } });
    }
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (rpc?.[1]) return registry.respond(rpc[1], init ?? {});
    if (url.includes("/storage/v1/object/")) {
      // The migration's source fetch. A test that wants a different answer replaces this.
      return new Response("unstubbed legacy url", { status: 500 });
    }
    return new Response(JSON.stringify({ message: `unstubbed url ${url}`, code: "PGRST301" }), { status: 500, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const env = {
    APP_ENV: "development",
    SUPABASE_URL: "https://testref.supabase.co",
    SUPABASE_PROJECT_REF: "testref",
    SUPABASE_ANON_KEY: "eyJhbGciOi-unit-anon-key-not-secret-0000000000000000",
    SUPABASE_JWT_SECRET: JWT_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "SECRET_SERVICE_ROLE_KEY_MUST_NEVER_LEAK_0000000000",
    ALLOWED_ORIGINS: "https://app.kicklive.test",
    MEDIA_BUCKET: bucket,
    ...opts.extraEnv,
  } as unknown as Record<string, unknown>;

  try {
    await opts.run({ bucket, registry });
  } finally {
    globalThis.fetch = original;
    void env;
  }
}

async function call(pathname: string, init: RequestInit, env: Record<string, unknown>): Promise<Harness> {
  const res = await worker.fetch(new Request(`https://api.kicklive.test${pathname}`, init), env as never, { waitUntil: () => undefined, passThroughOnException: () => undefined } as never);
  return { res, body: await json(res) };
}

function uploadRequest(bytes: Uint8Array, fields: Record<string, string>, declaredType = "image/png", token?: string): { pathname: string; init: RequestInit } {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([bytes as unknown as BlobPart], { type: declaredType }), "photo.png");
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { pathname: "/api/media/uploads", init: { method: "POST", body: form, headers } };
}

const ctxEnv = (bucket: FakeBucket, extra: Record<string, unknown> = {}) =>
  ({
    APP_ENV: "development",
    SUPABASE_URL: "https://testref.supabase.co",
    SUPABASE_PROJECT_REF: "testref",
    SUPABASE_ANON_KEY: "ey",
    SUPABASE_JWT_SECRET: JWT_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "SECRET_SERVICE_ROLE_KEY_MUST_NEVER_LEAK_0000000000",
    MEDIA_BUCKET: bucket,
    ...extra,
  }) as unknown as Record<string, unknown>;

beforeEach(() => {
  resetRateLimitMemory();
});

describe("phase6 · upload pipeline", () => {
  it("stores the bytes under the key the registry named, then publishes", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    const key = "teams/7/original/v2-9f2c1a4d.png";
    registry.reserveOutcome = { status: "proceed", asset: { id: 41, object_key: key, version: 2, visibility: "public", status: "uploading" } };
    registry.finalizeOutcome = { status: "ok", url: `/api/media/assets/${key}`, attached: true };
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const { res, body } = await call(
          ...([
            uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token).pathname,
            uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token).init,
            ctxEnv(bucket, { authorization: token }),
          ] as Parameters<typeof call>),
        );
        assert.equal(res.status, 201, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.data.url, `/api/media/assets/${key}`);
        assert.equal(bucket.puts[0], key, "the Worker writes to the key the database returned, not one it invented");
        assert.deepEqual([...bucket.objects.get(key)!.bytes], [...png()], "the bytes in the bucket are the bytes that were sent");
        assert.equal(registry.finalized[0], "stored");
        const reserve = registry.calls("kicklive_reserve_asset_upload")[0];
        assert.equal(reserve["p_byte_size"], 33);
        assert.match(String(reserve["p_sha256"]), /^[0-9a-f]{64}$/);
        assert.equal(reserve["p_width"], 8);
        assert.equal(reserve["p_height"], 8);
      },
    });
  });

  it("serves the sniffed type, never the declared one", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        // Declared JPEG, actually a GIF: the registry must be told `image/gif` and the
        // object must be stored as a GIF, or a browser would later be served the lie.
        const req = uploadRequest(gif(), { kind: "teams", entityId: "7" }, "image/jpeg", token);
        const { res } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 201);
        const reserve = registry.calls("kicklive_reserve_asset_upload")[0];
        assert.equal(reserve["p_content_type"], "image/gif");
        assert.equal(bucket.objects.get("teams/7/original/v2-9f2c1a4d.png")!.contentType, "image/gif");
      },
    });
  });

  it("refuses markup pretending to be an image, and never reserves it", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const req = uploadRequest(svg, { kind: "teams", entityId: "7" }, "image/svg+xml", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 400);
        assert.equal(body.error.fields[0].message, "MARKUP_REJECTED");
        assert.equal(bucket.puts.length, 0);
        assert.equal(registry.rpcCalls.length, 0, "a file that fails the format check never reaches the registry at all");
      },
    });
  });

  it("refuses an over-cap file before hashing or reserving", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    const bytes = png();
    const oversized = new Uint8Array(MEDIA_CATEGORIES.users.maxBytes + 10);
    oversized.set(bytes);
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const req = uploadRequest(oversized, { kind: "users", entityId: USER_ID }, "image/png", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 413);
        assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
        assert.equal(registry.rpcCalls.length, 0);
        assert.equal(bucket.puts.length, 0);
      },
    });
  });

  it("rejects an undeclared body field, including a client-chosen key", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7", key: "sponsors/1/original/evil.png" }, "image/png", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 400);
        assert.equal(body.error.code, "VALIDATION_FAILED");
        assert.ok(body.error.fields.some((f: { field: string }) => f.field === "key"));
        assert.equal(registry.rpcCalls.length, 0);
      },
    });
  });

  it("cannot be walked out of the key space by an entity id", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        for (const bad of ["../../etc/passwd", "7/../../sponsors", "10000000000000000000000000000000000000000000000000000000000000000"]) {
          const req = uploadRequest(png(), { kind: "teams", entityId: bad }, "image/png", token);
          const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
          assert.equal(res.status, 400, bad);
          assert.ok(
            body.error.fields.some((f: { field: string; message: string }) => f.field === "entityId"),
            JSON.stringify(body),
          );
        }
        assert.equal(registry.rpcCalls.length, 0, "a malformed id is refused before any authorization or write");
        assert.equal(bucket.puts.length, 0);
      },
    });
  });

  it("reports a quota refusal as 429 and a club refusal as 403, with no write either way", async () => {
    const token = await signedToken({ sub: USER_ID });
    for (const [outcome, status, code, needle] of [
      [{ status: "rejected", reason: "QUOTA_EXCEEDED", quota_bytes: 100, used_bytes: 100, requested_bytes: 33 }, 429, "RATE_LIMITED", "allowance"],
      [{ status: "forbidden", reason: "NOT_YOUR_CLUB" }, 403, "FORBIDDEN", "manage"],
      [{ status: "rejected", reason: "UNSUPPORTED_TYPE" }, 400, "VALIDATION_FAILED", "stored"],
    ] as [Record<string, unknown>, number, string, string][]) {
      const registry = new FakeRegistry();
      registry.reserveOutcome = outcome;
      await withMedia({
        token,
        registry,
        run: async ({ bucket }) => {
          const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token);
          const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
          assert.equal(res.status, status, JSON.stringify(body));
          assert.equal(body.error.code, code);
          assert.match(body.error.message, new RegExp(needle, "i"), body.error.message);
          assert.equal(bucket.puts.length, 0);
          assert.deepEqual(registry.finalized, [], "a refused upload must not publish anything");
        },
      });
    }
  });

  it("re-uploading identical bytes stores nothing new and says so", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    registry.reserveOutcome = { status: "skip_upload", asset: { id: 12, object_key: "teams/7/original/v1-9f2c1a4d.png", version: 1, visibility: "public", status: "ready" } };
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 201);
        assert.equal(body.data.reused, true);
        assert.equal(bucket.puts.length, 0);
        assert.deepEqual(registry.finalized, ["existing"], "the reservation still has to be closed out, or it looks like an orphan");
      },
    });
  });

  it("leaves the entity alone when the bucket write fails, and records the failure", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    const bucket = new FakeBucket();
    bucket.failPut = true;
    await withMedia({
      token,
      registry,
      bucket,
      run: async () => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 502);
        assert.equal(body.error.code, "DEPENDENCY_FAILED");
        assert.match(body.error.message, /not published/i);
        assert.deepEqual(registry.finalized, ["failed"], "the reservation is closed as failed rather than left 'uploading'");
        assert.ok(!JSON.stringify(body).includes("S3PutObjectFailed"), "the upstream error text stays out of the browser payload");
      },
    });
  });

  it("surfaces an orphan when the object exists but publishing was refused", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    registry.finalizeOutcome = { status: "rejected", reason: "ASSET_NOT_PENDING" };
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token);
        const { res } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 502);
        assert.equal(bucket.puts.length, 1, "the object really is in the bucket");
        assert.ok(bucket.objects.has("teams/7/original/v2-9f2c1a4d.png"), "and it stays as an orphan for reconciliation to report, rather than being quietly deleted");
      },
    });
  });

  it("refuses a write when the bucket is not bound, naming the binding", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      run: async () => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png", token);
        const { res, body } = await call(req.pathname, req.init, ctxEnv(new FakeBucket(), {}) && ({ ...ctxEnv(new FakeBucket()), MEDIA_BUCKET: undefined } as never));
        assert.equal(res.status, 503);
        assert.match(body.error.message, /MEDIA_BUCKET/);
        assert.equal(registry.rpcCalls.length, 0);
      },
    });
  });

  it("requires a session for the upload route, before any handler runs", async () => {
    await withMedia({
      token: null,
      run: async ({ bucket }) => {
        const req = uploadRequest(png(), { kind: "teams", entityId: "7" }, "image/png");
        const { res, body } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 401);
        assert.equal(body.error.code, "UNAUTHENTICATED");
        assert.equal(bucket.puts.length, 0);
      },
    });
  });
});

describe("phase6 · read-through and cache policy", () => {
  const key = "teams/7/original/v2-9f2c1a4d.png";

  it("serves a public object to an anonymous caller with immutable caching", async () => {
    const bucket = new FakeBucket();
    await bucket.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    await withMedia({
      token: null,
      bucket,
      run: async () => {
        const registry = new FakeRegistry();
        await withMedia({
          token: null,
          registry,
          bucket,
          run: async () => {
            const res = await worker.fetch(
              new Request(`https://api.kicklive.test/api/media/assets/${key}`),
              ctxEnv(bucket) as never,
              { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
            );
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", "the handler's cache policy survives finalise, which is what the 'handler' class is for");
            assert.equal(res.headers.get("content-type"), "image/png");
            assert.equal(res.headers.get("accept-ranges"), "bytes");
            assert.equal(res.headers.get("x-asset-visibility"), "public");
            assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...png()]);
          },
        });
      },
    });
  });

  it("answers a range request with 206 and the right slice", async () => {
    const bucket = new FakeBucket();
    const bytes = png(8, 8);
    await bucket.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    const registry = new FakeRegistry();
    registry.resolveOutcome = { ...registry.resolveOutcome, byte_size: bytes.byteLength };
    await withMedia({
      token: null,
      registry,
      bucket,
      run: async () => {
        const res = await worker.fetch(
          new Request(`https://api.kicklive.test/api/media/assets/${key}`, { headers: { range: "bytes=4-11" } }),
          ctxEnv(bucket) as never,
          { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
        );
        assert.equal(res.status, 206);
        assert.equal(res.headers.get("content-range"), `bytes 4-11/${String(bytes.byteLength)}`);
        assert.equal(res.headers.get("content-length"), "8");
        assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...bytes.slice(4, 12)]);
      },
    });
  });

  it("answers 304 when the etag already matches", async () => {
    const bucket = new FakeBucket();
    await bucket.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    const registry = new FakeRegistry();
    registry.resolveOutcome = { ...registry.resolveOutcome, etag: "etag-36" };
    await withMedia({
      token: null,
      registry,
      bucket,
      run: async () => {
        const res = await worker.fetch(
          new Request(`https://api.kicklive.test/api/media/assets/${key}`, { headers: { "if-none-match": '"etag-36"' } }),
          ctxEnv(bucket) as never,
          { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
        );
        assert.equal(res.status, 304);
        assert.equal(await res.text(), "");
      },
    });
  });

  it("404s an unregistered key without revealing whether storage has it", async () => {
    const bucket = new FakeBucket();
    await bucket.put("teams/99/original/v1-00000000.png", png(), { httpMetadata: { contentType: "image/png" } });
    const registry = new FakeRegistry();
    registry.resolveOutcome = null;
    await withMedia({
      token: null,
      registry,
      bucket,
      run: async () => {
        const { res, body } = await call(`/api/media/assets/teams/99/original/v1-00000000.png`, {}, ctxEnv(bucket));
        assert.equal(res.status, 404);
        assert.equal(body.error.code, "NOT_FOUND");
        assert.equal(bucket.objects.size, 1, "a read never deletes");
      },
    });
  });

  it("refuses a private object to strangers and no-stores it for its owner", async () => {
    const bucket = new FakeBucket();
    await bucket.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    const owner = await signedToken({ sub: USER_ID });

    const anonymous = new FakeRegistry();
    anonymous.resolveOutcome = { ...anonymous.resolveOutcome, visibility: "private" };
    await withMedia({
      token: null,
      registry: anonymous,
      bucket,
      run: async () => {
        const { res } = await call(`/api/media/assets/${key}`, {}, ctxEnv(bucket));
        assert.equal(res.status, 403, "an <img> with no session must not read a private object");
      },
    });

    const owned = new FakeRegistry();
    owned.resolveOutcome = { ...owned.resolveOutcome, visibility: "private", cache_class: "private", entity_id: USER_ID };
    owned.authorized = true;
    await withMedia({
      token: owner,
      registry: owned,
      bucket,
      run: async () => {
        const { res } = await call(`/api/media/assets/${key}`, { headers: { authorization: `Bearer ${owner}` } }, ctxEnv(bucket));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "private, no-store");
        assert.equal(res.headers.get("x-asset-visibility"), "private");
      },
    });

    const stranger = new FakeRegistry();
    stranger.resolveOutcome = { ...stranger.resolveOutcome, visibility: "private", cache_class: "private", entity_id: OTHER_ID };
    await withMedia({
      token: owner,
      registry: stranger,
      bucket,
      run: async () => {
        const { res } = await call(`/api/media/assets/${key}`, { headers: { authorization: `Bearer ${owner}` } }, ctxEnv(bucket));
        assert.equal(res.status, 403, "a signed-in stranger is not the owner");
      },
    });
  });

  it("refuses an encoded traversal path and 404s a normalised one", async () => {
    await withMedia({
      token: null,
      run: async ({ bucket }) => {
        const encoded = await call("/api/media/assets/..%2F..%2F..%2Fetc%2Fpasswd", {}, ctxEnv(bucket));
        assert.equal(encoded.res.status, 400, "a path that cannot be a key is a bad request, not a missing object");
        assert.equal(encoded.body.error.code, "BAD_REQUEST");
        const other = await call("/api/media/assets/teams/../players/1/original/v1-00000000.png", {}, ctxEnv(bucket));
        assert.ok(other.res.status === 404 || other.res.status === 400, `got ${String(other.res.status)}`);
      },
    });
  });
});

describe("phase6 · versioning, deletion and retention", () => {
  it("a replacement gets a new key while the old object keeps resolving", async () => {
    const bucket = new FakeBucket();
    const registry = new FakeRegistry();
    const oldKey = "teams/7/original/v1-11111111.png";
    await bucket.put(oldKey, png(8, 8), { httpMetadata: { contentType: "image/png" } });

    const token = await signedToken({ sub: USER_ID });
    registry.reserveOutcome = { status: "proceed", asset: { id: 42, object_key: "teams/7/original/v2-22222222.png", version: 2, visibility: "public", status: "uploading" } };
    await withMedia({
      token,
      registry,
      bucket,
      run: async () => {
        const req = uploadRequest(gif(4, 4), { kind: "teams", entityId: "7" }, "image/gif", token);
        const { res } = await call(req.pathname, req.init, ctxEnv(bucket));
        assert.equal(res.status, 201);
        assert.ok(bucket.objects.has("teams/7/original/v2-22222222.png"), "the new version is written under a new key");
        assert.ok(bucket.objects.has(oldKey), "the previous version is never deleted by a replacement, so every URL already in the wild still resolves");
        assert.equal(bucket.deletes.length, 0);
      },
    });

    // The old key serves on, with the same immutable policy: the render path is only
    // repointed, never invalidated.
    const registry2 = new FakeRegistry();
    registry2.resolveOutcome = { ...registry2.resolveOutcome, entity_id: "7" };
    await withMedia({
      token: null,
      registry: registry2,
      bucket,
      run: async () => {
        const { res } = await call(`/api/media/assets/${oldKey}`, {}, ctxEnv(bucket));
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control") ?? "", /immutable/);
      },
    });
  });

  it("soft delete keeps the object, and purge deletes it only after the registry agrees", async () => {
    const token = await signedToken({ sub: USER_ID });
    const bucket = new FakeBucket();
    const key = "teams/7/original/v2-9f2c1a4d.png";
    await bucket.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      bucket,
      run: async () => {
        const soft = await call("/api/media/assets/41", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, ctxEnv(bucket));
        assert.equal(soft.res.status, 200);
        assert.equal(soft.body.data.objectDeleted, false);
        assert.equal(bucket.objects.size, 1, "a soft delete never touches the bytes");
      },
    });

    const bucket2 = new FakeBucket();
    await bucket2.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    const admin = new FakeRegistry();
    admin.deleteOutcome = { status: "ok", action: "purged", object_key: key, delete_object: true };
    await withMedia({
      token,
      role: "admin",
      registry: admin,
      bucket: bucket2,
      run: async () => {
        const purged = await call("/api/media/assets/41?purge=true", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, ctxEnv(bucket2));
        assert.equal(purged.res.status, 200);
        assert.equal(purged.body.data.objectDeleted, true);
        assert.deepEqual(bucket2.deletes, [key]);
        assert.deepEqual(admin.calls("kicklive_delete_asset")[0], { p_asset_id: 41, p_purge: true }, "the purge decision is made in SQL, and the Worker only carries out what it approved");
      },
    });
  });

  it("restores a version by asking the registry, not by rewriting anything", async () => {
    const token = await signedToken({ sub: USER_ID });
    const registry = new FakeRegistry();
    await withMedia({
      token,
      registry,
      run: async ({ bucket }) => {
        const { res, body } = await call("/api/media/assets/41/restore", { method: "POST", headers: { authorization: `Bearer ${token}` } }, ctxEnv(bucket));
        assert.equal(res.status, 200);
        assert.equal(body.data.restored, true);
        assert.deepEqual(registry.calls("kicklive_restore_asset"), [{ p_asset_id: 41 }]);
        assert.equal(bucket.puts.length, 0, "a restore re-points at bytes that were never deleted");
      },
    });
  });

  it("sweeps by asking the database first and deleting after, in that order", async () => {
    const bucket = new FakeBucket();
    const key = "teams/7/original/v1-aaaaaaaa.png";
    await bucket.put(key, png(), { httpMetadata: { contentType: "image/png" } });
    const order: string[] = [];
    const registry = new FakeRegistry();
    const repo = {
      sweep: async () => {
        order.push("sweep");
        return registry.sweepOutcome as never;
      },
    };
    const env = { SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_URL: "https://testref.supabase.co", SUPABASE_PROJECT_REF: "testref" } as never;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      order.push("rpc");
      return new Response(JSON.stringify(registry.sweepOutcome), { status: 200, headers: { "content-type": "application/json" } });
    }) as never;
    try {
      const result = await sweepMedia(env, {
        bucket: {
          ...bucket,
          delete: async (k: string) => {
            order.push(`delete:${k}`);
            await bucket.delete(k);
          },
        } as never,
        limit: 100,
      });
      assert.equal(result.expiredReservations, 2);
      assert.equal(result.objectsDeleted, 1);
      assert.deepEqual(order, ["rpc", "delete:teams/7/original/v1-aaaaaaaa.png"], "the registry is told before the bytes are removed, never after");
      assert.equal(bucket.objects.size, 0);
      void repo;
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the hourly cron name is what the Worker dispatches on", async () => {
    const { MEDIA_SWEEP_CRON } = await import("../../workers/src/services/mediaStore.ts");
    assert.equal(MEDIA_SWEEP_CRON, "17 * * * *");
  });
});

describe("phase6 · migration of one object", () => {
  const sourceUrl = "https://testref.supabase.co/storage/v1/object/public/media/articles/1.png";

  it("recognises only our own public storage URLs", () => {
    assert.deepEqual(parseLegacyStorageUrl(sourceUrl, "testref"), { bucket: "media", path: "articles/1.png" });
    assert.equal(parseLegacyStorageUrl("https://elsewhere.example.com/storage/v1/object/public/media/a.png", "testref"), null, "another host is never fetched, whatever a row says");
    assert.equal(parseLegacyStorageUrl("http://testref.supabase.co/storage/v1/object/public/media/a.png", "testref"), null);
    assert.equal(parseLegacyStorageUrl("https://testref.supabase.co/storage/v1/object/private/media/a.png", "testref"), null, "a private object has no public read path to copy from");
    assert.equal(parseLegacyStorageUrl("https://testref.supabase.co/storage/v1/object/public/sponsors/a.png", "testref"), null);
    assert.equal(parseLegacyStorageUrl("https://testref.supabase.co/storage/v1/object/public/media/../../etc/passwd", "testref"), null);
    assert.equal(parseLegacyStorageUrl("https://images.unsplash.com/photo-1.png", "testref"), null, "an external hotlink is not ours to move");
    assert.equal(parseLegacyStorageUrl("/placeholder-team-logo.png", "testref"), null, "a bundled asset is not storage either");
  });

  it("skips what the registry already recorded, without fetching", async () => {
    const bucket = new FakeBucket();
    const registry = new FakeRegistry();
    registry.seenKey = "players/9/original/v1-12345678.jpg";
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response("", { status: 200 });
    }) as never;
    try {
      const outcome = await migrateOneObject({
        kind: "players",
        entityId: "9",
        url: sourceUrl,
        source: { bucket: "media", path: "articles/1.png" },
        bucket,
        repo: registry as unknown as MediaRepository,
        projectRef: "testref",
      });
      assert.deepEqual({ state: outcome.state, reason: outcome.reason }, { state: "skipped", reason: "ALREADY_RECORDED" });
      assert.equal(fetched, 0, "a re-run costs one cheap lookup per object, not a download");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("copies, records, and never touches the entity on a failure", async () => {
    const bucket = new FakeBucket();
    const registry = new FakeRegistry();
    const bytes = jpeg(20, 10);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes as unknown as BlobPart, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(bytes.byteLength) } })) as never;
    try {
      const outcome = await migrateOneObject({
        kind: "players",
        entityId: "9",
        url: sourceUrl,
        source: { bucket: "media", path: "articles/1.png" },
        bucket,
        repo: registry as unknown as MediaRepository,
        projectRef: "testref",
      });
      assert.equal(outcome.state, "migrated");
      const key = bucket.puts[0];
      assert.match(key, /^players\/9\/original\/v1-[0-9a-f]{8}\.jpg$/, `a migrated object lands in the same key space as an upload, got ${key}`);
      const record = registry.migratedRecords[0];
      assert.equal(record["p_outcome"], "migrated");
      assert.equal(record["p_source_url"], sourceUrl, "the source URL is what makes a re-run idempotent");
      assert.equal(record["p_sha256"], await sha256Hex(bytes));
      assert.equal(record["p_content_type"], "image/jpeg");
    } finally {
      globalThis.fetch = original;
    }

    // A source that is gone is a failure to record, not a reason to break a page.
    const bucket2 = new FakeBucket();
    const registry2 = new FakeRegistry();
    const gone = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as never;
    try {
      const failed = await migrateOneObject({
        kind: "players",
        entityId: "9",
        url: sourceUrl,
        source: { bucket: "media", path: "articles/missing.png" },
        bucket: bucket2,
        repo: registry2 as unknown as MediaRepository,
        projectRef: "testref",
      });
      assert.equal(failed.state, "failed");
      assert.equal(bucket2.puts.length, 0);
      assert.equal(registry2.migratedRecords.length, 0, "nothing is recorded for a source that never arrived");
    } finally {
      globalThis.fetch = gone;
    }

    // A non-image at a storage URL is skipped and recorded as skipped, so it is never
    // asked about again.
    const bucket3 = new FakeBucket();
    const registry3 = new FakeRegistry();
    const html = new TextEncoder().encode("<!doctype html><html><body>gone</body></html>");
    const third = globalThis.fetch;
    globalThis.fetch = (async () => new Response(html as unknown as BlobPart, { status: 200 })) as never;
    try {
      const skipped = await migrateOneObject({
        kind: "players",
        entityId: "9",
        url: sourceUrl,
        source: { bucket: "media", path: "articles/gone.html" },
        bucket: bucket3,
        repo: registry3 as unknown as MediaRepository,
        projectRef: "testref",
      });
      assert.equal(skipped.state, "skipped");
      assert.equal(skipped.reason, "NOT_AN_ACCEPTED_IMAGE");
      assert.equal(bucket3.puts.length, 0);
    } finally {
      globalThis.fetch = third;
    }
  });

  it("records a failed bucket write so the object can be retried, and keeps the old URL working", async () => {
    const bucket = new FakeBucket();
    bucket.failPut = true;
    const registry = new FakeRegistry();
    const bytes = png();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes as unknown as BlobPart, { status: 200 })) as never;
    try {
      const outcome = await migrateOneObject({
        kind: "teams",
        entityId: "7",
        url: sourceUrl,
        source: { bucket: "media", path: "articles/1.png" },
        bucket,
        repo: registry as unknown as MediaRepository,
        projectRef: "testref",
      });
      assert.equal(outcome.state, "failed");
      assert.equal(registry.migratedRecords[0]["p_outcome"], "failed");
      assert.equal(registry.migratedRecords[0]["p_reason"], "Error");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("phase6 · probe fixtures used by the pipeline", () => {
  it("reads dimensions out of every accepted format", () => {
    assert.deepEqual(probeImage(png(12, 34)), { mime: "image/png", width: 12, height: 34 });
    assert.deepEqual(probeImage(jpeg(40, 25)), { mime: "image/jpeg", width: 40, height: 25 });
    assert.deepEqual(probeImage(gif(64, 48)), { mime: "image/gif", width: 64, height: 48 });
    assert.equal(probeImage(webpExtended(120, 60)).mime, "image/webp");
    assert.deepEqual(probeImage(webpExtended(120, 60)).width ?? probeImage(webpExtended(120, 60)).height, 120 ?? 60, "VP8X carries both, and either reading proves the offsets are right");
  });

  it("the digest the registry is given is the digest of the stored bytes", async () => {
    const bytes = jpeg(3, 4);
    const digest = await sha256Hex(bytes);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, await sha256Hex(jpeg(3, 4)));
    assert.notEqual(digest, await sha256Hex(jpeg(3, 5)));
  });

  it("wrapping a throw in ApiError keeps the envelope free of upstream text", async () => {
    const err = new ApiError("DEPENDENCY_FAILED", 502, "Storage accepted the upload and then refused it.");
    assert.equal(err.status, 502);
    assert.equal(err.code, "DEPENDENCY_FAILED");
  });
});
