/**
 * Phase 15 · the messaging endpoints.
 *
 * A conversation inbox between an ordinary account and the staff desk. Every route here is thin: none of
 * them decides who may do what. Each runs as the caller's own JWT through a `SECURITY DEFINER` function that
 * takes the actor from `auth.uid()` and re-checks the role, so:
 *
 *   - a body cannot name a sender (an undeclared `sender_id` key is rejected by `readJsonBody`, and the
 *     function ignores anything the client might claim about identity — the sender is `auth.uid()`);
 *   - reading a thread is gated by RLS (owner sees their own, staff see all) AND by the function's own
 *     `user_id = auth.uid() or is_admin_or_media()` check, so a bug in one is not a breach on its own;
 *   - only staff (admin/media) can open a thread addressed to a chosen user — the coarse gate is the
 *     `messaging.staff` capability in the route table, the authority is `is_admin_or_media()` in the SQL.
 */
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readJsonBody, readQuery } from "../lib/validation.ts";
import { supabaseAsUser } from "../services/supabase.ts";
import type { HandlerContext } from "./index.ts";
import type { Principal } from "../middleware/auth.ts";

const SEND_KEYS = ["threadId", "body", "subject"] as const;
const START_KEYS = ["userId", "body", "subject"] as const;
const STATUS_KEYS = ["status"] as const;
const THREADS_QUERY_KEYS = ["limit"] as const;
const THREAD_QUERY_KEYS = ["limit"] as const;

/** A Postgres `code` in an RPC's jsonb answer is a business refusal; anything else is an outage. */
interface RpcRefusal {
  readonly ok?: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

const REFUSAL_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
};

function refusalMessage(code: string): string {
  switch (code) {
    case "FORBIDDEN":
      return "You do not have access to this conversation.";
    case "NOT_FOUND":
      return "That conversation could not be found.";
    case "UNAUTHENTICATED":
      return "Messaging is tied to your account. Sign in to continue.";
    default:
      return "The message could not be sent.";
  }
}

function asUser(env: HandlerContext["env"], principal: Principal) {
  if (!principal.token) {
    throw new ApiError("UNAUTHENTICATED", 401, "Messaging is tied to your account. Sign in to continue.");
  }
  return supabaseAsUser(env, principal.token);
}

async function rpc(ctx: HandlerContext, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await asUser(ctx.env, ctx.principal).call(fn, args)) as RpcRefusal | null;
  if (res && res.ok === false) {
    const code = String(res["code"] ?? "DEPENDENCY_FAILED");
    const status = REFUSAL_STATUS[code] ?? 400;
    throw new ApiError("VALIDATION_FAILED", status, refusalMessage(code), {
      fields: [{ field: "reason", message: code }],
      detail: typeof res["detail"] === "string" ? res["detail"] : undefined,
    });
  }
  return (res ?? {}) as Record<string, unknown>;
}

/** `GET /api/messages/threads` — the caller's conversation list. */
export async function handleMessageThreads(ctx: HandlerContext): Promise<Response> {
  const query = readQuery(ctx.url, THREADS_QUERY_KEYS);
  query.assertOnlyDeclared();
  const limit = query.integer("limit", { min: 1, max: 100, default: 50 });
  query.throwIfInvalid();
  const res = await rpc(ctx, "kicklive_message_threads", { p_limit: limit ?? 50 });
  return ok(res, { requestId: ctx.requestId });
}

/** `GET /api/messages/threads/:id` — one thread's messages; marks it read for the caller's side. */
export async function handleMessageThread(ctx: HandlerContext): Promise<Response> {
  const id = new Fields({ id: ctx.params["id"] }, []).integer("id", { required: true, min: 1 });
  if (id === undefined) throw new ApiError("VALIDATION_FAILED", 400, "That conversation id is not valid.");
  const query = readQuery(ctx.url, THREAD_QUERY_KEYS);
  query.assertOnlyDeclared();
  const limit = query.integer("limit", { min: 1, max: 500, default: 200 });
  query.throwIfInvalid();
  const res = await rpc(ctx, "kicklive_message_thread", { p_thread_id: id, p_limit: limit ?? 200 });
  return ok(res, { requestId: ctx.requestId });
}

/** `POST /api/messages/send` — send into an existing thread, or open one (non-staff) when threadId is null. */
export async function handleMessageSend(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, SEND_KEYS);
  fields.assertOnlyDeclared();
  const rawThread = fields.raw["threadId"];
  const threadId = rawThread === undefined || rawThread === null ? null : fields.integer("threadId", { min: 1 });
  const body = fields.prose("body", { required: true, max: 4000 });
  const subject = fields.prose("subject", { max: 200 });
  fields.throwIfInvalid();

  const res = await rpc(ctx, "kicklive_send_message", {
    p_thread_id: threadId ?? null,
    p_body: body,
    p_subject: subject ?? null,
  });
  return ok(res, { status: 201, requestId: ctx.requestId });
}

/** `POST /api/messages/start` — staff-only: open a thread addressed to a chosen account. */
export async function handleMessageStart(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, START_KEYS);
  fields.assertOnlyDeclared();
  const userId = fields.uuid("userId", { required: true });
  const body = fields.prose("body", { required: true, max: 4000 });
  const subject = fields.prose("subject", { max: 200 });
  fields.throwIfInvalid();

  const res = await rpc(ctx, "kicklive_message_start", {
    p_user_id: userId,
    p_body: body,
    p_subject: subject ?? null,
  });
  return ok(res, { status: 201, requestId: ctx.requestId });
}

/** `POST /api/messages/threads/:id/status` — close or reopen a thread. Owner or staff. */
export async function handleMessageStatus(ctx: HandlerContext): Promise<Response> {
  const id = new Fields({ id: ctx.params["id"] }, []).integer("id", { required: true, min: 1 });
  if (id === undefined) throw new ApiError("VALIDATION_FAILED", 400, "That conversation id is not valid.");
  const fields = await readJsonBody(ctx.request, STATUS_KEYS);
  fields.assertOnlyDeclared();
  const status = fields.enumValue("status", ["open", "closed"] as const, { required: true, label: "open or closed" });
  fields.throwIfInvalid();
  const res = await rpc(ctx, "kicklive_message_set_status", { p_thread_id: id, p_status: status });
  return ok(res, { requestId: ctx.requestId });
}

/** `GET /api/messages/unread` — a count for the badge, side-effect free. */
export async function handleMessageUnread(ctx: HandlerContext): Promise<Response> {
  const res = await rpc(ctx, "kicklive_message_unread_count", {});
  return ok(res, { requestId: ctx.requestId });
}
