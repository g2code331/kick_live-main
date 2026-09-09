/**
 * `useMatchRoom` — the one place the browser talks to a live match.
 *
 * It owns four things and nothing else: the transport ladder, the reducer, the draft queue, and the
 * controller's write path. A page composes `useMatchRoom(matchId, { mode: "controller" })` and renders
 * `state`; it never calls `/events` itself, never keeps its own match timer, and never has an opinion about
 * a score. That concentration is the point — the audit found ten Match Control screens each with their own
 * polling loop and their own idea of "live", and ten opinions is how one match ends up with ten scores.
 *
 * The transport ladder, in the order it is tried:
 *
 *   1. **WebSocket** (`/api/live/matches/:id` with a short-lived ticket). Snapshot on open, then frames
 *      from `sequence + 1`. Two consecutive failures and it steps down.
 *   2. **SSE** (`/api/matches/:id/stream`). Same frames, same sequences, `Last-Event-ID` resume — for the
 *      proxy that blocks sockets, the extension that kills them, and `worker-local`, whose Node http server
 *      cannot complete a WebSocket handshake at all. This is not decoration: it is how the room gets
 *      exercised without `wrangler`.
 *   3. **Polling** (`GET /api/matches/:id`, one request for the snapshot plus the timeline). Slow, boring,
 *      and it always works — which is what "a fan is never stale indefinitely" has to end in.
 *
 * Every step-down is visible in `connection.transport`, so a page can say "live", "streaming" or "updating
 * every 15 s" truthfully instead of claiming a socket it does not have.
 *
 * The write path is deliberately unglamorous: a controller's tap is **written to the draft queue first,
 * then sent**, and the entry leaves the queue only when Postgres has answered. An accepted tap repaints
 * through the same reducer a fan uses (the ack carries the exact frame that was broadcast), so a
 * controller's screen and a fan's screen cannot disagree about what just happened.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiErrorMessage,
  assignOfficial,
  correctEvent,
  fetchAccess,
  fetchMatchDetail,
  finalizeMatch,
  liveSocketUrl,
  liveStreamUrl,
  LiveApiError,
  recordEvent,
  requestLiveTicket,
  setMatchLock,
  standDownAssignment,
  transitionMatch,
  type AssignInput,
  type CorrectionInput,
  type FinalizeInput,
  type LockInput,
  type MatchAccessData,
  type MatchMutationData,
  type RecordEventInput,
  type TransitionInput,
} from "./api.ts";
import { classifyFailure, DraftQueue, localStorageDrafts, memoryStorage, type DraftEntry, type DraftKind, type DraftStorage } from "./draftQueue.ts";
import { applyFrame, displayMinute, emptyRoomState, isStale, recoveryFor, type ConnectionMode, type RoomState } from "./machine.ts";
import { parseFrame, type LiveMessage } from "./protocol.ts";

/** How long a socket may stay silent before the hook repairs itself with a fresh snapshot. */
const STALE_BUDGET_MS = 20_000;
/** Two failures on one transport and the hook steps down. Never more: a stadium wifi flap is normal. */
const DOWNGRADE_AFTER_FAILURES = 2;
const MAX_BACKOFF_MS = 30_000;
/** The DO hibernates; a client that says nothing for a minute is the one a proxy silently drops. */
const HEARTBEAT_MS = 25_000;
const POLL_MS = { controller: 5_000, viewer: 15_000 } as const;
/** The same ladder as the queue's retry schedule, bounded for a transport reconnect. */
const RECONNECT_STEPS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export type RoomStatus = "connecting" | "live" | "retrying" | "degraded" | "offline";

export interface RoomConnection {
  status: RoomStatus;
  transport: ConnectionMode;
  /** Consecutive failures on the current transport, for the caption's "attempt 3" and for step-down. */
  failureStreak: number;
  lastFrameAt: number | null;
  /** True while the pipe is silent past `STALE_BUDGET_MS` *and* the match clock is running. */
  stale: boolean;
  lastError: string | null;
}

