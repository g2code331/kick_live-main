/**
 * Verifies the Supabase access token the SPA already has, and turns it into an identity.
 *
 * This is the piece that makes the rest of the API worth building: everything downstream trusts
 * `userId` from here and *only* here. Note what is deliberately not trusted:
 *
 *   - `role` in a request body — ignored, not merely discouraged;
 *   - the JWT's own `role` claim — in Supabase that claim is the Postgres role (`anon` /
 *     `authenticated`), not the application role, so treating it as one would be a bug that looks
 *     like a security control;
 *   - `user_metadata.role` — the app used to write privileged roles here during signup.
 *
 * The application role is therefore read from `public.profiles` per request (cheap, indexed, and
 * immediately revoked when an admin demotes someone). If the load becomes hot, cache it in KV for a
 * few seconds — the invalidation story is "drop the key on role change", not "trust the token".
 */
import type { Env, AppRole } from "../env";
import { requireSecret } from "../env";
import { ApiError } from "../lib/response";
import { supabaseAdmin } from "../lib/supabase";

export interface Principal {
  readonly userId: string;
  readonly email: string | null;
  /** Null for anonymous callers. Never inferred from anything but the profiles row. */
  readonly role: AppRole | null;
}

export const ANONYMOUS: Principal = { userId: "", email: null, role: null };

interface JwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  aud?: string | string[];
  iss?: string;
  email?: string;
  role?: string;
}

function b64urlToJson(segment: string): Record<string, unknown> {
  const pad = segment.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(pad.padEnd(Math.ceil(pad.length / 4) * 4, "="));
  return JSON.parse(json) as Record<string, unknown>;
}

async function hmacSha256(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return sig;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Verify signature + expiry. Returns the claims, or throws `unauthenticated`. */
export async function verifyAccessToken(env: Env, token: string): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError("unauthenticated", 401, "Malformed access token.");

  const [headerSeg = "", payloadSeg = "", signatureSeg = ""] = parts;
  let header: Record<string, unknown>;
  let claims: JwtClaims;
  try {
    header = b64urlToJson(headerSeg);
    claims = b64urlToJson(payloadSeg) as JwtClaims;
  } catch {
    throw new ApiError("unauthenticated", 401, "Malformed access token.");
  }

  // HS256 is what a default Supabase project signs access tokens with (JWT secret). A project moved
  // to asymmetric signing must switch this to JWKS/ES256 — silently accepting `alg: none` or a
  // downgrade is the classic break, so the algorithm is matched exactly.
  if (header.alg !== "HS256") {
    throw new ApiError("unauthenticated", 401, `Unsupported token algorithm ${String(header.alg)}; this Worker verifies HS256.`);
  }

  const secret = requireSecret(env, "SUPABASE_JWT_SECRET");
  const expected = new Uint8Array(await hmacSha256(secret, `${headerSeg}.${payloadSeg}`));
  const provided = Uint8Array.from(atob(signatureSeg.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (!timingSafeEqualBytes(expected, provided)) {
    throw new ApiError("unauthenticated", 401, "Access token signature is not valid for this project.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) throw new ApiError("unauthenticated", 401, "Access token has expired.");
  // 60 s of leeway for clock skew between the edge and whatever minted the token.
  if (typeof claims.iat === "number" && claims.iat > now + 60) throw new ApiError("unauthenticated", 401, "Access token is issued in the future.");

  const aud = Array.isArray(claims.aud) ? claims.aud.join(",") : claims.aud;
  if (aud && aud !== "authenticated") throw new ApiError("unauthenticated", 401, `Unexpected token audience ${String(aud)}.`);

  if (!claims.sub) throw new ApiError("unauthenticated", 401, "Access token has no subject.");
  return claims;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || (scheme ?? "").toLowerCase() !== "bearer") return null;
  return value.trim();
}

const APP_ROLES: readonly AppRole[] = ["fan", "team_manager", "media", "admin"];

interface ProfileRow {
  id: string;
  email: string | null;
  role: string;
}

/** `Authorization: Bearer <access_token>` → Principal with the role the database currently holds. */
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const token = bearer(request);
  if (!token) return ANONYMOUS;

  const claims = await verifyAccessToken(env, token);
  const userId = String(claims.sub);

  const rows = await supabaseAdmin(env).from("profiles").select("id, email, role").eq("id", userId).limit(1).rows<ProfileRow>();

  const row = rows[0];
  if (!row) {
    // Valid token, no profile: the account was created before the signup trigger existed, or its
    // profile was deleted. Failing closed here is what stops a stale token keeping the session alive.
    throw new ApiError("unauthenticated", 401, "This account has no profile row; sign out and back in.");
  }

  const role = APP_ROLES.includes(row.role as AppRole) ? (row.role as AppRole) : "fan";
  return { userId: row.id, email: row.email ?? null, role };
}
