/**
 * Live match routes — the browser's only door to the match room.
 *
 * Shape of every write here, in order:
 *
 * ```
 *   authenticate → matrix (+ orAssigned) → parse/validate the body → resolve this match's rights
 *   → Durable Object (serialise, re-check state, persist through the SECURITY DEFINER function,
 *     broadcast only after the commit) → audit → envelope
 * ```
 *
 * Three properties are worth naming, because they are the ones a future edit is most likely to break:
 *
 *   - **the client sends intent, never results.** There is no field in this file that accepts a score, a
 *     status spelled however the caller likes, a sequence number or a minute to store: minutes come from
 *     the caller only as *event metadata* (validated against the period's ceiling) and the score and
 *     clock are recomputed in Postgres from the event log. The browser cannot lie about the result because
 *     it is not asked for it.
 *   - **the response is the room's frame**, not an echo of the request. `data.frame` is exactly what the
 *     fans' sockets received, so a controller's own screen converges through the same reducer as a
 *     stranger's — one code path, no "it worked for me, the fans saw nothing".
 *   - **a rejection is a decision, not a disappearance.** Conflicts answer 409 with the reason and the
 *     room's current sequence; the console's draft queue marks the entry `conflict` and shows it. Nothing
 *     is silently dropped, on either side.
 *
 * Reads that fans use (`/snapshot`, `/events`, `/stream`) hold the one capability an anonymous caller has,
 * `public.read`, so they work signed out and are still RLS-bound.
 */
import type { AppRole } from "../env.ts";
import type { HandlerContext } from "./index.ts";
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readJsonBody, readQuery, MATCH_EVENT_TYPES, GOAL_TYPES } from "../lib/validation.ts";
import { allowedNextStatuses, describe, MATCH_STATUS_VALUES, type MatchStatus } from "../lib/matchLifecycle.ts";
import { eventSpec } from "../lib/matchEvents.ts";
import { issueLiveTicket, verifyLiveTicket, type LiveTicketKind } from "../lib/liveTicket.ts";
import { assertCanClose, assertCanControl, assertNotLocked, isAssignmentRole, resolveMatchAccess, type MatchAccess, type MatchRights } from "../services/matchAccess.ts";
import { listAssignments, loadEvents } from "../services/matchPersistence.ts";
import { assignMatch, standDownAssignment } from "../services/matchPersistence.ts";
import { supabaseAdmin, supabaseAnon, supabaseAsUser } from "../services/supabase.ts";
import { writeAudit } from "../middleware/audit.ts";
import type { LiveEvent, LiveMessage, LiveScore, MatchSnapshot } from "../types/live.ts";
import type { MatchAccessData, MatchAuditData, MatchEventsPageData, MatchMutationData, MatchStreamFrame, MutationAck, LiveTicketData } from "../types/api.ts";

/** Transitions that end or interrupt the match: a mis-click is unrecoverable for the crowd, so they confirm. */
const CONFIRM_REQUIRED: readonly MatchStatus[] = ["full_time", "completed", "postponed", "cancelled", "abandoned", "suspended"];
/** Statuses where closing authority — head referee, commissioner, admin — is required, not just control. */
const CLOSING_TARGETS: readonly MatchStatus[] = ["full_time", "completed", "postponed", "cancelled", "abandoned"];
const SSE_POLL_MS = 1200;
const SSE_KEEPALIVE_MS = 15000;
/** Consecutive room failures an SSE stream survives before it ends. The client reconnects with backoff. */
const SSE_MAX_ERRORS = 4;

// ── plumbing ──────────────────────────────────────────────────────────────────
function matchIdOf(ctx: HandlerContext): number {
  const raw = ctx.params.matchId ?? "";
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError("NOT_FOUND", 404, "No match with that id.");
  }
  return id;
}

/**
 * The one way a handler reaches its room. Missing binding is a 503 that names the fix — the alternative
 * (a TypeError from `undefined.get`) is how "the app is broken" becomes a two-hour investigation.
 */
function roomStub(ctx: HandlerContext, matchId: number) {
  const ns = ctx.env.LIVE_MATCH_ROOM;
  if (!ns) {
    throw new ApiError("DEPENDENCY_FAILED", 503, "The live match room is not bound on this Worker: add the LIVE_MATCH_ROOM Durable Object binding to workers/wrangler.toml for this environment.", {
      detail: "env.LIVE_MATCH_ROOM is undefined",
    });
  }
  return ns.get(ns.idFromName(String(matchId)));
}

/**
 * Call the room and translate its answer back into this API's error vocabulary. The room's 4xx is the
 * caller's 4xx verbatim (code, message, field list) — inventing a second mapping here is how a rejected
 * event becomes a mystery.
 */
