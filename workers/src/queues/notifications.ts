/**
 * The queue consumer and the cron sweep.
 *
 * The queue is a **wake-up, never the record**: a job exists as a row in `notification_jobs` before it exists
 * here, so a lost message costs delay and not silence. That one property decides everything below — the
 * consumer may fail, the isolate may be recycled mid-batch, `queue.send` may never land, and the five-minute sweep
 * will still deliver the notification, because "pending and past its next attempt" is the queue's real
 * definition and this file is only the fast path to it.
 *
 * Two rules the rest of the design depends on:
 *
 *   - **A malformed message is acked, not retried.** A poison message that throws in parsing would be retried
 *       until the DLQ fills; `batch.ack()` plus a log line is the answer to "what do we do about garbage in the
 *       queue". A *delivery* failure is different, and retries.
 *   - **The consumer never invents a recipient.** It claims a job id, and the database decides who receives
 *       it (`kicklive_notification_recipients`). Nothing here reads a preference table directly, so the
 *       settings screen and the fan-out cannot disagree.
 */
import type { Env } from "../env.ts";
import { logError } from "../lib/debug.ts";
import { deliverJob, runtimeFor, type NotificationRepository, type DeliverOutcome, type NotificationsRuntime } from "../services/notifications.ts";
import { redact } from "../services/fcm.ts";

interface QueueMessageBody {
  readonly jobId: number;
}

export interface QueueBatch {
  readonly messages: readonly { id?: string; body: unknown; ack(): void; retry(): void }[];
  ack(): void;
  retry(): void;
}

/**
 * `QueueMessageBatch` from the Workers types is structurally this, and the tests hand in a plain object of the
 * same shape. Keeping the local interface means a test does not have to fake the runtime's class.
 */
/**
 * `deps` exists so the consumer's retry/ack decisions and its ordering can be tested without a Postgres and
 * without a Firebase project; production passes nothing and gets `runtimeFor(env)`. The seam is a parameter
 * rather than a module-level mock because a Worker isolate is shared across requests, and anything mutable at
 * module scope leaks from a test into the next invocation — and, in a dev run, from one user's request into
 * another's.
 */
export async function handleNotificationQueue(batch: QueueBatch, env: Env, deps?: Partial<NotificationsRuntime>): Promise<DeliverOutcome[]> {
  const runtime = { ...runtimeFor(env), ...(deps ?? {}) };
  const outcomes: DeliverOutcome[] = [];
  let retryAny = false;

  for (const message of batch.messages) {
    const jobId = parseJobId(message.body);
    if (jobId === null) {
      // Unparseable, or a job id that is not a positive integer. Acked: retrying it would loop, and the row it
      // was meant to wake up is still pending in the database for the sweep to find.
      message.ack();
      logError("notification-queue", new Error(`discarded malformed queue message: ${redact(JSON.stringify(message.body ?? null)).slice(0, 200)}`));
      continue;
    }
    try {
      const outcome = await deliverJob(runtime.repo, runtime.transport, jobId, { linkBase: runtime.linkBase });
      outcomes.push(outcome);
      if (outcome.status === "retry") retryAny = true;
    } catch (err) {
      // A repository or transport error that escaped `deliverJob` (a 5xx from PostgREST, say) is exactly the
      // case the retry policy exists for. The job stays `running` until the sweep's visibility timeout moves it
      // back, so this cannot double-send: the claim predicate is the guard, not the queue's at-most-once-ness.
      logError(`notification-job-${String(jobId)}`, err);
      retryAny = true;
    }
  }

  if (retryAny) batch.retry();
  else batch.ack();
  return outcomes;
}

function parseJobId(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as Record<string, unknown>)["jobId"];
  const id = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface SweepReport {
  readonly found: number;
  readonly enqueued: number;
  readonly deliveredInline: number;
  readonly pruned: boolean;
}

/**
 * The every-five-minutes sweep. Two jobs, one of which is a safety net nobody should ever notice:
 *
 *   1. re-enqueue anything `pending`/`retry` whose time has come. If no queue is bound (local `wrangler dev`
 *      without one, or an environment where the queue is still being provisioned) the sweep delivers inline —
 *      one code path, and the dev experience is the same as production's.
 *   2. once an hour, delete device rows that have been inactive for 30 days. A revoked registration is not a
 *      credential worth keeping, and "we keep it forever, just in case" is how a breach becomes a history of
 *      other people's push tokens.
 *
 * It never creates a job, never reads a preference, and never sends a push. Creating belongs to the trigger;
 * deciding belongs to SQL; sending belongs to the consumer.
 */
export async function sweepNotifications(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }, deps?: Partial<NotificationsRuntime>): Promise<SweepReport> {
  const runtime = { ...runtimeFor(env), ...(deps ?? {}) };
  const summary = await runtime.repo.pending(25);
  let enqueued = 0;
  let deliveredInline = 0;

  for (const jobId of summary.jobIds) {
    if (runtime.queue) {
      const send = runtime.queue.send({ jobId });
      enqueued++;
      ctx?.waitUntil(send);
    } else {
      await deliverJob(runtime.repo, runtime.transport, jobId, { linkBase: runtime.linkBase });
      deliveredInline++;
    }
  }

  const pruneNow = new Date().getUTCMinutes() < 5;
  if (pruneNow) await runtime.repo.prune("30 days");
  return { found: summary.jobIds.length, enqueued, deliveredInline, pruned: pruneNow };
}

/** Exposed for the tests and for an admin diagnostic; the production path is `sweepNotifications`. */
export async function drainJobs(repo: NotificationRepository, transport: ReturnType<typeof runtimeFor>["transport"], jobIds: readonly number[], linkBase = ""): Promise<DeliverOutcome[]> {
  const out: DeliverOutcome[] = [];
  for (const id of jobIds) out.push(await deliverJob(repo, transport, id, { linkBase }));
  return out;
}
