/**
 * Phase 6 · the media plane's invariants, asserted from the artifacts rather than from a runtime.
 *
 * Three kinds of thing live here, and each is here because it is the only place it can be checked:
 *
 *   1. The policy table and the SQL must agree. `mediaPolicy.ts` and the migration each encode
 *      "which kind maps to which column, what the cap is, what is uploadable". Two copies of a rule
 *      is normally a smell; the alternative — the caller telling the database what its limits are —
 *      is what makes a limit advisory. So the drift is what this file tests, by parsing both sides.
 *   2. The migration's shape: no destructive statement, RLS enabled and not forced, no client grant,
 *      every definer pinning its search_path, every function the verify block names actually existing.
 *      There is no Postgres in this sandbox, so these are text tests, and they are labelled as such
 *      rather than written as though they had executed SQL.
 *   3. The promises the phase makes to the rest of the repo: `supabase.storage` is gone from the
 *      browser bundle, no media credential is reachable from a client, the doc states what is and is
 *      not implemented, and the secret scanner actually catches the credential shapes R2 makes
 *      plausible.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ROUTES } from "../../workers/src/router.ts";
import { HANDLERS } from "../../workers/src/routes/index.ts";
import { cacheHeadersFor } from "../../workers/src/lib/headers.ts";
import {
  ACCEPTED_TYPES,
  MEDIA_CATEGORIES,
  MEDIA_KINDS,
  MIGRATION_MAX_BYTES_PER_RUN,
  OBJECT_KEY_PATTERN,
  RETENTION_DAYS,
  UPLOADABLE_KINDS,
  assetPathFor,
  buildObjectKey,
  cacheControlFor,
  isSafeObjectKey,
  mediaPolicyDocument,
} from "../../workers/src/lib/mediaPolicy.ts";
import { probeImage, probeLimits, sha256Hex } from "../../workers/src/lib/imageProbe.ts";
import { assetUrl, assetUrlOrEmpty, isManagedAssetPath, mediaUploadEndpoint, resetMediaAssetBaseForTests } from "../../src/lib/media/assets.ts";
import { scanSource } from "../../scripts/check-secrets.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Strips comments, so "no DROP TABLE" means *in the SQL*, not "the string does not appear
 *  anywhere, including the header that explains why it does not appear". */
const sqlCode = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const flat = (text: string): string => text.replace(/\s+/g, " ");

const MIGRATION_REL = "supabase/migrations/20260912120000_phase6_r2_media.sql";
const MIGRATION = read(MIGRATION_REL);
const CODE = sqlCode(MIGRATION);

/** Everything `public.<name>(` the migration defines, with its body, so assertions read the
 *  function rather than a grep that could match a comment or a call site. */
