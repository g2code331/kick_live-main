/**
 * Cloudflare Turnstile verification for the routes a bot would abuse: account creation, access
 * requests, and anonymous writes (the `media.views` increment is the current example).
 *
 * Declared now because the *contract* is what changes the SPA: a route either requires a
 * `turnstile-token` header or it does not, and that has to be decided before the client is written.
 * In development the check is skipped when no secret is configured, so `wrangler dev` stays usable.
 */
import type { Env } from "../env";
import { isProduction } from "../env";
import { ApiError } from "../lib/response";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  "challenge-ts"?: string;
  hostnames?: string[];
  action?: string;
  cdata?: string;
  "error-codes"?: string[];
}

export async function verifyTurnstile(env: Env, token: string | null, remoteIp: string, expectedAction?: string): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY;

  if (!token) {
    if (isProduction(env)) throw new ApiError("forbidden", 403, "This action needs a Turnstile challenge.");
    return;
  }
  if (!secret) {
    if (isProduction(env)) {
      throw new ApiError("internal_error", 500, "TURNSTILE_SECRET_KEY is not configured on this deployment.");
    }
    return;
  }

  const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
  if (expectedAction) body.set("expectedAction", expectedAction);

  let result: TurnstileResult;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    result = (await res.json()) as TurnstileResult;
  } catch (err) {
    // A siteverify outage must not lock the product shut; in production it must, because the
    // alternative is "the bot gate can be taken down for free". Fail closed in prod, open in dev.
    if (isProduction(env)) {
      throw new ApiError("dependency_failed", 503, "The bot check is unavailable. Try again shortly.", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (!result.success) {
    throw new ApiError("forbidden", 403, "The bot check failed.", (result["error-codes"] ?? []).join(","));
  }
  if (expectedAction && result.action && result.action !== expectedAction) {
    throw new ApiError("forbidden", 403, "The bot check was issued for a different action.");
  }
}

/** What the SPA must send: `turnstile-token` header on the routes the table marks `turnstile: true`. */
export const TURNSTILE_HEADER = "turnstile-token";
