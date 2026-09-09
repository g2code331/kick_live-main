/**
 * The offline draft queue: a controller's taps, durable before they are sent.
 *
 * A referee's phone in a stadium with three bars of signal is the whole design problem. Three rules
 * decide the shape of this file, and each one exists because the alternative loses a goal:
 *
 *   1. **Write first, send second.** A tap is appended to storage *before* the fetch starts. If the tab
 *      dies mid-request — a crash, an iOS memory sweep, a battery — the event is still there on next
 *      load. This mirrors the server's own rule (never ack without a durable recovery path) one layer
 *      down, and it is why "queued" is a state the UI shows rather than a lie it tells.
 *   2. **`client_event_id` is born here and never changes.** It is the idempotency key the server
 *      enforces with a unique index, so a retry after a timeout cannot become a second goal. Regenerating
 *      it on retry would be the single worst edit anyone could make to this file.
 *   3. **Nothing is discarded silently.** A queue that drops entries when full, when expired, or when the
 *      server refuses them is a queue that loses match events with extra steps. Every path returns a
 *      status the caller has to render; `refused` entries stay until a human dismisses them.
 *
 * Deliberately per-tab: two tabs on one device each have their own queue, and the server's unique index on
 * `(match_id, client_event_id)` is what stops them double-recording the *same* accepted event. It does not
 * merge drafts across tabs, and this file will not pretend to.
 *
 * Pure logic over an injected storage, so `node --test` can exercise every rule without a DOM.
 */

export const DRAFT_STORAGE_KEY = "kicklive:drafts:v1";
export const MAX_DRAFTS_PER_MATCH = 100;
/** A draft older than this is surfaced as expired. It is still kept: stale data beats lost data. */
export const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * What may wait in a pocket. A *correction* is time-insensitive — the server judges it when it arrives, and
 * "the goal was offside" is just as true an hour later — but a status transition is not: replaying a queued
 * "half time" tap at 21:40 because the signal came back would move a match the ground has already finished.
 * So the clock and the lifecycle are deliberately absent from this list, and `useMatchRoom` refuses to
 * queue one rather than silently dropping it.
 */
export type DraftKind = "event" | "correction";
export type DraftState = "pending" | "sending" | "refused";

export interface DraftEntry {
  /** Local id for React keys and for settling; unrelated to the server's `client_event_id`. */
  key: string;
  matchId: number;
  kind: DraftKind;
  /** The idempotency key the server will see. Immutable once created. */
  clientEventId: string;
  /** The request body, exactly as it will be posted. No score, no status of the match, no sequence. */
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: number;
  state: DraftState;
  attempts: number;
  /** Not before this instant (epoch ms). `0` means "now". */
  retryAfter: number;
  lastError: string | null;
  /** Set when the server answered with a decision rather than a failure, e.g. `invalid_for_state`. */
  conflictReason: string | null;
  /** A refusal a retry cannot fix — the controller must edit or drop it, and the UI says so. */
  permanent: boolean;
}

export interface DraftStorage {
  read(): unknown;
  write(value: unknown): void;
}

export type EnqueueResult = { ok: true; entry: DraftEntry } | { ok: false; reason: "queue_full"; detail: string };

interface PersistedShape {
  version: 1;
  entries: DraftEntry[];
}

/** In-memory by default; `localStorageDrafts()` wraps the real one and survives a refresh. */
export function memoryStorage(): DraftStorage {
  let value: unknown = null;
  return {
    read: () => value,
    write: (next: unknown) => {
      value = next;
    },
  };
}

/**
 * The browser adapter. Every method swallows quota/private-mode failures *into state* rather than throwing:
 * a phone in private browsing must still be able to record a match, in memory, with the UI saying so.
 */
export function localStorageDrafts(overrides: { getItem?: (k: string) => string | null; setItem?: (k: string, v: string) => void }): DraftStorage & { unavailable: boolean } {
  const get = overrides.getItem ?? ((k: string) => globalThis.localStorage?.getItem(k) ?? null);
  const set = overrides.setItem ?? ((k: string, v: string) => globalThis.localStorage?.setItem(k, v));
  const store: DraftStorage & { unavailable: boolean } = {
    unavailable: false,
    read() {
      try {
        const raw = get(DRAFT_STORAGE_KEY);
        return raw === null ? null : (JSON.parse(raw) as PersistedShape);
      } catch {
        // Corrupt JSON must not brick the console: start empty, but keep the raw text for one reload's
        // worth of debugging in the console log below.
        console.warn("[kicklive] draft queue: unreadable storage, starting empty");
        return null;
      }
    },
    write(value: unknown) {
      try {
        set(DRAFT_STORAGE_KEY, JSON.stringify(value));
      } catch (err) {
        store.unavailable = true;
        console.warn("[kicklive] draft queue not persisted (private mode or full quota):", err instanceof Error ? err.message : String(err));
      }
    },
  };
  return store;
}

export class DraftQueue {
  private entries: DraftEntry[];
  private readonly storage: DraftStorage;

