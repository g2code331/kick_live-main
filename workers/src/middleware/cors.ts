/**
 * CORS, as a policy rather than a `*`.
 *
 * The API is authenticated by bearer token, so it does not need credentialed CORS and must not allow
 * it: `Access-Control-Allow-Origin: *` combined with any cookie/session behaviour is a cross-site read
 * primitive. Origins come from `ALLOWED_ORIGINS` (exact strings, per environment, see wrangler.toml)
 * and an unset list means "no browser origin may call this Worker" — the desktop renderer talks to it
 * same-origin-less and gets no preflight allowance, which is the correct default until it is added.
 */
import type { Env } from "../env.ts";
import { allowedOrigins } from "../env.ts";

export const ALLOW_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

/** `turnstile-token` and `last-event-id` are part of the contract; unknown headers fail the preflight. */
export const ALLOW_HEADERS = "authorization, content-type, x-request-id, turnstile-token, last-event-id";

/** The client reads these; without the list a browser cannot see them. */
export const EXPOSE_HEADERS = "x-request-id, x-ratelimit-remaining, retry-after";

export const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Null-origin (sandboxed iframe, `file://`) is rejected on purpose — see the note in env docs. */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  return origin;
}

export function isAllowedOrigin(env: Env, origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

/** Returns the origin to echo, or null when the request must not be told anything about CORS. */
export function corsOriginFor(request: Request, env: Env): string | null {
  const origin = requestOrigin(request);
  return isAllowedOrigin(env, origin) ? origin : null;
}

export function preflightResponse(corsOrigin: string | null): Response {
  const headers = new Headers();
  // A rejected preflight is still a 204 with no CORS headers: the browser blocks it, and we have
  // leaked nothing about which origins the operator configured.
  if (corsOrigin) {
    headers.set("access-control-allow-origin", corsOrigin);
    headers.set("access-control-allow-methods", ALLOW_METHODS);
    headers.set("access-control-allow-headers", ALLOW_HEADERS);
    headers.set("access-control-max-age", String(PREFLIGHT_MAX_AGE_SECONDS));
    headers.set("vary", "origin");
  }
  return new Response(null, { status: 204, headers });
}

export function applyCors(headers: Headers, corsOrigin: string | null): Headers {
  if (!corsOrigin) return headers;
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  headers.set("vary", "origin");
  return headers;
}
