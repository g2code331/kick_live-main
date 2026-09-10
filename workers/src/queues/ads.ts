/**
 * Ad-event delivery: the producer the routes call, and the consumer the runtime invokes.
 *
 * The opposite of Phase 5's queue, and deliberately. A notification job is a row first and a message second,
 * so a lost message costs delay; an ad event is a message only, so a lost message costs a number — which is
 * acceptable *because* the numbers are declared a floor in the schema and nothing is invoiced from them. What
 * is not acceptable is an advertiser's click being counted twice, so this file optimises for exactly that:
 *
 *   - **At-least-once delivery, deduplicated at the door.** The consumer retries a whole batch when the
 *       database call fails, and the database turns a redelivery into a no-op on `ad_events.dedupe_key`. The
 *       queue's `max_retries` is therefore safe to leave on, which it would not be for a table with a
 *       `count + 1` in it.
 *   - **A malformed message is acked.** Nothing in this queue is a wake-up for a row that still exists, so a
 *       poison message has no sweep to save it; retrying it would only occupy the consumer until the DLQ
 *       fills. Discard, log the shape, move on.
 *   - **No queue, no stall.** Where `AD_EVENTS_QUEUE` is not bound — a preview deployment, a unit run — events
 *       are written inline in the request. That is a slower page, not a lost count, and it is the reason the
 *       local `dev` environment is not silently the one where counting is broken.
 */
import type { Env } from "../env.ts";
import { logDebug, logError } from "../lib/debug.ts";
import { flushObservations, observe } from "../lib/observability.ts";
import { AD_EVENT_NAMES, MAX_EVENTS_PER_BODY, VIEWER_KEY_PATTERN, type AdEventName } from "../lib/adPolicy.ts";
import { supabaseAdmin } from "../services/supabase.ts";
import type { QueueBatch } from "./notifications.ts";

export interface AdEventMessage {
  readonly advertisementId: string;
  readonly placementCode: string;
  readonly event: AdEventName;
  readonly viewerKey: string;
  /** Present when the browser knows the interaction happened earlier (the batch that arrives on `visibilitychange`). */
  readonly occurredAt?: string;
  /** For the log line only — never written to a table. */
  readonly requestId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACEMENT = /^[A-Z][A-Z0-9_]{1,31}$/;

export interface AdEventSink {
  /** Writes a slice of events and resolves to whatever the database answered per row. */
  record(events: readonly AdEventMessage[]): Promise<AdEventReceipt[]>;
}

export interface AdEventReceipt {
  readonly counted: boolean;
  readonly reason?: string;
}

export interface AdEventsRuntime {
  readonly sink: AdEventSink;
  readonly maxBatch: number;
}

/** The RPC's row shape is `{ok, results:[{counted, reason}]}`; anything else is treated as an error. */
function receiptsFrom(payload: unknown, expected: number): AdEventReceipt[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length !== expected) {
    throw new Error(`kicklive_ad_record_events answered with ${Array.isArray(results) ? results.length : "no"} receipts for ${expected} events`);
  }
  return results.map((r) => ({ counted: Boolean((r as { counted?: unknown })?.counted), reason: (r as { reason?: string })?.reason }));
}

export function runtimeFor(env: Env): AdEventsRuntime {
  return {
    maxBatch: 100,
    sink: {
      async record(events) {
        const payload = events.map((e) => ({
          advertisement_id: e.advertisementId,
          placement_code: e.placementCode,
          event: e.event,
          viewer_key: e.viewerKey,
          occurred_at: e.occurredAt ?? null,
        }));
        const data = await supabaseAdmin(env).call<{ results?: unknown }>("kicklive_ad_record_events", { p_events: payload });
        return receiptsFrom(data, events.length);
      },
    },
  };
}

/**
 * Validate a queue message. A key that does not match the shape is not "slightly wrong", it is a message from a
 * client that has not read the contract, and the database would refuse every row of the batch for it — so the
 * refusal happens here, where it can be logged, and the message is acked.
 */
/**
 * One sample per event the rollup write actually counted, by event name, and one refusal per event it did not.
 *
 * The reason a creative was not counted (`duplicate_window`, `out_of_window`, whatever
 * `kicklive_ad_record_event` decides) goes to the log rather than into a dimension: an unbounded dimension
 * value is how a metrics table turns into a log table, and the *count* of refusals is the operational fact.
 */
function observeAdReceipts(events: AdEventMessage[], receipts: AdEventReceipt[]): void {
  let counted = 0;
  for (const [index, event] of events.entries()) {
    if (receipts[index]?.counted === true) {
      counted++;
      observe({ subsystem: "advertising", metric: "events", route: "/advertising/events", dimension: event.event, samples: 1 });
    } else {
      observe({ subsystem: "advertising", metric: "ingest", route: "/advertising/events", dimension: "refused", samples: 1 });
    }
  }
  if (counted > 0) observe({ subsystem: "advertising", metric: "ingest", route: "/advertising/events", dimension: "written", samples: counted });
}

export function parseAdEvent(body: unknown): AdEventMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.advertisementId === "string" ? b.advertisementId : "";
  const placement = typeof b.placementCode === "string" ? b.placementCode : "";
  const key = typeof b.viewerKey === "string" ? b.viewerKey : "";
  const event = b.event;
  if (!UUID.test(id) || !PLACEMENT.test(placement)) return null;
  if (!VIEWER_KEY_PATTERN.test(key)) return null;
  if (typeof event !== "string" || !(AD_EVENT_NAMES as readonly string[]).includes(event)) return null;
  const occurredAt = typeof b.occurredAt === "string" && !Number.isNaN(Date.parse(b.occurredAt)) ? new Date(b.occurredAt).toISOString() : undefined;
  return {
    advertisementId: id.toLowerCase(),
    placementCode: placement,
    event: event as AdEventName,
    viewerKey: key.toLowerCase(),
    ...(occurredAt ? { occurredAt } : {}),
    ...(typeof b.requestId === "string" ? { requestId: b.requestId.slice(0, 64) } : {}),
  };
}

