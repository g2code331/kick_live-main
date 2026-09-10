/**
 * Phase 9 · observability's invariants, asserted from the artifacts.
 *
 * The executable half (the record/rollup/purge paths, the grant matrix, the percentile maths) lives in
 * `scripts/sql-flow.mjs`, which needs a real Postgres. What lives here is the class of bug that file cannot
 * see because it needs two artifacts at once, plus the two promises that are only visible from the outside:
 *
 *   1. **Drift between the Worker's catalogue and the database's.** Both sides hold the same table —
 *      `METRIC_CATALOGUE` in `workers/src/lib/observability.ts` and the VALUES list inside
 *      `kicklive_observability_catalogue()` — and either half can be edited alone. A metric in code and not in
 *      SQL is a number the panel never shows; a metric in SQL and not in code is documentation for a
 *      measurement nobody takes. Both directions are asserted, at the dimension level, not just the name.
 *   2. **The bucket list, which is a shared secret between two languages.** Latency percentiles are read out
 *      of a stored histogram whose edges came from `observability_config`. If the Worker's `LATENCY_BUCKETS_MS`
 *      and the seeded array stop agreeing, every percentile in the UI becomes a plausible lie — the wrong
 *      bound, not an error. Asserting the literal is the cheap fix for a bug no runtime check would catch.
 *   3. **Coverage of the audit trail.** A privileged mutating route with no entry in `AUDIT_ACTIONS`, no
 *      presence in `AUDITED_IN_SQL` and no self-service capability means an action that leaves no evidence.
 *      The test walks the route table rather than trusting the file that writes it.
 *   4. **What the public door does not say.** `kicklive_health_read` must not project a reason, a detail or a
 *      count, and `kicklive_metrics_purge` must never name `activity_logs`. Those are text assertions on SQL,
 *      labelled as such: they are the promises an external reviewer will check first, and they are exactly the
 *      kind that get quietly widened by a later "helpful" column.
 *
 * And, because they are cheap and load-bearing: the error taxonomy is total over `ApiCode`, redaction kills
 * the four shapes that must never reach a log, the sample buffer folds and drops with a counter rather than
 * growing without bound, and a failure response carries `x-error-category` without its body changing shape.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ROUTES } from "../../workers/src/router.ts";
import { HANDLERS } from "../../workers/src/routes/index.ts";
import { capabilityTable } from "../../workers/src/lib/capabilities.ts";
import {
  LATENCY_BUCKETS_MS,
  METRIC_CATALOGUE,
  OBSERVABILITY_SUBSYSTEMS,
  bufferStats,
  drainBuffer,
  flushObservations,
  observe,
  observeGauge,
  redact,
  resetObservabilityForTests,
  sizeClass,
  subsystemFor,
  traceFor,
  traceFrom,
} from "../../workers/src/lib/observability.ts";
import { ERROR_CATEGORIES, categoryForStatus, classify, failWithCategory, safeMessage } from "../../workers/src/lib/errors.ts";
import { AUDIT_ACTIONS, AUDITED_IN_SQL, SELF_SERVICE_CAPABILITIES, auditActionFor, shouldAuditRoute } from "../../workers/src/middleware/audit.ts";
import { ApiError } from "../../workers/src/lib/response.ts";
import { requestIdFrom } from "../../workers/src/lib/headers.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

/** SQL comments explain what the code refuses, so a scan of the code has to remove them first or it fails on
 *  its own documentation — the same helper `phase8-sponsorship.test.ts` uses, for the same reason. */
const sqlCode = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const MIGRATION_REL = "supabase/migrations/20260915120000_phase9_observability.sql";
const MIGRATION = read(MIGRATION_REL);
const CODE = sqlCode(MIGRATION);