async function callRoom<T>(ctx: HandlerContext, matchId: number, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "x-request-id": ctx.requestId, ...(init.headers as Record<string, string> | undefined) };
  if (ctx.principal.token) headers.authorization = `Bearer ${ctx.principal.token}`;
  let response: Response;
  try {
    response = await roomStub(ctx, matchId).fetch(new Request(`https://match-room/${String(matchId)}${path}`, { ...init, headers }));
  } catch (err) {
    // The room itself was unreachable. Nothing was acknowledged, so say exactly that: the controller's
    // draft entry stays pending and retries with the same client_event_id.
    throw new ApiError("DEPENDENCY_FAILED", 503, "The live match room is unavailable. Nothing was recorded; try again and your console will resend the queued events.", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new ApiError("DEPENDENCY_FAILED", 503, "The live match room returned an unreadable answer.", { detail: text.slice(0, 200) });
  }
  const envelope = body as { success?: boolean; data?: T; error?: { code?: string; message?: string; fields?: { field: string; message: string }[]; detail?: string }; requestId?: string } | null;
  if (!response.ok || envelope?.success !== true) {
    const error = envelope?.error;
    const code = (error?.code ?? "DEPENDENCY_FAILED") as ApiError["code"];
    throw new ApiError(code, response.status, error?.message ?? "The live match room could not handle this request.", { fields: error?.fields, detail: error?.detail });
  }
  return (envelope.data ?? null) as T;
}

/** Rights for this caller on this match. Every mutating handler goes through here — no exceptions. */
async function accessFor(ctx: HandlerContext, matchId: number): Promise<MatchAccess> {
  const token = ctx.principal.token;
  if (!token) throw new ApiError("UNAUTHENTICATED", 401, "This action needs a signed-in official.");
  return await resolveMatchAccess(supabaseAsUser(ctx.env, token), ctx.principal, matchId);
}

function authorized(access: MatchAccess, action: "event" | "transition" | "close" | "correct"): MatchRights {
  const rights = access.rights;
  if (action === "close") assertCanClose(access);
  else assertCanControl(access, action === "event" ? "record events in" : action === "correct" ? "correct events in" : "change the clock of");
  if (action === "event" || action === "transition") assertNotLocked(access);
  return rights;
}

/** The parts of the body a controller is allowed to name. Anything else is a 400, not a surprise. */
const EVENT_KEYS = [
  "client_event_id",
  "event_type",
  "team_id",
  "player_id",
  "assist_player_id",
  "minute",
  "extra_minute",
  "description",
  "goal_type",
  "card_reason",
  "metadata",
  "allow_duplicate_content",
  "expected_sequence",
] as const;

