/**
 * Phase 5 · the notification endpoints.
 *
 * Every route here is thin on purpose, and the thinness is the security model: none of them decides anything.
 * Registration, preferences, the inbox and the broadcast all run as **the caller's own JWT** through a
 * `SECURITY DEFINER` function that takes the user from `auth.uid()`, so:
 *
 *   - a body cannot name a user (an undeclared `user_id` key is rejected by `readJsonBody` before anything else
 *     runs — the "never trust a client user id" rule is enforced by the parser, not by care);
 *   - the RLS policies and the function's own `where user_id = auth.uid()` have to agree before a row moves, so
 *     a bug in one is not automatically a breach;
 *   - no route can read a device token. The list comes from `notification_devices_public`, which does not
 *     select the column, and the fan-out that *does* read tokens happens only in the queue consumer with the
 *     service-role key.
 *
 * The one privileged route — `POST /admin/notifications/broadcast` — creates a job and hands it to the queue.
 * It never sends a push inline: an admin pressing "send" must not hold a request open across 500 FCM calls, and
 * a Worker that dies mid-loop would leave a half-sent announcement with no record.
 */
import type { Env } from "../env.ts";
import { NOTIFICATION_KINDS, validateCopy } from "../lib/notificationPolicy.ts";
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readJsonBody, readQuery } from "../lib/validation.ts";
import { supabaseAsUser } from "../services/supabase.ts";
import { deliverJob, runtimeFor } from "../services/notifications.ts";
import type { HandlerContext } from "./index.ts";
import type { Principal } from "../middleware/auth.ts";

const DEVICE_KEYS = ["token", "provider", "platform", "appId"] as const;
const PREFERENCE_KEYS = ["enabled", "categories"] as const;
const BROADCAST_KEYS = ["title", "body", "kind", "confirm"] as const;
const INBOX_QUERY_KEYS = ["limit", "before"] as const;

/** A Postgres `code` in an RPC's jsonb answer is a business refusal; anything else is an outage. */
interface RpcRefusal {
  readonly ok?: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

/** The status each refusal code deserves, so the SPA can branch on the code and the HTTP status still lies to nobody. */
const REFUSAL_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  DEVICE_LIMIT: 400,
  AUDIENCE_TOO_LARGE: 413,
  CONFIRMATION_REQUIRED: 400,
  VALIDATION_FAILED: 400,
  UNKNOWN_KIND: 400,
  NOT_FOUND: 404,
};

function asUser(env: Env, principal: Principal) {
  if (!principal.token) {
    // The capability matrix already refuses an anonymous caller for these routes; this is the second door, and
    // it exists because `supabaseAsUser` would otherwise send the string "null" as a bearer token.
    throw new ApiError("UNAUTHENTICATED", 401, "Notifications are tied to your account. Sign in to manage them.");
  }
  return supabaseAsUser(env, principal.token);
}

async function rpc(ctx: HandlerContext, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await asUser(ctx.env, ctx.principal).call(fn, args)) as RpcRefusal | null;
  if (res && res.ok === false) {
    const code = String(res["code"] ?? "DEPENDENCY_FAILED");
    const status = REFUSAL_STATUS[code] ?? 400;
    throw new ApiError("VALIDATION_FAILED", status, refusalMessage(code), {
      // `ApiCode` is a closed union and stays that way: inventing `DEVICE_LIMIT` as a transport code would
      // mean every client has to learn a new HTTP-level word for what is really "the function refused, for
      // this reason". The reason therefore rides in `error.fields`, which unlike `detail` is exposed in
      // production, so the SPA branches on `fields.reason === "DEVICE_LIMIT"` rather than pattern-matching a
      // sentence. `detail` stays dev-only, because a Postgres message can name a column.
      fields: [{ field: "reason", message: code }],
      detail: typeof res["detail"] === "string" ? res["detail"] : undefined,
    });
  }
  return (res ?? {}) as Record<string, unknown>;
}

function refusalMessage(code: string): string {
  switch (code) {
    case "DEVICE_LIMIT":
      return "This account has reached its limit of registered devices. Remove one and try again.";
    case "AUDIENCE_TOO_LARGE":
      return "That audience is larger than this deployment will push to in one request. Narrow it, or send it as a scheduled announcement.";
    case "CONFIRMATION_REQUIRED":
      return "This broadcast reaches more than 1000 people. Send again with confirm: true to proceed.";
    case "UNKNOWN_KIND":
      return "That notification category does not exist.";
    case "FORBIDDEN":
      return "Only an administrator may send an announcement.";
    case "UNAUTHENTICATED":
      return "Notifications are tied to your account. Sign in to manage them.";
    default:
      return "The notification settings could not be saved.";
  }
}

