/**
 * Phase 2 — the Worker's boundary behaviour, asserted end-to-end.
 *
 * These tests import the real entry point (`workers/src/index.ts`) and call its `fetch` handler the way
 * Cloudflare does. Nothing is mocked inside the Worker: the only stub is `globalThis.fetch`, which is
 * how the Worker reaches Supabase, so each test drives authentication, the capability matrix, the
 * envelope, CORS, cache headers and error sanitisation *together* — the combination is the product.
 *
 * Why not `miniflare`/`vitest-pool-worker`: they would add a dev dependency (and a workers runtime
 * download) to assert things `node --test` can assert with a `Request` object. If the Worker ever gains
 * KV/DO-dependent behaviour, that is the point to add a runtime, and this file is where it plugs in.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import worker from "../../workers/src/index.ts";
import { allowedOrigins } from "../../workers/src/env.ts";
import { capabilitiesFor, roleHasCapability } from "../../workers/src/lib/capabilities.ts";
import { ApiError } from "../../workers/src/lib/response.ts";
import { Fields, GOAL_TYPES, MATCH_EVENT_TYPES, MATCH_STATUSES, readJsonBody, readQuery, REQUESTABLE_ROLES } from "../../workers/src/lib/validation.ts";
import { createRateLimiter, limitKeyFor, resetRateLimitMemory, RATE_LIMITED_BY_DEFAULT, BUDGETS } from "../../workers/src/middleware/ratelimit.ts";
import { ROUTES } from "../../workers/src/router.ts";
import { assertSupabaseUrl } from "../../workers/src/services/supabase.ts";
import { createApiClient, fieldErrors, API_ROOT } from "../../src/lib/api/client.ts";
import { resolveApiBaseUrl, ConfigError } from "../../src/lib/env.ts";
import { scanSource } from "../../scripts/check-secrets.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const codeOf = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const JWT_SECRET = "unit-test-jwt-secret-not-a-real-key";
const SERVICE_ROLE_SENTINEL = "SECRET_SERVICE_ROLE_KEY_MUST_NEVER_LEAK_0000000000";
const ALLOWED_ORIGIN = "https://app.kicklive.test";

const baseEnv: Record<string, string> = {
  APP_ENV: "development",
  SUPABASE_URL: "https://testref.supabase.co",
  SUPABASE_PROJECT_REF: "testref",
  SUPABASE_ANON_KEY: "eyJhbGciOi-unit-anon-key-not-secret-0000000000000000",
  SUPABASE_JWT_SECRET: JWT_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_SENTINEL,
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
};

const envWith = (over: Record<string, string | undefined> = {}): Record<string, string> => {
  const env = { ...baseEnv };
  for (const [k, v] of Object.entries(over))
    if (v === undefined) delete env[k];
    else env[k] = v;
  return env as unknown as Record<string, string>;
};

const executionContext = {
  waitUntil: (_p: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
} as unknown as object;

const USER_ID = "3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c";

function b64url(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

/** A genuinely signed HS256 token — the Worker verifies signatures, so a fake one cannot be a fixture. */
async function signedToken(claims: Record<string, unknown>, secret: string = JWT_SECRET, alg = "HS256"): Promise<string> {
  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: "supabase", aud: "authenticated", role: "authenticated", ...claims }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Installs a fake Supabase. `routes` is matched in order against the request URL. */
async function withSupabase<T>(routes: { match: string; respond: (init: RequestInit) => Response }[], run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const route of routes) if (url.includes(route.match)) return route.respond(init ?? {});
    return new Response(JSON.stringify({ message: `unstubbed url ${url}`, code: "PGRST301" }), { status: 500, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const profileResponse = (row: Record<string, unknown> | null): Response => new Response(JSON.stringify(row === null ? [] : [row]), { status: 200, headers: { "content-type": "application/json" } });

function call(pathname: string, init: RequestInit = {}, env: Record<string, string> = envWith()): Promise<Response> {
  return worker.fetch(new Request(`https://api.kicklive.test${pathname}`, init), env as never, executionContext as never);
}

const json = async (res: Response): Promise<Record<string, any>> => JSON.parse(await res.text());

const okCall = async (pathname: string, init: RequestInit = {}, env?: Record<string, string>) => {
  const res = await call(pathname, init, env);
  return { res, body: await json(res) };
};

// ─────────────────────────────────────────────────────────────────────────────
describe("phase2 · health route", () => {
  it("answers under /api, under the /v1 alias and bare, with the envelope", async () => {
    for (const pathname of ["/api/health", "/v1/health", "/health"]) {
      const { res, body } = await okCall(pathname);
      assert.equal(res.status, 200, pathname);
      assert.equal(body.success, true, pathname);
      assert.equal(body.data.service, "kick-live-api", pathname);
      assert.equal(body.data.status, "healthy", pathname);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    }
  });

  it("reports the route census without reporting anything about the deployment's keys", async () => {
    const { body } = await okCall("/api/health");
    assert.ok(body.data.routes.total >= ROUTES.length);
    assert.equal(body.data.routes.implemented, ROUTES.filter((r) => r.implemented).length);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(SERVICE_ROLE_SENTINEL), "service role key must never appear in a response");
    for (const banned of ["SUPABASE_URL", "anon", "eyJ", "ANON_KEY"]) assert.ok(!text.includes(banned), `health payload leaked ${banned}`);
  });

  it("is edge-cacheable while every other route is no-store", async () => {
    const health = await call("/api/health");
    assert.match(health.headers.get("cache-control") ?? "", /s-maxage=60/);
    const me = await call("/api/me");
    assert.equal(me.headers.get("cache-control"), "no-store");
  });

  it("returns 404 NOT_FOUND for an unknown path and 405 for a known path with the wrong method", async () => {
    const missing = await okCall("/api/nope");
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.success, false);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    const wrongMethod = await okCall("/api/health", { method: "DELETE" });
    assert.equal(wrongMethod.res.status, 405);
    assert.equal(wrongMethod.body.error.code, "METHOD_NOT_ALLOWED");
  });
});