function readEventBody(fields: Fields): Record<string, unknown> {
  const type = fields.enumValue("event_type", MATCH_EVENT_TYPES as unknown as readonly string[], { required: true, label: "an event type this database accepts" });
  const clientEventId = fields.string("client_event_id", { required: true, min: 8, max: 64, pattern: /^[A-Za-z0-9_-]+$/, patternMessage: "may contain letters, digits, - and _" });
  const teamId = fields.rowId("team_id");
  const playerId = fields.rowId("player_id");
  const assistId = fields.rowId("assist_player_id");
  const minute = fields.minute("minute", { required: true });
  const extraMinute = fields.integer("extra_minute", { min: 0, max: 30, default: 0 });
  const description = fields.prose("description", { max: 500 });
  const goalType = fields.enumValue("goal_type", GOAL_TYPES as unknown as readonly string[]);
  const cardReason = fields.prose("card_reason", { max: 200 });
  const allowDuplicate = fields.boolean("allow_duplicate_content", { default: false });
  const expectedSequence = fields.integer("expected_sequence", { min: 0 });
  fields.throwIfInvalid();

  const raw = fields.raw;
  const metadata = typeof raw.metadata === "object" && raw.metadata !== null && !Array.isArray(raw.metadata) ? (raw.metadata as Record<string, unknown>) : null;
  if (Array.isArray(raw.metadata)) {
    throw new ApiError("VALIDATION_FAILED", 400, "metadata must be an object of extra facts, not a list.", { fields: [{ field: "metadata", message: "must be an object" }] });
  }
  if (metadata) {
    // A whitelist, because `metadata` reaches Postgres verbatim and is later rendered in the timeline:
    // `{html: "<script>"}` must not be possible. Anything not listed is refused rather than dropped, so
    // a client that thinks it sent a photo never silently loses it.
    const allowed = ["photo_url", "video_url", "var_decision", "penalty_round", "shootout_index", "body_part", "clock_note"];
    const unexpected = Object.keys(metadata).filter((k) => !allowed.includes(k));
    if (unexpected.length > 0) {
      throw new ApiError("VALIDATION_FAILED", 400, `metadata cannot contain ${unexpected.join(", ")}.`, {
        fields: unexpected.map((field) => ({ field: `metadata.${field}`, message: `is not one of: ${allowed.join(", ")}` })),
      });
    }
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === "string" && v.length > 500)
        throw new ApiError("VALIDATION_FAILED", 400, `metadata.${k} is too long.`, { fields: [{ field: `metadata.${k}`, message: "must be 500 characters or fewer" }] });
    }
  }

  const spec = eventSpec(type ?? "");
  const body: Record<string, unknown> = {
    event_type: type,
    client_event_id: clientEventId,
    team_id: teamId ?? null,
    player_id: playerId ?? null,
    assist_player_id: assistId ?? null,
    minute: minute ?? 0,
    extra_minute: extraMinute ?? 0,
    description: description ?? null,
    goal_type: goalType ?? null,
    card_reason: cardReason ?? null,
    metadata,
    allow_duplicate_content: allowDuplicate === true,
  };
  if (typeof expectedSequence === "number") body.expected_sequence = expectedSequence;
  // Structural rules that do not need the match state; the room adds the state-dependent ones (already
  // booked off, two yellows, minutes beyond the period, content duplicates).
  if (spec.team === "forbidden" && teamId !== undefined) body.team_id = null;
  if (spec.players === "none" && (playerId !== undefined || assistId !== undefined)) {
    throw new ApiError("VALIDATION_FAILED", 400, `${String(type)} has no player attached — it is a match-level event.`, {
      fields: [{ field: "player_id", message: `is not accepted for ${String(type)}` }],
    });
  }
  if (spec.players !== "none" && playerId === undefined && spec.players === "one") {
    throw new ApiError("VALIDATION_FAILED", 400, "This event needs a player.", { fields: [{ field: "player_id", message: "required" }] });
  }
  if (spec.players === "one_or_two" && spec.group === "substitution" && assistId === undefined) {
    throw new ApiError("VALIDATION_FAILED", 400, "A substitution needs the player coming off as well as the one coming on.", {
      fields: [{ field: "assist_player_id", message: "required for a substitution" }],
    });
  }
  if (!spec.goalType && goalType !== undefined) body.goal_type = null;
  if (!spec.cardReason && cardReason !== undefined) body.card_reason = null;
  return body;
}

// ── reads ─────────────────────────────────────────────────────────────────────
/** `GET /matches/:id/snapshot` — the one call that fills a screen: state, clock, score, recent events. */
export async function handleMatchSnapshot(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const snapshot = await callRoom<MatchSnapshot>(ctx, matchId, "/snapshot");
  return ok<MatchSnapshot>(snapshot, { requestId: ctx.requestId });
}

/** `GET /matches/:id/events` — the timeline, oldest first, cursor-paged. */
export async function handleMatchEvents(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const query = readQuery(ctx.url, ["after_sequence", "limit"]);
  const after = query.integer("after_sequence", { min: 0, default: 0 });
  const limit = query.integer("limit", { min: 1, max: 200, default: 100 });
  query.throwIfInvalid();
  // A fan timeline is public data, so the signed-out read is allowed and still RLS-bound; a signed-in
  // caller reads with their own token, which can only ever see the same rows plus their own drafts.
  const rest = ctx.principal.token ? supabaseAsUser(ctx.env, ctx.principal.token) : supabaseAnon(ctx.env);
  const rows: LiveEvent[] = await loadEvents(rest, matchId, { afterSequence: after ?? 0, limit: limit ?? 100 });
  const data: MatchEventsPageData = {
    match_id: matchId,
    after_sequence: after ?? 0,
    events: rows,
    /** Pass as `after_sequence` for the next page; null when the timeline is fully walked. */
    next_after_sequence: rows.length > 0 && rows.length === (limit ?? 100) ? (rows[rows.length - 1]?.sequence ?? null) : null,
    server_time: new Date().toISOString(),
  };
  return ok<MatchEventsPageData>(data, { requestId: ctx.requestId });
}

/**
 * `GET /matches/:id/access` — what this caller may do here, and what the state machine allows next.
 * The console renders its buttons from this and the server refuses regardless; a disabled button is
 * feedback, never a security control (Phase 1 doctrine, still true).
 */
