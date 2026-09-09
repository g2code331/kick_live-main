/**
 * Live tickets: the short credential a WebSocket handshake carries, because a browser cannot attach an
 * `Authorization` header to an upgrade request.
 *
 * The failure mode this exists to avoid is the common one: `?token=<access token>` in the socket URL.
 * That puts a 12-hour, full-account credential into every proxy access log, browser history and error
 * reporter on the path. A ticket instead is
 *
 *   - **scoped to one match** (`match`), so it cannot be replayed against another fixture;
 *   - **scoped to one purpose** (`aud`), so it cannot be presented to any other route as a session;
 *   - **read-only by construction** (`kind` selects which broadcast feed the socket joins — writes always
 *     go through the REST routes with the caller's real token);
 *   - **short**: 6 h for a viewer, 15 min for a controller, which is what makes "reconnect and the
 *     console re-tickets" the normal path rather than a long-lived privilege.
 *
 * `kind: "controller"` is only minted after `services/matchAccess.ts` confirmed an assignment, and the
 * signature is HMAC-SHA256 over the project JWT secret, verified exactly like an access token (exact
 * `alg`, timing-safe compare, `exp`). Nothing about the caller's *role* is trusted from the ticket beyond
 * choosing a broadcast tag — if the signature is forged, the worst outcome is receiving fan frames early.
 */
import type { AppRole, Env } from "../env.ts";
import { requireSecret } from "../env.ts";
import { ApiError } from "./response.ts";

export const LIVE_TICKET_AUDIENCE = "kicklive-live" as const;
export type LiveTicketKind = "viewer" | "controller";

export const TICKET_TTL_SECONDS: Record<LiveTicketKind, number> = { viewer: 6 * 60 * 60, controller: 15 * 60 };

export interface LiveTicketClaims {
  readonly sub: string;
  readonly match: number;
  readonly kind: LiveTicketKind;
  readonly role: AppRole | null;
  readonly exp: number;
  readonly jti: string;
}

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(segment: string): string {
  const pad = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad.padEnd(Math.ceil(pad.length / 4) * 4, "="));
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function issueLiveTicket(env: Env, claims: { userId: string; matchId: number; kind: LiveTicketKind; role: AppRole | null }): Promise<{ ticket: string; expires_in: number; expires_at: string }> {
  const secret = requireSecret(env, "SUPABASE_JWT_SECRET");
  const ttl = TICKET_TTL_SECONDS[claims.kind];
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      aud: LIVE_TICKET_AUDIENCE,
      iat: now,
      exp: now + ttl,
      jti: crypto.randomUUID(),
      sub: claims.userId,
      match: claims.matchId,
      kind: claims.kind,
      role: claims.role,
    }),
  );
  const signature = b64url(await sign(secret, `${header}.${payload}`));
  return { ticket: `${header}.${payload}.${signature}`, expires_in: ttl, expires_at: new Date((now + ttl) * 1000).toISOString() };
}

/** Throws `UNAUTHENTICATED` rather than returning false, so a socket handshake refuses with a real reason. */
export async function verifyLiveTicket(env: Env, ticket: string, expectedMatchId: number): Promise<LiveTicketClaims> {
  const parts = ticket.split(".");
  if (parts.length !== 3) throw new ApiError("UNAUTHENTICATED", 401, "Malformed live ticket.");
  const [headerSeg = "", payloadSeg = "", signatureSeg = ""] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(headerSeg)) as Record<string, unknown>;
    payload = JSON.parse(fromB64url(payloadSeg)) as Record<string, unknown>;
  } catch {
    throw new ApiError("UNAUTHENTICATED", 401, "Malformed live ticket.");
  }
  if (header.alg !== "HS256") throw new ApiError("UNAUTHENTICATED", 401, `Unsupported live-ticket algorithm ${String(header.alg)}.`);
  if (payload.aud !== LIVE_TICKET_AUDIENCE) throw new ApiError("UNAUTHENTICATED", 401, "That ticket was not issued for live match access.");

  const secret = requireSecret(env, "SUPABASE_JWT_SECRET");
  const expected = await sign(secret, `${headerSeg}.${payloadSeg}`);
  const provided = Uint8Array.from(atob(signatureSeg.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (!timingSafeEqualBytes(expected, provided)) throw new ApiError("UNAUTHENTICATED", 401, "Live ticket signature is not valid.");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new ApiError("UNAUTHENTICATED", 401, "Live ticket has expired; request a new one and reconnect.");
  if (payload.match !== expectedMatchId) throw new ApiError("FORBIDDEN", 403, "That live ticket is not for this match.");
  const kind = payload.kind === "controller" ? "controller" : "viewer";
  const role = payload.role === "admin" || payload.role === "team_manager" || payload.role === "media" || payload.role === "fan" ? payload.role : null;
  return {
    sub: String(payload.sub ?? ""),
    match: expectedMatchId,
    kind,
    role,
    exp: payload.exp,
    jti: String(payload.jti ?? ""),
  };
}