describe("phase2 · /api/me authentication", () => {
  it("401s an anonymous caller before any handler runs", async () => {
    const { res, body } = await okCall("/api/me");
    assert.equal(res.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  });

  it("leaves declared public reads anonymous-reachable: 501 for the route, never 401", async () => {
    // `public.read` is the one capability an anonymous principal holds, so a declared-but-unbuilt
    // public route must say "not implemented". Making it 401 would advertise that the route is private
    // and push public reads through a token they do not need.
    const { res, body } = await okCall("/api/media/feed");
    assert.equal(res.status, 501);
    assert.equal(body.error.code, "NOT_IMPLEMENTED");
    const fixtures = await okCall("/api/matches");
    assert.equal(fixtures.res.status, 501);
  });

  it("derives the response code from the matrix, not from a per-route guess", async () => {
    const { authorizeForRoute } = await import("../../workers/src/middleware/authorization.ts");
    const { ANONYMOUS } = await import("../../workers/src/middleware/auth.ts");
    assert.doesNotThrow(() => authorizeForRoute(ANONYMOUS, "public.read"), "public reads stay direct");
    assert.throws(
      () => authorizeForRoute(ANONYMOUS, "profile.read_own"),
      (err: unknown) => err instanceof ApiError && err.status === 401 && err.code === "UNAUTHENTICATED",
    );
    assert.throws(
      () => authorizeForRoute(ANONYMOUS, "identity.grant_role"),
      (err: unknown) => err.status === 401,
    );
    const fan = { ...ANONYMOUS, userId: USER_ID, role: "fan" as const };
    assert.throws(
      () => authorizeForRoute(fan, "match_control.write"),
      (err: unknown) => err.status === 403 && err.code === "FORBIDDEN",
    );
    assert.doesNotThrow(() => authorizeForRoute(fan, "public.read"));
    const admin = { ...fan, role: "admin" as const };
    for (const capability of ["identity.grant_role", "admin.audit_read", "match_control.finalize", "notifications.broadcast"] as const) {
      assert.doesNotThrow(() => authorizeForRoute(admin, capability), capability);
    }
    // One message for every refusal, so probing routes cannot enumerate who holds what.
    const denied = await okCall("/api/admin/audit", { headers: { authorization: "Bearer whatever" } });
    assert.ok(denied.res.status === 401 || denied.res.status === 403);
    assert.ok(typeof denied.body.error.message === "string");
  });

  it("returns role and capabilities read from the profile row", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: () => profileResponse({ id: USER_ID, email: "ops@kicklive.test", username: "ops", role: "media" }) }], async () => {
      const { res, body } = await okCall("/api/me", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      assert.equal(body.data.userId, USER_ID);
      assert.equal(body.data.role, "media", "role must come from the profiles row");
      assert.deepEqual(body.data.email, "ops@kicklive.test");
      assert.ok(body.data.capabilities.includes("media.publish"));
      assert.ok(!body.data.capabilities.includes("identity.grant_role"));
      assert.ok(res.headers.get("x-request-id"), "every response carries a correlation id");
    });
  });

  it("rejects a tampered signature, an unexpected algorithm, an expired token and a foreign audience", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const good = await signedToken({ sub: USER_ID, exp: future });
    const [head, payload] = good.split(".");

    const cases: { label: string; token: string }[] = [
      { label: "tampered signature", token: `${head}.${payload}.${b64url("nope-nope-nope-nope-nope-nope")}` },
      { label: "alg none", token: `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${payload}.` },
      { label: "expired", token: await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) - 60 }) },
      { label: "future iat", token: await signedToken({ sub: USER_ID, iat: Math.floor(Date.now() / 1000) + 3600, exp: future }) },
      { label: "wrong audience", token: await signedToken({ sub: USER_ID, exp: future, aud: "service_role" }) },
      { label: "no subject", token: await signedToken({ exp: future }) },
      { label: "not a jwt", token: "just-a-string" },
    ];

    for (const c of cases) {
      const { res, body } = await okCall("/api/me", { headers: { authorization: `Bearer ${c.token}` } });
      assert.equal(res.status, 401, c.label);
      assert.equal(body.error.code, "UNAUTHENTICATED", c.label);
      assert.ok(!JSON.stringify(body).includes("atob"), c.label);
    }
  });

  it("401s a valid token whose profile row is gone (fail closed, no anonymous fallback)", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: () => profileResponse(null) }], async () => {
      const { res, body } = await okCall("/api/me", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
      assert.equal(body.error.code, "UNAUTHENTICATED");
    });
  });

  it("reads the profile with the caller's own token, never with the service role", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    let seenAuthorization = "";
    await withSupabase(
      [
        {
          match: "/rest/v1/profiles",
          respond: (init) => {
            seenAuthorization = String(new Headers(init.headers as HeadersInit).get("authorization") ?? "");
            return profileResponse({ id: USER_ID, email: null, username: null, role: "fan" });
          },
        },
      ],
      async () => {
        await call("/api/me", { headers: { authorization: `Bearer ${token}` } });
        assert.equal(seenAuthorization, `Bearer ${token}`, "RLS must apply as the caller on identity reads");
        assert.ok(!seenAuthorization.includes(SERVICE_ROLE_SENTINEL));
      },
    );
  });
});

