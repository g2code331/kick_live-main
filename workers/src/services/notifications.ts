/**
 * The Worker's side of Phase 5: who receives a job, and what happens when a send fails.
 *
 * Two modules, one seam, and the seam is deliberate. `NotificationRepository` is the *only* thing `deliverJob`
 * knows about the database, and `DeliveryTransport` is the only thing it knows about FCM. That is what makes
 * the fan-out testable without a Postgres or a Firebase project: the tests in
 * `tests/integration/notifications-queue.test.ts` run the real `deliverJob` against a fake repository and the
 * mock transport, and assert the ordering (history before send), the batching, the retry decision, and the
 * device retirement. A production delivery path whose retry logic can only be exercised by sending a real push
 * is a production delivery path that has never been tested.
 *
 * Everything that decides *who* is told lives in SQL (`kicklive_notification_audience`, §13 of the
 * architecture) — including the preference defaults and the audience rules — because that same decision has to
 * hold for the inbox insert, the admin's audience count, and any future second transport. This file reads the
 * answer; it does not compute it.
 */
import type { Env } from "../env.ts";
import { logError } from "../lib/debug.ts";
import { DEVICE_FAILURE_LIMIT, FCM_BATCH_CONCURRENCY, FCM_BATCH_SIZE, SWEEP_LIMIT, type NotificationKind } from "../lib/notificationPolicy.ts";
import { redact, transportFor, type DeliveryStatus, type DeliveryTransport, type SendInput } from "../services/fcm.ts";
import { supabaseAdmin } from "../services/supabase.ts";

export interface ClaimedJob {
  readonly id: number;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly metadata: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly matchId: number | null;
}

export interface RecipientRow {
  readonly deviceId: string;
  readonly userId: string;
  readonly token: string;
  readonly provider: "fcm" | "webpush";
  readonly platform: string;
}

export interface ResultRow {
  readonly deviceId: string;
  readonly status: DeliveryStatus;
  readonly messageId?: string;
  readonly errorCode?: string;
}

export interface PendingSummary {
  readonly jobIds: number[];
  readonly counts: Record<string, number>;
  readonly oldestPendingSeconds: number | null;
}

export type FinishStatus = "sent" | "partial" | "failed" | "retry";

export interface NotificationRepository {
  claim(jobId: number): Promise<ClaimedJob | null>;
  materialise(jobId: number): Promise<void>;
  recipients(jobId: number): Promise<RecipientRow[]>;
  recordResults(jobId: number, results: ResultRow[]): Promise<void>;
  finish(jobId: number, status: FinishStatus, error?: string, nextAttemptAt?: string): Promise<void>;
  pending(limit: number): Promise<PendingSummary>;
  prune(window: string): Promise<void>;
}

export interface DeliverOutcome {
  readonly jobId: number;
  readonly status: FinishStatus | "not_claimable";
  readonly sent: number;
  readonly failed: number;
  readonly retired: number;
  readonly retryInMs: number | null;
}

/**
 * Backoff, capped. Exponential without a cap is how a 5-minute incident turns into a job whose next attempt is
 * scheduled for next week; a cap without jitter is how 5 000 jobs all retry in the same second.
 */