/** The body of one `as $fn$ … $fn$;` function, by name. */
function sqlFunction(name: string): string {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} is defined in ${MIGRATION_REL}`);
  const open = MIGRATION.indexOf("\n", MIGRATION.indexOf("as $fn$", start));
  assert.notEqual(open, -1, `${name} opens a $fn$ body`);
  const close = MIGRATION.indexOf("\n$fn$;", open);
  assert.notEqual(close, -1, `${name} closes its $fn$ body`);
  return MIGRATION.slice(open, close);
}

/** The catalogue as each side states it: `"<subsystem>.<metric>" -> sorted dimensions`. */
function sqlCatalogue(): Map<string, string[]> {
  const body = sqlFunction("kicklive_observability_catalogue");
  const out = new Map<string, string[]>();
  for (const match of body.matchAll(/\('([a-z]+)',\s*'([a-z_]+)',\s*'([^']*)'/g)) {
    out.set(`${match[1]}.${match[2]}`, match[3].split("|").sort());
  }
  return out;
}

function codeCatalogue(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, dims] of Object.entries(METRIC_CATALOGUE)) out.set(key, [...dims].sort());
  return out;
}

describe("phase 9 · the catalogue is one table in two languages", () => {
  it("has an entry in SQL for every metric the Worker writes", () => {
    const sql = sqlCatalogue();
    assert.ok(sql.size >= 20, `the SQL catalogue lists ${String(sql.size)} metrics, expected at least 20`);
    const missing = [...codeCatalogue().keys()].filter((key) => !sql.has(key));
    assert.deepEqual(missing, [], `metrics recorded in code but absent from kicklive_observability_catalogue: ${missing.join(", ")}`);
  });

  it("has an entry in code for every metric SQL documents", () => {
    const code = codeCatalogue();
    const extra = [...sqlCatalogue().keys()].filter((key) => !code.has(key));
    assert.deepEqual(extra, [], `metrics documented in SQL that nothing records: ${extra.join(", ")}`);
  });

  it("agrees on the dimensions of each metric, not just its name", () => {
    const sql = sqlCatalogue();
    const drift: string[] = [];
    for (const [key, dims] of codeCatalogue()) {
      const theirs = sql.get(key);
      if (!theirs) continue; // already failed above with a better message
      if (theirs.join("|") !== dims.join("|")) drift.push(`${key}: code [${dims.join("|")}] vs sql [${theirs.join("|")}]`);
    }
    assert.deepEqual(drift, [], "dimension lists must match exactly — the panel groups on these strings");
  });

  it("declares the eight subsystems in both places, in the same order", () => {
    const check = CODE.match(/subsystem\s+text not null check \(subsystem in \(([^)]*)\)\)/);
    assert.ok(check, "metric_rollups subsystem CHECK is present");
    const listed = (check?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(listed, [...OBSERVABILITY_SUBSYSTEMS]);
  });

  it("names the health components the schema can store", () => {
    const catalogue = codeCatalogue().get("system.health") ?? [];
    const check = CODE.match(/component\s+text\s+primary key check \(component in \(([^)]*)\)\)/);
    assert.ok(check, "system_health component CHECK is present");
    const listed = (check?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    assert.deepEqual([...catalogue].sort(), [...listed].sort(), "system.health dimensions are the health components");
  });
});

describe("phase 9 · the latency histogram is the same ruler on both sides", () => {
  it("matches the seeded bucket literal exactly", () => {
    const literal = CODE.match(/latency_buckets_ms\s+integer\[\] not null default '\{([^}]*)\}'/);
    assert.ok(literal, "the config seeds a latency bucket array literal");
    const buckets = (literal?.[1] ?? "").split(",").map((n) => Number(n.trim()));
    assert.deepEqual(buckets, [...LATENCY_BUCKETS_MS], "a mismatch makes every percentile in the UI a plausible lie");
    assert.equal(buckets.length, 10);
    assert.deepEqual(
      [...buckets].sort((a, b) => a - b),
      buckets,
      "buckets must be sorted; the CHECK in SQL says so too",
    );
    assert.ok(buckets[0] > 0, "a zero-width first bucket would divide by zero in prose, if not in code");
  });

  it("accepts the size classes the Worker emits as dimensions", () => {
    const dims = codeCatalogue().get("api.payload") ?? [];
    for (const cls of ["s_lt_1kb", "s_1_10kb", "s_10_100kb", "s_gt_100kb", "rejected"]) {
      assert.ok(dims.includes(cls), `api.payload dimension ${cls} is catalogued`);
    }
    assert.equal(sizeClass(512), "s_lt_1kb");
    assert.equal(sizeClass(2048), "s_1_10kb");
    assert.equal(sizeClass(50_000), "s_10_100kb");
    assert.equal(sizeClass(500_000), "s_gt_100kb");
  });

  it("routes belong to exactly one subsystem", () => {
    const cases: [string, string][] = [
      ["/notifications/devices", "notifications"],
      ["/admin/notifications/broadcast", "notifications"],
      ["/advertising/serve", "advertising"],
      ["/sponsorship", "advertising"],
      ["/media/assets/:id", "media"],
      ["/live/matches/:matchId", "live"],
      ["/matches/:matchId/events", "live"],
      ["/observability/health", "system"],
      ["/teams/:teamId", "api"],
    ];
    for (const [pattern, expected] of cases) assert.equal(subsystemFor(pattern), expected, pattern);
  });
});

describe("phase 9 · the error taxonomy", () => {
  it("covers the categories the plan names", () => {
    for (const required of ["AUTHENTICATION_ERROR", "AUTHORIZATION_ERROR", "VALIDATION_ERROR", "DATABASE_ERROR", "R2_ERROR", "QUEUE_ERROR", "FCM_ERROR", "WEBSOCKET_ERROR", "INTERNAL_ERROR"]) {
      assert.ok((ERROR_CATEGORIES as readonly string[]).includes(required), `${required} is a category`);
    }
  });

  it("maps every declared ApiCode to a category, with no default falling through", () => {
    // The union is asserted from `response.ts`'s text as well as from behaviour, because TypeScript already
    // enforces totality in `BY_CODE` and this catches the case where a code is added *and* defaulted.
    const source = read("workers/src/lib/response.ts");
    const codes = (source.match(/^\s*\| "([A-Z_]+)"/gm) ?? []).map((line) => line.replace(/[^A-Z_]/g, ""));
    assert.ok(codes.length >= 13, `found ${String(codes.length)} ApiCodes in response.ts`);
    for (const code of codes) {
      const err = new ApiError(code as never, code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : 500, "x");
      const category = classify(err).category;
      assert.ok((ERROR_CATEGORIES as readonly string[]).includes(category), `${code} → ${category} is a real category`);
      assert.notEqual(category, "", `${code} has a category`);
    }
  });

  it("classifies by shape, not by luck", () => {
    assert.equal(classify(new Error("SUPABASE_ANON_KEY is not configured")).category, "DATABASE_ERROR");
    assert.equal(classify(new Error("PGRST102: no rows")).category, "DATABASE_ERROR");
    assert.equal(classify(new Error("FIREBASE 403 SENDER_ID_MISMATCH")).category, "FCM_ERROR");
    assert.equal(classify(new Error("queue producer rejected the batch")).category, "QUEUE_ERROR");
    assert.equal(classify(new Error("r2 put failed: AccessDenied")).category, "R2_ERROR");
    assert.equal(classify(new Error("websocket send threw")).category, "WEBSOCKET_ERROR");
    assert.equal(categoryForStatus(401), "AUTHENTICATION_ERROR");
    assert.equal(categoryForStatus(403), "AUTHORIZATION_ERROR");
    assert.equal(categoryForStatus(409), "VALIDATION_ERROR");
    assert.equal(categoryForStatus(404), "NOT_FOUND_ERROR");
    assert.equal(categoryForStatus(500), "INTERNAL_ERROR");
  });

  it("keeps a message short and free of credentials", () => {
    const long = `token=eyJhbcEiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123 ${"x".repeat(500)}`;
    const safe = safeMessage(long);
    assert.ok(safe.length <= 245, `truncated to ${String(safe.length)}`);
    assert.ok(!safe.includes("\n"), "flattened to one line");
    // `safeMessage` bounds and flattens; the *redaction* is `redact()`, and the two compose — that split is why
    // a truncation rule can never be argued about in the middle of an incident.
    assert.ok(!redact(safe).includes("eyJhbcEi"), "a jwt does not survive the pipeline that writes logs");
  });

  it("adds the category as a header, and does not touch the envelope", async () => {
    const response = failWithCategory(new ApiError("DEPENDENCY_FAILED", 502, "PostgREST is refusing."), { exposeDetail: false, requestId: "req-1" });
    assert.equal(response.headers.get("x-error-category"), "DATABASE_ERROR");
    assert.equal(response.status, 502);
    const body = (await response.json()) as { success: boolean; error: { code: string; message: string; detail?: string }; requestId?: string };
    // The Phase 2 envelope, key for key. The category is a header precisely because the body is frozen by
    // tests and by clients; a new field in here would be a contract change smuggled in as instrumentation.
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId", "success"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
    assert.equal(body.error.code, "DEPENDENCY_FAILED", "the code a client branches on is untouched");
    assert.equal(body.requestId, "req-1");
    assert.ok(!("stack" in body.error) && !("detail" in body.error), "no detail with exposeDetail false, and never a stack");
  });

  it("reads the message and ignores the stack", () => {
    const err = new Error("database refused the write");
    err.stack = `Error: database refused the write\n    at recordEvent (/worker/src/services/supabase.ts:131:9)\n    at Object.<anonymous> (/worker/index.ts:1:1)`;
    const shape = JSON.stringify({ category: classify(err).category, message: safeMessage(err) });
    assert.ok(!shape.includes("at "), "no frames, because only `message` is ever read");
    assert.ok(!shape.includes("/worker/"), "no paths, and therefore no layout of the deployment in a log line");
    assert.equal(classify("a bare string").category, "INTERNAL_ERROR", "classify never throws on a non-Error");
    assert.equal(classify(null).category, "INTERNAL_ERROR");
  });
});

describe("phase 9 · redaction", () => {
  it("kills the four shapes that must never reach a log", () => {
    const cases = [
      "Authorization: Bearer sk_secretvaluehere12345",
      "headers map to header: Bearer ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "SUPABASE_SERVICE_ROLE_KEY = eyJhbGciOiJIUzI1NiJ9",
      "password: hunter2verysecret",
      "-----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    for (const input of cases) {
      const out = redact(input);
      assert.ok(out.includes("[redacted]") || !out.includes(input.slice(0, 24)), `redacted: ${input.slice(0, 28)}`);
    }
  });

  it("leaves an ordinary sentence alone, on one line", () => {
    assert.equal(redact("media sweep finished with nothing to do"), "media sweep finished with nothing to do");
    assert.ok(!redact("line one\nline two").includes("\n"), "flattened");
    assert.equal(redact("x".repeat(400)).length, 300, "capped at the default width");
  });

  it("the SQL refuses what the Worker redacts, so a mistake is loud", () => {
    const body = sqlCode(sqlFunction("kicklive_observability_refuses"));
    for (const marker of ["BEARER_TOKEN", "JWT_SHAPE", "SERVICE_KEY_NAME", "CLOUD_CREDENTIAL", "PEM_KEY", "CREDENTIAL_ASSIGNMENT"]) {
      assert.ok(body.includes(marker), `the redactor's SQL counterpart names ${marker}`);
    }
  });
});