export interface UseMatchRoomOptions {
  /** `controller` opens a controller ticket (which the Worker refuses unless the assignment rows say so) and enables writes. */
  mode?: "viewer" | "controller";
  /** Loads `GET /access` — rights and legal transitions. Implied by `mode: "controller"`. */
  withAccess?: boolean;
  /** Set false to park the room (a modal that owns the screen, a paused background tab). */
  enabled?: boolean;
  /** Injection for tests and for a shell with no persistent storage. */
  storage?: DraftStorage;
}

export interface WriteOutcome {
  ok: boolean;
  /** The tap is stored and will be sent when the pipe returns — a normal outcome, not an error. */
  queued: boolean;
  key: string | null;
  sequence: number | null;
  error: string | null;
  /** Present when a refusal needs the controller to decide something rather than just retry. */
  needsDecision: boolean;
}

const REFUSED: Omit<WriteOutcome, "error"> = { ok: false, queued: false, key: null, sequence: null, needsDecision: false };

export function useMatchRoom(matchId: number, options: UseMatchRoomOptions = {}) {
  const mode = options.mode === "controller" ? "controller" : "viewer";
  const wantAccess = mode === "controller" || options.withAccess === true;
  const enabled = options.enabled !== false;
  const storage = options.storage;

  const [state, setState] = useState<RoomState>(() => emptyRoomState(matchId));
  const [connection, setConnection] = useState<RoomConnection>({ status: "connecting", transport: "socket", failureStreak: 0, lastFrameAt: null, stale: false, lastError: null });
  const [access, setAccess] = useState<MatchAccessData | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // `stateRef` is the truth the transport reads and writes; `state` is React's mirror of it. A frame
  // arriving inside `onmessage` cannot await a re-render, and a write issued right after a frame must not
  // carry a stale `expected_sequence` — so the ref is authoritative and `setState` only moves pixels.
  const stateRef = useRef(state);
  const commit = useCallback(
    (next: RoomState) => {
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const apply = useCallback(
    (message: LiveMessage | null): void => {
      if (message === null) return;
      const next = applyFrame(stateRef.current, message, Date.now());
      if (next !== stateRef.current) commit(next);
    },
    [commit],
  );

  const queue = useMemo(() => new DraftQueue(storage ?? (typeof localStorage === "undefined" ? memoryStorage() : localStorageDrafts({}))), [storage]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const syncDrafts = useCallback(() => setDrafts(queueRef.current.list(matchId)), [matchId]);

  // ── the draft pump ─────────────────────────────────────────────────────────

  /**
   * Turns a send failure into queue state. `already recorded` is the interesting case: the ledger has the
   * event and only the ack was lost, so the draft is settled rather than refused.
   */
  const settleFailure = useCallback((entry: DraftEntry, failure: LiveApiError | null, reasonOverride?: string): void => {
    const q = queueRef.current;
    const message = apiErrorMessage(failure);
    if (failure?.status === 409 && /already recorded/i.test(message)) {
      q.settle(entry.key);
      return;
    }
    q.recordConflict(entry.key, reasonOverride ?? (failure === null ? "network" : "validation"), message);
  }, []);

  const sendOne = useCallback(
    async (entry: DraftEntry, payload: Record<string, unknown>): Promise<MatchMutationData> => (entry.kind === "event" ? recordEvent(matchId, payload as unknown as RecordEventInput) : correctEvent(matchId, payload as unknown as CorrectionInput)),
    [matchId],
  );

  /**
   * Sends queued entries oldest-first, one at a time, until nothing is eligible.
   *
   * Sequential on purpose: two in-flight drafts from one console can land out of order, and an event applied
   * before the one the controller tapped first is a timeline that no longer matches the match. The server's
   * sequence allocator keeps the *ledger* correct either way; this is about the controller's own screen not
   * showing nonsense for a second.
   */
  const pump = useCallback(async (): Promise<void> => {
    const q = queueRef.current;
    let sent = 0;
    for (;;) {
      const entry = q.next(matchId);
      if (!entry) break;
      q.markSending(entry.key);
      // `expected_sequence` is added at send time and never stored: a draft queued during an outage carries a
      // sequence that was true then and is meaningless now, and honouring it would reject honest events.
      const payload: Record<string, unknown> = { ...entry.payload };
      // The queue owns the idempotency key, and it is stamped here rather than at tap time so it cannot be
      // lost by a caller that forgot, or changed by one that edited a draft. A correction carries its key
      // inside `replacement` because `POST /corrections` declares only four top-level fields — and a
      // voiding correction (no replacement) needs none: correcting an already-corrected row is refused by
      // the ledger, so a retry stays visible instead of becoming a double correction.
      if (entry.kind === "event") payload.client_event_id = entry.clientEventId;
      if (entry.kind === "correction" && payload.replacement !== null && typeof payload.replacement === "object" && !Array.isArray(payload.replacement)) {
        payload.replacement = { ...(payload.replacement as Record<string, unknown>), client_event_id: entry.clientEventId };
      }
      if (stateRef.current.sequence > 0) payload.expected_sequence = stateRef.current.sequence;
      try {
        const data = await sendOne(entry, payload);
        q.settle(entry.key);
        sent += 1;
        apply(data.frame ?? null);
        if (data.sequence !== null && data.sequence > stateRef.current.sequence) {
          // An ack with no following broadcast (a socket that dropped mid-send) still has to move the
          // cursor, or the next resume would re-fetch rows this client already has.
          commit({ ...stateRef.current, sequence: data.sequence, ready: true, revision: stateRef.current.revision + 1 });
        }
      } catch (err) {
        const failure = err instanceof LiveApiError ? err : null;
        const kind = classifyFailure(failure?.code ?? "NETWORK_ERROR", failure?.status ?? 0);
        if (kind === "retry" && payload.expected_sequence !== undefined) {
          // A lost optimistic-concurrency race looks exactly like a transient failure, and the honest way
          // to tell them apart is to resend without the hint: the state machine then judges the event on its
          // merits. Only a refusal that survives that retry becomes a conflict.
          const rest = { ...payload };
          delete rest.expected_sequence;
          if (entry.kind !== "event") delete rest.client_event_id;
          try {
            const retry = await sendOne(entry, rest);
            q.settle(entry.key);
            sent += 1;
            apply(retry.frame ?? null);
            continue;
          } catch (retryErr) {
            settleFailure(entry, retryErr instanceof LiveApiError ? retryErr : failure);
            break;
          }
        }
        if (kind === "retry") {
          q.scheduleRetry(entry.key, apiErrorMessage(failure));
        } else if (kind === "conflict") {
          settleFailure(entry, failure, "invalid_for_state");
        } else {
          settleFailure(entry, failure, "validation");
        }
        break;
      }
    }
    if (sent > 0) syncDrafts();
  }, [apply, commit, matchId, sendOne, settleFailure, syncDrafts]);

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  const refresh = useCallback(async (): Promise<void> => {
    if (!Number.isFinite(matchId) || matchId <= 0) return;
    try {
      apply((await fetchMatchDetail(matchId)).snapshot);
    } catch {
      // A failed refresh is not something to shout about: the transport's state already says "retrying", and
      // a second red banner on top of it is noise. This silence is exactly why `connection.stale` exists.
    }
  }, [apply, matchId]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  /** Lets the transport's `onopen` and a manual "retry now" reach the pump without re-binding the effect. */
  const actionRef = useRef<{ pump: () => void; reconnect: () => void } | null>(null);

  // ── transport ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !Number.isFinite(matchId) || matchId <= 0) return;
    if (stateRef.current.matchId !== matchId) commit(emptyRoomState(matchId));

    let disposed = false;
    let socket: WebSocket | null = null;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let failureStreak = 0;
    let transport: ConnectionMode = typeof WebSocket === "function" ? "socket" : typeof EventSource === "function" ? "stream" : "polling";

    const patch = (next: Partial<RoomConnection>) => {
      if (!disposed) setConnection((prev) => ({ ...prev, ...next }));
    };

    const clearTimers = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (heartbeat !== null) clearInterval(heartbeat);
      retryTimer = null;
      pollTimer = null;
      heartbeat = null;
    };

    const schedule = (delayMs: number) => {
      if (disposed) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) void open();
      }, Math.min(delayMs, MAX_BACKOFF_MS));
    };

    const closeTransports = () => {
      if (socket !== null) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
        socket = null;
      }
      if (source !== null) {
        source.close();
        source = null;
      }
    };

    const onOpen = () => {
      failureStreak = 0;
      patch({ status: "live", lastError: null, failureStreak: 0, stale: false });
      actionRef.current?.pump();
    };

    const onDrop = (why: string) => {
      if (disposed) return;
      clearTimers();
      failureStreak += 1;
      patch({ status: "retrying", lastError: why, failureStreak });
      if (failureStreak >= DOWNGRADE_AFTER_FAILURES && transport !== "polling") {
        transport = transport === "socket" ? "stream" : "polling";
        failureStreak = 0;
        patch({ transport, status: transport === "polling" ? "degraded" : "retrying" });
        void open();
        return;
      }
      schedule(RECONNECT_STEPS[Math.min(failureStreak, RECONNECT_STEPS.length) - 1] ?? MAX_BACKOFF_MS);
    };

    async function openSocket() {
      let url = "";
      try {
        // The ticket is fetched *inside* the attempt so an expired one (15 min for a controller) is simply
        // refetched by the next attempt rather than needing its own error path.
        const ticket = await requestLiveTicket(matchId, mode);
        if (disposed) return;
        url = liveSocketUrl(ticket);
      } catch (err) {
        onDrop(err instanceof Error ? err.message : "Could not get a live ticket for this match.");
        return;
      }
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        onOpen();
        // "what have I already seen" is the only thing this client is allowed to assert.
        const recovery = recoveryFor(stateRef.current);
        const frame = recovery.frame === "resume" ? { type: "resume" as const, after_sequence: recovery.afterSequence } : { type: "snapshot" as const };
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          /* closed between open and here; onclose handles it */
        }
        heartbeat = setInterval(() => {
          if (ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              /* the close handler will run */
            }
          }
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        apply(parseFrame(event.data, matchId));
        patch({ lastFrameAt: stateRef.current.lastFrameAt, stale: false });
      };
      ws.onerror = () => patch({ lastError: "The live socket reported an error." });
      ws.onclose = () => {
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        onDrop("The live socket closed.");
      };
    }

    function openStream() {
      if (typeof EventSource !== "function") {
        transport = "polling";
        patch({ transport, status: "degraded" });
        void open();
        return;
      }
      const es = new EventSource(liveStreamUrl(matchId, stateRef.current.sequence), { withCredentials: false });
      source = es;
      es.onopen = () => onOpen();
      for (const type of ["MATCH_SNAPSHOT", "MATCH_EVENT", "MATCH_STATUS", "MATCH_CLOCK", "MATCH_ERROR", "SYNC_CONFLICT", "CONTROLLERS"] as const) {
        es.addEventListener(type, (event: MessageEvent<string>) => apply(parseFrame(event.data, matchId)));
      }
      es.onerror = () => {
        // EventSource reconnects by itself and replays with `Last-Event-ID`. `readyState === 2` means it
        // gave up, which is the moment to step down rather than sit on a dead pipe.
        if (es.readyState === 2) {
          es.close();
          source = null;
          onDrop("The SSE stream ended.");
        }
      };
    }

    async function pollOnce() {
      await refreshRef.current();
      if (!disposed && transport === "polling") {
        patch({ status: "degraded", lastFrameAt: stateRef.current.lastFrameAt });
        pollTimer = setTimeout(() => {
          pollTimer = null;
          if (!disposed) void pollOnce();
        }, POLL_MS[mode]);
      }
    }

    function open(): void {
      if (disposed) return;
      closeTransports();
      if (transport === "socket") void openSocket();
      else if (transport === "stream") openStream();
      else {
        clearTimers();
        void pollOnce();
      }
    }

    actionRef.current = {
      pump: () => void pumpRef.current(),
      reconnect: () => schedule(0),
    };
    void open();

    const onOnline = () => {
      failureStreak = 0;
      void pumpRef.current();
      schedule(0);
    };
    const onVisibility = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      // Backgrounded tabs get throttled sockets; on return, do not wait for the next keepalive to notice.
      if (isStale(stateRef.current, Date.now(), transport)) void refreshRef.current();
      void pumpRef.current();
    };
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("online", onOnline);
      globalThis.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      disposed = true;
      actionRef.current = null;
      clearTimers();
      closeTransports();
      if (typeof globalThis.removeEventListener === "function") {
        globalThis.removeEventListener("online", onOnline);
        globalThis.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [apply, commit, matchId, mode]);

  // ── the one-second pulse ───────────────────────────────────────────────────
  // A single interval drives the minute ticker, the staleness rule and the retry nudge, rather than three
  // timers that drift apart. It only runs while the room is enabled.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const current = stateRef.current;
      const stale = isStale(current, at, connection.transport);
      if (stale && !connection.stale) {
        setConnection((prev) => ({ ...prev, stale: true }));
        void refreshRef.current();
        actionRef.current?.pump();
      } else if (!stale && connection.stale) {
        setConnection((prev) => ({ ...prev, stale: false }));
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [connection.stale, connection.transport, enabled]);

  useEffect(() => {
    // Un-stick a send that was in flight when the tab died, and surface anything older than the TTL.
    queueRef.current.recover();
    syncDrafts();
  }, [syncDrafts]);

  // ── access ─────────────────────────────────────────────────────────────────
  const reloadAccess = useCallback(async () => {
    if (!wantAccess) return;
    try {
      setAccess(await fetchAccess(matchId));
      setAccessError(null);
    } catch (err) {
      setAccess(null);
      setAccessError(err instanceof Error ? err.message : "Could not read your rights for this match.");
    }
  }, [matchId, wantAccess]);

  // Rights and legal moves both depend on the status, so a transition refreshes them. `/access` is the only
  // source for either: the console keeps no copy of the state machine, which is how ten screens used to
  // end up with ten slightly different ideas of what "half time" unlocks.
  useEffect(() => {
    void reloadAccess();
  }, [reloadAccess, state.status]);

  // ── writes ─────────────────────────────────────────────────────────────────
  const enqueueAndSend = useCallback(
    async (kind: DraftKind, payload: Record<string, unknown>): Promise<WriteOutcome> => {
      const q = queueRef.current;
      const result = q.enqueue(matchId, kind, payload);
      if (!result.ok) {
        return { ...REFUSED, queued: false, error: result.detail, needsDecision: true };
      }
      syncDrafts();
      await pumpRef.current();
      const remaining = q.list(matchId).find((e) => e.key === result.entry.key);
      if (!remaining) {
        return { ok: true, queued: false, key: result.entry.key, sequence: stateRef.current.sequence, error: null, needsDecision: false };
      }
      return { ok: false, queued: remaining.state !== "refused", key: remaining.key, sequence: null, error: remaining.lastError, needsDecision: remaining.permanent };
    },
    [matchId, syncDrafts],
  );

  /** One tap, one row. The minute here is the *event's* minute, which the controller owns; the match clock is not. */
  const record = useCallback((input: Omit<RecordEventInput, "client_event_id" | "expected_sequence">): Promise<WriteOutcome> => enqueueAndSend("event", { ...input }), [enqueueAndSend]);

  const correct = useCallback((input: Omit<CorrectionInput, "expected_sequence">): Promise<WriteOutcome> => enqueueAndSend("correction", { ...input }), [enqueueAndSend]);

  /**
   * Status changes go out inline and are never queued: half time at 21:40 because the signal came back at
   * 21:40 is not a correction, it is a different match. An offline console is told "no", and the server's
   * clock keeps its integrity.
   */
  const transition = useCallback(
    async (input: TransitionInput): Promise<WriteOutcome> => {
      if (connection.stale && connection.transport !== "polling") {
        return { ...REFUSED, error: "The live connection is stalled, and a status change is never queued. Refresh the room, then try again.", needsDecision: true };
      }
      try {
        const data = await transitionMatch(matchId, { ...input, expected_sequence: stateRef.current.sequence || undefined });
        apply(data.frame ?? null);
        await reloadAccess();
        return { ok: true, queued: false, key: null, sequence: data.sequence, error: null, needsDecision: false };
      } catch (err) {
        return outcomeFromError(err);
      }
    },
    [apply, connection.stale, connection.transport, matchId, reloadAccess],
  );

  const finalize = useCallback(
    async (input: FinalizeInput): Promise<WriteOutcome> => {
      try {
        const data = await finalizeMatch(matchId, input);
        apply(data.frame ?? null);
        await reloadAccess();
        return { ok: true, queued: false, key: null, sequence: data.sequence, error: null, needsDecision: false };
      } catch (err) {
        return outcomeFromError(err);
      }
    },
    [apply, matchId, reloadAccess],
  );

  const lock = useCallback(
    async (input: LockInput): Promise<WriteOutcome> => {
      try {
        const data = await setMatchLock(matchId, input);
        apply(data.frame ?? null);
        await reloadAccess();
        return { ok: true, queued: false, key: null, sequence: data.sequence, error: null, needsDecision: false };
      } catch (err) {
        return outcomeFromError(err);
      }
    },
    [apply, matchId, reloadAccess],
  );

  const assign = useCallback(
    async (input: AssignInput): Promise<WriteOutcome> => {
      try {
        await assignOfficial(matchId, input);
        await reloadAccess();
        return { ok: true, queued: false, key: null, sequence: null, error: null, needsDecision: false };
      } catch (err) {
        return outcomeFromError(err);
      }
    },
    [matchId, reloadAccess],
  );

  const standDown = useCallback(
    async (assignmentId: string): Promise<WriteOutcome> => {
      try {
        await standDownAssignment(matchId, assignmentId);
        await reloadAccess();
        return { ok: true, queued: false, key: null, sequence: null, error: null, needsDecision: false };
      } catch (err) {
        return outcomeFromError(err);
      }
    },
    [matchId, reloadAccess],
  );

  const retryDraft = useCallback(
    async (key: string) => {
      queueRef.current.retry(key);
      syncDrafts();
      await pumpRef.current();
      return !queueRef.current.list(matchId).some((e) => e.key === key);
    },
    [matchId, syncDrafts],
  );

  const discardDraft = useCallback(
    (key: string) => {
      queueRef.current.discard(key);
      syncDrafts();
    },
    [syncDrafts],
  );

  /** Edits a refused draft and gives it a fresh idempotency key, since it is now a different claim. */
  const reviseDraft = useCallback(
    async (key: string, payload: Record<string, unknown>) => {
      const revised = queueRef.current.revise(key, payload);
      syncDrafts();
      if (revised === null) return false;
      await pumpRef.current();
      return !queueRef.current.list(matchId).some((e) => e.key === key);
    },
    [matchId, syncDrafts],
  );

  const discardAllDrafts = useCallback(() => {
    queueRef.current.discardAll(matchId);
    syncDrafts();
  }, [matchId, syncDrafts]);

  const clock = displayMinute(state.clock, now);

  return {
    state,
    connection,
    access,
    accessError,
    drafts,
    draftCounts: queue.count(matchId),
    clock,
    /** Lets a page render "updated 12s ago" from the same number the hook judges staleness with. */
    secondsSinceFrame: state.lastFrameAt === null ? null : Math.max(0, Math.round((now - state.lastFrameAt) / 1000)),
    staleBudgetMs: STALE_BUDGET_MS,
    isController: mode === "controller",
    actions: {
      record,
      correct,
      transition,
      finalize,
      lock,
      assign,
      standDown,
      refresh,
      reloadAccess,
      retryDraft,
      discardDraft,
      reviseDraft,
      discardAllDrafts,
      sendDraftsNow: () => void pumpRef.current(),
      reconnectNow: () => actionRef.current?.reconnect(),
    },
  };
}

export type UseMatchRoomResult = ReturnType<typeof useMatchRoom>;

function outcomeFromError(err: unknown): WriteOutcome {
  const failure = err instanceof LiveApiError ? err : null;
  return { ...REFUSED, error: apiErrorMessage(failure), needsDecision: failure?.status === 403 || failure?.status === 409 };
}