export async function handleMatchAccess(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const access = await accessFor(ctx, matchId);
  const isAdmin = access.rights.isAdmin;
  // RLS decides the visibility of these rows: an official sees their own assignment, an admin sees all.
  const assignments = await listAssignments(supabaseAsUser(ctx.env, ctx.principal.token ?? ""), matchId).catch(() => []);
  const data: MatchAccessData = {
    match_id: matchId,
    status: access.match.status as MatchStatus,
    status_label: describe(access.match.status as MatchStatus),
    is_locked: access.match.is_locked === true,
    protocol_version: 1,
    rights: access.rights,
    allowed_transitions: allowedNextStatuses(access.match.status as MatchStatus, isAdmin).map((to) => ({
      to,
      label: describe(to),
      requires_confirmation: CONFIRM_REQUIRED.includes(to),
      requires_closing_authority: CLOSING_TARGETS.includes(to),
    })),
    assignments: assignments.map((a) => ({ id: a.id, role: a.role, status: a.status, user_id: a.user_id, username: a.username, assigned_at: a.assigned_at })),
    /** Why control is off, in the console's words. Null when control is on. */
    reason: access.rights.canControl ? null : (access.rights.reason ?? "This account may not control this match."),
  };
  return ok<MatchAccessData>(data, { requestId: ctx.requestId });
}

// ── writes ────────────────────────────────────────────────────────────────────
/**
 * `POST /matches/:id/events` — append one event (a goal, a card, a substitution, a draft resync).
 *
 * `client_event_id` is required, always: the same POST twice must never become two goals. A controller
 * with no connection generates it locally (`crypto.randomUUID()`), and its queue replays it unchanged.
 */
export async function handleRecordMatchEvent(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, EVENT_KEYS);
  fields.assertOnlyDeclared();
  const event = readEventBody(fields);
  const access = await accessFor(ctx, matchId);
  const rights = authorized(access, "event");

  const data = await callRoom<MutationAck>(ctx, matchId, "/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: ctx.requestId, isAdmin: rights.isAdmin, event }),
  });

  // `match_events` is itself the append-only audit of an accepted event (who, when, what, idempotency
  // key, sequence), so the only extra log line here is the one that matters to an operator: a replay
  // that was refused by the uniqueness rule. It is the fingerprint of a client retry bug or a stuck queue.
  if (data.duplicate) {
    void ctx.ctx.waitUntil(
      writeAudit(ctx.env, {
        actorId: ctx.principal.userId,
        action: "match.event_duplicate",
        entityType: "match",
        entityId: matchId,
        entityName: `match ${String(matchId)}`,
        details: { client_event_id: event.client_event_id ?? null, event_type: event.event_type ?? null, sequence: data.frame?.sequence ?? null },
        requestId: ctx.requestId,
      }),
    );
  }
  return ok<MatchMutationData>(
    {
      accepted: data.accepted !== false,
      duplicate: data.duplicate === true,
      frame: data.frame,
      match_id: matchId,
      sequence: data.frame?.sequence ?? null,
    },
    { requestId: ctx.requestId, status: data.duplicate === true ? 200 : 201 },
  );
}

/** `PUT /matches/:id/state` — a lifecycle transition. The only way status changes from the browser. */
export async function handleMatchTransition(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["status", "reason", "stoppage", "expected_sequence", "confirm"]);
  fields.assertOnlyDeclared();
  const to = fields.enumValue("status", MATCH_STATUS_VALUES as unknown as readonly string[], { required: true, label: "a match status" });
  const reason = fields.prose("reason", { max: 500 });
  const stoppage = fields.integer("stoppage", { min: 0, max: 30 });
  const expected = fields.integer("expected_sequence", { min: 0 });
  const confirm = fields.boolean("confirm");
  fields.throwIfInvalid();
  if (!to) throw new ApiError("VALIDATION_FAILED", 400, "status is required.", { fields: [{ field: "status", message: "required" }] });
  const target = to as MatchStatus;
  if (CONFIRM_REQUIRED.includes(target) && confirm !== true) {
    throw new ApiError("VALIDATION_FAILED", 400, `${describe(target)} ends or interrupts the match for every viewer. Send confirm: true to go ahead.`);
  }
  const access = await accessFor(ctx, matchId);
  const rights = authorized(access, CLOSING_TARGETS.includes(target) ? "close" : "transition");

  const data = await callRoom<MutationAck>(ctx, matchId, "/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: ctx.requestId, isAdmin: rights.isAdmin, to: target, reason: reason ?? null, stoppage: stoppage ?? null, expectedSequence: expected ?? null }),
  });

  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: "match.status",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { from: data.frame?.type === "MATCH_STATUS" ? data.frame.previous_status : null, to: target, reason: reason ?? null, sequence: data.frame?.sequence ?? null },
      requestId: ctx.requestId,
    }),
  );
  return ok<MatchMutationData>({ accepted: true, frame: data.frame, match_id: matchId, sequence: data.frame?.sequence ?? null }, { requestId: ctx.requestId });
}