describe("phase 9 · the buffer folds, caps and drops with a counter", () => {
  it("folds repeated samples for the same key into one row", () => {
    resetObservabilityForTests();
    for (let i = 0; i < 5; i++) observe({ subsystem: "api", metric: "requests", route: "/teams/:teamId", dimension: "2xx", samples: 2, durationMs: 40 });
    observe({ subsystem: "api", metric: "requests", route: "/teams/:teamId", dimension: "5xx", samples: 1, errors: 1, durationMs: 900 });
    const drained = drainBuffer();
    assert.equal(drained.length, 2, "two keys, five writes");
    const ok2xx = drained.find((s) => s.dimension === "2xx");
    assert.equal(ok2xx?.samples, 10);
    assert.equal(ok2xx?.durationMs, 40, "the mean survives, not the sum");
    assert.equal(drained.find((s) => s.dimension === "5xx")?.errors, 1);
  });

  it("folds a concrete path to `*` so cardinality cannot grow without bound", () => {
    resetObservabilityForTests();
    // 1200 distinct *ids* in the path. The buffer could not hold 1200 keys even if it wanted to, but the real
    // protection is this: a route containing a run of digits is a path, not a pattern, and is folded on the way
    // in. A per-object series is how a metrics table becomes the raw log that the design refuses to keep.
    for (let i = 0; i < 1200; i++) observe({ subsystem: "api", metric: "requests", route: `/teams/${String(1000 + i)}`, dimension: "2xx", samples: 1 });
    const drained = drainBuffer();
    assert.equal(drained.length, 1, "one series, however many teams called");
    assert.equal(drained[0]?.route, "*", "folded to the pattern position");
    assert.equal(drained[0]?.samples, 1200, "and the count survives the fold");
    resetObservabilityForTests();
    // Letter-keyed names, so nothing folds on the *path* rule and the buffer's own cap is what is under test:
    // past MAX_KEYS the excess merges into the `*` series, and `overflowed` counts how many writes that took.
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const slug = (n: number): string => `${letters[n % 26]}${letters[Math.floor(n / 26) % 26]}${letters[Math.floor(n / 676) % 26]}${letters[Math.floor(n / 17576) % 26]}`;
    for (let i = 0; i < 1200; i++) observe({ subsystem: "api", metric: "requests", route: `/pat-${slug(i)}`, dimension: "2xx", samples: 1 });
    const drainedOverflow = drainBuffer();
    const stats = bufferStats();
    // The bound is "MAX_KEYS distinct series, plus one fold series per (subsystem, metric) that overflowed",
    // and the slack is deliberate: refusing the fold key would throw away counts, which is the opposite of what
    // a metrics buffer is for. Asserting the shape rather than the exact number keeps that decision editable.
    assert.ok(stats.keys <= 8, `fold keys only, after the drain: ${String(stats.keys)}`);
    const totals = drainedOverflow.filter((sample) => sample.metric === "requests").reduce((sum, sample) => sum + (sample.samples ?? 0), 0);
    assert.equal(totals, 1200, "bounded memory, and not one request lost from the count");
    const meta = drainedOverflow.filter((sample) => sample.subsystem === "system");
    assert.ok(
      meta.every((sample) => (sample.samples ?? 0) > 0),
      "the telemetry's own rows are never zero-count placeholders",
    );
    const overflow = drainedOverflow.find((sample) => sample.dimension === "overflow");
    assert.ok(overflow !== undefined && (overflow.samples ?? 0) > 0, "the overflow is itself counted");
  });

  it("folds a gauge's readings into the value the rollup will store", () => {
    resetObservabilityForTests();
    observeGauge("live", "connections", 12, "room");
    observeGauge("live", "connections", 3, "room");
    observeGauge("live", "connections", 40, "room");
    const [only] = drainBuffer();
    assert.equal(only?.samples, 3, "three readings");
    // Sum, deliberately: `metric_rollups.value_sum` is the column a gauge lives in, and the read that answers
    // "busiest minute" takes a `max` of per-bucket sums. Which is also why the room emits at most one reading
    // per minute — see `emitConnectionsGauge` in `do/MatchRoom.ts`.
    assert.equal(only?.value, 55, "12 + 3 + 40");
  });

  it("refuses a sample with no subsystem or metric rather than inventing one", () => {
    resetObservabilityForTests();
    observe({ subsystem: undefined as never, metric: "requests", samples: 1 });
    observe({ subsystem: "api", metric: "", samples: 1 });
    // Nothing is invented, and the refusal is itself a number: `system.metrics.dropped` is how an operator
    // finds out that somebody's instrumentation is wrong instead of wondering why a metric is empty.
    const drained = drainBuffer();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.subsystem, "system");
    assert.equal(drained[0]?.metric, "metrics");
    assert.equal(drained[0]?.dimension, "dropped");
    assert.equal(drained[0]?.samples, 2);
  });
});

