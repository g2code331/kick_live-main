/**
 * The load ladder (spec §7.3's "prove the fallback fires"). Everything is driven through injected
 * `load`/`sleep`, so this runs in milliseconds and asserts the exact log vocabulary the CI smoke
 * test greps for — if the wording changes, this test fails before the pipeline does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_BACKOFF_MS, LOAD_LOG_PATTERNS, MAX_SOURCE_ATTEMPTS, buildLoadPlan, delayFor, describePlan, formatLog, runLoadPlan } from "../../shared/renderer-load.ts";
import type { LoadAttempt } from "../../shared/renderer-load.ts";

type Mode = "always" | "never" | { failFirst: number };

function harness(mode: Mode) {
  const lines: string[] = [];
  const slept: number[] = [];
  const seen: string[] = [];
  let failures = 0;
  const load = async (attempt: LoadAttempt): Promise<void> => {
    seen.push(attempt.target);
    const shouldFail = mode === "never" ? false : mode === "always" ? true : failures < mode.failFirst;
    if (shouldFail) {
      failures += 1;
      throw new Error(`ERR_FILE_NOT_FOUND for ${attempt.label}`);
    }
  };
  const deps = {
    load,
    log: (l: string) => lines.push(l),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
  return { lines, slept, seen, deps };
}

describe("buildLoadPlan", () => {
  it("primary is the asar file:// path, then the loopback server, then the diagnostic page", () => {
    const plan = buildLoadPlan({ rendererIndexPath: "/app/renderer/dist/index.html", httpOrigin: "http://127.0.0.1:4123" });
    assert.deepEqual(
      plan.sources.map((s) => s.kind),
      ["file", "http", "error-page"],
    );
    assert.equal(plan.sources[0].target, "file:///app/renderer/dist/index.html");
    assert.equal(plan.sources[1].target, "http://127.0.0.1:4123/", "trailing slash so relative asset URLs resolve against the origin");
    assert.equal(plan.sources[0].attempts, MAX_SOURCE_ATTEMPTS);
    assert.equal(describePlan(plan), "1:file(4) -> 2:http(2) -> 3:error-page(1)");
  });

  it("no http origin => the diagnostic page is the only fallback", () => {
    const plan = buildLoadPlan({ rendererIndexPath: "/x/index.html" });
    assert.deepEqual(
      plan.sources.map((s) => s.kind),
      ["file", "error-page"],
    );
  });

  it("brokenPath replaces the primary source, which is how the smoke test forces a fallback", () => {
    const plan = buildLoadPlan({ rendererIndexPath: "/good/index.html", httpOrigin: "http://127.0.0.1:1", brokenPath: "/missing/index.html" });
    assert.equal(plan.sources[0].label, "broken-primary");
    assert.equal(plan.sources[0].target, "file:///missing/index.html");
    assert.notEqual(plan.sources[0].target, "file:///good/index.html", "the good path must not be reachable when brokenPath is set");
  });

  it("clamps attempt counts so a misconfigured env var cannot loop forever", () => {
    assert.equal(buildLoadPlan({ rendererIndexPath: "/x", attemptsPerSource: 99 }).sources[0].attempts, 6);
    assert.equal(buildLoadPlan({ rendererIndexPath: "/x", attemptsPerSource: 0 }).sources[0].attempts, 1);
  });
});

describe("delayFor", () => {
  it("walks the documented backoff and sticks to the last rung", () => {
    assert.deepEqual([...DEFAULT_BACKOFF_MS], [250, 500, 1000]);
    assert.equal(delayFor(1, DEFAULT_BACKOFF_MS), 250);
    assert.equal(delayFor(3, DEFAULT_BACKOFF_MS), 1000);
    assert.equal(delayFor(9, DEFAULT_BACKOFF_MS), 1000, "never grows past the ladder");
    assert.equal(delayFor(1, []), 0);
  });
});

describe("runLoadPlan", () => {
  it("succeeds on the first try and logs LOADED", async () => {
    const { lines, slept, deps } = harness("never");
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html", httpOrigin: "http://127.0.0.1:1" });
    const res = await runLoadPlan(plan, deps);
    assert.equal(res.ok, true);
    assert.equal(res.usedFallback, false);
    assert.equal(res.attemptNumber, 1);
    assert.deepEqual(slept, [], "a healthy load must not wait");
    assert.match(lines[0], LOAD_LOG_PATTERNS.loaded);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("[kicklive:renderer] LOADED"), "prefix is part of the contract");
  });

  it("retries with the documented backoff ladder before falling over", async () => {
    const { lines, slept, deps } = harness({ failFirst: 3 });
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html", httpOrigin: "http://127.0.0.1:1" });
    const res = await runLoadPlan(plan, deps);
    assert.equal(res.ok, true);
    assert.deepEqual(slept, [250, 500, 1000], "3 failures => 3 waits, doubling then capped per DEFAULT_BACKOFF_MS");
    assert.equal(res.failures, 3);
    assert.equal(res.usedFallback, false, "it recovered on the primary source");
    const failed = lines.filter((l) => LOAD_LOG_PATTERNS.loadFailed.test(l));
    assert.equal(failed.length, 3);
    assert.equal(lines.filter((l) => LOAD_LOG_PATTERNS.retry.test(l)).length, 3);
    assert.match(failed[2], /retryInMs=1000/);
  });

  it("falls back to the embedded server and says FALLBACK_ACTIVE", async () => {
    const { lines, deps, seen } = harness({ failFirst: 4 });
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html", httpOrigin: "http://127.0.0.1:4123" });
    const res = await runLoadPlan(plan, deps);
    assert.equal(res.ok, true);
    assert.equal(res.usedFallback, true);
    assert.equal(res.source, "http://127.0.0.1:4123/");
    assert.match(lines.join("\n"), LOAD_LOG_PATTERNS.fallback);
    assert.ok(seen.includes("http://127.0.0.1:4123/"));
    const fallbackLine = lines.find((l) => LOAD_LOG_PATTERNS.fallback.test(l))!;
    assert.match(fallbackLine, /source=http:\/\/127\.0\.0\.1:4123\/ attempt=5\/7/);
  });

  it("no retry after the last attempt of a source (it moves on instead of sleeping for nothing)", async () => {
    const { lines, slept, deps } = harness({ failFirst: 4 });
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html" });
    await runLoadPlan(plan, deps);
    const lastOfSource = lines.filter((l) => LOAD_LOG_PATTERNS.loadFailed.test(l)).at(-1)!;
    assert.match(lastOfSource, /retryInMs=0/);
    assert.equal(slept.length, 3, "4 failures on a 4-attempt source = 3 waits");
    assert.ok(lines.some((l) => /DIAGNOSTIC source=asar-file exhausted=true/.test(l)));
  });

  it("exhaustion ends at the diagnostic page and logs EXHAUSTED", async () => {
    const { lines, deps } = harness("always");
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html", httpOrigin: "http://127.0.0.1:4123" });
    const res = await runLoadPlan(plan, deps);
    assert.equal(res.ok, false);
    assert.equal(res.totalAttempts, 7);
    assert.match(lines.join("\n"), LOAD_LOG_PATTERNS.exhausted);
    const last = lines.at(-1)!;
    assert.ok(formatLog("").length > 0);
    assert.match(last, /EXHAUSTED attempts=7 lastError="ERR_FILE_NOT_FOUND/);
    assert.equal(res.usedFallback, true);
  });

  it("the broken-path plan never touches the healthy path and still ends with a document", async () => {
    const { lines, seen, deps } = harness({ failFirst: 4 });
    const plan = buildLoadPlan({ rendererIndexPath: "/app/index.html", httpOrigin: "http://127.0.0.1:4123", brokenPath: "/gone/index.html" });
    const res = await runLoadPlan(plan, deps);
    assert.equal(res.ok, true);
    assert.equal(seen.filter((s) => s.includes("/app/index.html")).length, 0, "the healthy path is not consulted: the smoke test must fall back");
    assert.equal(res.source, "http://127.0.0.1:4123/");
    assert.ok(lines.some((l) => LOAD_LOG_PATTERNS.fallback.test(l)));
  });
});