describe("phase2 · authorization runs before the 501 stub", () => {
  it("a fan on a declared admin route gets 403, not 501 — even when the body claims otherwise", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: () => profileResponse({ id: USER_ID, email: null, username: null, role: "fan" }) }], async () => {
      const { res, body } = await okCall("/api/admin/users/" + USER_ID + "/role", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: "admin" }),
      });
      assert.equal(res.status, 403);
      assert.equal(body.error.code, "FORBIDDEN");
      assert.notEqual(body.error.code, "NOT_IMPLEMENTED", "an unbuilt route must not answer a caller it should have refused");
    });
  });

  it("an admin on the same unbuilt route gets 501 with the phase that owns it", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: () => profileResponse({ id: USER_ID, email: null, username: null, role: "admin" }) }], async () => {
      const { res, body } = await okCall("/api/admin/users/" + USER_ID + "/role", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      assert.equal(res.status, 501);
      assert.equal(body.error.code, "NOT_IMPLEMENTED");
      assert.match(body.error.message, /phase \d/);
    });
  });

  it("the matrix has no route where a self-asserted role could slip through", () => {
    // Role claims are not read anywhere in the Worker: only `sub` from a verified token matters.
    const workerSource = ["index.ts", "middleware/auth.ts", "middleware/authorization.ts"].map((f) => codeOf(`workers/src/${f}`)).join("\n");
    assert.ok(!/request.*body.*role/i.test(workerSource), "no worker file may read a role out of a request body");
    assert.ok(!capabilitiesFor("fan").includes("identity.grant_role"));
    assert.ok(!roleHasCapability(null, "match_control.write"));
    assert.ok(roleHasCapability(null, "public.read"), "public reads stay public so the SPA need not proxy them");
  });

  it("resource-level checks exist and filter by owner, not just by role", () => {
    const source = codeOf("workers/src/services/teamAccess.ts");
    assert.match(source, /owner_id/);
    assert.match(source, /principal\.role !== "team_manager"/);
    const route = ROUTES.find((r) => r.pattern === "/teams/mine");
    assert.ok(route && route.implemented, "/teams/mine is the implemented demonstration");
    assert.match(read("workers/src/routes/teams.ts"), /role !== "team_manager" && role !== "admin"/);
    assert.match(read("workers/src/routes/teams.ts"), /supabaseAsUser\(ctx\.env, token\)/, "the read must run as the caller, not as the service role");
  });
});