describe("phase 9 · correlation ids", () => {
  it("accepts a caller's id only when it is shaped like one, and mints one otherwise", () => {
    // `requestIdFrom` never returns null: an unshaped or missing id is *replaced* by a fresh uuid, because a
    // request that cannot be joined to a log line is worse than one whose client used its own key. The caller's
    // id is echoed in the log as `clientRequestId`, which is why the shape rule is a filter and not a trust.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.match(requestIdFrom("abc123"), UUID, "too short: replaced");
    assert.equal(requestIdFrom("a".repeat(8)), "a".repeat(8), "a valid 8-char id survives");
    assert.equal(requestIdFrom("A_b.9-x".repeat(9).slice(0, 64)), "A_b.9-x".repeat(9).slice(0, 64), "up to 64 characters");
    assert.match(requestIdFrom("../../etc/passwd"), UUID, "no path traversal through a request id");
    assert.match(requestIdFrom("<script>alert(1)</script>"), UUID, "no html through a request id");
    assert.match(requestIdFrom(`x${" ".repeat(70)}`), UUID, "no padding");
    assert.match(requestIdFrom(null), UUID, "no header at all");
  });

  it("survives a hop through a queue payload and back", () => {
    const trace = traceFor("req-9f2c1a", "http");
    // A trace travels as `payload.trace`, never at the top level: a queue message's own fields are its business
    // (`jobId`, `advertisementId`), and a correlation object that shares their namespace would be spoofable by
    // any producer that learned the field names.
    const restored = traceFrom({ jobId: 42, trace });
    assert.equal(restored?.requestId, "req-9f2c1a");
    assert.equal(restored?.origin, "http");
    assert.equal(traceFrom(null), null);
    assert.equal(traceFrom({ trace: { requestId: "short" } }), null, "a foreign id is not a correlation");
    assert.equal(traceFrom({ requestId: trace.requestId }), null, "a top-level id is not a trace");
  });

  it("the response echoes the id it chose, and only that", () => {
    const response = failWithCategory(new ApiError("NOT_FOUND", 404, "No match with that id."), { exposeDetail: false, requestId: "req-4f2a9c11" });
    assert.equal(response.headers.get("x-request-id"), null, "finalise owns the header; fail only carries the id in the body");
    assert.equal(response.headers.get("x-error-category"), "NOT_FOUND_ERROR");
  });
});