/** `POST /matches/:id/corrections` — the only permitted way an accepted event changes meaning. */
export async function handleMatchCorrection(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["event_id", "reason", "replacement", "expected_sequence", "confirm"]);
  fields.assertOnlyDeclared();
  const eventId = fields.rowId("event_id", { required: true });
  const reason = fields.prose("reason", { required: true, max: 500 });
  const expected = fields.integer("expected_sequence", { min: 0 });
  const confirm = fields.boolean("confirm");
  fields.throwIfInvalid();
  if (confirm !== true) throw new ApiError("VALIDATION_FAILED", 400, "A correction rewrites what fans have already been shown. Send confirm: true to go ahead.");
  const raw = fields.raw.replacement;
  let replacement: Record<string, unknown> | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw))
      throw new ApiError("VALIDATION_FAILED", 400, "replacement must be an object with the corrected fields.", { fields: [{ field: "replacement", message: "must be an object" }] });
    // Only these may be corrected, and they are validated by the same reader as a fresh event, so a
    // "correction" cannot smuggle in a shape the original event would have been refused for.
    const corrected = new Fields(raw, [...EVENT_KEYS]);
    replacement = readEventBody(corrected);
  }

  const access = await accessFor(ctx, matchId);
  const rights = authorized(access, "correct");
  if (!(rights.canCorrectAny || rights.canCorrectOwn)) {
    throw new ApiError("FORBIDDEN", 403, "Only the official who recorded an event, or a platform admin, may correct it.");
  }

  const data = await callRoom<MutationAck>(ctx, matchId, "/corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: ctx.requestId, isAdmin: rights.isAdmin, eventId, reason: reason ?? "", replacement, expectedSequence: expected ?? null }),
  });

  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: "match.event_corrected",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { event_id: eventId ?? null, reason: reason ?? null, replacing: typeof raw === "object" && raw !== null ? ((raw as Record<string, unknown>).event_type ?? null) : null },
      requestId: ctx.requestId,
    }),
  );
  return ok<MatchMutationData>({ accepted: true, frame: data.frame, match_id: matchId, sequence: data.frame?.sequence ?? null }, { requestId: ctx.requestId });
}

/** `POST /matches/:id/finalize` — freeze the result, derived from the event log. */
export async function handleMatchFinalize(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["confirm", "note"]);
  fields.assertOnlyDeclared();
  const confirm = fields.boolean("confirm");
  const note = fields.prose("note", { max: 500 });
  fields.throwIfInvalid();
  if (confirm !== true) throw new ApiError("VALIDATION_FAILED", 400, "Finalizing publishes the result and closes corrections. Send confirm: true to go ahead.");
  const access = await accessFor(ctx, matchId);
  authorized(access, "close");

  const data = await callRoom<MutationAck>(ctx, matchId, "/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: ctx.requestId, confirmed: true, note: note ?? null }),
  });
  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: "match.finalize",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { score: (data.frame as { score?: LiveScore } | undefined)?.score ?? null, note: note ?? null },
      requestId: ctx.requestId,
    }),
  );
  return ok<MatchMutationData>({ accepted: true, frame: data.frame, match_id: matchId, sequence: data.frame?.sequence ?? null }, { requestId: ctx.requestId });
}

/** `POST /matches/:id/lock` — admin freeze, broadcast so a console mid-entry learns before it writes. */
export async function handleMatchLock(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["locked", "reason"]);
  fields.assertOnlyDeclared();
  const locked = fields.boolean("locked", { default: true });
  const reason = fields.prose("reason", { max: 500 });
  fields.throwIfInvalid();
  if (locked === true && (reason ?? "").length < 3)
    throw new ApiError("VALIDATION_FAILED", 400, "Locking a match needs a reason.", { fields: [{ field: "reason", message: "at least 3 characters" }] });

  const data = await callRoom<MutationAck>(ctx, matchId, "/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: ctx.requestId, locked: locked !== false, reason: reason ?? null }),
  });
  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: locked === false ? "match.unlock" : "match.lock",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { reason: reason ?? null },
      requestId: ctx.requestId,
    }),
  );
  return ok<MatchMutationData>({ accepted: true, frame: data.frame, match_id: matchId, sequence: data.frame?.sequence ?? null }, { requestId: ctx.requestId });
}

// ── assignment ────────────────────────────────────────────────────────────────
/**
 * `GET /matches/:id/assignments` — who is on this match. RLS decides the width: an official sees their
 * own row (so they can tell a peer is present), an admin sees the whole list.
 */