describe("phase2 · input validation", () => {
  it("rejects unknown body fields before a handler sees them", () => {
    const fields = new Fields({ score: 1, role: "admin" }, ["score"]);
    assert.throws(
      () => fields.assertOnlyDeclared(),
      (err: unknown) => err instanceof ApiError && err.code === "VALIDATION_FAILED" && err.fields?.[0]?.field === "role",
    );
  });

  it("rejects wrong types, missing required fields, bad enums, bad ids and out-of-range numbers", () => {
    const check = (source: Record<string, unknown>, run: (f: Fields) => unknown, field: string) => {
      const fields = new Fields(source, Object.keys(source));
      run(fields);
      assert.ok(
        fields.errors.some((e) => e.field === field),
        `${field} should have been rejected: ${JSON.stringify(fields.errors)}`,
      );
    };
    check({ minute: "ten" }, (f) => f.minute("minute", { required: true }), "minute");
    check({ minute: 131 }, (f) => f.minute("minute", { required: true }), "minute");
    check({ home_score: 2.5 }, (f) => f.score("home_score", { required: true }), "home_score");
    check({ home_score: -1 }, (f) => f.score("home_score", { required: true }), "home_score");
    check({ event_type: "hand_of_god" }, (f) => f.enumValue("event_type", MATCH_EVENT_TYPES, { required: true }), "event_type");
    check({ status: "almost_final" }, (f) => f.enumValue("status", MATCH_STATUSES, { required: true }), "status");
    check({ match_id: "1; DROP TABLE" }, (f) => f.rowId("match_id", { required: true }), "match_id");
    check({ user_id: "not-a-uuid" }, (f) => f.uuid("user_id", { required: true }), "user_id");
    check({ kickoff_at: "2026-13-45" }, (f) => f.timestamp("kickoff_at", { required: true }), "kickoff_at");
    check({}, (f) => f.string("reason", { required: true, min: 20 }), "reason");
    check({ headline: "x".repeat(300) }, (f) => f.string("headline", { max: 120 }), "headline");
    check({ publish: "yes" }, (f) => f.boolean("publish"), "publish");
  });

  it("accepts legitimate values, including 94th-minute stoppage time and a date-only kickoff", () => {
    const fields = new Fields({ minute: 94, home_score: 3, status: "live", kickoff_at: "2026-09-12", headline: "  Late drama  " }, ["minute", "home_score", "status", "kickoff_at", "headline"]);
    assert.equal(fields.minute("minute", { required: true }), 94);
    assert.equal(fields.score("home_score", { required: true }), 3);
    assert.equal(fields.enumValue("status", MATCH_STATUSES, { required: true }), "live");
    assert.equal(fields.timestamp("kickoff_at", { required: true }), new Date("2026-09-12T00:00:00.000Z").toISOString());
    assert.equal(fields.string("headline", { max: 120 }), "Late drama");
    assert.deepEqual(fields.errors, []);
  });

  it("bounds the body and refuses malformed JSON at the reader", async () => {
    const huge = new Request("https://api.kicklive.test/api/media", { method: "POST", body: "x".repeat(70 * 1024) });
    await assert.rejects(
      () => readJsonBody(huge, ["title"]),
      (err: unknown) => err instanceof ApiError && err.code === "PAYLOAD_TOO_LARGE" && err.status === 413,
    );

    const notJson = new Request("https://api.kicklive.test/api/media", { method: "POST", body: "{oops" });
    await assert.rejects(
      () => readJsonBody(notJson, ["title"]),
      (err: unknown) => err instanceof ApiError && err.code === "BAD_REQUEST",
    );

    const isArray = new Request("https://api.kicklive.test/api/media", { method: "POST", body: "[1,2]" });
    await assert.rejects(
      () => readJsonBody(isArray, ["title"]),
      (err: unknown) => err instanceof ApiError && err.code === "BAD_REQUEST",
    );
  });

  it("validates query parameters with the same rules, so `?limit=` cannot be weaponised", () => {
    assert.throws(
      () => readQuery(new URL("https://x/api/matches?debug=true"), ["limit"]),
      (err: unknown) => err instanceof ApiError && err.code === "VALIDATION_FAILED",
    );
    const fields = readQuery(new URL("https://x/api/matches?limit=25&status=live"), ["limit", "status"]);
    assert.equal(fields.integer("limit", { min: 1, max: 100 }), 25);
    assert.equal(fields.enumValue("status", MATCH_STATUSES), "live");
    assert.throws(
      () => {
        const over = readQuery(new URL("https://x/api/matches?limit=99999"), ["limit"]);
        over.integer("limit", { min: 1, max: 100 });
        over.throwIfInvalid();
      },
      (err: unknown) => err instanceof ApiError && err.code === "VALIDATION_FAILED",
    );
  });

  it("mirrors the schema CHECK lists exactly — the API cannot be looser than the database", () => {
    const sql = read("KICKLIVE_FINAL_SCHEMA.sql");
    const checkList = (marker: string): string[] => {
      const start = sql.indexOf(marker);
      assert.ok(start > 0, `${marker} not found in the schema`);
      const inner = sql.slice(start + marker.length, sql.indexOf("))", start));
      return [...inner.matchAll(/'([a-z_]+)'/g)].map((m) => String(m[1]));
    };
    const sorted = (values: readonly string[]): string[] => [...values].sort();
    // `matches.status` needs an anchored regex: `teams.status` and `access_requests.status` carry the
    // same `CHECK (status IN (` shape, and reading the wrong one would make this test agree with a bug.
    const matchStatus = /status\s+TEXT\s+DEFAULT\s+'scheduled'\s+CHECK \(status IN \(([\s\S]*?)\)\)/.exec(sql);
    assert.ok(matchStatus, "matches.status CHECK not found");
    const statusValues = [...String(matchStatus[1]).matchAll(/'([a-z_]+)'/g)].map((m) => String(m[1]));
    assert.deepEqual(sorted(MATCH_STATUSES), sorted(statusValues), "matches.status");
    assert.deepEqual(sorted(MATCH_EVENT_TYPES), sorted(checkList("CHECK (event_type IN (")), "match_events.event_type");
    assert.deepEqual(sorted(GOAL_TYPES), sorted(checkList("CHECK (goal_type IN (")), "match_events.goal_type");
    assert.deepEqual(sorted(REQUESTABLE_ROLES), ["media", "team_manager"], "admin must never be requestable");
    assert.ok(!MATCH_EVENT_TYPES.includes("penalty_scored" as never), "a name the schema does not have must not be accepted");
  });
});