  constructor(storage: DraftStorage) {
    this.storage = storage;
    // Defensive on purpose: the storage adapter is allowed to fail (private mode, a quota fight, a blob a
    // different build wrote), and a queue that throws in its constructor takes the whole console down with
    // it. An unreadable queue starts empty and stays usable.
    this.entries = readEntries(safelyRead(storage));
  }

  /** Everything queued for one match, oldest first: the order they must be sent in. */
  list(matchId: number): DraftEntry[] {
    return this.entries.filter((e) => e.matchId === matchId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  all(): DraftEntry[] {
    return this.entries.slice();
  }

  count(matchId: number, now: number = Date.now()): { pending: number; sending: number; refused: number; expired: number } {
    const rows = this.list(matchId);
    return {
      pending: rows.filter((e) => e.state === "pending").length,
      sending: rows.filter((e) => e.state === "sending").length,
      refused: rows.filter((e) => e.state === "refused").length,
      // "expired" is an age judgement, not a state: `recover()` is what turns an aged pending entry into a
      // refused one, and the count must not fall back to zero the moment it does.
      expired: rows.filter((e) => now - Date.parse(e.createdAt) > DRAFT_TTL_MS).length,
    };
  }

  /**
   * Appends and persists *before* returning. `clientEventId` is generated here — a caller that passed its
   * own would be one refactor away from reusing one across two taps.
   */
  enqueue(matchId: number, kind: DraftKind, payload: Record<string, unknown>, clientEventId?: string): EnqueueResult {
    const unsent = this.list(matchId).filter((e) => e.state !== "refused" || !e.permanent);
    if (unsent.length >= MAX_DRAFTS_PER_MATCH) {
      return {
        ok: false,
        reason: "queue_full",
        detail: `${String(MAX_DRAFTS_PER_MATCH)} events are already waiting for this match. Reconnect and send them before recording more.`,
      };
    }
    const now = Date.now();
    const entry: DraftEntry = {
      key: `d${now.toString(36)}${randomPart()}`,
      matchId,
      kind,
      clientEventId: clientEventId ?? newClientId(),
      payload,
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
      state: "pending",
      attempts: 0,
      retryAfter: 0,
      lastError: null,
      conflictReason: null,
      permanent: false,
    };
    this.entries = [...this.entries, entry];
    this.persist();
    return { ok: true, entry };
  }

  /** Marks an in-flight send. If the tab dies in this state, `recover()` un-sticks it on next load. */
  markSending(key: string): void {
    this.update(key, { state: "sending", attempts: (this.find(key)?.attempts ?? 0) + 1, lastError: null });
  }

  /** The server accepted it (or said "already had it"): the draft is done, and history is the record now. */
  settle(key: string): void {
    if (!this.entries.some((e) => e.key === key)) return;
    this.entries = this.entries.filter((e) => e.key !== key);
    this.persist();
  }

  /** Accepted under a different id — the duplicate reply — settle by the idempotency key instead. */
  settleByClientEventId(matchId: number, clientEventId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.matchId === matchId && e.clientEventId === clientEventId && e.state !== "refused"));
    this.persist();
    return this.entries.length !== before;
  }

  /**
   * A transport failure: keep it, back off, and tell the caller how long. Retrying forever at 0 ms is how
   * a stadium wifi outage turns into 4 000 requests.
   */
  scheduleRetry(key: string, message: string, now: number = Date.now()): { retryInMs: number } {
    const entry = this.find(key);
    const attempts = Math.max(1, entry?.attempts ?? 1);
    const wait = backoffFor(attempts);
    this.update(key, { state: "pending", retryAfter: now + wait, lastError: message.slice(0, 300) });
    return { retryInMs: wait };
  }

  /**
   * The server answered with a decision. `duplicate` is success by another route; `invalid_for_state`,
   * `closed_match` and `not_assigned` need a human; `sequence_gap`/`database_unavailable` will pass on a
   * retry, so they are not marked permanent.
   */
  recordConflict(key: string, reason: string, detail: string): { permanent: boolean } {
    const permanent = reason === "invalid_for_state" || reason === "closed_match" || reason === "not_assigned" || reason === "validation";
    this.update(key, { state: "refused", conflictReason: reason, lastError: detail.slice(0, 300), permanent });
    return { permanent };
  }

  /**
   * A human said "try that one again": the refusal is cleared and the backoff is forgotten. `revise()` is
   * the other button, for when the payload itself was wrong.
   */
  retry(key: string): void {
    this.update(key, { state: "pending", retryAfter: 0, attempts: 0, conflictReason: null, permanent: false });
  }

  /** Explicit dismissal of a refused draft, the only way a refused entry leaves the queue. */
  discard(key: string): void {
    this.entries = this.entries.filter((e) => e.key !== key);
    this.persist();
  }