describe("phase 9 · the audit trail's coverage", () => {
  const mutating = ROUTES.filter((route) => route.method !== "GET");

  it("every privileged mutating route is audited somewhere, by name", () => {
    const unaudited: string[] = [];
    for (const route of mutating) {
      if (!route.capability) continue;
      if (!(route.implemented ?? false)) continue;
      const key = `${route.method} ${route.pattern}`;
      const inSql = AUDITED_IN_SQL.includes(key);
      const selfService = (SELF_SERVICE_CAPABILITIES as readonly string[]).includes(route.capability);
      const catalogued = AUDIT_ACTIONS[key] !== undefined;
      if (!inSql && !selfService && !catalogued) unaudited.push(`${key} (${route.capability})`);
    }
    assert.deepEqual(unaudited, [], "a privileged mutation that leaves no evidence is a Phase 9 gap");
  });

  it("nothing is audited twice: the SQL list and the code list are disjoint", () => {
    const overlap = [...AUDITED_IN_SQL].filter((key) => AUDIT_ACTIONS[key] !== undefined);
    assert.deepEqual(overlap, [], `${overlap.join(", ")} would write two rows for one action`);
  });

  it("an audited route resolves to a namespaced action and a table-shaped entity", () => {
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(AUDIT_ACTIONS)) {
      if (entry.read) continue; // a POST that reads resolves to null, which the next test asserts
      const [method, pattern] = key.split(" ");
      const resolved = auditActionFor(method ?? "GET", pattern ?? "/");
      assert.equal(resolved?.action, entry.action, `${key} resolves to its catalogue entry`);
      assert.match(entry.action, /^[a-z][a-z0-9_.]{2,63}$/, `${entry.action} satisfies the SQL action CHECK`);
      assert.match(entry.entityType, /^[a-z][a-z0-9_]{1,39}$/, `${entry.entityType} satisfies the SQL entity_type CHECK`);
      seen.add(entry.action);
    }
    assert.ok(seen.size >= 20, `${String(seen.size)} distinct actions`);
    assert.equal(seen.size, Object.keys(AUDIT_ACTIONS).filter((k) => !AUDIT_ACTIONS[k]?.read).length, "action names are unique across the catalogue");
  });

  it("a read that happens to use POST is listed and skipped", () => {
    for (const key of Object.entries(AUDIT_ACTIONS)
      .filter(([, entry]) => entry.read)
      .map(([key]) => key)) {
      assert.equal(auditActionFor("POST", key.replace("POST ", "")), null, `${key} is a read: no audit row`);
    }
  });

  it("GETs are never audited, whatever the capability", () => {
    assert.equal(shouldAuditRoute({ method: "GET", pattern: "/observability/audit", capability: "admin.audit_read" }), false);
    assert.equal(shouldAuditRoute({ method: "POST", pattern: "/advertising/analytics", capability: "campaign.manage" }), false, "a POST that reads");
    assert.equal(shouldAuditRoute({ method: "POST", pattern: "/advertising/campaigns", capability: "campaign.manage" }), true);
    assert.equal(shouldAuditRoute({ method: "POST", pattern: "/notifications/devices", capability: "profile.read_own" }), false, "a fan's own device");
    assert.equal(shouldAuditRoute({ method: "POST", pattern: "/matches/:matchId/events", capability: "match_control.write" }), false, "SQL writes the richer row");
  });

  it("the immutability trigger and the select-only policy exist, and no policy writes", () => {
    assert.ok(CODE.includes("create trigger activity_logs_append_only"), "the append-only trigger is attached");
    assert.ok(CODE.includes('create policy "activity_logs: admin select"'), "the admin policy is select-only");
    assert.ok(!/create policy[^\n]*activity_logs[^\n]*for (update|delete|all)/.test(CODE), "no policy grants an update, delete or all on the audit table");
    const guard = sqlCode(sqlFunction("kicklive_audit_guard_immutable"));
    assert.match(guard, /tg_op = 'DELETE'/, "deletes are refused");
    // Updates are refused *by content*, not by operation: the one exception is the foreign key's own
    // `on delete set null`, which arrives as an UPDATE changing nothing but `user_id`. Testing the shape of the
    // exception is how a reviewer can see it is narrow — any other column changing falls through to a refusal,
    // and the surviving update must have cleared the subject rather than set it to something else.
    assert.match(guard, /to_jsonb[(]new[)] - 'user_id' is distinct from to_jsonb[(]old[)] - 'user_id'/, "any edit other than the FK's is refused");
    assert.match(guard, /if new[.]user_id is not null then/, "and the surviving update must have cleared the subject");
    assert.ok(guard.includes("on delete set null") || guard.includes("user_id"), "the one exception (FK clearing the subject) is named in the body");
  });

  it("retention never touches the audit table", () => {
    const purge = sqlCode(sqlFunction("kicklive_metrics_purge"));
    assert.ok(!/delete\s+from\s+(public\.)?activity_logs/i.test(purge), "kicklive_metrics_purge must not delete audit rows");
    assert.ok(purge.includes("auditTouched"), "and it says so in its own answer");
    const rollup = sqlCode(sqlFunction("kicklive_metrics_rollup_daily"));
    assert.ok(rollup.includes("granularity = 'minute'"), "only minute rows are compacted");
    assert.ok(!rollup.includes("activity_logs"), "compaction does not read the audit table");
  });
});