export async function handleMatchAssignmentList(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const rest = ctx.principal.token ? supabaseAsUser(ctx.env, ctx.principal.token) : supabaseAnon(ctx.env);
  const rows = await listAssignments(rest, matchId).catch(() => {
    if (ctx.principal.token) return [];
    // The table is admin-readable; an anonymous caller simply gets nothing.
    return [];
  });
  return ok({ match_id: matchId, assignments: rows, you: rows.find((r) => r.user_id === ctx.principal.userId) ?? null }, { requestId: ctx.requestId });
}

/** `POST /matches/:id/assignments` — who is allowed to control this match. Admin only. */
export async function handleMatchAssign(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["user_id", "role", "note"]);
  fields.assertOnlyDeclared();
  const userId = fields.uuid("user_id", { required: true });
  const role = fields.string("role", { required: true, max: 32 });
  const note = fields.prose("note", { max: 300 });
  fields.throwIfInvalid();
  if (!isAssignmentRole(role)) {
    throw new ApiError("VALIDATION_FAILED", 400, "role must be an officiating role this engine recognises.", {
      fields: [{ field: "role", message: "must be head_referee, assistant_referee, fourth_official, var_official, match_commissioner or data_operator" }],
    });
  }
  // The assignee must exist and have a profile: assigning to a deleted uuid is how a match ends up with
  // nobody able to control it, at 19:58, on a Sunday.
  const profile = await supabaseAdmin(ctx.env)
    .from("profiles")
    .select("id, username, role")
    .eq("id", userId ?? "")
    .limit(1)
    .maybeSingle<{ id: string; username: string; role: string }>()
    .catch(() => null);
  if (!profile)
    throw new ApiError("VALIDATION_FAILED", 400, "No account with that id — the official must have signed up before being assigned.", { fields: [{ field: "user_id", message: "not found" }] });

  const result = await assignMatch(supabaseAsUser(ctx.env, ctx.principal.token ?? ""), { matchId, userId: userId ?? "", role, note: note ?? null });
  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: "match.assign",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { user_id: userId ?? null, username: profile.username, role: role ?? null },
      requestId: ctx.requestId,
    }),
  );
  return ok({ match_id: matchId, assignment_id: result.id, role, user: profile }, { requestId: ctx.requestId, status: 201 });
}

/** `POST /matches/:id/assignments/stand-down` — the caller's own row, or anyone's for an admin. */
export async function handleMatchStandDown(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["assignment_id"]);
  fields.assertOnlyDeclared();
  const assignmentId = fields.uuid("assignment_id", { required: true });
  fields.throwIfInvalid();
  const rest = supabaseAsUser(ctx.env, ctx.principal.token ?? "");
  const rows = await listAssignments(rest, matchId);
  const target = rows.find((r) => r.id === assignmentId);
  if (!target) throw new ApiError("NOT_FOUND", 404, "No such assignment on this match.");
  if (target.user_id !== ctx.principal.userId && ctx.principal.role !== "admin") {
    throw new ApiError("FORBIDDEN", 403, "You may stand down your own assignment; an admin must release someone else's.");
  }
  const result = await standDownAssignment(rest, assignmentId ?? "");
  void ctx.ctx.waitUntil(
    writeAudit(ctx.env, {
      actorId: ctx.principal.userId,
      action: "match.assignment_stood_down",
      entityType: "match",
      entityId: matchId,
      entityName: `match ${String(matchId)}`,
      details: { assignment_id: assignmentId ?? null, role: target.role, self: target.user_id === ctx.principal.userId },
      requestId: ctx.requestId,
    }),
  );
  return ok({ assignment_id: assignmentId, status: result.status }, { requestId: ctx.requestId });
}

/** `GET /matches/:id/audit` — the paper trail an admin reads when two officials disagree. */
export async function handleMatchAudit(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const query = readQuery(ctx.url, ["limit"]);
  const limit = query.integer("limit", { min: 1, max: 100, default: 50 });
  query.throwIfInvalid();
  if (!ctx.principal.token) throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  const rows = await supabaseAdmin(ctx.env)
    .from("activity_logs")
    .select("id, created_at, action, entity_type, entity_name, details, profiles(username, role)")
    .eq("entity_type", "match")
    .eq("entity_id", matchId)
    .order("created_at", { ascending: false })
    .limit(limit ?? 50)
    .rows<Record<string, unknown>>();
  const data: MatchAuditData = {
    match_id: matchId,
    entries: rows.map((r) => {
      const who = r.profiles as { username?: string; role?: string } | null;
      return {
        id: Number(r.id),
        created_at: String(r.created_at ?? ""),
        action: String(r.action ?? ""),
        entity_name: (r.entity_name as string | null) ?? null,
        actor: who?.username ?? null,
        actor_role: who?.role ?? null,
        details: (r.details as Record<string, unknown> | null) ?? null,
      };
    }),
  };
  return ok<MatchAuditData>(data, { requestId: ctx.requestId });
}

