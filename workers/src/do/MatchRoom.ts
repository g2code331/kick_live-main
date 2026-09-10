/**
 * MatchRoom — one Durable Object instance per match, keyed by the match id.
 *
 * Responsibilities, and only these:
 *
 *   1. **ordering** — hand each accepted mutation the sequence Postgres allocated, and never let two
 *      writes interleave (`serialise` below queues them inside the isolate), so the number a fan sees on
 *      frame N is the row the database committed as Nth;
 *   2. **broadcast** — push the smallest frame that conveys the change (`MATCH_EVENT`, `MATCH_STATUS`,
 *      `MATCH_CLOCK`) rather than making every screen refetch teams/players/fixtures (step 23);
 *   3. **clock** — derive the minute from server-side timestamps, so no browser `setInterval` is
 *      authoritative (step 16);
 *   4. **recovery** — answer `after=SEQ` with the events in between, or say "take a snapshot" when the
 *      gap is wider than the retained window (step 12);
 *   5. **connections** — hold the sockets, with hibernation, so thousands of idle fans cost no compute.
 *
 * It is **not** the permanent store. Every mutation is persisted through `kicklive_record_match_event`
 * (or its siblings) *before* it is acknowledged or broadcast, which buys three properties:
 *
 *   - a POST whose 200 the controller saw is a row in Postgres — an acknowledged event always has a
 *     durable recovery path (step 20);
 *   - if Postgres is unreachable, the client gets 503 `DEPENDENCY_FAILED` and **nothing** is broadcast:
 *     no phantom goal on the fans' screens, no silent loss either — the console keeps the event in its
 *     draft queue and retries with the same `client_event_id`;
 *   - after eviction, restart or a redeploy, the first request rehydrates from
 *     `kicklive_match_live_state` and the sequence continues from `matches.live_seq`.
 *
 * Two rules keep this object from becoming a side door:
 *
 *   - **it holds no credentials.** The caller's bearer token is read from the subrequest's `authorization`
 *     header, used for that one Postgres call, and never written to storage. Reads that have no caller
 *     token (a fan's socket, the SSE poller) go as `anon` and are therefore subject to RLS — the object
 *     never uses the service role, so a bug here cannot exceed what the data already allows to be public.
 *   - **authorisation is not decided here.** The Worker route has already checked the capability matrix and
 *     the assignment; the object re-checks *state* (closed match, locked, illegal transition, impossible
 *     event) because that is the part it owns. The database is the last line, not this object.
 *
 * Because hibernation can evict the instance between messages, anything that must survive is read from
 * `state.storage` rather than trusted from a class field.
 */
import type { Env } from "../env.ts";
import { logError } from "../lib/debug.ts";
import { flushObservations, observe, observeGauge } from "../lib/observability.ts";
import { classify } from "../lib/errors.ts";
import { ApiError, json, ok } from "../lib/response.ts";
import { assertRecordable, inspectEvent, type EventLike } from "../lib/matchEvents.ts";
import { assertTransition, canRecordEvents, clockKind, MATCH_STATUS_VALUES, minuteCeiling, periodOf, type MatchStatus } from "../lib/matchLifecycle.ts";
import { correctEvent, finalizeMatch, liveState, loadEvents, recordEvent, setMatchLock, transitionMatch, type MutationResult } from "../services/matchPersistence.ts";
import { supabaseAnon, supabaseAsUser, type SupabaseRest } from "../services/supabase.ts";
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type LiveClock,
  type LiveEvent,
  type LiveMatchInfo,
  type LiveMessage,
  type LiveScore,
  type MatchSnapshot,
  type SyncConflictMessage,
} from "../types/live.ts";

/** Events kept in the room for cheap replay. Anything older is read from Postgres, which has it all. */
const RETAINED_EVENTS = 60;
/** Upper bound on a single replay; past it the client takes a snapshot instead (a step is a step). */
const MAX_REPLAY_EVENTS = 200;
const CLOCK_TICK_SECONDS = 15;

const VIEWERS = (matchId: number): string => `m${String(matchId)}:v`;
const CONTROLLERS = (matchId: number): string => `m${String(matchId)}:c`;

interface RoomState {
  version: 1;
  matchId: number;
  status: MatchStatus;
  score: LiveScore;
  /** Highest sequence this room has committed. Postgres owns the allocation; this mirrors it. */
  sequence: number;
  clockStartedAt: string | null;
  elapsedBeforePause: number;
  stoppage: number | null;
  isLocked: boolean;
  info: LiveMatchInfo;
  events: LiveEvent[];
  updatedAt: string;
}

/**
 * What a reconnecting client gets back. `status`/`score`/`clock` ride along even on a replay so a client
 * can settle its view from one round trip — and because `clock.status` is how every frame tells the
 * viewer which period is running, no separate "what is the status now" call is ever needed.
 */
