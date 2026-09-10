/**
 * Phase 5 · the fan-out, exercised end to end without a database or a Firebase project.
 *
 * `deliverJob` and `handleNotificationQueue` are the parts of this phase whose *order* matters as much as their
 * content: claim before send (or a redelivery sends twice), materialise before send (or a failed push leaves no
 * history), record after send (or a crash mid-batch re-sends to devices that were already told). Those are all
 * observable against a fake repository, which is why they are asserted here rather than deferred to a live
 * project. What is NOT provable here is that FCM accepts the payload we build, that `UNREGISTERED` arrives with
 * the shape we expect, or that the SQL's `on conflict` clauses behave — §20 of
 * docs/NOTIFICATIONS_ARCHITECTURE.md is the checklist for those, and running it is a manual step.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverJob, type ClaimedJob, type FinishStatus, type NotificationRepository, type RecipientRow, type ResultRow } from "../../workers/src/services/notifications.ts";
import { handleNotificationQueue, sweepNotifications } from "../../workers/src/queues/notifications.ts";
import { MockTransport, redact } from "../../workers/src/services/fcm.ts";

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

class FakeRepo implements NotificationRepository {
  readonly calls: Call[] = [];
  readonly recorded: ResultRow[] = [];
  finished: { status: FinishStatus; error?: string; next?: string } | null = null;
  materialisedBeforeSend = false;
  sentAtMaterialise = 0;

  readonly job: ClaimedJob | null;
  readonly deviceList: readonly RecipientRow[];

  // No constructor parameter properties: `node --experimental-strip-types` refuses them, and the test runner
  // that gates this repo runs the file as written rather than through a bundler.
  constructor(job: ClaimedJob | null, deviceList: readonly RecipientRow[]) {
    this.job = job;
    this.deviceList = deviceList;
  }

  async claim(_id: number) {
    this.calls.push({ op: "claim", args: [_id] });
    return this.job;
  }
  async materialise(id: number) {
    this.calls.push({ op: "materialise", args: [id] });
    this.materialisedBeforeSend = this.sentAtMaterialise === 0;
  }
  async recipients(id: number) {
    this.calls.push({ op: "recipients", args: [id] });
    return [...this.deviceList];
  }
  async recordResults(id: number, results: readonly ResultRow[]) {
    this.calls.push({ op: "recordResults", args: [id] });
    this.recorded.push(...results);
    this.sentAtMaterialise++;
  }
  async finish(id: number, status: FinishStatus, error?: string, next?: string) {
    this.calls.push({ op: "finish", args: [id, status] });
    this.finished = { status, error, next };
  }
  async pending() {
    return { jobIds: [], counts: {}, oldestPendingSeconds: null };
  }
  async prune(window: string) {
    this.calls.push({ op: "prune", args: [window] });
  }
}

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 7,
  kind: "goal",
  title: "⚽ GOAL!",
  body: "Arsenal 2 – 1 Chelsea",
  metadata: { matchId: 42, kind: "goal" },
  attempts: 1,
  maxAttempts: 6,
  matchId: 42,
  ...over,
});

const device = (i: number, token = `token-${String(i)}`): RecipientRow => ({
  deviceId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  userId: "u1",
  token,
  provider: "fcm",
  platform: "web",
});

const TOKEN_LIKE = "ya29." + "AbCdEf".repeat(25);

describe("phase5 · deliverJob", () => {
  it("refuses to do anything when the claim loses the race", async () => {
    const repo = new FakeRepo(null, [device(1)]);
    const transport = new MockTransport();
    const outcome = await deliverJob(repo, transport, 7);
    assert.deepEqual(outcome, { jobId: 7, status: "not_claimable", sent: 0, failed: 0, retired: 0, retryInMs: null });
    assert.deepEqual(
      repo.calls.map((c) => c.op),
      ["claim"],
      "a lost claim must not materialise, read devices, send, or finish",
    );
    assert.equal(transport.sent.length, 0);
  });

  it("writes history before it sends, so a failed push is still a notification", async () => {
    const repo = new FakeRepo(job(), [device(1)]);
    repo.recordResults = async () => {
      throw new Error("delivery blew up after the send");
    };
    await assert.rejects(() => deliverJob(repo, new MockTransport(), 7));
    assert.ok(repo.materialisedBeforeSend, "the inbox rows are created before the first send");
    assert.deepEqual(
      repo.calls.map((c) => c.op),
      ["claim", "materialise", "recipients"],
    );
  });

  it("treats an empty audience as success, not as something to retry", async () => {
    const repo = new FakeRepo(job(), []);
    const outcome = await deliverJob(repo, new MockTransport(), 7);
    assert.equal(outcome.status, "sent");
    assert.deepEqual(repo.finished, { status: "sent", error: undefined, next: undefined });
  });

  it("retires an invalid token, retries a transient one, and never confuses the two", async () => {
    const repo = new FakeRepo(job(), [device(1, "invalid:abc"), device(2, "flaky:abc"), device(3, "good:abc".replace("good:", ""))]);
    const outcome = await deliverJob(repo, new MockTransport(), 7);
    assert.equal(outcome.retired, 1, "the UNREGISTERED device");
    assert.equal(outcome.failed, 1, "the unreachable one");
    assert.equal(outcome.sent, 1, "the fine one");
    assert.equal(outcome.status, "retry", "a transient failure requeues the job for the devices that never got it");
    assert.ok(outcome.retryInMs && outcome.retryInMs > 20_000 && outcome.retryInMs < 60_000, `backoff out of range: ${String(outcome.retryInMs)}`);
    assert.equal(repo.finished?.status, "retry");
    const statuses = new Map(repo.recorded.map((r) => [r.deviceId, r.status]));
    assert.equal(statuses.get(device(1).deviceId), "skipped_invalid_token");
    assert.equal(statuses.get(device(2).deviceId), "failed");
    assert.equal(statuses.get(device(3).deviceId), "sent");
  });

  it("stops on the last allowed attempt instead of scheduling another", async () => {
    const repo = new FakeRepo(job({ attempts: 6, maxAttempts: 6 }), [device(1, "flaky:x")]);
    const outcome = await deliverJob(repo, new MockTransport(), 1);
    assert.equal(outcome.status, "partial");
    assert.equal(repo.finished?.status, "partial");
    assert.equal(repo.finished?.next, undefined, "no next_attempt_at is written once the budget is gone");
  });

  it("sends in bounded batches of 500, one record call per batch", async () => {
    const many = Array.from({ length: 1_200 }, (_, i) => device(i + 1));
    const repo = new FakeRepo(job(), many);
    const transport = new MockTransport();
    const outcome = await deliverJob(repo, transport, 7);
    assert.equal(outcome.sent, 1_200);
    assert.equal(transport.sent.length, 1_200, "FCM has no batch endpoint we can use, so this is the fan-out");
    assert.equal(repo.calls.filter((c) => c.op === "recordResults").length, 3, "500 + 500 + 200 → three writes, not twelve hundred");
  });

  it("builds a payload a browser can act on, and puts no secret in it", async () => {
    const transport = new MockTransport();
    const repo = new FakeRepo(job(), [device(1, TOKEN_LIKE)]);
    await deliverJob(repo, transport, 7);
    const sent = transport.sent[0]!;
    assert.equal(sent.url, "/matches/42", "a tap goes to the match, on the same origin");
    assert.equal(sent.title, "⚽ GOAL!");
    assert.deepEqual(sent.metadata, { matchId: 42, kind: "goal" });
    assert.ok(!JSON.stringify(sent.metadata).includes(TOKEN_LIKE), "the token goes to FCM and nowhere else");
  });

  it("keeps a token out of anything the error path can produce", async () => {
    const thrown = new Error(`fetch failed for token ${TOKEN_LIKE} with Authorization: Bearer ${TOKEN_LIKE}`);
    const redacted = redact(String(thrown));
    assert.ok(!redacted.includes(TOKEN_LIKE.slice(0, 30)), `redact leaked: ${redacted.slice(0, 120)}`);
    assert.match(redacted, /\[token|Bearer \[redacted\]/);
  });
});

describe("phase5 · the queue consumer", () => {
  const batch = (messages: readonly unknown[]) => {
    const log: string[] = [];
    return {
      log,
      messages: messages.map((body, i) => ({
        id: `m${String(i)}`,
        body,
        ack() {
          log.push(`ack:${String(i)}`);
        },
        retry() {
          log.push(`retry:${String(i)}`);
        },
      })),
      ack() {
        log.push("ack:all");
      },
      retry() {
        log.push("retry:all");
      },
    };
  };

  it("acks a malformed message instead of retrying it forever", async () => {
    const b = batch([{ nothing: true }, "not an object", { jobId: 0 }, { jobId: -3 }, { jobId: 1.5 }]);
    const outcomes = await handleNotificationQueue(b as never, {} as never, { repo: new FakeRepo(null, []), transport: new MockTransport(), linkBase: "", queue: undefined });
    assert.equal(outcomes.length, 0, "nothing was deliverable");
    assert.deepEqual(b.log, ["ack:0", "ack:1", "ack:2", "ack:3", "ack:4", "ack:all"], "each poison message is acked, so it cannot loop until the DLQ fills");
  });

  it("delivers a well-formed message and acks the batch", async () => {
    const repo = new FakeRepo(job(), [device(1), device(2)]);
    const transport = new MockTransport();
    const b = batch([{ jobId: 7 }]);
    const outcomes = await handleNotificationQueue(b as never, {} as never, { repo, transport, linkBase: "", queue: undefined });
    assert.equal(outcomes[0]?.status, "sent");
    assert.equal(transport.sent.length, 2);
    assert.deepEqual(b.log, ["ack:all"]);
  });

  it("retries the whole batch when a job needs another attempt", async () => {
    const repo = new FakeRepo(job(), [device(1, "flaky:abc")]);
    const b = batch([{ jobId: 7 }]);
    const outcomes = await handleNotificationQueue(b as never, {} as never, { repo, transport: new MockTransport(), linkBase: "", queue: undefined });
    assert.equal(outcomes[0]?.status, "retry");
    assert.deepEqual(b.log, ["retry:all"], "the un-acked message comes back, and the claim predicate makes the second pass a no-op if it was already sent");
  });

  it("survives a repository failure without swallowing it", async () => {
    const repo = new FakeRepo(job(), [device(1)]);
    repo.claim = async () => {
      throw new Error('relation "notification_jobs" does not exist');
    };
    const b = batch([{ jobId: 7 }]);
    const outcomes = await handleNotificationQueue(b as never, {} as never, { repo, transport: new MockTransport(), linkBase: "", queue: undefined });
    assert.deepEqual(outcomes, [], "a job whose tables are missing produces no outcome");
    assert.deepEqual(b.log, ["retry:all"], "and the message is retried, which is how an unapplied migration becomes a delay instead of a loss");
  });
});

describe("phase5 · the sweep", () => {
  it("enqueues every claimable job when a queue is bound", async () => {
    const repo = new FakeRepo(null, []);
    repo.pending = async () => ({ jobIds: [1, 2, 3], counts: { pending: 3 }, oldestPendingSeconds: 61 });
    const sent: unknown[] = [];
    const waits: Promise<unknown>[] = [];
    const report = await sweepNotifications(
      {} as never,
      { waitUntil: (p) => void waits.push(p) },
      {
        repo,
        transport: new MockTransport(),
        linkBase: "",
        queue: { send: async (m: unknown) => void sent.push(m) } as never,
      },
    );
    assert.deepEqual(sent, [{ jobId: 1 }, { jobId: 2 }, { jobId: 3 }], "the payload is a job id and nothing else");
    assert.equal(report.enqueued, 3);
    assert.equal(report.deliveredInline, 0);
    await Promise.all(waits);
  });

  it("delivers inline when no queue is bound, so local dev exercises the same path", async () => {
    const repo = new FakeRepo(job({ id: 5 }), [device(1)]);
    repo.pending = async () => ({ jobIds: [5], counts: { pending: 1 }, oldestPendingSeconds: 12 });
    const transport = new MockTransport();
    const report = await sweepNotifications({} as never, undefined, { repo, transport, linkBase: "", queue: undefined });
    assert.equal(report.deliveredInline, 1);
    assert.equal(transport.sent.length, 1, "the same deliverJob, with or without a queue");
  });

  it("prunes inside the hourly window and not outside it", async () => {
    const windows: string[] = [];
    const repo = new FakeRepo(null, []);
    repo.pending = async () => ({ jobIds: [], counts: {}, oldestPendingSeconds: null });
    repo.prune = async (w: string) => void windows.push(w);
    const report = await sweepNotifications({} as never, undefined, { repo, transport: new MockTransport(), linkBase: "", queue: undefined });
    const minute = new Date().getUTCMinutes();
    if (minute < 5) {
      assert.deepEqual(windows, ["30 days"], "a dead device row is deleted after 30 days, on the hour");
      assert.equal(report.pruned, true);
    } else {
      assert.deepEqual(windows, [], "the prune runs hourly, not every five minutes");
      assert.equal(report.pruned, false);
    }
  });
});