export interface EnqueueOutcome {
  /** `queue` when the batch is handed to the runtime, `inline` when this Worker wrote it itself. */
  readonly path: "queue" | "inline" | "dropped";
  readonly accepted: number;
  readonly counted?: number;
  readonly note?: string;
}

/**
 * Hand a validated batch to the queue, or write it now when there is no queue.
 *
 * Returns `dropped` rather than throwing when both paths fail, and the route answers 202 anyway. That is a
 * decision, not an omission: the alternative is a 500 on a page whose only sin was showing an advertisement,
 * and an error a viewer can see for a number nobody is invoiced is the worst trade in this file.
 */
export async function recordAdEvents(env: Env, events: readonly AdEventMessage[], deps?: Partial<AdEventsRuntime>): Promise<EnqueueOutcome> {
  const runtime = { ...runtimeFor(env), ...(deps ?? {}) };
  const queue = (env as unknown as { AD_EVENTS_QUEUE?: { send(m: unknown): Promise<void> } }).AD_EVENTS_QUEUE;
  if (queue) {
    try {
      for (const event of events.slice(0, MAX_EVENTS_PER_BODY)) await queue.send(event);
      return { path: "queue", accepted: Math.min(events.length, MAX_EVENTS_PER_BODY) };
    } catch (err) {
      logError("ad-events-queue", err);
      // Fall through to the inline write: a queue that will not accept is precisely the case where the
      // request's own remaining budget should be spent rather than the counts being lost.
    }
  }
  try {
    const receipts = await runtime.sink.record(events.slice(0, MAX_EVENTS_PER_BODY));
    return { path: "inline", accepted: receipts.length, counted: receipts.filter((r) => r.counted).length };
  } catch (err) {
    if (queue) return { path: "dropped", accepted: 0, note: "queue send and inline write both failed" };
    logError("ad-events-inline", err);
    return { path: "dropped", accepted: 0, note: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

/**
 * The consumer. `batch.ack()` on success, `batch.retry()` on a database failure — and nothing in between,
 * because a partial ack would have to decide which rows the failed call had already written, which is the
 * database's dedupe's job, not this loop's.
 */
export async function handleAdEventQueue(batch: QueueBatch, env: Env, deps?: Partial<AdEventsRuntime>): Promise<AdEventReceipt[]> {
  const runtime = { ...runtimeFor(env), ...(deps ?? {}) };
  const events: AdEventMessage[] = [];
  let malformed = 0;
  for (const message of batch.messages) {
    const parsed = parseAdEvent(message.body);
    if (parsed === null) {
      message.ack();
      malformed++;
      logError("ad-events-queue", new Error(`discarded malformed queue message: ${JSON.stringify(message.body ?? null).slice(0, 200)}`));
      continue;
    }
    events.push(parsed);
  }
  // The refusal is counted and its content is logged, and the two never meet: a message body in a metric
  // dimension would be a per-viewer record wearing a metric's clothes, and the raw text of a malformed body is
  // not something a dashboard can group on either.
  if (malformed > 0) observe({ subsystem: "advertising", metric: "ingest", route: "/advertising/events", dimension: "refused", samples: malformed });
  if (events.length === 0) {
    await flushObservations(env).catch(() => undefined);
    return [];
  }
  try {
    const receipts = await runtime.sink.record(events);
    batch.ack();
    observeAdReceipts(events, receipts);
    await flushObservations(env).catch(() => undefined);
    return receipts;
  } catch (err) {
    logError("ad-events-queue", err);
    // A refused *batch* is the interesting case — it is a queue redelivery loop starting — so every message in
    // it is counted as a refusal before the retry, which is what turns 'the rollup write is failing' into a
    // rate rather than a stack of identical log lines.
    observe({ subsystem: "advertising", metric: "ingest", route: "/advertising/events", dimension: "refused", samples: events.length });
    await flushObservations(env).catch(() => undefined);
    batch.retry();
    return [];
  }
}

/**
 * The hourly maintenance pass, invoked from `scheduled` beside the media sweep.
 *
 * Three steps, in this order, because each one's answer is only meaningful after the previous: expire what has
 * run out (`kicklive_ad_expire_due`, so the tables stop claiming an expired flight is live), prune the raw log
 * past its retention (`kicklive_ad_sweep`, bounded, rollups untouched), then read the integrity counts back
 * (`kicklive_ad_diagnostics`) so the log line carries "and nothing is broken" rather than silence.
 *
 * Every step is idempotent, which is what makes it safe to also expose the same sequence as an admin button: a
 * double run must be a no-op, not a second deletion.
 */
export async function runAdMaintenance(env: Env): Promise<{ expired: unknown; swept: unknown; diagnostics: unknown }> {
  const admin = supabaseAdmin(env);
  const expired = await admin.call<unknown>("kicklive_ad_expire_due", {});
  const swept = await admin.call<unknown>("kicklive_ad_sweep", {});
  const diagnostics = await admin.call<unknown>("kicklive_ad_diagnostics", {});
  // A maintenance run is a routine event and goes to `logDebug`, not `logError`: the hour the sweep works has
  // to look the same in the logs as the hour there was nothing to prune, or the signal anyone wants ("ad
  // maintenance is failing") is buried under eight thousand lines a year of it succeeding.
  logDebug(`ad-maintenance: expire ${JSON.stringify(expired)} · sweep ${JSON.stringify(swept)} · integrity ${JSON.stringify(diagnostics)}`);
  return { expired, swept, diagnostics };
}
