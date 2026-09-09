/**
 * Controller contract: what the UI may do with a decision. These are the behaviours the spec demands
 * verbatim — "one prompt per open", snooze persistence *per version*, offline = unknown(lastSeenAt),
 * and the refusal lines the tests are allowed to grep.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createUpdateController, emptyStore } from "../../shared/update-controller.ts";
import type { UpdateStore } from "../../shared/update-controller.ts";
import { createMemoryStorage } from "../../desktop/src/settings-store.ts";
import { collectLogs, fakeFetch, manifest } from "../support/fixture.ts";

const NOW = new Date("2026-09-09T00:00:00.000Z");

function controllerFor(
  opts: {
    body?: unknown;
    status?: number;
    storage?: ReturnType<typeof createMemoryStorage>;
    surface?: "desktop" | "pwa";
    currentVersion?: string;
    channel?: "stable" | "beta";
    onInstall?: (d: never) => Promise<{ ok: boolean; detail: string }>;
    attempts?: number;
    json?: string;
  } = {},
) {
  const text = opts.json ?? JSON.stringify(opts.body ?? manifest());
  const { fetch, hits } = fakeFetch({ "/kicklive-update-stable.json": { status: opts.status ?? 200, body: text } });
  const logs = collectLogs();
  const storage = opts.storage ?? createMemoryStorage();
  const controller = createUpdateController({
    surface: opts.surface ?? "desktop",
    currentVersion: opts.currentVersion ?? "1.0.0",
    channel: opts.channel ?? "stable",
    platformId: "linux_x64",
    storage,
    manifestUrl: "http://127.0.0.1/kicklive-update-stable.json",
    allowInsecureUrls: true,
    fetchImpl: fetch,
    log: logs.log,
    now: () => NOW,
    backoffMs: [0],
    attempts: opts.attempts,
    onInstall: opts.onInstall as never,
  });
  return { controller, logs, storage, hits };
}

describe("update controller: checking", () => {
  it("emits the documented CHECKED line with reason + surface", async () => {
    const { controller, logs } = controllerFor();
    const summary = await controller.check("startup");
    assert.equal(summary.decision.state, "available");
    assert.equal(logs.lines.length, 1, `expected exactly one log line, got ${JSON.stringify(logs.lines)}`);
    assert.match(logs.lines[0], /^\[kicklive:updates\] CHECKED reason=startup surface=desktop state=available/);
  });

  it("persists lastSeen + outcome for the next launch", async () => {
    const { controller, storage } = controllerFor();
    await controller.check("manual");
    const store = storage.current();
    assert.equal(store.lastSeen?.version, "1.1.0");
    assert.equal(store.lastOutcome, "ok");
    assert.equal(store.lastCheckAt, NOW.toISOString());
    assert.equal(store.schemaVersion, 1);
  });

  it("does not downgrade lastSeen when a rolled-back manifest is published", async () => {
    const storage = createMemoryStorage({ lastSeen: { version: "1.2.0", at: "2026-01-01T00:00:00.000Z", channel: "stable" } });
    const { controller } = controllerFor({ body: manifest({ version: "1.1.0" }), storage });
    await controller.check("startup");
    assert.equal(storage.current().lastSeen?.version, "1.2.0", "the client must remember it already saw something newer");
  });

  it("offline => state unknown with lastSeenAt, never up-to-date", async () => {
    const storage = createMemoryStorage({ lastSeen: { version: "1.0.5", at: "2026-09-01T00:00:00.000Z", channel: "stable" } });
    const { controller } = controllerFor({ status: 503, storage, attempts: 1 });
    const summary = await controller.check("startup");
    assert.equal(summary.decision.state, "unknown");
    assert.equal(summary.decision.reason, "manifest-unreachable");
    assert.equal(summary.decision.lastSeenAt, "2026-09-01T00:00:00.000Z");
    assert.equal(summary.mayPrompt, false);
    assert.equal(storage.current().lastSeen?.version, "1.0.5", "an unreachable feed must not wipe the last known state");
  });

  it("retries transport failures but not schema failures", async () => {
    const down = controllerFor({ status: 503, attempts: 3 });
    await down.controller.check("startup");
    assert.equal(down.hits["/kicklive-update-stable.json"], 3, "network errors get the full attempt budget");

    const broken = controllerFor({ json: "{not json", attempts: 3 });
    await broken.controller.check("startup");
    assert.equal(broken.hits["/kicklive-update-stable.json"], 1, "a malformed manifest is not going to heal on retry");
  });

  it("deduplicates concurrent checks (startup + focus can overlap)", async () => {
    const { controller } = controllerFor();
    const [a, b] = await Promise.all([controller.check("startup"), controller.check("focus")]);
    assert.equal(a, b, "the same in-flight summary is shared");
  });
});

describe("update controller: one prompt per open", () => {
  it("prompts once, then stays quiet even for a second manual check", async () => {
    const { controller } = controllerFor();
    assert.equal((await controller.check("startup")).mayPrompt, true);
    assert.equal((await controller.check("manual")).mayPrompt, false, "second check in the same app open must not nag");
  });

  it("a manual check after an automatic one still reports the decision (the user asked)", async () => {
    const { controller } = controllerFor();
    await controller.check("startup");
    const second = await controller.check("manual");
    assert.equal(second.decision.state, "available");
    assert.equal(second.mayPrompt, false);
  });

  it("resetPromptLatch models an app restart", async () => {
    const { controller } = controllerFor();
    await controller.check("startup");
    controller.resetPromptLatch();
    assert.equal((await controller.check("startup")).mayPrompt, true);
  });

  it("up-to-date never prompts", async () => {
    const { controller } = controllerFor({ body: manifest({ version: "1.0.0" }) });
    const summary = await controller.check("startup");
    assert.equal(summary.mayPrompt, false);
    assert.equal(summary.decision.state, "up-to-date");
  });
});

describe("update controller: snooze", () => {
  it("is stored per candidate version and survives a restart", async () => {
    const storage = createMemoryStorage();
    const first = controllerFor({ storage });
    await first.controller.check("startup");
    const after = await first.controller.snooze();
    assert.equal(after.decision.reason, "snoozed");
    assert.equal(after.mayPrompt, false);

    const table = storage.current().snoozedUntil;
    assert.deepEqual(Object.keys(table), ["1.1.0"], "snooze is keyed by the candidate version, not global");
    assert.ok(Date.parse(table["1.1.0"]) > NOW.getTime());

    // A fresh controller (i.e. a restart) reads the same store and stays quiet.
    const restarted = controllerFor({ storage });
    const summary = await restarted.controller.check("startup");
    assert.equal(summary.decision.reason, "snoozed");
    assert.equal(summary.mayPrompt, false);
  });

  it("expires after 12 hours by default", async () => {
    const storage = createMemoryStorage();
    const { controller } = controllerFor({ storage });
    await controller.check("startup");
    await controller.snooze();
    const until = storage.current().snoozedUntil["1.1.0"];
    assert.equal((Date.parse(until) - NOW.getTime()) / 3_600_000, 12);
  });

  it("a newer release is not silenced by snoozing the old one", async () => {
    const storage = createMemoryStorage();
    const first = controllerFor({ storage });
    await first.controller.check("startup");
    await first.controller.snooze();
    const next = controllerFor({ storage, body: manifest({ version: "1.2.0" }) });
    const summary = await next.controller.check("startup");
    assert.equal(summary.mayPrompt, true, "1.2.0 is a different candidate: snoozing 1.1.0 must not hide it");
  });

  it("mandatory releases ignore the snooze", async () => {
    const storage = createMemoryStorage();
    const { controller } = controllerFor({ storage, body: manifest({ mandatoryBelow: "1.1.0" }), currentVersion: "1.0.0" });
    await controller.check("startup");
    await controller.snooze();
    const summary = await controller.check("startup");
    assert.equal(summary.decision.mandatory, true);
  });
});

describe("update controller: storage resilience", () => {
  it("a throwing storage cannot break the check", async () => {
    const storage = {
      async load() {
        throw new Error("EIO");
      },
      async save() {
        throw new Error("EROFS");
      },
    };
    const logs = collectLogs();
    const { fetch } = fakeFetch({ "/m.json": { body: JSON.stringify(manifest()) } });
    const controller = createUpdateController({
      surface: "desktop",
      currentVersion: "1.0.0",
      channel: "stable",
      platformId: "linux_x64",
      storage,
      manifestUrl: "http://127.0.0.1/m.json",
      allowInsecureUrls: true,
      fetchImpl: fetch,
      log: logs.log,
      now: () => NOW,
    });
    const summary = await controller.check("startup");
    assert.equal(summary.decision.state, "available", "we still show the user what the feed says");
    assert.ok(logs.lines.some((l) => l.includes("STORE_READ_FAILED") && l.includes("EIO")));
    assert.ok(logs.lines.some((l) => l.includes("STORE_WRITE_FAILED")));
  });

  it("a store written by a future schema version is ignored, not trusted", async () => {
    const storage = {
      async load() {
        return { schemaVersion: 2 as never, lastSeen: null, lastCheckAt: null, lastOutcome: null, snoozedUntil: { "1.1.0": "2099-01-01T00:00:00.000Z" } };
      },
      async save() {},
    };
    const { controller } = controllerFor({ storage: storage as never });
    const summary = await controller.check("startup");
    assert.equal(summary.mayPrompt, true, "an unreadable snooze table must not silently suppress an update");
  });
});

describe("update controller: install hand-off", () => {
  it("refuses when there is nothing to install, with the log line the tests grep", async () => {
    const storage = createMemoryStorage();
    const { controller, logs } = controllerFor({
      storage,
      body: manifest({ version: "0.5.0" }),
      onInstall: (async () => ({ ok: true, detail: "MUST NOT BE CALLED" })) as never,
    });
    const res = await controller.install();
    assert.equal(res.ok, false);
    assert.match(res.detail, /never-downgrade/);
    assert.ok(logs.lines.some((l) => /^\[kicklive:updates\] REFUSE_INSTALL reason=never-downgrade detail=".*/.test(l)));
  });

  it("refuses on an unknown manifest state", async () => {
    const { controller } = controllerFor({ status: 503, attempts: 1, onInstall: (async () => ({ ok: true, detail: "should not be reached" })) as never });
    const res = await controller.install();
    assert.equal(res.ok, false);
    assert.match(res.detail, /refused/);
  });

  it("hands the verified decision to the privileged installer", async () => {
    let seen: { version?: string; file?: string } = {};
    const { controller } = controllerFor({
      onInstall: (async (decision: { candidateVersion?: string; artifact?: { fileName?: string } }) => {
        seen = { version: decision.candidateVersion, file: decision.artifact?.fileName };
        return { ok: true, detail: "staged" };
      }) as never,
    });
    const res = await controller.install();
    assert.equal(res.ok, true);
    assert.equal(seen.version, "1.1.0");
    assert.match(String(seen.file), /kicklive_1\.1\.0_amd64\.deb/);
  });

  it("the PWA surface has no privileged installer by design", async () => {
    const { controller } = controllerFor({ surface: "pwa" });
    const res = await controller.install();
    assert.equal(res.ok, false);
    assert.match(res.detail, /no privileged installer/);
  });
});