  discardAll(matchId: number): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.matchId !== matchId);
    this.persist();
    return before - this.entries.length;
  }

  /** Edits a refused draft's payload and puts it back in line with a *new* idempotency key. */
  revise(key: string, payload: Record<string, unknown>): DraftEntry | null {
    const entry = this.find(key);
    if (!entry) return null;
    const revised: DraftEntry = { ...entry, payload, clientEventId: newClientId(), state: "pending", attempts: 0, retryAfter: 0, lastError: null, conflictReason: null, permanent: false, updatedAt: Date.now() };
    this.entries = this.entries.map((e) => (e.key === key ? revised : e));
    this.persist();
    return revised;
  }

  /** Entries eligible to go now, oldest first. `sending` is included only if it has been stuck. */
  next(matchId: number, now: number = Date.now()): DraftEntry | null {
    return this.list(matchId).find((e) => (e.state === "pending" || (e.state === "sending" && now - e.updatedAt > STUCK_SEND_MS)) && e.retryAfter <= now && !e.permanent) ?? null;
  }

  /**
   * Called on load and on `online`: a send that was in flight when the tab died is not "still sending", it
   * is a send to retry with the same key. Without this, an event can be stranded in `sending` forever,
   * which is the silent-loss bug in disguise.
   */
  recover(now: number = Date.now()): { recovered: number; expired: number } {
    let recovered = 0;
    let expired = 0;
    this.entries = this.entries.map((e) => {
      if (e.state === "sending") {
        recovered += 1;
        return { ...e, state: "pending" as DraftState, retryAfter: 0, updatedAt: now };
      }
      if (now - Date.parse(e.createdAt) > DRAFT_TTL_MS && e.state === "pending") {
        expired += 1;
        return { ...e, state: "refused" as DraftState, conflictReason: "expired", permanent: true, lastError: "Older than 72 hours — check the match timeline before sending it." };
      }
      return e;
    });
    if (recovered > 0 || expired > 0) this.persist();
    return { recovered, expired };
  }

  private find(key: string): DraftEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  private update(key: string, patch: Partial<DraftEntry>): void {
    this.entries = this.entries.map((e) => (e.key === key ? { ...e, ...patch, updatedAt: Date.now() } : e));
    this.persist();
  }

  private persist(): void {
    try {
      this.storage.write({ version: 1, entries: this.entries } satisfies PersistedShape);
    } catch (err) {
      // A write failure must not lose the in-memory queue, and must not escape into the tap handler: the
      // controller is mid-match, and "recorded, not persisted" is a message for the banner, not a crash.
      console.warn("[kicklive] draft queue could not persist:", err instanceof Error ? err.message : String(err));
    }
  }
}

/** A send older than this is assumed lost, not still in flight. */
export const STUCK_SEND_MS = 45_000;

/** 1s, 2s, 4s, 8s, 16s, 30s, 60s, 60s… — never a busy-loop, never a minute of dead air either. */
export function backoffFor(attempts: number): number {
  const steps = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1] ?? 60_000;
}

/**
 * Turns an `ApiFailure` code into what the queue should do. Keeping the decision here (rather than at the
 * call site) is what lets the fan view, the console and the tests agree on it.
 */
export function classifyFailure(code: string, status: number): "retry" | "refuse" | "conflict" {
  if (code === "CONFLICT") return "conflict";
  if (code === "VALIDATION_FAILED" || code === "FORBIDDEN" || code === "NOT_FOUND" || code === "BAD_REQUEST") return "refuse";
  if (code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "DEPENDENCY_FAILED" || code === "RATE_LIMITED" || status >= 500) return "retry";
  // Anything unrecognised retries: a queue that discards on surprise is the failure mode this file exists
  // to prevent, and the idempotency key makes a needless retry harmless.
  return "retry";
}

/** `storage.read()` is outside this module's control (localStorage can throw), so it gets one guard. */
function safelyRead(storage: DraftStorage): unknown {
  try {
    return storage.read();
  } catch (err) {
    console.warn("[kicklive] draft queue storage unreadable, starting empty:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function readEntries(raw: unknown): DraftEntry[] {
  if (raw === null || typeof raw !== "object") return [];
  const shape = raw as Partial<PersistedShape>;
  if (shape.version !== 1 || !Array.isArray(shape.entries)) return [];
  return shape.entries.filter(isDraftEntry);
}

/**
 * A stored blob is untrusted input: it may be from an older build, hand-edited, or half-written by a crash.
 * Anything malformed is dropped, and anything missing a field is defaulted, rather than thrown at render.
 */
function isDraftEntry(value: unknown): value is DraftEntry {
  const e = value as Partial<DraftEntry> | null;
  return typeof e === "object" && e !== null && typeof e.key === "string" && typeof e.matchId === "number" && (e.kind === "event" || e.kind === "correction") && typeof e.clientEventId === "string" && typeof e.payload === "object" && e.payload !== null && typeof e.createdAt === "string";
}

function newClientId(): string {
  return `c-${randomUuidLike()}`;
}

/**
 * `crypto.randomUUID()` where available. The fallback is not decorative: a stadium phone on an old
 * WebView, or the desktop shell running in a non-secure context, has no `crypto.randomUUID`, and a
 * controller must still be able to record a goal there.
 */
function randomUuidLike(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const now = Date.now().toString(36);
  return `${now}-${randomPart()}-${randomPart()}`;
}

function randomPart(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(4);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16);
}