export interface ReplayResult {
  mode: "events" | "snapshot";
  sequence: number;
  events: LiveEvent[];
  status: MatchStatus;
  score: LiveScore;
  clock: LiveClock;
  reason?: string;
}

export class MatchRoom {
  state: DurableObjectState;

  env: Env;

  /** Mutation tail. One write in flight per match keeps broadcast order equal to commit order. */
  tail: Promise<unknown> = Promise.resolve();

  /** Only used to avoid re-sending a MATCH_CLOCK frame every 15 seconds for a minute that has not moved. */
  lastMinuteSent = -1;

  /** When the connections gauge was last sampled. See `emitConnectionsGauge`. */
  lastGaugeAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ── entry point ─────────────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matchId = Number(url.pathname.split("/").filter(Boolean)[0] ?? "0");
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return json({ success: false, error: { code: "BAD_REQUEST", message: "A MatchRoom path must begin with the match id." } }, { status: 400 });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return await this.upgrade(request, matchId, url);

    const action = url.pathname.replace(/^\/\d+/, "").replace(/\/+$/, "");
    try {
      switch (`${request.method} ${action}`) {
        case "GET /snapshot": {
          // The fallback transport's read: an SSE client, a poller, or a socket that gave up. Counted apart
          // from the pushed snapshots so 'the websocket layer is not working' is visible while it is still
          // only a ratio rather than a complaint.
          observe({ subsystem: "live", metric: "snapshots", route: `/live/matches/:matchId`, dimension: "poll", samples: 1 });
          return ok(await this.snapshotFrame(matchId, await this.load(matchId)));
        }
        case "GET /events":
          return ok(await this.replay(matchId, Number(url.searchParams.get("after") ?? "0")));
        case "GET /diagnostics":
          return ok(await this.diagnostics(matchId));
        case "POST /events":
          return await this.serialise(() => this.handleEvent(matchId, request));
        case "POST /transition":
          return await this.serialise(() => this.handleTransition(matchId, request));
        case "POST /corrections":
          return await this.serialise(() => this.handleCorrection(matchId, request));
        case "POST /finalize":
          return await this.serialise(() => this.handleFinalize(matchId, request));
        case "POST /lock":
          return await this.serialise(() => this.handleLock(matchId, request));
        case "POST /refresh":
          observe({ subsystem: "live", metric: "snapshots", route: `/live/matches/:matchId`, dimension: "poll", samples: 1 });
          return ok(await this.snapshotFrame(matchId, await this.refresh(matchId)));
        default:
          return json({ success: false, error: { code: "NOT_FOUND", message: `No MatchRoom action for ${request.method} ${action}` } }, { status: 404 });
      }
    } catch (err) {
      // A live-match mutation that failed is the number an operator cares about most at 21:00, and this catch
      // is the only place that sees every failure of every action. Counted by category (database, websocket,
      // validation) and against the route pattern, never with the message: the sentence is already in the log
      // line below with the same join key, and a metric that carries text is a log in disguise.
      observe({
        subsystem: "live",
        metric: "event_failures",
        route: "/live/matches/:matchId",
        dimension: classify(err).category,
        samples: 1,
      });
      if (err instanceof ApiError) {
        return json(
          { success: false, error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}), ...(err.detail ? { detail: err.detail } : {}) } },
          { status: err.status },
        );
      }
      logError(`do:match:${String(matchId)}`, err);
      return json({ success: false, error: { code: "INTERNAL_ERROR", message: "The live match room could not handle this request." } }, { status: 500 });
    }
  }

  /**
   * Run `work` after everything queued before it. A rejected link still has to advance the tail, or one
   * bad event would freeze the match for everyone — hence `.catch(() => undefined)` on the chain but not
   * on the returned promise.
   */
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    // How long a committed change waited behind the tail — the part of a fan's 'the goal has not appeared yet'
    // that the network is not responsible for. This attaches a second consumer of the same promise instead of
    // chaining onto the returned one, so the caller still sees the original promise and its original failure.
    run.then(
      () => observe({ subsystem: "live", metric: "lag", route: "/live/matches/:matchId", dimension: "write_tail", samples: 1, durationMs: Date.now() - queuedAt }),
      () => undefined,
    );
    return run;
  }

  // ── state ───────────────────────────────────────────────────────────────────
  private async load(matchId: number): Promise<RoomState> {
    const stored = await this.state.storage.get<RoomState>("room");
    if (stored && stored.version === 1 && stored.matchId === matchId) return stored;
    return await this.refresh(matchId);
  }

  /**
   * Rebuild from Postgres — the only way state is created, so a room can never hold an opinion the
   * database does not. Used on first touch after eviction, after a correction, and by `/refresh`.
   */
  private async refresh(matchId: number): Promise<RoomState> {
    const snapshot = await liveState(this.reader(), matchId);
    if (!snapshot) throw new ApiError("NOT_FOUND", 404, "No match with that id.");
    const room: RoomState = {
      version: 1,
      matchId,
      status: snapshot.status,
      score: snapshot.score,
      sequence: snapshot.sequence,
      clockStartedAt: snapshot.clock.started_at,
      elapsedBeforePause: snapshot.clock.elapsed_before_pause,
      stoppage: snapshot.clock.stoppage,
      isLocked: snapshot.match.is_locked,
      info: snapshot.match,
      events: snapshot.events.slice(-RETAINED_EVENTS),
      updatedAt: new Date().toISOString(),
    };
    await this.state.storage.put("room", room);
    this.lastMinuteSent = -1;
    return room;
  }

  private async save(room: RoomState): Promise<void> {
    room.updatedAt = new Date().toISOString();
    await this.state.storage.put("room", room);
  }

  /**
   * Reads as `anon` unless this subrequest carries a token, in which case read as the caller — the
   * published result of a match is public data, so a fan's socket never needs more than that, and RLS is
   * what decides if the caller may see more.
   */
  private reader(request?: Request): SupabaseRest {
    const token = bearer(request);
    if (token) return supabaseAsUser(this.env, token);
    try {
      return supabaseAnon(this.env);
    } catch {
      throw new ApiError("DEPENDENCY_FAILED", 503, "SUPABASE_ANON_KEY is not configured on this Worker, so public live reads cannot be served.");
    }
  }

  /** Reads that must be authorised (a mutation's write path) refuse instead of silently downgrading. */
  private writer(request: Request): SupabaseRest {
    const token = bearer(request);
    if (!token) throw new ApiError("UNAUTHENTICATED", 401, "The match room needs the caller's token to persist a change.");
    return supabaseAsUser(this.env, token);
  }

  // ── mutations ───────────────────────────────────────────────────────────────
  private async handleEvent(matchId: number, request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: string; isAdmin?: boolean; expectedSequence?: number | null; event: Record<string, unknown> };
    const event = body.event ?? {};
    const clientEventId = str(event.client_event_id);
    const type = str(event.event_type);
    if (!type) throw new ApiError("VALIDATION_FAILED", 400, "event_type is required.", { fields: [{ field: "event_type", message: "required" }] });
    const spec = assertRecordable(type); // lifecycle types must arrive as a transition, not as a button

    const room = await this.load(matchId);
    const rest = this.writer(request);

    // `afterClose` is the one exception the state machine grants: an admin back-filling an event after
    // full time is legitimate (a data operator spotting a missed corner three days later), and the audit
    // row records that it happened outside the match. Nobody else gets that.
    const allowedAfterClose = body.isAdmin === true && spec.afterClose === true;

    // State gates, in the order a controller needs to hear them.
    if (room.isLocked && !body.isAdmin) {
      return await this.conflict(matchId, room, "closed_match", clientEventId, "This match is locked. An admin must unlock it before anything else is recorded.");
    }
    if (!canRecordEvents(room.status) && !allowedAfterClose) {
      return await this.conflict(
        matchId,
        room,
        "closed_match",
        clientEventId,
        `The match is ${room.status}, so ordinary live events are closed. Correct an event instead, or ask an admin to reopen the match.`,
      );
    }

    const minute = num(event.minute) ?? 0;
    const candidate: EventLike = {
      event_type: type,
      team_id: num(event.team_id),
      player_id: num(event.player_id),
      assist_player_id: num(event.assist_player_id),
      minute,
      period: periodOf(room.status),
      event_status: "active",
      sequence: room.sequence + 1,
      goal_type: str(event.goal_type),
    };
    const problems = inspectEvent(candidate, {
      existing: room.events.map(toEventLike),
      homeTeamId: room.info.home_team_id ?? -1,
      awayTeamId: room.info.away_team_id ?? -1,
      status: room.status,
      isAdmin: body.isAdmin === true,
    });
    const ceiling = minuteCeiling(room.status);
    if (minute < 0) problems.push({ field: "minute", message: "cannot be negative" });
    if (minute > ceiling) problems.push({ field: "minute", message: `is beyond the ${String(ceiling)}-minute ceiling for ${periodOf(room.status)}; a wrong minute is corrected, not recorded twice` });
    if (problems.length > 0) {
      throw new ApiError("VALIDATION_FAILED", 400, "This event is not consistent with the match.", { fields: problems });
    }

    const result = await recordEvent(rest, {
      matchId,
      clientEventId: clientEventId ?? crypto.randomUUID(),
      eventType: type,
      teamId: candidate.team_id,
      playerId: candidate.player_id,
      assistPlayerId: candidate.assist_player_id ?? null,
      minute,
      extraMinute: num(event.extra_minute) ?? 0,
      description: str(event.description),
      goalType: str(event.goal_type),
      cardReason: str(event.card_reason),
      metadata: isRecord(event.metadata) ? event.metadata : null,
      expectedSequence: typeof body.expectedSequence === "number" ? body.expectedSequence : null,
      allowDuplicateContent: event.allow_duplicate_content === true,
    });

    if (result.rejected) {
      return await this.conflict(
        matchId,
        room,
        "sequence_gap",
        clientEventId,
        `The server moved on without you: ${result.rejected.reason}. The match is now at sequence ${String(result.rejected.actual_sequence)}.`,
      );
    }

    const changed = await this.applyResult(matchId, room, result);
    // Nothing is broadcast until the write is committed and the room's view matches it. A replayed
    // `client_event_id` is *settled* rather than re-broadcast, so the crowd never sees the goal twice.
    if (result.event) {
      const frame: LiveMessage = {
        version: PROTOCOL_VERSION,
        matchId,
        type: "MATCH_EVENT",
        sequence: result.sequence,
        at: new Date().toISOString(),
        event: result.event,
        score: result.score,
        clock: this.clockOf(room),
      };
      if (changed && result.duplicate !== true) await this.broadcast(matchId, frame, "all");
      return ok({ accepted: true, duplicate: result.duplicate === true, changed, frame }, { requestId: body.requestId });
    }
    // The commit succeeded but the RPC handed back no row (only possible if the event was folded into
    // another one). Rather than invent a frame, send the truth: a fresh snapshot, which every client
    // already knows how to apply.
    observe({ subsystem: "live", metric: "snapshots", route: `/live/matches/:matchId`, dimension: "push", samples: 1 });
    const snapshot = await this.snapshotFrame(matchId, await this.load(matchId));
    if (changed) await this.broadcast(matchId, snapshot, "all");
    return ok({ accepted: true, duplicate: result.duplicate === true, changed, snapshot }, { requestId: body.requestId });
  }

  private async handleTransition(matchId: number, request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: string; isAdmin?: boolean; to?: string; reason?: string | null; stoppage?: number | null; expectedSequence?: number | null };
    const room = await this.load(matchId);
    const rest = this.writer(request);
    const to = (body.to ?? "") as MatchStatus;
    if (!MATCH_STATUS_VALUES.includes(to)) {
      throw new ApiError("VALIDATION_FAILED", 400, "Unknown target status.", { fields: [{ field: "status", message: `must be one of: ${MATCH_STATUS_VALUES.join(", ")}` }] });
    }
    // Checked here for a helpful message, and again inside the database for the guarantee.
    const transition = assertTransition(room.status, to, body.isAdmin === true);
    if (transition.reasonRequired === true && (body.reason ?? "").trim().length < 3) {
      throw new ApiError("VALIDATION_FAILED", 400, `${transition.label} needs a reason — it goes in the match audit trail.`, { fields: [{ field: "reason", message: "at least 3 characters" }] });
    }

    const result = await transitionMatch(rest, {
      matchId,
      toStatus: to,
      reason: (body.reason ?? null)?.trim() || null,
      stoppage: num(body.stoppage),
      expectedSequence: typeof body.expectedSequence === "number" ? body.expectedSequence : null,
    });
    if (result.rejected) {
      return await this.conflict(matchId, room, "sequence_gap", null, `The status change lost the race: ${result.rejected.reason}.`);
    }
    await this.applyResult(matchId, room, result);
    const frame: LiveMessage = {
      version: PROTOCOL_VERSION,
      matchId,
      type: "MATCH_STATUS",
      sequence: result.sequence,
      at: new Date().toISOString(),
      status: result.status,
      previous_status: room.status,
      label: transition.label,
      reason: (body.reason ?? null)?.trim() || null,
      clock: result.clock,
      score: result.score,
      event: result.event,
    };
    await this.broadcast(matchId, frame, "all");
    return ok({ accepted: true, frame }, { requestId: body.requestId });
  }

  /**
   * A correction is an event in its own right; the original row is marked `corrected` and stays. Because
   * the score is a fold over the surviving rows, the recalculated number cannot disagree with an
   * edit — there is no "set the score" path anywhere. The room re-reads from Postgres afterwards rather
   * than trying to predict what the database did.
   */
  private async handleCorrection(matchId: number, request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: string; eventId?: number; reason?: string; replacement?: Record<string, unknown> | null; expectedSequence?: number | null };
    const room = await this.load(matchId);
    const eventId = num(body.eventId);
    const reason = (body.reason ?? "").trim();
    if (eventId === null) throw new ApiError("VALIDATION_FAILED", 400, "event_id is required.", { fields: [{ field: "event_id", message: "required" }] });
    if (reason.length < 3)
      throw new ApiError("VALIDATION_FAILED", 400, "A correction needs a reason; it is the audit trail for a league dispute.", { fields: [{ field: "reason", message: "at least 3 characters" }] });
    const target = room.events.find((e) => e.id === eventId);
    if (!target && room.events.length === RETAINED_EVENTS) {
      throw new ApiError("VALIDATION_FAILED", 400, "That event is outside this match's live window. Open the full history and correct it from there.");
    }

    const result = await correctEvent(this.writer(request), {
      eventId,
      reason,
      replacement: isRecord(body.replacement) ? body.replacement : null,
      expectedSequence: typeof body.expectedSequence === "number" ? body.expectedSequence : null,
    });
    if (result.rejected) return await this.conflict(matchId, room, "sequence_gap", null, `The correction lost the race: ${result.rejected.reason}.`);

    // Re-read from Postgres instead of patching the buffer: the score is a fold over the surviving rows,
    // so this cannot disagree with the database, and a snapshot is unambiguous for every client.
    const fresh = await this.refresh(matchId);
    const snapshot = await this.snapshotFrame(matchId, fresh);
    await this.broadcast(matchId, snapshot, "all");
    // The controller learns which row was replaced and who recorded it; a fan just sees the timeline move.
    return ok({ accepted: true, corrected_event_id: eventId, reason, replacement_event_id: result.event?.id ?? null, score: fresh.score, snapshot }, { requestId: body.requestId });
  }

  private async handleFinalize(matchId: number, request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: string; confirmed?: boolean; note?: string | null };
    const room = await this.load(matchId);
    if (body.confirmed !== true) {
      throw new ApiError("VALIDATION_FAILED", 400, "Finalizing locks the result and publishes it to fans. Send confirmed: true to go ahead.");
    }
    const result = await finalizeMatch(this.writer(request), matchId, body.confirmed === true);
    await this.applyResult(matchId, room, result);
    const frame: LiveMessage = {
      version: PROTOCOL_VERSION,
      matchId,
      type: "MATCH_STATUS",
      sequence: result.sequence,
      at: new Date().toISOString(),
      status: result.status,
      previous_status: room.status,
      label: "Result finalized",
      reason: (body.note ?? null)?.trim() || null,
      clock: result.clock,
      score: result.score,
      event: result.event,
    };
    await this.broadcast(matchId, frame, "all");
    return ok({ accepted: true, frame }, { requestId: body.requestId });
  }

  private async handleLock(matchId: number, request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: string; locked?: boolean; reason?: string | null };
    const room = await this.load(matchId);
    const locked = body.locked === true;
    if (locked && (body.reason ?? "").trim().length < 3)
      throw new ApiError("VALIDATION_FAILED", 400, "Locking a match suspends everyone's edits; give a reason.", { fields: [{ field: "reason", message: "at least 3 characters" }] });
    const result = await setMatchLock(this.writer(request), matchId, locked, (body.reason ?? null)?.trim() || null);
    room.isLocked = result.is_locked;
    room.info = { ...room.info, is_locked: result.is_locked };
    await this.save(room);
    const frame: LiveMessage = {
      version: PROTOCOL_VERSION,
      matchId,
      type: "MATCH_STATUS",
      sequence: room.sequence,
      at: new Date().toISOString(),
      status: room.status,
      previous_status: room.status,
      label: result.is_locked ? "Match locked" : "Match unlocked",
      reason: (body.reason ?? null)?.trim() || null,
      clock: this.clockOf(room),
      score: room.score,
      event: null,
    };
    await this.broadcast(matchId, frame, "all");
    return ok({ accepted: true, is_locked: result.is_locked, frame }, { requestId: body.requestId });
  }

  /**
   * Commit → room → sockets, in that order. Returns false when the sequence did not advance (an
   * idempotent replay), which is how a duplicate POST stays invisible on fans' screens.
   */
  private async applyResult(matchId: number, room: RoomState, result: MutationResult): Promise<boolean> {
    const changed = result.sequence > room.sequence;
    room.sequence = result.sequence;
    room.status = result.status;
    room.score = result.score;
    room.clockStartedAt = result.clock.started_at;
    room.elapsedBeforePause = result.clock.elapsed_before_pause;
    room.stoppage = result.clock.stoppage;
    if (result.event) room.events = [...room.events, result.event].slice(-RETAINED_EVENTS);
    await this.save(room);
    this.lastMinuteSent = -1;
    await this.ensureAlarm();
    return changed;
  }

  /**
   * Rejected-with-context. The controller's console surfaces this as `SYNC CONFLICT` with the server's
   * snapshot attached, so a stale draft is *decided*, never discarded (step 15).
   */
  private async conflict(matchId: number, room: RoomState, reason: SyncConflictMessage["reason"], clientEventId: string | null, detail: string): Promise<Response> {
    // The reason is already a bounded enum, so it can be the dimension verbatim. What is not recorded is the
    // client event id or the rejected payload: a refused frame is a count, and its contents are retrievable
    // from the log by whoever sent them.
    observe({
      subsystem: "live",
      metric: "rejected",
      route: `/live/matches/:matchId`,
      dimension: String(reason)
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_")
        .slice(0, 32),
      samples: 1,
    });
    const snapshot = await this.snapshotFrame(matchId, room);
    const frame: SyncConflictMessage = {
      version: PROTOCOL_VERSION,
      matchId,
      type: "SYNC_CONFLICT",
      sequence: room.sequence,
      at: new Date().toISOString(),
      reason,
      client_event_id: clientEventId,
      detail,
      snapshot,
    };
    await this.broadcast(matchId, frame, "controllers");
    return json({ success: false, error: { code: "CONFLICT", message: detail } }, { status: 409 });
  }

  // ── reads / recovery ────────────────────────────────────────────────────────
  private async snapshotFrame(matchId: number, room: RoomState): Promise<MatchSnapshot> {
    return {
      version: PROTOCOL_VERSION,
      matchId,
      type: "MATCH_SNAPSHOT",
      sequence: room.sequence,
      at: new Date().toISOString(),
      status: room.status,
      score: room.score,
      clock: this.clockOf(room),
      body: {
        match: room.info,
        clock: this.clockOf(room),
        score: room.score,
        events: room.events.slice(-RETAINED_EVENTS),
        rebuilt_from_database: false,
        controllers_online: count(this.state.getWebSockets(CONTROLLERS(matchId))),
        viewers_online: count(this.state.getWebSockets(VIEWERS(matchId))),
      },
    };
  }

  /**
   * Replay for a reconnecting client. Cheap when the buffer covers the gap; otherwise Postgres is asked
   * for the rows in between; when even that is too wide, the answer is "snapshot". There is no third
   * outcome, which is what makes "reload the page" unnecessary (step 12).
   */
  private async replay(matchId: number, after: number, request?: Request): Promise<ReplayResult> {
    const room = await this.load(matchId);
    const floor = Number.isFinite(after) && after > 0 ? Math.trunc(after) : 0;
    const now = { status: room.status, score: room.score, clock: this.clockOf(room), sequence: room.sequence };
    if (floor >= room.sequence) return { mode: "events", events: [], ...now };
    const buffered = room.events.filter((e) => e.sequence > floor);
    const lowest = buffered.length > 0 ? Math.min(...buffered.map((e) => e.sequence)) : Number.POSITIVE_INFINITY;
    if (buffered.length > 0 && lowest <= floor + 1 && buffered.length < RETAINED_EVENTS) {
      return this.countReconnect(matchId, "resume", { mode: "events", events: buffered, ...now });
    }

    try {
      const rows = await loadEvents(this.reader(request), matchId, { afterSequence: floor, limit: MAX_REPLAY_EVENTS });
      if (rows.length === 0) return this.countReconnect(matchId, "snapshot", { mode: "snapshot", events: [], ...now, reason: "nothing after that sequence" });
      const coversGap = Math.min(...rows.map((e) => e.sequence)) <= floor + 1;
      if (!coversGap || rows.length >= MAX_REPLAY_EVENTS) {
        return this.countReconnect(matchId, "snapshot", { mode: "snapshot", events: [], ...now, reason: "gap too wide to replay" });
      }
      return this.countReconnect(matchId, "resume", { mode: "events", events: rows, ...now });
    } catch (err) {
      // Postgres down: say so rather than pretending "nothing happened", which would silently drop
      // events the client then never re-asks for.
      if (err instanceof ApiError && (err.code === "DEPENDENCY_FAILED" || err.code === "INTERNAL_ERROR")) throw err;
      return this.countReconnect(matchId, "snapshot", { mode: "snapshot", events: [], ...now, reason: "replay unavailable" });
    }
  }

  /**
   * One sample per socket coming back, and which way it came back: 'resume' (the retained buffer covered the
   * gap — free and instant) or 'snapshot' (the client had to be rebuilt from a full read). A spike in the
   * second after a deploy is the signal that the retained buffer was too short for the outage, which is a
   * number worth having and the only reason this helper exists.
   */
  private countReconnect<T extends { mode: "events" | "snapshot" }>(matchId: number, kind: "resume" | "snapshot", result: T): T {
    observe({ subsystem: "live", metric: "reconnects", route: `/live/matches/:matchId`, dimension: kind, samples: 1 });
    return result;
  }

  private async diagnostics(matchId: number): Promise<Record<string, unknown>> {
    const room = await this.load(matchId);
    return {
      matchId,
      sequence: room.sequence,
      status: room.status,
      score: room.score,
      clock: this.clockOf(room),
      retained_events: room.events.length,
      is_locked: room.isLocked,
      updated_at: room.updatedAt,
      viewers: count(this.state.getWebSockets(VIEWERS(matchId))),
      controllers: count(this.state.getWebSockets(CONTROLLERS(matchId))),
      alarm: await this.state.storage.getAlarm(),
    };
  }

  // ── the clock ───────────────────────────────────────────────────────────────
  private clockOf(room: RoomState): LiveClock {
    return {
      kind: clockKind(room.status),
      started_at: room.clockStartedAt,
      elapsed_before_pause: room.elapsedBeforePause,
      minute: this.minuteOf(room),
      stoppage: room.stoppage,
      period: periodOf(room.status),
      status: room.status,
    };
  }

  /**
   * The authoritative minute: wall-clock time since the running period started, plus the seconds banked
   * before a pause. A client *renders* from `started_at`, so a backgrounded tab catches up on its own and
   * a phone whose clock is wrong still shows the same score. Stopped clocks report the banked minute.
   */
  private minuteOf(room: RoomState): number {
    const running = clockKind(room.status) === "wallclock";
    const elapsed = room.elapsedBeforePause + (running && room.clockStartedAt ? Math.max(0, (Date.now() - Date.parse(room.clockStartedAt)) / 1000) : 0);
    const complete = Math.floor(elapsed / 60);
    if (!running) return complete;
    // Football labels 0:00–0:59 as the 1st minute, and stoppage as 45+ rather than 46 — the label, not a
    // different measurement. `minuteCeiling` absorbs the difference.
    return complete + 1;
  }

  async alarm(): Promise<void> {
    const room = await this.state.storage.get<RoomState>("room");
    const viewers = count(this.state.getWebSockets(VIEWERS(this.matchIdOf(room))));
    // The tick is the Durable Object's only guaranteed moment to hand telemetry over. A room's samples sit in
    // this isolate's buffer, and an isolate is evicted whenever the platform feels like it, so a room that
    // never flushed would simply stop reporting mid-match — which is exactly the failure an operator would
    // read as "the crowd left". Both exits from this function flush, and the gauge below is what makes
    // "how many people were watching, and for how long" answerable afterwards.
    this.emitConnectionsGauge(room ? room.matchId : this.matchIdOf(room), viewers);
    await flushObservations(this.env).catch(() => undefined);
    // Nobody watching, or a stopped clock: go back to sleep instead of burning quota. The next mutation
    // or socket re-arms it.
    if (!room || viewers === 0 || clockKind(room.status) !== "wallclock") {
      await this.state.storage.deleteAlarm();
      await flushObservations(this.env).catch(() => undefined);
      return;
    }
    const minute = this.minuteOf(room);
    if (minute !== this.lastMinuteSent) {
      this.lastMinuteSent = minute;
      const frame: LiveMessage = {
        version: PROTOCOL_VERSION,
        matchId: room.matchId,
        type: "MATCH_CLOCK",
        sequence: room.sequence,
        at: new Date().toISOString(),
        clock: this.clockOf(room),
        score: room.score,
      };
      await this.broadcast(room.matchId, frame, "all");
    }
    await this.state.storage.setAlarm(Date.now() + CLOCK_TICK_SECONDS * 1000);
  }

  private matchIdOf(room: RoomState | undefined): number {
    return room?.matchId ?? 0;
  }

  private async ensureAlarm(): Promise<void> {
    if (await this.state.storage.getAlarm()) return;
    await this.state.storage.setAlarm(Date.now() + CLOCK_TICK_SECONDS * 1000);
  }

  // ── websockets ──────────────────────────────────────────────────────────────
  /**
   * Hibernating upgrade: `acceptWebSocket` lets Cloudflare drop the isolate between messages, which is
   * the only reason a 40 000-viewer match is affordable. Nothing here trusts the query string for
   * rights — `role=controller` only selects which *tag* the socket joins for broadcasts, and it is set by
   * the Worker after `resolveMatchAccess` said the caller may control. Writes never come over the
   * socket: they go through the REST route, where authentication, authorisation, rate limiting and the
   * audit entry happen.
   */
  private async upgrade(request: Request, matchId: number, url: URL): Promise<Response> {
    const asController = url.searchParams.get("role") === "controller";
    const tags = asController ? [VIEWERS(matchId), CONTROLLERS(matchId)] : [VIEWERS(matchId)];
    const [client, server] = Object.values(new WebSocketPair());
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"PONG"}'));
    this.state.acceptWebSocket(server, tags);
    await this.ensureAlarm();

    const room = await this.load(matchId);
    const frame = await this.snapshotFrame(matchId, room);
    try {
      server.send(JSON.stringify(frame));
    } catch (err) {
      logError(`do:match:${String(matchId)}:welcome`, err);
    }
    if (asController) {
      const online = count(this.state.getWebSockets(CONTROLLERS(matchId)));
      await this.broadcast(
        matchId,
        {
          version: PROTOCOL_VERSION,
          matchId,
          type: "CONTROLLERS",
          sequence: room.sequence,
          at: new Date().toISOString(),
          controllers_online: online,
          peer_controller: online > 1 ? "another controller is connected to this match" : null,
        },
        "controllers",
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const matchId = this.matchIdOfSocket(ws);
    if (matchId === 0) return;
    if (typeof message !== "string") return;
    let frame: ClientFrame | { type?: string };
    try {
      frame = JSON.parse(message) as ClientFrame;
    } catch {
      send(ws, { version: PROTOCOL_VERSION, matchId, type: "MATCH_ERROR", sequence: 0, at: new Date().toISOString(), error: { code: "BAD_REQUEST", message: "Frames must be JSON." } });
      return;
    }
    if (frame.type === "ping") return; // already answered by the hibernation auto-response
    try {
      if (frame.type === "resume") {
        const after = "after_sequence" in frame ? frame.after_sequence : 0;
        const replay = await this.replay(matchId, after);
        if (replay.mode === "events") {
          const room = await this.load(matchId);
          for (const event of replay.events)
            send(ws, { version: PROTOCOL_VERSION, matchId, type: "MATCH_EVENT", sequence: event.sequence, at: new Date().toISOString(), event, score: room.score, clock: this.clockOf(room) });
          return;
        }
      }
      send(ws, await this.snapshotFrame(matchId, await this.load(matchId)));
    } catch (err) {
      if (err instanceof ApiError && err.code === "DEPENDENCY_FAILED") {
        send(ws, {
          version: PROTOCOL_VERSION,
          matchId,
          type: "MATCH_ERROR",
          sequence: 0,
          at: new Date().toISOString(),
          error: { code: "DEPENDENCY_FAILED", message: "The match database is unreachable. Stay connected; this socket will resume from your last sequence." },
        });
        return;
      }
      logError(`do:match:${String(matchId)}:ws`, err);
      send(ws, {
        version: PROTOCOL_VERSION,
        matchId,
        type: "MATCH_ERROR",
        sequence: 0,
        at: new Date().toISOString(),
        error: { code: "INTERNAL_ERROR", message: "The live match room could not read this match." },
      });
    }
  }

  /** The match id lives in the socket's tag, so a hibernated room can still tell which match to serve. */
  /**
   * One reading per minute per room, which is what makes the stored number mean what the panel says it means.
   *
   * `metric_rollups.value_sum` accumulates every sample that arrives for a bucket, so a gauge emitted on
   * every broadcast would add the same audience once per goal, and the read that answers "how many people were
   * watching at the busiest minute" (a `max` over per-bucket sums) would report the busiest *broadcast*. Once
   * a minute, one reading, and the rollup's minute bucket holds exactly the audience of that minute.
   */
  private emitConnectionsGauge(matchId: number, viewers: number): void {
    const now = Date.now();
    if (now - this.lastGaugeAt < 60_000) return;
    this.lastGaugeAt = now;
    observeGauge("live", "connections", viewers + count(this.state.getWebSockets(CONTROLLERS(matchId))), "room", `/live/matches/:matchId`);
  }

  private matchIdOfSocket(ws: WebSocket): number {
    for (const tag of this.state.getTags(ws)) {
      const found = /^m(\d+):/.exec(tag);
      if (found) return Number(found[1]);
    }
    return 0;
  }

  webSocketClose(ws: WebSocket): void {
    // No bookkeeping to undo: the tags are the registry, and the platform has already removed the socket.
    // The only consequence worth acting on is that nobody is left watching, which `alarm()` notices.
    void ws;
  }

  webSocketError(ws: WebSocket): void {
    void ws; // A broken socket must never be able to block a broadcast or keep a room awake.
  }

  /**
   * Best-effort fan-out. A socket that throws is dropped by the platform; it must not fail the mutation
   * that was already committed, so errors here are swallowed by design (the client recovers via
   * `resume`, and REST `/snapshot` is always available).
   */
  private async broadcast(matchId: number, frame: LiveMessage, audience: "all" | "controllers"): Promise<void> {
    const payload = JSON.stringify(frame);
    const sockets = audience === "controllers" ? this.state.getWebSockets(CONTROLLERS(matchId)) : this.state.getWebSockets(VIEWERS(matchId));
    let failed = 0;
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        failed++;
      }
    }
    // Still swallowed, still correct, and no longer invisible. One send that throws is a socket the platform is
    // about to remove, which is normal at the edges of a match; a *rate* of them is a room whose clients cannot
    // hear, which is the difference between a shrug and an alert.
    if (failed > 0) {
      observe({ subsystem: "live", metric: "event_failures", route: `/live/matches/:matchId`, dimension: "WEBSOCKET_ERROR", samples: failed });
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** `matches.minute` is written by the RPC at commit time; the room never writes the row itself. */
function toEventLike(event: LiveEvent): EventLike {
  return {
    event_type: event.event_type,
    team_id: event.team_id,
    player_id: event.player_id,
    assist_player_id: event.assist_player_id,
    minute: event.minute,
    period: event.period,
    event_status: event.status,
    sequence: event.sequence,
    goal_type: event.goal_type,
  };
}

function bearer(request: Request | undefined): string | null {
  const header = request?.headers.get("authorization") ?? "";
  if (!/^bearer\s+\S+/i.test(header)) return null;
  return header.replace(/^bearer\s+/i, "").trim();
}

function send(ws: WebSocket, frame: LiveMessage): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* dropped by the platform */
  }
}

function count(sockets: Iterable<WebSocket>): number {
  let n = 0;
  for (const socket of sockets) {
    void socket;
    n += 1;
  }
  return n;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