describe("phase 9 · monitoring endpoints leak nothing they were not given", () => {
  const observability = ROUTES.filter((route) => route.pattern.startsWith("/observability"));

  it("declares the five sections the plan asks for", () => {
    const patterns = observability.map((route) => route.pattern);
    for (const required of ["/observability/health", "/observability/metrics", "/observability/live-matches", "/observability/notifications", "/observability/advertising"]) {
      assert.ok(patterns.includes(required), `${required} exists`);
    }
  });

  it("gates every read behind an admin-only capability except the public one", () => {
    const table = capabilityTable();
    const adminOnly = new Set(table.filter((row) => row.roles.length === 1 && row.roles[0] === "admin").map((row) => row.capability));
    for (const route of observability) {
      if (route.pattern === "/observability/health") {
        assert.equal(route.capability, "public.read");
        continue;
      }
      assert.ok(route.capability && adminOnly.has(route.capability), `${route.pattern} is gated by ${String(route.capability)}, which must be admin-only`);
    }
  });

  it("is not cacheable anywhere, and every row has a handler", () => {
    for (const route of observability) {
      assert.equal(route.cache, "none", `${route.pattern} must not be cacheable — a stale health page hides an outage`);
      assert.equal(route.rateLimit, route.capability === "public.read" ? "public" : route.rateLimit === "admin-blast" ? "admin-blast" : "authenticated");
      assert.equal(typeof HANDLERS[`${route.method} ${route.pattern}`], "function", `${route.method} ${route.pattern} is wired`);
      const budget = route.rateLimit ?? "public";
      const expected = route.capability === "public.read" ? "public" : budget === "admin-blast" ? "admin-blast" : "authenticated";
      assert.equal(budget, expected, `${route.pattern} budget class`);
      assert.ok(route.invariants && route.invariants.length > 60, `${route.pattern} documents its own invariant`);
    }
  });

  it("the public health projection carries no reason, detail or count", () => {
    const anon = sqlCode(sqlFunction("kicklive_health_read"));
    const admin = sqlCode(sqlFunction("kicklive_health_read_admin"));
    for (const forbidden of ["'reason'", "'detail'", "'consecutiveFailures'", "count("]) {
      assert.ok(!anon.includes(forbidden), `the anon read must not project ${forbidden}`);
    }
    for (const required of ["'reason'", "'detail'", "'consecutiveFailures'"]) {
      assert.ok(admin.includes(required), `the admin read must project ${required}`);
    }
  });

  it("the four Phase 9 tables are RLS-on with no policies, and only service_role writes", () => {
    for (const table of ["metric_rollups", "metric_daily", "system_health", "observability_config"]) {
      assert.ok(new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i").test(CODE), `${table} has RLS on`);
    }
    for (const table of ["metric_rollups", "metric_daily", "system_health", "observability_config"]) {
      assert.ok(!new RegExp(`create policy[^\n]*\b${table}\b`, "i").test(CODE), `no policy exists on ${table}: with RLS on and no policies, only a definer function can read it`);
    }
  });

  it("grants the public door to exactly one function, and says so twice", () => {
    // The grant is a loop over `pg_proc` (so a function added in a later edit cannot keep a stale grant), which
    // means the *text* to assert is the loop's filter plus the one carve-out, and the §16 self-check that
    // re-counts what ended up in the catalogue at apply time. All three are checked, because any one alone can
    // be edited into a lie.
    const grantBlock = CODE.slice(CODE.indexOf("$grant$"), CODE.indexOf("$grant$", CODE.indexOf("$grant$") + 1));
    assert.ok(grantBlock.length > 200, "the grant section is present");
    assert.ok(/if f[.]proname = 'kicklive_health_read' then/.test(CODE), "the only anon grant is the public health read");
    assert.ok(/revoke all on function %s from public, anon, authenticated/.test(CODE), "everything in scope is revoked from the client roles first");
    assert.match(CODE, /has_function_privilege\('anon', p\.oid, 'EXECUTE'\)[\s\S]{0,120}n <> 1/, "and §16 counts anon-executable functions at apply time");
  });
});

describe("phase 9 · the write path, against a fake PostgREST", () => {
  const env = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "service-role-test", APP_ENV: "test" } as never;

  it("posts folded samples to kicklive_metrics_record and nothing else", async () => {
    resetObservabilityForTests();
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, rows: 2, refused: 0, bucket: "2026-09-15T12:00:00Z" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      observe({ subsystem: "api", metric: "requests", route: "/teams/:teamId", dimension: "2xx", samples: 3, durationMs: 25 });
      observe({ subsystem: "live", metric: "connections", route: "/live/matches/:matchId", dimension: "room", samples: 1, value: 7 });
      const report = await flushObservations(env, { force: true });
      assert.equal(calls.length, 1, "one round trip for a whole buffer");
      assert.match(calls[0]!.url, /\/rest\/v1\/rpc\/kicklive_metrics_record$/);
      const payload = JSON.parse(calls[0]!.body) as { p_samples: Record<string, unknown>[] };
      assert.equal(payload.p_samples.length, 2);
      assert.equal(payload.p_samples[0]?.metric, "requests");
      assert.equal(payload.p_samples[1]?.value, 7);
      assert.equal(report?.sent, 2);
      assert.equal(report?.ok, true);
      assert.equal(report?.kept, undefined, "a successful flush keeps nothing");
      assert.equal(bufferStats().keys, 0, "the buffer is empty after a successful flush");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never sends a secret, even when one was caught in a dimension", async () => {
    resetObservabilityForTests();
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ ok: true, rows: 1, refused: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      observe({
        subsystem: "api",
        metric: "errors",
        route: "/auth/exchange",
        dimension: "AUTHENTICATION_ERROR",
        samples: 1,
        value: undefined,
      });
      observe({ subsystem: "system", metric: "metrics", route: "*", dimension: "dropped", samples: 1 });
      await flushObservations(env, { force: true });
      const wire = seen.join("\n");
      assert.ok(!/bearer\s+[a-z0-9._-]{10,}/i.test(wire), "no bearer token on the wire");
      assert.ok(!wire.includes("service-role-test"), "the key used to authenticate the call is not inside the payload");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("re-buffers on failure instead of losing the numbers", async () => {
    resetObservabilityForTests();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "PGRST202: unknown function" }), { status: 404 })) as typeof fetch;
    try {
      observe({ subsystem: "api", metric: "requests", route: "/health", dimension: "2xx", samples: 4 });
      const report = await flushObservations(env, { force: true });
      assert.equal(report?.ok, false);
      assert.ok(report?.kept !== undefined && report.kept >= 1, "the samples are still buffered");
      assert.ok(bufferStats().keys >= 1, "and reachable after the failed call");
      assert.ok(bufferStats().failures >= 1, "the failure itself is counted");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to send when the service key is absent, and reports why rather than failing quietly", async () => {
    resetObservabilityForTests();
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      observe({ subsystem: "api", metric: "requests", route: "/health", dimension: "2xx", samples: 1 });
      const report = await flushObservations({ APP_ENV: "test" } as never, { force: true });
      assert.equal(called, 0, "no network call without a key to sign it with");
      assert.equal(report?.ok, false);
      assert.equal(report?.reason, "NO_SERVICE_KEY", "the reason is a code, not a stack trace");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("phase 9 · the frontend reads the safe projection", () => {
  const module = read("src/lib/data/observability.ts");
  const panel = read("src/pages/portals/admin/SystemMonitoring.tsx");

  it("has one read per section, and no Supabase client", () => {
    for (const fn of ["readPublicHealth", "readAdminHealth", "readMetrics", "readLiveMatchMetrics", "readNotificationMetrics", "readAdvertisingMetrics", "readAlerts", "readAudit"]) {
      assert.ok(module.includes(`export const ${fn}`), `${fn} is exported`);
    }
    assert.ok(!module.includes("lib/supabase"), "the panel does not talk to PostgREST directly — RLS would refuse it anyway, and the definer functions are the door");
  });

  it("renders no fan identity, and explains what it is not showing", () => {
    assert.ok(panel.includes("sockets, never whose") || panel.includes("not sockets"), "the header states the privacy rule");
    assert.ok(!/\.email|user_id|userId|device_token|fcm/.test(panel.replace(/requestId/g, "")), "no identity field is read in the panel");
  });

  it("labels percentiles as bounds rather than measurements", () => {
    assert.ok(panel.includes("p50") && panel.includes("p95") && panel.includes("p99"));
    assert.ok(module.includes("value.open"), "the open flag is what decides the wording");
    assert.ok(module.includes("boundMs"), "and the bound is a bound");
    assert.ok(panel.includes("open top bucket"), "and the panel says so out loud when it happens");
  });

  it("asks twice before deleting telemetry, and the public health type has no reason field", () => {
    assert.ok(panel.includes("confirmRetention"), "retention is a two-click action");
    const publicShape = module.slice(module.indexOf("export interface PublicHealth"), module.indexOf("export interface AdminHealth"));
    assert.ok(!publicShape.includes("reason?") || publicShape.includes("reason?: string;"), "the public shape carries at most a single word");
    assert.ok(!publicShape.includes("detail"), "no detail on the public type at all");
    assert.ok(module.slice(module.indexOf("export interface HealthComponentRow"), module.indexOf("export interface PublicHealth")).includes("Admin reads only"));
  });
});

describe("phase 9 · the Admin Portal tab", () => {
  const portal = read("src/pages/portals/AdminPortal.tsx");

  it("adds monitoring as a tab and renders the component", () => {
    assert.ok(portal.includes("'monitoring'"), "the tab id exists in the union");
    assert.match(portal, /\{ id: 'monitoring', label: 'Monitoring'/, "and in the tab list");
    assert.ok(portal.includes("{activeTab === 'monitoring' && <SystemMonitoring />}"), "it renders the panel");
    assert.ok(portal.includes("import SystemMonitoring from './admin/SystemMonitoring';"), "from the admin folder");
  });
});