export function retryDelayMs(attempts: number): number {
  const base = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * One job, start to finish.
 *
 * The order is the design, and two of its steps are load-bearing:
 *   - claim *before* anything else, so a redelivery or a sweep race returns `not_claimable` rather than
 *     sending twice;
 *   - materialise the inbox rows *before* sending, so a push that fails still leaves a record (brief: history
 *     is independent of delivery success).
 *
 * `waitUntil` semantics live in the caller; this function performs no fire-and-forget work of its own, so it can
 * be awaited in a test and in a queue consumer identically.
 */
export async function deliverJob(repo: NotificationRepository, transport: DeliveryTransport, jobId: number, opts: { linkBase?: string; now?: () => Date } = {}): Promise<DeliverOutcome> {
  const job = await repo.claim(jobId);
  if (!job) return { jobId, status: "not_claimable", sent: 0, failed: 0, retired: 0, retryInMs: null };

  await repo.materialise(job.id);
  const recipients = await repo.recipients(job.id);
  if (recipients.length === 0) {
    // No audience is a success, not a failure: it means everyone who wanted this was told by the inbox, or
    // nobody is entitled to it. Retrying would spin forever on a match with no interested devices.
    await repo.finish(job.id, "sent");
    return { jobId, status: "sent", sent: 0, failed: 0, retired: 0, retryInMs: null };
  }

  const linkBase = opts.linkBase ?? "";
  const batches: RecipientRow[][] = [];
  for (let i = 0; i < recipients.length; i += FCM_BATCH_SIZE) batches.push(recipients.slice(i, i + FCM_BATCH_SIZE));

  const results: ResultRow[] = [];
  let sent = 0;
  let retired = 0;
  let transientFailures = 0;

  for (const batch of batches) {
    const settled = await mapWithConcurrency(batch, FCM_BATCH_CONCURRENCY, async (recipient) => {
      const input: SendInput = {
        deviceId: recipient.deviceId,
        token: recipient.token,
        title: job.title,
        body: job.body,
        url: linkFor(linkBase, job),
        metadata: { ...job.metadata, kind: job.kind },
      };
      let delivery;
      try {
        delivery = await transport.send(input);
      } catch (err) {
        // A transport that throws is treated as transient: never retire a device because our own client
        // misbehaved, and never let the error text (which may carry a token) into the outcome.
        logError(`fcm-${String(job.id)}`, new Error(redact(String(err))));
        delivery = { status: "failed" as const, errorCode: "TRANSPORT_ERROR" };
      }
      return { recipient, delivery };
    });

    for (const { recipient, delivery } of settled) {
      results.push({
        deviceId: recipient.deviceId,
        status: delivery.status,
        ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
        ...(delivery.errorCode ? { errorCode: delivery.errorCode } : {}),
      });
      if (delivery.status === "sent") sent++;
      else if (delivery.status === "skipped_invalid_token") retired++;
      else transientFailures++;
    }
    // One call per batch, not per device: the bookkeeping must not become the slow part of a goal.
    await repo.recordResults(job.id, results.splice(0, results.length));
  }

  const failed = transientFailures;
  if (failed > 0 && job.attempts < job.maxAttempts) {
    const delay = retryDelayMs(job.attempts);
    await repo.finish(job.id, "retry", "FCM_RETRY", new Date((opts.now?.() ?? new Date()).getTime() + delay).toISOString());
    return { jobId, status: "retry", sent, failed, retired, retryInMs: delay };
  }
  if (failed > 0) {
    await repo.finish(job.id, "partial", "FCM_RETRY_EXHAUSTED");
    return { jobId, status: "partial", sent, failed, retired, retryInMs: null };
  }
  await repo.finish(job.id, sent === 0 && retired > 0 ? "sent" : retired > 0 ? "partial" : "sent");
  return { jobId, status: retired > 0 ? "partial" : "sent", sent, failed: 0, retired, retryInMs: null };
}

/** Where a tap lands. Relative by default, because the SPA's origin is the only one that must work. */
function linkFor(linkBase: string, job: ClaimedJob): string {
  const matchId = typeof job.metadata["matchId"] === "number" ? (job.metadata["matchId"] as number) : null;
  if (matchId !== null) return `${linkBase}/matches/${String(matchId)}`;
  return `${linkBase}/profile?tab=notifications`;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The repository the Worker actually uses: service-role RPC calls, and nothing else. */
export function supabaseNotifications(env: Env): NotificationRepository {
  // Service role, because a delivery record names rows no user may enumerate (other people's devices), and
  // because ownership is decided in the SQL functions (`auth.uid()`), not by which key we present. The routes
  // still authenticate the caller first; this client never serves an unauthenticated request.
  const db = () => supabaseAdmin(env);
  return {
    async claim(jobId) {
      const res = (await db().call("kicklive_claim_notification_job", { p_job_id: jobId })) as ({ ok: boolean } & Record<string, unknown>) | null;
      if (!res || res["ok"] !== true) return null;
      return {
        id: Number(res["id"]),
        kind: String(res["kind"]) as NotificationKind,
        title: String(res["title"] ?? ""),
        body: String(res["body"] ?? ""),
        metadata: (res["metadata"] as Record<string, unknown>) ?? {},
        attempts: Number(res["attempts"] ?? 1),
        maxAttempts: Number(res["max_attempts"] ?? 6),
        matchId: res["match_id"] === null || res["match_id"] === undefined ? null : Number(res["match_id"]),
      };
    },
    async materialise(jobId) {
      await db().call("kicklive_materialise_notifications", { p_job_id: jobId });
    },
    async recipients(jobId) {
      const rows = (await db().call("kicklive_notification_recipients", { p_job_id: jobId })) as
        { device_id: string; user_id: string; token: string; provider: "fcm" | "webpush"; platform: string }[] | null;
      // A token is copied into the row and then dropped; it is never logged, never returned by a route, and
      // never written to a delivery record.
      return (rows ?? []).map((r) => ({ deviceId: r.device_id, userId: r.user_id, token: r.token, provider: r.provider, platform: r.platform }));
    },
    async recordResults(jobId, results) {
      await db().call("kicklive_record_notification_results", { p_job_id: jobId, p_results: results });
    },
    async finish(jobId, status, error, nextAttemptAt) {
      await db().call("kicklive_finish_notification_job", { p_job_id: jobId, p_status: status, p_error: error ?? null, p_next_attempt_at: nextAttemptAt ?? null });
    },
    async pending(limit) {
      const res = (await db().call("kicklive_pending_notification_jobs", { p_limit: limit })) as {
        jobIds?: (string | number)[];
        counts?: Record<string, number>;
        oldestPendingSeconds?: number | null;
      } | null;
      return { jobIds: (res?.jobIds ?? []).map(Number), counts: res?.counts ?? {}, oldestPendingSeconds: res?.oldestPendingSeconds ?? null };
    },
    async prune(window) {
      await db().call("kicklive_prune_notification_devices", { p_window: window });
    },
  };
}

export const DEFAULT_SWEEP_LIMIT = SWEEP_LIMIT;
export const DEFAULT_DEVICE_FAILURE_LIMIT = DEVICE_FAILURE_LIMIT;

/** The consumer's dependency set, resolved per invocation so a test can inject a fake repository. */
export interface NotificationsRuntime {
  readonly repo: NotificationRepository;
  readonly transport: DeliveryTransport;
  readonly linkBase: string;
  readonly queue: Env["NOTIFICATION_QUEUE"];
}

export function runtimeFor(env: Env): NotificationsRuntime {
  return {
    repo: supabaseNotifications(env),
    transport: transportFor(env),
    linkBase: (env.NOTIFICATIONS_LINK_BASE ?? "").replace(/\/$/, ""),
    queue: env.NOTIFICATION_QUEUE,
  };
}