function fnBody(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} is not defined in the migration`);
  const end = CODE.indexOf("$fn$;", start);
  assert.notEqual(end, -1, `${name} has no closing $fn$`);
  return CODE.slice(start, end);
}

/**
 * The migration files that come *after* Phase 6, in apply order.
 *
 * Why a test needs them: the media kind list is a CHECK constraint, and the only way to widen a CHECK is to
 * drop and re-add it — which is exactly what Phase 7 (`advertisements`) and Phase 8 (`sponsors`) do. An
 * assertion that read Phase 6's file alone therefore encoded "Phase 6 is the last word on the shape of the
 * media registry", and it failed while the schema was getting *more* correct. A drift test has to compare the
 * worker's table against the final state, so the later files are replayed here in the same order the
 * migrator will run them.
 */
const LATER_MIGRATIONS = fs
  .readdirSync(path.join(REPO, "supabase/migrations"))
  .filter((f) => f > path.basename(MIGRATION_REL) && f.endsWith(".sql"))
  .sort()
  .map((f) => ({ name: f, code: sqlCode(read(`supabase/migrations/${f}`)) }));

/** `media_assets`' entity-kind list as the database will finally hold it. */
function finalEntityKinds(): string[] {
  const kindList = (source: string): string[] | null => {
    const m = /media_assets_kind_check\s+check \s*\(\s*entity_kind in \(([^)]*)\)/.exec(source);
    return m
      ? m[1]!
          .split(",")
          .map((k) => k.trim().replace(/^'|'$/g, ""))
          .filter(Boolean)
      : null;
  };
  let kinds = kindList(CODE) ?? [];
  for (const file of LATER_MIGRATIONS) {
    // A later `drop constraint` followed by an `add constraint` replaces the list; a later file that only
    // mentions the name (in its verify block, say) must not be read as a change.
    if (!file.code.includes("drop constraint if exists media_assets_kind_check")) continue;
    const next = kindList(file.code);
    if (next && next.length > 0) kinds = next;
  }
  return kinds;
}

/** Each kind's URL column, with the last definition of `kicklive_asset_url_column` winning. */
function finalUrlColumns(): Map<string, string> {
  const arms = caseArms(fnBody("kicklive_asset_url_column"), "select case p_entity_kind");
  for (const file of LATER_MIGRATIONS) {
    const start = file.code.indexOf("create or replace function public.kicklive_asset_url_column(");
    if (start < 0) continue;
    const end = file.code.indexOf("$fn$;", start);
    for (const [kind, column] of caseArms(file.code.slice(start, end), "select case p_entity_kind")) {
      if (column === "null") arms.delete(kind);
      else arms.set(kind, column);
    }
  }
  return arms;
}

function caseArms(source: string, marker: string): Map<string, string> {
  const body = flat(source.slice(source.indexOf(marker)));
  const arms = new Map<string, string>();
  for (const match of body.matchAll(/when '([a-z_]+)'\s*(?:then|=)\s*(?:'([a-z_]+)'|(null|[\d]+|'[\w]*'))/g)) {
    arms.set(match[1]!, match[2] ?? match[3]!);
  }
  return arms;
}

function stringList(regex: RegExp, label: string): string[] {
  const match = regex.exec(flat(CODE));
  assert.ok(match, `${label} not found in the migration`);
  return (match[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · sniffing, not trusting", () => {
  const PNG = (w = 4, h = 6): Uint8Array => {
    const b = new Uint8Array(33);
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v));
    b[11] = 13;
    b.set([0x49, 0x48, 0x44, 0x52], 12);
    b[16] = 0;
    b[17] = 0;
    b[18] = 0;
    b[19] = w;
    b[20] = 0;
    b[21] = 0;
    b[22] = 0;
    b[23] = h;
    return b;
  };
  const GIF = (): Uint8Array => {
    const b = new Uint8Array(13);
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    b[6] = 12;
    b[8] = 7;
    return b;
  };
  const JPEG = (w = 40, h = 20): Uint8Array => {
    const out = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x05, 0x00, 0x00, 0x00];
    out.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03);
    return new Uint8Array(out);
  };

  it("accepts the four formats by signature and reads their dimensions", () => {
    assert.deepEqual(probeImage(PNG(4, 6)), { mime: "image/png", width: 4, height: 6 });
    assert.deepEqual(probeImage(GIF()), { mime: "image/gif", width: 12, height: 7 });
    const j = probeImage(JPEG(40, 20));
    assert.equal(j.mime, "image/jpeg");
    assert.deepEqual({ width: j.width, height: j.height }, { width: 40, height: 20 }, "an APP0 segment before SOF0 must be skipped by length, not by luck");
    assert.deepEqual(Object.keys(ACCEPTED_TYPES).sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  });

  it("a file that declares one type and is another is stored as what it is", () => {
    // The route never passes `file.type` to the registry at all; this is the same fact at the
    // level below, where a lie could otherwise survive: the sniff is the only source of truth.
    const declaredPngButIsGif = GIF();
    assert.equal(probeImage(declaredPngButIsGif).mime, "image/gif");
    const declaredGifButIsPng = PNG(2, 2);
    assert.equal(probeImage(declaredGifButIsPng).mime, "image/png");
  });

  it("refuses markup, empty, truncated, unknown and absurdly-sized inputs", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    assert.equal(probeImage(svg).reason, "MARKUP_REJECTED");
    assert.equal(probeImage(new TextEncoder().encode("  \n<?xml version='1.0'?><svg/>")).reason, "MARKUP_REJECTED", "leading whitespace is not a defence");
    assert.equal(probeImage(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])).reason, "UNSUPPORTED_TYPE", "a zip named .png");
    assert.equal(probeImage(new Uint8Array(4)).reason, "TOO_SMALL");
    assert.equal(probeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0])).reason, "DIMENSIONS_UNAVAILABLE", "SOI then EOI is a truncated file, not an image");
    // The dimensions are big-endian at bytes 16..19 (width) and 20..23 (height). A 1×1 file is free to
    // *claim* 8193×1, and that is the whole point of the check: the decode happens in the visitor's
    // browser, so a 67-megapixel lie takes the page down with it.
    const wide = PNG(1, 1);
    wide[18] = 0x20;
    wide[19] = 0x01;
    assert.equal(probeImage(wide).reason, "TOO_MANY_PIXELS");
    const tall = PNG(1, 1);
    tall[22] = 0x20;
    tall[23] = 0x01;
    assert.equal(probeImage(tall).reason, "TOO_MANY_PIXELS");
    assert.ok(probeLimits.maxDimension >= 4096 && probeLimits.maxPixels >= 16_000_000, "the ceilings are product decisions, not accident: a phone panorama has to fit");
  });

  it("the digest is of these bytes and only these bytes", async () => {
    const a = await sha256Hex(PNG(1, 1));
    const b = await sha256Hex(PNG(1, 2));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    // Independent implementation, so a bug in the hex loop cannot be invisible.
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", PNG(1, 1).slice().buffer as ArrayBuffer)).toString("hex");
    assert.equal(a, expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · keys, paths and cache classes", () => {
  it("derives the key from components, never from a client string", () => {
    const key = buildObjectKey({ kind: "news", entityId: "431", version: 3, sha256: "9f2c1a4d00000000000000000000000000000000000000000000000000000000", extension: "png" });
    assert.equal(key, "news/431/original/v3-9f2c1a4d.png");
    assert.match(key, OBJECT_KEY_PATTERN);
    assert.equal(assetPathFor(key), "/api/media/assets/news/431/original/v3-9f2c1a4d.png");
    assert.equal(
      buildObjectKey({
        kind: "users",
        entityId: "3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c",
        version: 1,
        sha256: "abcdef0111111111111111111111111111111111111111111111111111111111",
        extension: "jpg",
        variant: "original",
      }),
      "users/3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c/original/v1-abcdef01.jpg",
    );
  });

  it("a key from a URL cannot express traversal, an absolute path or a dot-dot segment", () => {
    for (const bad of [
      "../teams/1/a.png",
      "/etc/passwd",
      "teams/1/../../x.png",
      "teams/1/./a.png",
      "Teams/1/a.png",
      "teams/1/a.png?x=1",
      "teams 1/a.png",
      "a",
      "teams\\1\\a.png",
      "teams/1/a.png#f",
      "teams//1/a.png",
      "teams/1//",
      "teams/../..",
      "..",
      ".",
    ]) {
      assert.ok(!isSafeObjectKey(bad), `accepted a key that should be impossible: ${bad}`);
    }
    assert.ok(isSafeObjectKey("teams/1/original/v1-aaaaaaaa.png"));
    assert.ok(isSafeObjectKey("users/3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c/original/v12-abcdef01.webp"));
    // The database's CHECK is the character set only. A literal `..` is *not* a parent directory in a
    // bucket — keys are opaque strings — and duplicating the HTTP-path rule in SQL would put a
    // transport concern under two owners. The read route, which is where the path is a path, applies
    // the full rule.
    assert.ok(!OBJECT_KEY_PATTERN.test("../x.png"), "the character set must still reject a leading dot");
    assert.ok(OBJECT_KEY_PATTERN.test("teams/1/../x.png"), "and the CHECK deliberately does not pretend to own dot-segments");
  });

  it("a versioned key is immutable and a private one is never shared", () => {
    assert.equal(cacheControlFor({ visibility: "public", objectKey: "teams/7/original/v4-deadbeef.png" }), "public, max-age=31536000, immutable");
    assert.equal(cacheControlFor({ visibility: "public", objectKey: "teams/7/legacy.png" }), "public, max-age=300, stale-while-revalidate=86400");
    assert.equal(cacheControlFor({ visibility: "private", objectKey: "users/7/original/v1-deadbeef.png" }), "private, no-store");
    // The `handler` cache class exists so the entry point leaves the per-object policy alone, but it
    // must not become "no policy": a forgotten header still means no-store.
    assert.deepEqual(cacheHeadersFor("handler"), {});
    const entry = read("workers/src/index.ts");
    assert.match(entry, /cache === "handler" && !response\.headers\.has\("cache-control"\)/);
    assert.match(entry, /extra\["cache-control"\] = "no-store"/);
  });

  it("the migration builds the same key, from the same components", () => {
    // Only the expression after `select` counts: the signature above it repeats every parameter name,
    // and an ordering test that read the argument list would pass while proving nothing.
    const body = flat(fnBody("kicklive_asset_object_key"));
    const sql = body.slice(body.indexOf("as $fn$"));
    // Component *order*, tolerant of how the concatenation is broken across lines and of the `'/v'`
    // shortcut. What matters is that the key the client was told about and the key written to storage
    // are products of one expression over the same six parts, in the same sequence.
    const parts = ["p_entity_kind", "p_entity_id", "p_variant", "p_version::text", "left(lower(p_sha256), 8)", "p_extension"];
    // Positions rather than a synthesized regex: the point is that the six parts occur, in that order,
    // and a pattern assembled from strings is exactly the kind of test that silently matches `sS`.
    const at = parts.map((part) => sql.indexOf(part));
    at.forEach((index, i) => {
      assert.ok(index >= 0, `the SQL key expression never mentions ${parts[i]}`);
      if (i > 0) assert.ok(index > at[i - 1]!, `${parts[i]} is in the wrong place in the SQL key expression`);
    });
    for (const separator of ["'/'", "'-'", "'.'"]) assert.ok(sql.includes(separator), `missing the ${separator} separator`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · the policy table and the SQL must agree", () => {
  it("the legal kinds are the ones the database will accept", () => {
    assert.deepEqual(finalEntityKinds().sort(), [...MEDIA_KINDS].sort(), "the registry's kind list and the worker's disagree");
    // Phase 6's own file must still be the *base* of it, or the widening in a later file is doing something
    // it was never meant to: the kinds this migration created have to be a subset of what ends up legal.
    const baseKinds = stringList(/media_assets_kind_check check \(entity_kind in \(([^)]*)\)\)/, "entity_kind CHECK");
    for (const kind of baseKinds) assert.ok(MEDIA_KINDS.includes(kind as (typeof MEDIA_KINDS)[number]), `${kind} disappeared from the worker's kinds`);
  });

  it("the URL column per kind is the same column on both sides", () => {
    const arms = finalUrlColumns();
    for (const kind of MEDIA_KINDS) {
      const expected = MEDIA_CATEGORIES[kind].urlColumn;
      const inSql = arms.get(kind);
      if (expected === "") {
        assert.ok(inSql === undefined || inSql === "null", `${kind} must have no column in SQL either`);
        continue;
      }
      assert.equal(inSql, expected, `${kind}'s url column differs between mediaPolicy.ts and the migration`);
      // And the column must actually exist, or finalize would fail at runtime.
      const schema = read("KICKLIVE_FINAL_SCHEMA.sql");
      const table = MEDIA_CATEGORIES[kind].table;
      const block = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`), schema.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`) + 1600);
      assert.ok(
        new RegExp(`\\b${expected}\\b`).test(block) ||
          new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS\\s+${expected}`).test(schema) ||
          // A kind that arrived after this file was written has its column in that later migration instead,
          // which is the correct place for it and not a hole in the schema authority.
          LATER_MIGRATIONS.some((file) => new RegExp(`create table if not exists public\\.${table}[\\s\\S]{0,2400}?\\b${expected}\\b`, "i").test(file.code)),
        `${table}.${expected} is not in the schema authority`,
      );
    }
  });

  it("every kind is public today, and the reason is written down", () => {
    for (const kind of MEDIA_KINDS) assert.equal(MEDIA_CATEGORIES[kind].visibility, "public", `${kind} became private without a fetch-with-token UI`);
    assert.equal(flat(fnBody("kicklive_asset_visibility")).includes("select 'public';"), true, "the SQL must say the same thing");
    const doc = read("docs/R2_MEDIA_ARCHITECTURE.md");
    assert.match(doc, /sends no `Authorization` header/);
  });

  it("the per-role quotas are one set of numbers, not two", () => {
    const arms = caseArms(fnBody("kicklive_upload_quota_bytes"), "select case p_role");
    const documented = mediaPolicyDocument().dailyQuotaBytes.roles as Record<string, number | null>;
    const quotaSql = flat(fnBody("kicklive_upload_quota_bytes"));
    const elseArm = /else (null|[\d]+)/.exec(quotaSql.slice(quotaSql.indexOf("case p_role")))?.[1];
    assert.ok(elseArm !== undefined, "the quota CASE needs an else, or an unknown role gets NULL and unlimited storage");
    for (const [role, bytes] of Object.entries(documented)) {
      // A role with no arm takes the ELSE branch. That is the same number spelled twice when we are
      // careful and a silent policy change when we are not, so the test accepts either form.
      const inSql = arms.get(role) ?? elseArm;
      assert.equal(inSql === "null" ? null : Number(inSql), bytes, `quota for ${role} differs between SQL and the policy document`);
    }
    assert.equal(arms.get("admin"), "null", "admin being unlimited is a decision; if it ever becomes a number, say so in the doc too");
  });

  it("the size ceilings line up: the global var, the DB CHECK, and the biggest category", () => {
    const ceiling = Number(/MEDIA_MAX_BYTES = (\d+)/.exec(read("workers/wrangler.toml"))?.[1]);
    assert.ok(Number.isFinite(ceiling) && ceiling > 0, "MEDIA_MAX_BYTES must be declared in wrangler.toml");
    const check = /byte_size > 0 and byte_size <= (\d+)/.exec(CODE);
    assert.ok(check, "the byte_size CHECK must bound the size");
    assert.equal(Number(check![1]), ceiling, "the database and the deployment must agree on the largest object in the system");
    const largest = Math.max(...Object.values(MEDIA_CATEGORIES).map((c) => c.maxBytes));
    assert.ok(largest <= ceiling, `a category cap (${largest}) exceeds the global ceiling (${ceiling})`);
    // And the ceiling is not so large that the Worker's buffering limit is unreachable: a file that
    // clears the DB CHECK but cannot be read by `readUpload` would be a 413 nobody can explain.
    assert.ok(ceiling <= 50 * 1024 * 1024, `MEDIA_MAX_BYTES ${ceiling} exceeds what a Worker request should buffer`);
    assert.ok(UPLOADABLE_KINDS.every((k) => MEDIA_CATEGORIES[k].maxBytes <= ceiling));
    assert.ok(MIGRATION_MAX_BYTES_PER_RUN <= 128 * 1024 * 1024, "a migration run must stay well inside a Worker request's patience");
  });

  it("only the six kinds with a URL column and an owner predicate take browser uploads", () => {
    assert.deepEqual([...UPLOADABLE_KINDS].sort(), MEDIA_KINDS.filter((k) => MEDIA_CATEGORIES[k].uploadable).sort());
    for (const kind of ["seasons", "matches"] as const) assert.equal(MEDIA_CATEGORIES[kind].uploadable, false);
    const reserve = flat(fnBody("kicklive_reserve_asset_upload"));
    assert.match(reserve, /p_variant is distinct from 'original'/, "the server must refuse a variant a browser cannot fill, not merely not offer one");
    assert.match(reserve, /VARIANT_UNSUPPORTED/);
  });

  it("the migration's lifecycle states are the ones the code reasons about", () => {
    const statuses = stringList(/media_assets_status_check\s+check \(status in \(([^)]*)\)\)/, "status CHECK");
    assert.deepEqual(statuses, ["uploading", "ready", "failed", "superseded", "deleted", "purged"]);
    const resolved = flat(fnBody("kicklive_asset_for_key"));
    assert.match(resolved, /a\.status in \('ready', 'superseded'\)/, "a superseded object must keep resolving, or the immutable cache claim is false");
    assert.match(resolved, /'unknown'/, "an unregistered key answers a status, not a row of metadata");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · the migration file, read as a document", () => {
  it("adds nothing it does not need to, and destroys nothing", () => {
    const forbidden = [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\bdrop\s+constraint\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\s+public\.media_assets\b/i,
      /\balter\s+table\s+public\.\w+\s+force\s+row\s+level\s+security\b/i,
    ];
    for (const re of forbidden) assert.ok(!re.test(CODE), `${re.source} appears in executable SQL; this migration is additive only`);
  });

  it("keeps the eight existing URL columns in place", () => {
    const columns = [
      "public.media.image_url",
      "public.team_news.image_url",
      "public.teams.logo_url",
      "public.players.photo_url",
      "public.competitions.logo_url",
      "public.profiles.avatar_url",
      "public.media.video_url",
      "public.match_events.video_url",
    ];
    for (const column of columns) assert.ok(!CODE.includes(`drop column ${column.split(".")[1]}`), `${column} was removed`);
    const schema = read("KICKLIVE_FINAL_SCHEMA.sql");
    for (const column of columns) {
      const [, table, name] = column.split(".");
      const block = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`), schema.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`) + 2000);
      assert.ok(
        new RegExp(`\\b${name}\\s+TEXT`).test(block) || new RegExp(`ALTER TABLE public\\.${table} ADD COLUMN IF NOT EXISTS\\s+${name}\\s+TEXT`).test(schema),
        `${column} is not in the schema authority any more`,
      );
    }
  });

  it("enables RLS, grants nothing to a client role, and does not fake it with FORCE", () => {
    for (const table of ["media_assets", "media_operations"]) {
      assert.ok(CODE.includes(`alter table public.${table} enable row level security;`), `${table} must have RLS on`);
      assert.ok(CODE.includes(`revoke all on table public.${table} from anon, authenticated, service_role;`), `${table} must start from no privileges at all`);
    }
    assert.ok(/grant select, insert on table public\.media_assets to service_role;/.test(CODE), "the Worker needs select and insert, and no more");
    assert.ok(!/grant (update|delete|all)[^;]*on table public\.media_assets/.test(CODE), "a client-or-Worker update right on the registry would let a status change skip its bookkeeping");
    assert.ok(!/grant[^;]*media_assets to (anon|authenticated)/.test(CODE), "no client role may hold a table privilege on the registry");
    assert.ok(!/force row level security/.test(CODE), "no FORCE, for the reason Phase 5 §9.6 gives");
  });

  it("every definer function pins its search_path", () => {
    const blocks = CODE.split(/(?=create or replace function)/).filter((b) => b.startsWith("create or replace function"));
    assert.ok(blocks.length >= 15, `expected the migration's functions to be enumerable, found ${String(blocks.length)}`);
    for (const block of blocks) {
      const name = /create or replace function public\.([a-z_]+)/.exec(block)?.[1] ?? "?";
      if (!/security definer/.test(block)) continue;
      assert.match(block, /set search_path = public, pg_temp/, `${name} is SECURITY DEFINER without pinning its search_path`);
    }
    for (const name of [
      "kicklive_reserve_asset_upload",
      "kicklive_finalize_asset_upload",
      "kicklive_delete_asset",
      "kicklive_record_migrated_asset",
      "kicklive_asset_for_key",
      "kicklive_entity_assets",
      "kicklive_asset_authorized",
      "kicklive_sweep_media",
      "kicklive_reconcile_assets",
      "kicklive_asset_diagnostics",
      "kicklive_migration_seen",
      "can_manage_team",
    ]) {
      assert.match(fnBody(name), /security definer/, `${name} must run as its owner, or it cannot read the registry on the caller's behalf`);
    }
  });

  it("grants exactly the client-callable set, and derives the list from the verify block", () => {
    const declared = stringList(/expected text\[\] := array\[([^\]]*)\]/, "the verify block's function list");
    assert.ok(declared.length >= 14, `the verify block should name every function, named ${String(declared.length)}`);
    for (const name of declared) {
      assert.ok(CODE.includes(`create or replace function public.${name}(`), `${name} is asserted by the verify block but never created`);
    }
    const granted = ["kicklive_reserve_asset_upload", "kicklive_finalize_asset_upload", "kicklive_entity_assets", "kicklive_delete_asset", "kicklive_restore_asset"];
    // Parse the *authenticated* arm rather than the whole block: the sweep and the migration
    // pre-checks also appear in the loop's WHERE clause (they have to, or the pattern-driven loop
    // would never grant them to service_role), and grepping the block would report them as
    // client-granted when they are not.
    const clientGrantList = flat(CODE.slice(CODE.indexOf("if r.proname in ("), CODE.indexOf("then", CODE.indexOf("if r.proname in ("))));
    const clientGranted = [...clientGrantList.matchAll(/'(kicklive_[a-z_]+)'/g)].map((m) => m[1]!);
    assert.deepEqual(clientGranted.sort(), [...granted].sort(), "the set of browser-callable media functions changed; that is an authorization decision, not a refactor");
    // And the ones that read other people's rows or decide an audience are not in it.
    for (const name of [
      "kicklive_asset_diagnostics",
      "kicklive_sweep_media",
      "kicklive_record_migrated_asset",
      "kicklive_reconcile_assets",
      "kicklive_migration_seen",
      "kicklive_asset_authorized",
      "kicklive_upload_quota_bytes",
    ]) {
      assert.ok(!clientGranted.includes(name), `${name} must never be client-granted`);
    }
    assert.match(flat(CODE).replace(/\s+/g, " "), /grant execute on function public\.%I\(%s\) to service_role/);
  });

  it("never deletes an object, and says so", () => {
    assert.ok(!/http_post|r2\.|aws_s3|storage\.objects|net\.http/.test(CODE), "the migration must not grow a way to reach the bucket: object deletion is the Worker's job, after the row agrees");
    assert.match(flat(fnBody("kicklive_delete_asset")), /'delete_object', p_purge/);
    assert.ok(RETENTION_DAYS > 0);
    assert.match(CODE, /30 days/);
  });

  it("wraps itself in a transaction, verifies, and reloads the schema cache", () => {
    const lines = CODE.split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    assert.equal(lines[0], "begin;");
    assert.ok(lines.includes("commit;"));
    assert.ok(MIGRATION.trimEnd().endsWith(`notify pgrst, 'reload schema';`), "PostgREST will not see a new function until it is told");
    assert.match(MIGRATION, /raise exception 'kicklive migration verification failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · the API surface", () => {
  const mediaRoutes = ROUTES.filter((r) => r.pattern === "/media" || r.pattern.startsWith("/media/") || r.pattern.startsWith("/admin/media/"));

  it("declares nine media routes, all implemented, all handler-backed", () => {
    // Phase 2's four media stubs (`/media`, `/media/:mediaId`, `/media/:mediaId/publish`,
    // `/media/feed`) stay exactly as they were: declared, unimplemented, answering 501. Phase 6 built
    // the storage plane, not the editorial API; a census that silently absorbed those stubs into
    // "media is done" would be a census of the wrong thing.
    const built = mediaRoutes.filter((r) => r.implemented);
    const stubs = mediaRoutes.filter((r) => !r.implemented);
    assert.equal(built.length, 9);
    assert.deepEqual(stubs.map((r) => r.pattern).sort(), ["/media", "/media/:mediaId", "/media/:mediaId/publish", "/media/feed"]);
    for (const route of built) {
      assert.ok(HANDLERS[`${route.method} ${route.pattern}`], `${route.method} ${route.pattern} has no handler`);
    }
    for (const [key, handler] of Object.entries(HANDLERS)) {
      if (!key.includes("/media/")) continue;
      const [, pattern] = key.split(" ");
      assert.ok(
        mediaRoutes.some((r) => r.pattern === pattern),
        `HANDLERS has ${key} which the route table does not declare`,
      );
      assert.equal(typeof handler, "function");
    }
  });

  it("the read path resolves a key through the registry before it touches the bucket", () => {
    const route = read("workers/src/routes/media.ts");
    // Two properties a runtime test with a fake bucket would not catch, because both are about what
    // the code refuses to do: a malformed key is a bad request (a 404 would make a traversal attempt
    // indistinguishable from a typo), and the object is fetched only after `kicklive_asset_for_key`
    // has said what the key is — so no URL can name a bucket object the registry does not own.
    assert.match(route, /if \(!raw \|\| !isSafeObjectKey\(raw\)\) \{[\s\S]{0,160}BAD_REQUEST/);
    assert.match(route, /resolve: \(key\) => publicRepositoryFor\(env\)\.resolve\(key\)/, "the read route must hand the registry, not the bucket, the first look at the key");
    const store = read("workers/src/services/mediaStore.ts");
    assert.match(store, /const meta = await deps\.resolve\(input\.objectKey\);[\s\S]{0,140}"NOT_FOUND", 404/);
  });

  it("retires the two signed-upload stubs, everywhere", () => {
    assert.ok(!ROUTES.some((r) => r.pattern.includes("uploads/sign") || r.pattern.includes("uploads/:key")));
    const readme = read("workers/README.md");
    assert.ok(!readme.includes("uploads/sign"), "the route map still advertises a retired design");
    for (const route of mediaRoutes) assert.ok(readme.includes(`\`${route.method} ${route.pattern}\``), `README does not list ${route.method} ${route.pattern}`);
  });

  it("names a rate budget on every write, and no media write is unbounded", () => {
    for (const route of mediaRoutes) {
      if (route.method === "GET") continue;
      assert.ok(route.rateLimit, `${route.method} ${route.pattern} writes without a rate limit`);
    }
    const upload = mediaRoutes.find((r) => r.pattern === "/media/uploads");
    assert.equal(upload?.rateLimit, "mutation");
    assert.equal(mediaRoutes.find((r) => r.pattern === "/media/migration")?.rateLimit, "admin-blast", "a bulk copy is not a mutation");
    assert.equal(mediaRoutes.find((r) => r.pattern === "/media/assets/*")?.cache, "handler");
    assert.equal(mediaRoutes.find((r) => r.pattern === "/media/diagnostics")?.capability, "admin.settings_write");
    assert.equal(mediaRoutes.find((r) => r.pattern === "/media/sweep")?.capability, "admin.settings_write");
  });

  it("the upload contract accepts four fields and none of them is a key, a bucket or a type", () => {
    const route = read("workers/src/routes/media.ts");
    assert.match(route, /const UPLOAD_KEYS = \["kind", "entityId", "variant", "alt"\]/);
    assert.ok(!/fields\.string\("key"|fields\.string\("bucket"|fields\.string\("contentType"/.test(route), "the route must not read a client-named key, bucket or declared type");
    assert.match(route, /formData\(\)/);
    assert.match(route, /typeof value !== "string"/, "a file part is told from a text part by its shape, not by a filename guess");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · the frontend read path", () => {
  it("assetUrl resolves only our own paths and passes everything else through", () => {
    resetMediaAssetBaseForTests();
    assert.equal(assetUrl("/api/media/assets/teams/7/original/v1-aaaaaaaa.png"), "/api/media/assets/teams/7/original/v1-aaaaaaaa.png");
    assert.equal(assetUrl("/media/assets/teams/7/original/v1-aaaaaaaa.png"), "/api/media/assets/teams/7/original/v1-aaaaaaaa.png");
    const legacy = "https://testref.supabase.co/storage/v1/object/public/media/articles/1.png";
    assert.equal(assetUrl(legacy), legacy, "a legacy storage URL is still a working URL");
    assert.equal(assetUrl("https://images.unsplash.com/photo-1.png"), "https://images.unsplash.com/photo-1.png");
    assert.equal(assetUrl("/placeholder-team-logo.png"), "/placeholder-team-logo.png");
    assert.equal(assetUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
    assert.equal(assetUrl(null, "fb"), "fb");
    assert.equal(assetUrl(undefined, "fb"), "fb");
    assert.equal(assetUrl("   ", "fb"), "fb");
    assert.equal(assetUrl(42, "fb"), "fb", "a number in a url column must not become the string '42' in a src attribute");
    assert.equal(assetUrl(""), undefined, "a JSX `src` wants undefined, not null (see the note on assetUrl)");
    assert.equal(assetUrl("  \n "), undefined);
    assert.equal(assetUrl(undefined), undefined);
    assert.equal(assetUrlOrEmpty(null), "");
    assert.ok(isManagedAssetPath("/api/media/assets/a/b"));
    assert.ok(!isManagedAssetPath("/api/media/uploads"));
    assert.equal(mediaUploadEndpoint(), "/api/media/uploads", "with no configured base the upload goes to the page's own origin");
  });

  it("the components that render media go through the resolver", () => {
    const sites = [
      "src/pages/HomePage.tsx",
      "src/pages/NewsPage.tsx",
      "src/pages/portals/AdminPortal.tsx",
      "src/pages/portals/MediaPortal.tsx",
      "src/pages/portals/TeamOwnerPortal.tsx",
      "src/pages/portals/shared/MediaPublisher.tsx",
    ];
    for (const site of sites) {
      const source = read(site);
      assert.match(source, /import \{[^}]*assetUrl[^}]*\} from/, `${site} renders media without importing the resolver`);
      assert.match(source, /assetUrl\(/, `${site} imports the resolver but never calls it`);
    }
  });

  it("no browser code talks to a storage API any more", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|html)$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        if (/supabase\.storage|\.storage\.from\(|getPublicUrl|createSignedUrl/.test(text)) offenders.push(path.relative(REPO, full));
      }
    };
    walk(path.join(REPO, "src"));
    assert.deepEqual(offenders, [], "an upload path in the browser bypasses the registry, the quota and the format check; use POST /api/media/uploads");
  });

  it("no media credential can reach a bundle", () => {
    const needles = ["MEDIA_BUCKET", "r2.dev", "ACCOUNT_ID", "SECRET_ACCESS_KEY", "ACCESS_KEY_ID", "aws-sdk", "@aws-sdk"];
    const scanned: string[] = [];
    for (const dir of ["src", "pwa", "shared"]) {
      const root = path.join(REPO, dir);
      if (!fs.existsSync(root)) continue;
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!/\.(ts|tsx|js|jsx|html|css|json)$/.test(entry.name)) continue;
          scanned.push(full);
          const text = fs.readFileSync(full, "utf8");
          for (const needle of needles) assert.ok(!text.includes(needle), `${path.relative(REPO, full)} mentions ${needle}: media must be reached through the Worker, not a credential`);
        }
      };
      walk(root);
    }
    assert.ok(scanned.length > 40, "the census should have read the app, not nothing");
  });

  it("the upload client has progress, cancellation and a retryable answer", () => {
    const upload = read("src/lib/media/upload.ts");
    assert.match(upload, /XMLHttpRequest/, "fetch cannot report upload progress, and a 9 MB upload without progress is a form that looks frozen");
    assert.match(upload, /xhr\.upload\.addEventListener\("progress"/);
    assert.match(upload, /abort\(\)/);
    assert.match(upload, /addEventListener\("abort"/);
    assert.match(upload, /timeoutMs/);
    assert.match(upload, /retryable/);
    assert.match(upload, /readAccessToken\(\)/, "the token is read fresh per upload and never cached here");
    const publisher = read("src/pages/portals/shared/MediaPublisher.tsx");
    assert.match(publisher, /uploadAsset\(/);
    assert.match(publisher, /AbortController/);
    assert.match(publisher, /reused|Retry/, "the retry affordance is the point of the typed error");
    assert.match(publisher, /URL\.revokeObjectURL/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · configuration and documentation", () => {
  it("R2 is bound once per environment, with distinct buckets, before the first env block", () => {
    const toml = read("workers/wrangler.toml");
    const lines = toml.split("\n").map((l) => l.trim());
    const firstEnv = lines.findIndex((l) => l === "[env.staging]");
    const topR2 = lines.findIndex((l) => l === "[[r2_buckets]]");
    assert.ok(topR2 >= 0 && firstEnv > topR2, "an active [[r2_buckets]] after [env.staging] silently becomes staging's, and dev gets no bucket");
    assert.equal(lines.filter((l) => l === "[[env.staging.r2_buckets]]").length, 1);
    assert.equal(lines.filter((l) => l === "[[env.production.r2_buckets]]").length, 1);
    const buckets = [...toml.matchAll(/^bucket_name = "([^"]+)"/gm)].map((m) => m[1]!);
    assert.deepEqual(new Set(buckets).size, buckets.length, "two environments must not share one bucket");
    assert.equal(buckets.length, 3);
    assert.match(toml, /binding = "MEDIA_BUCKET"/);
    // Comment lines legitimately *name* other secrets (`wrangler secret put TURNSTILE_SECRET_KEY`);
    // what must not exist anywhere in this file is an assignment of a bucket credential.
    const tomlCode = toml
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.ok(!/r2\.dev|(access|secret)[_-]?key|aws/i.test(tomlCode), "no bucket credential belongs in this file, in any form");
  });

  it("the local env example documents both new phases and still holds no secret", () => {
    const example = read("workers/.dev.vars.example");
    for (const needle of ["FCM_SERVICE_ACCOUNT", "FCM_PROJECT_ID", "NOTIFICATIONS_MAX_AUDIENCE", "MEDIA_MAX_BYTES"]) assert.ok(example.includes(needle), `${needle} is undocumented`);
    assert.match(example, /no secrets, by design/i);
    assert.ok(!/-----BEGIN|AKIA[0-9A-Z]{16}/.test(example), "an example file is where a real key gets pasted by mistake");
    assert.match(example, /wrangler secret put FCM_SERVICE_ACCOUNT/);
  });

  it("the architecture doc covers the phase and labels what is not true yet", () => {
    const doc = read("docs/R2_MEDIA_ARCHITECTURE.md");
    for (const heading of [
      "What exists today",
      "no media credential exists",
      "why presigned uploads were dropped",
      "keys, prefixes",
      "database versus in object storage",
      "The kinds",
      "the pipeline, in order",
      "The format check",
      "Public and private",
      "Reads and caching",
      "Quotas, limits and rate control",
      "Idempotency, versions, replacement and restore",
      "Migration from Supabase Storage",
      "Security",
      "Retention, orphan reconciliation, observability",
      "Manual setup",
      "deliberately not done",
      "Testing",
    ]) {
      assert.ok(doc.toLowerCase().includes(heading.toLowerCase()), `docs/R2_MEDIA_ARCHITECTURE.md never answers: ${heading}`);
    }
    for (const label of ["IMPLEMENTED", "CONFIGURED", "REQUIRES MANUAL SETUP", "NOT YET IMPLEMENTED"]) assert.ok(doc.includes(label));
    assert.match(doc, /not provable from a sandbox/);
    assert.match(doc, /`video_url` columns|Video uploads/);
    // The doc must not claim a bucket exists.
    assert.match(doc, /npx wrangler r2 bucket create/);
  });

  it("the migration plan records Phase 6 and the numbering collision it created", () => {
    const plan = read("docs/PRODUCTION_MIGRATION_PLAN.md");
    assert.match(plan, /Phase 6 — media on R2|Phase 6 · media on R2|Phase 6 — R2 media/);
    assert.match(plan, /advertising/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phase6 · the secret scanner catches what this phase makes plausible", () => {
  it("finds a PEM, a service-account JSON, an AWS key and a Supabase token — and not a doc comment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-secrets-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "leaked.ts"), 'const key = "-----BEGIN PRIVATE KEY-----";\nexport default key;\n');
      fs.writeFileSync(path.join(root, "src", "sa.json"), '{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nAAA\\n"\n}\n');
      fs.writeFileSync(path.join(root, "src", "aws.ts"), 'export const id = "AKIAABCDEFGHIJKLMNOP";\n');
      fs.writeFileSync(path.join(root, "src", "pat.ts"), 'export const t = "sbp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
      fs.writeFileSync(path.join(root, "src", "documented.ts"), "// The PEM format we parse starts with -----BEGIN PRIVATE KEY-----\nexport const x = 1;\n");
      fs.writeFileSync(path.join(root, "src", "key.pem"), "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n");
      const findings = scanSource(root);
      const kinds = new Set(findings.map((f: { kind: string }) => f.kind));
      for (const kind of ["pem-private-key", "service-account-json", "aws-access-key-id", "supabase-token"]) {
        assert.ok(kinds.has(kind), `the scanner missed ${kind}`);
      }
      assert.ok(
        findings.some((f: { file: string }) => f.file.endsWith("key.pem")),
        "a .pem file must be scanned even though it is not source",
      );
      assert.ok(
        !findings.some((f: { file: string; kind: string }) => f.file.endsWith("documented.ts") && f.kind === "pem-private-key"),
        "the repo documents the PEM format it parses; flagging that comment would get the rule muted",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays quiet on this repository", () => {
    assert.deepEqual(scanSource(REPO), [], "the tree must be clean for the phase to claim it");
  });
});