/** `GET /matches/:id/diagnostics` — the room's own account of itself, for incident triage. */
export async function handleMatchDiagnostics(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  return ok(await callRoom<Record<string, unknown>>(ctx, matchId, "/diagnostics"), { requestId: ctx.requestId });
}

// ── the sockets ───────────────────────────────────────────────────────────────
/**
 * `POST /matches/:id/live-ticket` — a browser cannot set an `Authorization` header on a WebSocket
 * handshake, so it exchanges its real session for a scoped ticket. A `controller` ticket is only minted
 * for an assigned official; the socket it opens is still read-only.
 */
export async function handleLiveTicket(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const fields = await readJsonBody(ctx.request, ["kind"]);
  fields.assertOnlyDeclared();
  const kind = (fields.enumValue("kind", ["viewer", "controller"]) ?? "viewer") as LiveTicketKind;
  fields.throwIfInvalid();

  let role: AppRole | null = null;
  if (kind === "controller") {
    const access = await accessFor(ctx, matchId);
    assertCanControl(access, "open the control feed for");
    role = ctx.principal.role;
  }
  const issued = await issueLiveTicket(ctx.env, { userId: ctx.principal.userId || "anon", matchId, kind, role });
  const data: LiveTicketData = { ...issued, kind, match_id: matchId, ws_path: `/api/live/matches/${String(matchId)}` };
  return ok<LiveTicketData>(data, { requestId: ctx.requestId });
}

/**
 * `GET /live/matches/:id` — the WebSocket upgrade, relayed to the room.
 *
 * The Worker's job here is exactly two things: verify the ticket (or accept an anonymous fan), and pick
 * the broadcast audience. The room holds the socket. Everything the socket can do is read; a write from
 * a controller goes through the REST routes above, where authentication, authorisation, rate limiting and
 * audit live. That asymmetry is deliberate — a long-lived socket that could write would be a
 * credential-less privileged channel, which is the bug pattern Phase 1 was written to remove.
 */