describe("phase2 · CORS", () => {
  it("preflight from an allowed origin echoes it, with methods, headers and a max age", async () => {
    const res = await call("/api/me", { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /turnstile-token/);
    assert.equal(res.headers.get("access-control-max-age"), "600");
    assert.equal(res.headers.get("access-control-allow-credentials"), null, "bearer-token API must never allow credentials");
  });

  it("preflight from an unknown origin is a 204 with no CORS headers at all", async () => {
    const res = await call("/api/me", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 204);
    for (const header of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]) assert.equal(res.headers.get(header), null, header);
  });

  it("a `null` origin (sandboxed iframe, file://) is refused rather than echoed", async () => {
    const res = await call("/api/health", { headers: { origin: "null" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("actual responses echo the origin only for configured hosts, and never a wildcard", async () => {
    const allowed = await call("/api/health", { headers: { origin: ALLOWED_ORIGIN } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(allowed.headers.get("vary"), "origin");

    const denied = await call("/api/health", { headers: { origin: "https://kicklive.football" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    for (const env of [envWith({ ALLOWED_ORIGINS: "*" }), envWith({ ALLOWED_ORIGINS: "" })]) {
      assert.deepEqual(allowedOrigins(env as never), [], '`*` and empty must both mean "no cross-origin access"');
      const res = await call("/api/health", { headers: { origin: ALLOWED_ORIGIN } }, env);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
  });

  it("the source never writes a wildcard, and there is no second CORS implementation", () => {
    const corsSource = codeOf("workers/src/middleware/cors.ts");
    assert.ok(!corsSource.includes('"*"'), "no literal wildcard in the CORS middleware");
    const allWorkers = fs.readdirSync(path.join(REPO, "workers/src/middleware")).filter((f) => f.endsWith(".ts"));
    assert.ok(allWorkers.includes("cors.ts"));
    const indexSource = codeOf("workers/src/index.ts");
    assert.match(indexSource, /from "\.\/middleware\/cors\.ts"/, "the entry point must use the module, not re-implement it");
  });
});

describe("phase2 · rate-limit architecture", () => {
  it("blocks inside the window and reports the store it used", async () => {
    resetRateLimitMemory();
    const limiter = createRateLimiter({} as never);
    const budget = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) assert.equal((await limiter.check("test:route", budget)).allowed, true, `call ${String(i)}`);
    const blocked = await limiter.check("test:route", budget);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
    assert.equal(blocked.store, "memory", "an unshared counter must be labelled, not presented as a defence");
    resetRateLimitMemory();
  });

  it("buckets by identity when authenticated and by IP when not", () => {
    const route = "POST /api/media";
    assert.equal(limitKeyFor(route, "mutation", USER_ID, "1.2.3.4"), `mutation:${route}:${USER_ID}`);
    assert.equal(limitKeyFor(route, "mutation", null, "1.2.3.4"), `mutation:${route}:ip:1.2.3.4`);
  });

  it("every write route declares a budget class, and credential exchange is the strictest", () => {
    const writes = ROUTES.filter((r) => r.method !== "GET");
    assert.ok(writes.length >= 10);
    for (const route of writes) assert.ok(route.rateLimit, `${route.method} ${route.pattern} declares no rateLimit class`);
    assert.equal(ROUTES.find((r) => r.pattern === "/auth/sign-up")?.rateLimit, "auth-exchange");
    assert.equal(ROUTES.find((r) => r.pattern === "/admin/notifications/broadcast")?.rateLimit, "admin-blast");
    assert.ok(BUDGETS["auth-exchange"].limit <= 10 && BUDGETS["auth-exchange"].windowSeconds >= 300);
    assert.ok(BUDGETS.public.limit >= 300, "public reads must not punish a page load");
    for (const route of ROUTES.filter((r) => r.method === "GET" && r.cache === "private")) assert.equal(route.rateLimit, "authenticated", route.pattern);
  });
});

describe("phase2 · production error handling", () => {
  const upstreamFailure = () =>
    new Response(JSON.stringify({ message: 'column "phone_hash" does not exist', details: "Perhaps you meant profiles.phone", hint: "check the schema", code: "42703" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

  it("production responses carry a code and a message and nothing else", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: upstreamFailure }], async () => {
      const { res, body } = await okCall("/api/me", { headers: { authorization: `Bearer ${token}` } }, envWith({ APP_ENV: "production" }));
      assert.equal(res.status, 502);
      assert.equal(body.error.code, "DEPENDENCY_FAILED");
      const text = JSON.stringify(body);
      for (const banned of ["42703", "phone_hash", "profiles.phone", "stack", "at ", "SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_SENTINEL]) {
        assert.ok(!text.includes(banned), `production response leaked ${banned}`);
      }
      assert.equal(body.error.detail, undefined);
    });
  });

  it("staging and development keep the detail, because that is where it is actionable", async () => {
    const token = await signedToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
    await withSupabase([{ match: "/rest/v1/profiles", respond: upstreamFailure }], async () => {
      for (const APP_ENV of ["development", "staging"]) {
        const { body } = await okCall("/api/me", { headers: { authorization: `Bearer ${token}` } }, envWith({ APP_ENV }));
        assert.match(body.error.detail ?? "", /42703/, APP_ENV);
      }
    });
  });

  it("an unexpected throw is still an envelope, never a stack trace", async () => {
    const res = await call("/api/me", { headers: { authorization: "Bearer not-a-jwt-at-all" } });
    const body = await json(res);
    assert.equal(body.success, false);
    assert.equal(typeof body.error.code, "string");
    assert.ok(!/at .*\.ts:\d+/.test(JSON.stringify(body)), "no source frames in the response");
    assert.match(res.headers.get("x-content-type-options") ?? "", /nosniff/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  it("only one key file may read the service-role secret, and it is not exposed anywhere", () => {
    const users = fs
      .readdirSync(path.join(REPO, "workers/src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    const reading = users.filter((f) => codeOf(path.join("workers/src", f)).includes("SUPABASE_SERVICE_ROLE_KEY"));
    assert.deepEqual(reading.sort(), ["env.ts", "services/supabase.ts"], "service-role access must stay in one module");
    assert.ok(!read("workers/wrangler.toml").match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=/m));
    assert.ok(!codeOf("workers/src/lib/response.ts").includes("stack"));
  });
});

describe("phase2 · environment separation", () => {
  it("the Worker refuses to build a client when URL and ref disagree", () => {
    assert.equal(assertSupabaseUrl(envWith() as never), "https://testref.supabase.co");
    assert.throws(
      () => assertSupabaseUrl(envWith({ SUPABASE_PROJECT_REF: "otherref" }) as never),
      (err: unknown) => err instanceof ApiError && err.code === "INTERNAL_ERROR" && /testref/.test(err.message),
    );
    assert.throws(
      () => assertSupabaseUrl(envWith({ SUPABASE_URL: "http://testref.supabase.co" }) as never),
      (err: unknown) => err instanceof ApiError && /https/.test(err.message),
    );
    assert.throws(
      () => assertSupabaseUrl(envWith({ SUPABASE_URL: "not a url" }) as never),
      (err: unknown) => err instanceof ApiError,
    );
  });

  it("wrangler.toml has three environments and no bindings for infra that does not exist yet", () => {
    const toml = read("workers/wrangler.toml");
    const active = toml
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    assert.ok(
      active.some((l) => l === "[env.staging]"),
      "staging environment",
    );
    assert.ok(
      active.some((l) => l === "[env.production]"),
      "production environment",
    );
    assert.ok(
      active.some((l) => l === "[vars]"),
      "development is the default block",
    );
    assert.deepEqual(
      active.filter((l) => /^\[\[(d1_databases|r2_buckets|queues\.\w+|kv_namespaces)\]\]|^\[durable_objects\]/.test(l)),
      [],
      "no unused bindings may be active",
    );
    assert.ok(!active.some((l) => /^ALLOWED_ORIGINS\s*=\s*"\*"/.test(l)));
    assert.ok(!/(eyJ[A-Za-z0-9_-]{20,})/.test(toml), "no real-looking key in the committed config");
    assert.ok(toml.includes("SUPABASE_PROJECT_REF"));
  });

  it("local secrets are git-ignored, and no worker source contains a credential", () => {
    assert.match(read(".gitignore"), /^workers\/\.dev\.vars$/m);
    assert.deepEqual(scanSource(REPO), [], "check-secrets must find nothing in src, workers/src or the shipped dirs");
  });

  it("the frontend refuses a remote API in dev and a localhost API in prod", () => {
    const rules = (over: Partial<Record<"raw" | "dev" | "prod" | "allowRemote", string | boolean>>) => ({ raw: "", dev: true, prod: false, allowRemote: false, ...over });
    assert.equal(resolveApiBaseUrl(rules({})), "", "empty means same-origin /api");
    assert.equal(resolveApiBaseUrl(rules({ raw: "http://127.0.0.1:8787/" })), "http://127.0.0.1:8787", "a local Worker is the normal dev setup");
    assert.throws(
      () => resolveApiBaseUrl(rules({ raw: "https://api.kicklive.football" })),
      (err: unknown) => err instanceof ConfigError && /dev server/.test((err as Error).message),
    );
    assert.equal(resolveApiBaseUrl(rules({ raw: "https://api.kicklive.football", allowRemote: true })), "https://api.kicklive.football", "explicit opt-in is allowed and visible");
    assert.throws(
      () => resolveApiBaseUrl(rules({ raw: "https://api.kicklive.football/api" })),
      (err: unknown) => err instanceof ConfigError && /no path/.test((err as Error).message),
    );
    assert.throws(
      () => resolveApiBaseUrl(rules({ raw: "http://localhost:8787", dev: false, prod: true })),
      (err: unknown) => err instanceof ConfigError && /production/.test((err as Error).message),
    );
    assert.equal(resolveApiBaseUrl(rules({ raw: "https://api.kicklive.football", dev: false, prod: true })), "https://api.kicklive.football");
  });

  it("the Vite dev server proxies /api to the local Worker, so dev has no remote default", () => {
    const vite = read("vite.config.ts");
    assert.match(vite, /proxy: \{\s*"\/api"/);
    assert.match(vite, /127\.0\.0\.1:8787/);
  });

  it("the route table has no duplicates and documents only routes that exist", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.pattern}`);
    assert.equal(new Set(keys).size, keys.length, "one handler per method+pattern; no parallel implementations");
    for (const listed of RATE_LIMITED_BY_DEFAULT) assert.ok(keys.includes(listed), `${listed} is documented as rate-limited but is not a route`);
    assert.equal(ROUTES.filter((r) => r.implemented).length, 3, "phase 2 implements health, /me and /teams/mine, nothing else");
    // Documentation is part of the contract: the README's route map is generated from this table, and a
    // hand-edited copy is how a doc starts promising routes that were never built.
    const declared = (read("workers/README.md").match(/^\| `(GET|POST|PUT|PATCH|DELETE) /gm) ?? []).length;
    assert.equal(declared, ROUTES.length, "workers/README.md route map is stale — run `npm run worker:routes`");
  });
});

describe("phase2 · frontend api client", () => {
  const stubFetch = (respond: (url: string, init: RequestInit) => Response): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetch: ((input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Promise.resolve(respond(String(input), init ?? {}));
      }) as unknown as typeof fetch,
    };
  };

  it("prefixes /api, sends the bearer token and unwraps the envelope", async () => {
    const fetchStub = stubFetch(() => new Response(JSON.stringify({ success: true, data: { ok: 1 }, requestId: "req-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ baseUrl: "http://127.0.0.1:8787", getToken: async () => "tok123", fetchImpl: fetchStub.fetch });
    const result = await client.get<{ ok: number }>("me", { query: { limit: 5, empty: "", skip: undefined, tags: ["a", "b"] } });
    assert.equal(result.ok, true);
    assert.deepEqual(fetchStub.calls[0]?.url, "http://127.0.0.1:8787/api/me?limit=5&tags=a&tags=b");
    const headers = new Headers(fetchStub.calls[0]?.init.headers as HeadersInit);
    assert.equal(headers.get("authorization"), "Bearer tok123");
    assert.equal(headers.get("accept"), "application/json");
    assert.ok(headers.get("x-request-id"));
    if (result.ok) assert.equal(result.requestId, "req-1");
  });

  it("sends no authorization header for an anonymous caller, and JSON only when there is a body", async () => {
    const fetchStub = stubFetch(() => new Response(JSON.stringify({ success: true, data: null }), { status: 200 }));
    const client = createApiClient({ getToken: async () => null, fetchImpl: fetchStub.fetch });
    await client.post("/matches/1/finalize");
    const headers = new Headers(fetchStub.calls[0]?.init.headers as HeadersInit);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("content-type"), null);
    assert.equal(fetchStub.calls[0]?.url, `${API_ROOT}/matches/1/finalize`);
  });

  it("surfaces a 400 as a field map instead of throwing, so the form can render it", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "VALIDATION_FAILED",
              message: "2 field(s) in the request are not valid.",
              fields: [
                { field: "minute", message: "must be 130 or less" },
                { field: "event_type", message: "must be one of: goal, ..." },
              ],
            },
          }),
          { status: 400 },
        ),
    );
    const client = createApiClient({ fetchImpl: fetchStub.fetch });
    const result = await client.post("/matches/1/events", { minute: 400, event_type: "nope" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "VALIDATION_FAILED");
    assert.deepEqual(fieldErrors(result), { minute: "must be 130 or less", event_type: "must be one of: goal, ..." });
  });

  it("turns an HTML edge failure into a readable error, not a parse crash", async () => {
    for (const [status, body, expectCode] of [
      [502, "<html><body>bad gateway</body></html>", "DEPENDENCY_FAILED"],
      [429, JSON.stringify({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests." } }), "RATE_LIMITED"],
      [500, "boom", "INTERNAL_ERROR"],
    ] as [number, string, string][]) {
      const client = createApiClient({ fetchImpl: stubFetch(() => new Response(body, { status, headers: { "retry-after": status === 429 ? "30" : "" } })).fetch });
      const result = await client.get("/health");
      assert.equal(result.ok, false, `HTTP ${String(status)}`);
      if (result.ok) continue;
      assert.equal(result.code, expectCode, `HTTP ${String(status)}`);
      assert.ok(result.message.length > 10 && !result.message.includes("<html>"), `HTTP ${String(status)} message: ${result.message}`);
      if (status === 429) assert.equal(result.retryAfterSeconds, 30);
    }
  });

  it("retries once with a freshly-read token when the first attempt 401s", async () => {
    let token = "stale";
    const seen: (string | null)[] = [];
    const fetchStub = stubFetch((_url, init) => {
      const sent = new Headers(init.headers as HeadersInit).get("authorization");
      seen.push(sent);
      return sent === "Bearer fresh"
        ? new Response(JSON.stringify({ success: true, data: { role: "fan" } }), { status: 200 })
        : new Response(JSON.stringify({ success: false, error: { code: "UNAUTHENTICATED", message: "Access token has expired." } }), { status: 401 });
    });
    const client = createApiClient({
      // The client re-reads `getToken` on the retry, which is what makes a session refreshed
      // between render and click recover instead of logging the user out.
      getToken: () => Promise.resolve(token),
      fetchImpl: fetchStub.fetch,
    });
    const pending = client.get("/me");
    token = "fresh";
    const result = await pending;
    assert.equal(fetchStub.calls.length, 2, "exactly one retry, not a loop");
    assert.deepEqual(seen, ["Bearer stale", "Bearer fresh"]);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data, { role: "fan" });
  });

  it("aborts a hung Worker instead of pinning a spinner, and respects an external signal", async () => {
    const client = createApiClient({
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
        })) as unknown as typeof fetch,
    });
    const result = await client.get("/health");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TIMEOUT");
    assert.equal(result.status, 0);

    const external = new AbortController();
    external.abort();
    const cancelled = await createApiClient({ fetchImpl: (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch }).get("/health", { signal: external.signal });
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.match(cancelled.message, /cancelled/i);
  });

  it("mirrors the Worker's payload fields exactly", () => {
    const workerTypes = read("workers/src/types/api.ts") + "\n" + read("workers/src/services/profiles.ts");
    const clientTypes = read("src/lib/api/types.ts");
    const fieldsOf = (source: string, name: string): string[] => {
      const start = source.indexOf(`interface ${name}`);
      assert.ok(start >= 0, `${name} not found`);
      const block = source.slice(start, source.indexOf("}", start));
      return [...block.matchAll(/^\s{2}(\w+)(\?)?:/gm)].map((m) => String(m[1])).sort();
    };
    assert.deepEqual(fieldsOf(clientTypes, "HealthData"), fieldsOf(workerTypes, "HealthData"));
    assert.deepEqual(fieldsOf(clientTypes, "MeData"), fieldsOf(workerTypes, "SafeProfile"), "the SPA must not invent or drop identity fields");
    assert.deepEqual(fieldsOf(clientTypes, "ManagedTeamsData"), fieldsOf(workerTypes, "ManagedTeamsData"));

    const workerCodes = read("workers/src/lib/response.ts");
    const clientCodes = codeOf("src/lib/api/types.ts");
    for (const code of [...workerCodes.matchAll(/^\s{2}\| "([A-Z_]+)"$/gm)].map((m) => String(m[1]))) {
      assert.ok(clientCodes.includes(`"${code}"`), `client is missing error code ${code}`);
    }
  });
});