/** `POST /api/notifications/devices` — the only way a token enters the system. */
export async function handleNotificationDeviceRegister(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, DEVICE_KEYS);
  fields.assertOnlyDeclared();
  const token = fields.string("token", { required: true, min: 20, max: 4096 });
  const platform = fields.enumValue("platform", ["android", "ios", "web", "unknown"], { required: true, label: "android, ios, web or unknown" });
  // Absent is `fcm`, and the default is applied here rather than in `enumValue` because that helper has no
  // `default` option: an omitted key is a legitimate request, an unknown one is a client bug.
  const provider = fields.enumValue("provider", ["fcm", "webpush"]) ?? "fcm";
  const appId = fields.string("appId", { max: 120 });
  fields.throwIfInvalid();

  const res = await rpc(ctx, "kicklive_register_notification_device", {
    p_provider: provider ?? "fcm",
    p_token: token,
    p_platform: platform,
    p_app_id: appId ?? null,
    // The UA family is read server-side: it is what lets the settings screen say "Chrome on Android" without
    // the client claiming anything about itself, and it is not used for authorisation.
    p_ua: ctx.request.headers.get("user-agent")?.slice(0, 200) ?? null,
  });
  return ok({ id: res["id"], active: true, devices: res["devices"] ?? null }, { status: 201, requestId: ctx.requestId });
}

/** `GET /api/notifications/devices` — from the view, so a token is not in reach of a leaked session token. */
export async function handleNotificationDeviceList(ctx: HandlerContext): Promise<Response> {
  const rows = await asUser(ctx.env, ctx.principal)
    .from("notification_devices_public")
    .select("id, platform, provider, app_id, active, created_at, last_seen_at, last_sent_at")
    .order("created_at", { ascending: false })
    .rows<Record<string, unknown>>();
  return ok(
    {
      devices: rows.map((r) => ({
        id: r["id"],
        platform: r["platform"],
        provider: r["provider"],
        appId: r["app_id"],
        active: r["active"],
        createdAt: r["created_at"],
        lastSeenAt: r["last_seen_at"],
        lastSentAt: r["last_sent_at"],
      })),
    },
    { requestId: ctx.requestId },
  );
}

/** `DELETE /api/notifications/devices/:id` — "sign this phone out". */
export async function handleNotificationDeviceDelete(ctx: HandlerContext): Promise<Response> {
  const id = new Fields({ id: ctx.params["id"] }, []).uuid("id", { required: true });
  if (!id) throw new ApiError("VALIDATION_FAILED", 400, "That device id is not valid.");
  await rpc(ctx, "kicklive_unregister_notification_device", { p_id: id });
  return new Response(null, { status: 204 });
}

/** `GET /api/notifications/preferences` — the merged document, never a raw table read. */
export async function handleNotificationPreferencesRead(ctx: HandlerContext): Promise<Response> {
  const doc = await rpc(ctx, "kicklive_notification_preferences", {});
  return ok(doc, { requestId: ctx.requestId });
}

/** `PUT /api/notifications/preferences` — full-document semantics, so an omitted switch is an off switch. */
export async function handleNotificationPreferencesWrite(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, PREFERENCE_KEYS);
  fields.assertOnlyDeclared();
  const enabled = fields.boolean("enabled", { default: true });
  const raw = fields.raw["categories"];
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new ApiError("VALIDATION_FAILED", 400, "categories must be an object keyed by category name.", { fields: [{ field: "categories", message: "expected an object" }] });
  }
  if (raw !== undefined && typeof raw === "object") {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(key)) {
        // Refused here rather than silently dropped: a client that sends `goal_scored` has a bug, and a server
        // that ignores it hides the bug until the user notices they are not being told about goals.
        throw new ApiError("VALIDATION_FAILED", 400, `Unknown notification category "${key}".`, { fields: [{ field: "categories", message: `${key} is not a category this product has` }] });
      }
    }
  }
  fields.throwIfInvalid();
  const doc = await rpc(ctx, "kicklive_set_notification_preferences", { p_enabled: enabled ?? true, p_categories: raw ?? {} });
  return ok(doc["document"] ?? doc, { requestId: ctx.requestId });
}

/** `GET /api/notifications/inbox` — page and unread count from one SQL call, so they cannot disagree. */
export async function handleNotificationInbox(ctx: HandlerContext): Promise<Response> {
  const query = readQuery(ctx.url, INBOX_QUERY_KEYS);
  query.assertOnlyDeclared();
  const limit = query.integer("limit", { min: 1, max: 100, default: 20 });
  const before = query.timestamp("before");
  query.throwIfInvalid();
  const res = await rpc(ctx, "kicklive_notifications_page", { p_limit: limit ?? 20, p_before: before ?? null });
  return ok(res, { requestId: ctx.requestId });
}

/** `POST /api/notifications/inbox/:id/read`. */
export async function handleNotificationInboxRead(ctx: HandlerContext): Promise<Response> {
  const id = new Fields({ id: ctx.params["id"] }, []).integer("id", { required: true, min: 1 });
  if (id === undefined) throw new ApiError("VALIDATION_FAILED", 400, "That notification id is not valid.");
  await rpc(ctx, "kicklive_mark_notifications_read", { p_id: id });
  return ok({ id, read: true }, { requestId: ctx.requestId });
}