export async function handleLiveSocket(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  if ((ctx.request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    throw new ApiError("BAD_REQUEST", 400, "This endpoint is a WebSocket handshake. The REST equivalent is GET /api/matches/:matchId/snapshot.");
  }
  // The signature, expiry and match binding are verified *here*; the room is then told which broadcast
  // feed the socket joins. An absent ticket means a fan, which is the correct default.
  const ticket = ctx.url.searchParams.get("ticket");
  const claims = ticket ? await verifyLiveTicket(ctx.env, ticket, matchId) : null;
  const audience = claims?.kind === "controller" ? "?role=controller" : "";

  const headers: Record<string, string> = { upgrade: "websocket", "x-request-id": ctx.requestId };
  if (ctx.principal.token) headers.authorization = `Bearer ${ctx.principal.token}`;
  const stub = roomStub(ctx, matchId);
  let response: Response;
  try {
    response = await stub.fetch(new Request(`https://match-room/${String(matchId)}/socket${audience}`, { method: "GET", headers }));
  } catch (err) {
    throw new ApiError("DEPENDENCY_FAILED", 503, "The live match room is unavailable, so the socket could not open.", { detail: err instanceof Error ? err.message : String(err) });
  }
  const upstream = response.webSocket;
  if (!upstream) {
    const body = await response.text();
    throw new ApiError(response.status === 401 ? "UNAUTHENTICATED" : "DEPENDENCY_FAILED", response.status === 401 ? 401 : 503, "The live match room refused this socket.", {
      detail: body.slice(0, 200),
    });
  }
  return new Response(null, { status: 101, webSocket: upstream });
}

/**
 * `GET /matches/:id/stream` — SSE, the fallback that makes the fan view work everywhere a raw socket
 * does not: the corporate proxy in front of a stadium office, the desktop shell mid-update, a browser
 * extension that blocks WebSockets, and `worker-local` (Node's http server cannot complete a WebSocket
 * handshake, so this is also how the room is exercised without `wrangler`).
 *
 * Same frames, same sequence numbers, same resume rule (`Last-Event-ID`), so the client's reducer is
 * identical whichever transport it got.
 */
export async function handleMatchStream(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  const query = readQuery(ctx.url, ["after"]);
  const requested = query.integer("after", { min: 0 });
  query.throwIfInvalid();
  const lastEventId = Number(ctx.request.headers.get("last-event-id") ?? "");
  let cursor = Number.isFinite(lastEventId) && lastEventId > 0 ? Math.trunc(lastEventId) : (requested ?? 0);

  const encoder = new TextEncoder();
  let closed = false;
  const abort: AbortSignal | undefined = ctx.request.signal;
  abort?.addEventListener("abort", () => {
    closed = true;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: LiveMessage, id?: number): void => {
        const lines: string[] = [];
        if (id !== undefined) lines.push(`id: ${String(id)}`);
        lines.push(`event: ${frame.type}`, `data: ${JSON.stringify(frame)}`, "");
        controller.enqueue(encoder.encode(lines.join("\n")));
      };
      let errors = 0;
      let lastKeepalive = Date.now();
      let seenStatus: string | null = null;
      try {
        const snapshot = await callRoom<MatchSnapshot>(ctx, matchId, "/snapshot");
        emit(snapshot, snapshot.sequence);
        cursor = Math.max(cursor, snapshot.sequence);
        seenStatus = snapshot.status;
        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, SSE_POLL_MS));
          if (closed) break;
          try {
            const replay = await callRoom<MatchStreamFrame>(ctx, matchId, `/events?after=${String(cursor)}`);
            errors = 0;
            if (replay.mode === "snapshot") {
              const fresh = await callRoom<MatchSnapshot>(ctx, matchId, "/snapshot");
              emit(fresh, fresh.sequence);
              cursor = Math.max(cursor, fresh.sequence);
              seenStatus = fresh.status;
              continue;
            }
            for (const event of replay.events) {
              emit({ type: "MATCH_EVENT", version: 1, matchId, sequence: event.sequence, at: new Date().toISOString(), event, score: replay.score, clock: replay.clock }, event.sequence);
              cursor = Math.max(cursor, event.sequence);
            }
            // A minute tick and a status change both ride the same stream, so a viewer with no events
            // still sees 45+2 and "Half time" without polling the whole fixture list.
            if (replay.clock && replay.clock.status !== seenStatus) {
              seenStatus = replay.clock.status;
              emit(
                {
                  type: "MATCH_STATUS",
                  version: 1,
                  matchId,
                  sequence: replay.sequence,
                  at: new Date().toISOString(),
                  status: replay.clock.status,
                  previous_status: replay.clock.status,
                  label: describe(replay.clock.status),
                  reason: null,
                  clock: replay.clock,
                  score: replay.score,
                  event: null,
                },
                replay.sequence,
              );
            }
            if (replay.sequence > cursor) cursor = replay.sequence;
            if (Date.now() - lastKeepalive > SSE_KEEPALIVE_MS) {
              controller.enqueue(encoder.encode(`: keepalive ${String(Math.round(Date.now() / 1000))}\n\n`));
              lastKeepalive = Date.now();
            }
          } catch (err) {
            errors += 1;
            if (errors >= SSE_MAX_ERRORS) {
              emit({
                type: "MATCH_ERROR",
                version: 1,
                matchId,
                sequence: cursor,
                at: new Date().toISOString(),
                error: { code: err instanceof ApiError ? err.code : "INTERNAL_ERROR", message: "The live stream could not be refreshed. Reconnect to resume from your last event." },
              });
              controller.close();
              return;
            }
          }
        }
      } catch (err) {
        if (!closed) {
          emit({
            type: "MATCH_ERROR",
            version: 1,
            matchId,
            sequence: cursor,
            at: new Date().toISOString(),
            error: { code: err instanceof ApiError ? err.code : "INTERNAL_ERROR", message: "The live stream stopped. Reconnect to resume from your last event." },
          });
        }
      }
      try {
        controller.close();
      } catch {
        /* already closed by the client hanging up */
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": ctx.requestId,
    },
  });
}

/** `GET /matches/:id` fan payload — the match page's single request. */
export async function handleMatchDetail(ctx: HandlerContext): Promise<Response> {
  const matchId = matchIdOf(ctx);
  // The fan page's single request: the room's snapshot plus the whole timeline behind it. Deliberately
  // *not* "snapshot + teams + players + statistics + commentary + standings", which is what the page
  // used to refetch every ten seconds.
  const [snapshot, replay] = await Promise.all([callRoom<MatchSnapshot>(ctx, matchId, "/snapshot"), callRoom<MatchStreamFrame>(ctx, matchId, "/events?after=0")]);
  const events: LiveEvent[] = snapshot.body.events.length > 0 ? [...snapshot.body.events].reverse() : replay.events;
  return ok({ match_id: matchId, snapshot, events, status: snapshot.status, clock: snapshot.clock, score: snapshot.score, server_time: new Date().toISOString() }, { requestId: ctx.requestId });
}