/** `POST /api/notifications/inbox/read-all`. */
export async function handleNotificationInboxReadAll(ctx: HandlerContext): Promise<Response> {
  const res = await rpc(ctx, "kicklive_mark_all_notifications_read", {});
  return ok(res, { requestId: ctx.requestId });
}

/**
 * `GET /api/notifications/config` — what the settings screen needs to render itself: the categories, the
 * defaults for a user who has never chosen, and the limits it must not exceed. Public, because a signed-out
 * visitor is exactly who the opt-in prompt is for; contains no user data and no key.
 */
export async function handleNotificationConfig(ctx: HandlerContext): Promise<Response> {
  const defaults = (await asUser(ctx.env, ctx.principal).call("kicklive_preference_defaults", {})) as Record<string, boolean> | null;
  return ok(
    {
      kinds: NOTIFICATION_KINDS,
      defaults: defaults ?? {},
      limits: { maxDevices: 10, titleMaxChars: 120, bodyMaxChars: 480, inboxPageSizeMax: 100 },
      // Whether this deployment can push at all. `mock` means no FCM project is configured, and the UI should
      // not promise a phone a buzz it cannot receive.
      transport: ctx.env.FCM_PROJECT_ID?.trim() ? "fcm" : "mock",
    },
    { requestId: ctx.requestId },
  );
}

/**
 * `POST /api/admin/notifications/broadcast` — the only endpoint that can address many users at once, so it is
 * admin-gated by the capability matrix, checked again inside the SQL function, counted before anything is
 * written, capped by configuration, and acknowledged with a job id rather than a promise that it arrived.
 */
export async function handleNotificationBroadcast(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, BROADCAST_KEYS);
  fields.assertOnlyDeclared();
  const title = fields.prose("title", { required: true, max: 120 });
  const body = fields.prose("body", { required: true, max: 480 });
  const kind = fields.enumValue("kind", BROADCAST_KIND_NAMES, { required: true, label: "announcement, system, news, competition_update or team_update" });
  const confirm = fields.boolean("confirm", { default: false });
  fields.throwIfInvalid();

  const copyProblem = validateCopy(title ?? "", body ?? "");
  if (copyProblem) throw new ApiError("VALIDATION_FAILED", 400, copyProblem);

  // The audience cap is a deployment figure, not a per-request knob: an admin choosing their own ceiling is a
  // way to turn off the limit.
  const res = await rpc(ctx, "kicklive_broadcast_notification", {
    p_title: title,
    p_body: body,
    p_kind: kind,
    p_confirm: confirm ?? false,
    p_created_by: ctx.principal.userId || null,
  });
  const jobId = res["jobId"] ?? res["job_id"] ?? null;
  const audience = res["audience"] ?? null;
  if (ctx.env.NOTIFICATION_QUEUE && jobId !== null) {
    // Awaited, unlike the trigger's `waitUntil`: here the caller is an admin waiting for an answer, and a send
    // that will happen "when the sweep gets to it" is a worse reply than a queue that refused the message.
    await ctx.env.NOTIFICATION_QUEUE.send({ jobId: Number(jobId) });
  }
  return ok({ jobId, audience, status: "queued", note: "The send runs in the queue; delivery outcomes land in notification_deliveries." }, { status: 202, requestId: ctx.requestId });
}

// The same five kinds the SQL function allows. It is written twice on purpose — once here for a 400 with a
// field name, once in the function as the authority — and the parity test in
// `tests/unit/phase5-notifications.test.ts` is what keeps the two honest.
const BROADCAST_KIND_NAMES = ["announcement", "system", "news", "competition_update", "team_update"] as const;

/**
 * `GET /api/notifications/diagnostics` — admin-only, and deliberately not a list of jobs. It answers "is the
 * pipeline moving" with counts and an age, because the moment a diagnostics endpoint returns notification bodies
 * it becomes a way to read other people's inboxes through an operator's token.
 */
export async function handleNotificationDiagnostics(ctx: HandlerContext): Promise<Response> {
  if (ctx.principal.role !== "admin") throw new ApiError("FORBIDDEN", 403, "Administrator only.");
  const runtime = runtimeFor(ctx.env);
  const summary = await runtime.repo.pending(25);
  return ok(
    {
      transport: runtime.transport.name,
      counts: summary.counts,
      claimable: summary.jobIds.length,
      oldestPendingSeconds: summary.oldestPendingSeconds,
      // Whether the migration has been applied at all. `null` from the RPC means "no jobs table", and an
      // operator reading this needs that distinction, because everything else looks the same when it is empty.
      queueBound: Boolean(ctx.env.NOTIFICATION_QUEUE),
      applied: !(summary.jobIds.length === 0 && Object.keys(summary.counts).length === 0),
    },
    { requestId: ctx.requestId },
  );
}

/** Used by the queue consumer's tests and by `POST /api/notifications/inbox/:id/read` retries. */
export async function deliverNow(env: Env, jobId: number): Promise<unknown> {
  const runtime = runtimeFor(env);
  return deliverJob(runtime.repo, runtime.transport, jobId, { linkBase: runtime.linkBase });
}
