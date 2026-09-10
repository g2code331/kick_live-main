/**
 * Authentication: who is calling. Authorization (what they may do) is `middleware/authorization.ts`.
 *
 * Three things this module refuses to do, because they are the ways this product was previously
 * exploitable (docs/SECURITY_AUDIT_PHASE1.md F-01/F-02/F-04):
 *
 *   - it does not read a role from the request body, a query param or a cookie;
 *   - it does not read a role from the JWT. Supabase's `role` *claim* is the Postgres role
 *     (`anon` / `authenticated`), not `profiles.role`; treating one as the other would look exactly
 *     like a security control while being a bug;
 *   - it does not accept a user id from the caller. `userId` comes from `sub`.
 *
 * The authoritative application role is read from `public.profiles` on every request. That is one
 * indexed primary-key read per request; if it ever needs caching, cache it in KV and invalidate on
 * role change — never "trust the token" as the alternative.
 */
import type { AppRole, Env } from "../env.ts";
import { requireSecret } from "../env.ts";
import { ApiError } from "../lib/response.ts";
import { supabaseAsUser } from "../services/supabase.ts";
import { isProfileRow, PROFILE_COLUMNS, type ProfileRow } from "../services/profiles.ts";

export interface Principal {
  readonly userId: string;
  readonly email: string | null;
  readonly username: string | null;
  /** Null for anonymous callers. Never inferred from anything but the profiles row. */
  readonly role: AppRole | null;
  /** The verified access token, for routes that must call Supabase *as this user* (RLS applies). */
  readonly token: string | null;
}

export const ANONYMOUS: Principal = { userId: "", email: null, username: null, role: null, token: null };

interface JwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  aud?: string | string[];
  iss?: string;
  email?: string;
  role?: string;
}

const APP_ROLES: readonly AppRole[] = ["fan", "team_manager", "media", "admin"];

function b64urlToJson(segment: string): Record<string, unknown> {
  const pad = segment.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(pad.padEnd(Math.ceil(pad.length / 4) * 4, "="));
  return JSON.parse(json) as Record<string, unknown>;
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Signature, expiry, clock skew and audience. Throws `UNAUTHENTICATED` rather than returning false. */
export async function verifyAccessToken(env: Env, token: string): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError("UNAUTHENTICATED", 401, "Malformed access token.");

  const [headerSeg = "", payloadSeg = "", signatureSeg = ""] = parts;
  let header: Record<string, unknown>;
  let claims: JwtClaims;
  try {
    header = b64urlToJson(headerSeg);
    claims = b64urlToJson(payloadSeg) as JwtClaims;
  } catch {
    throw new ApiError("UNAUTHENTICATED", 401, "Malformed access token.");
  }

  // A default Supabase project signs access tokens HS256 with the project JWT secret. If a project is
  // moved to asymmetric signing this must become a JWKS lookup; accepting `alg: none` or letting the
  // header pick the algorithm is the classic break, so the algorithm is matched exactly.
  if (header.alg !== "HS256") {
    throw new ApiError("UNAUTHENTICATED", 401, `Unsupported token algorithm ${String(header.alg)}; this Worker verifies HS256.`);
  }

  const secret = requireSecret(env, "SUPABASE_JWT_SECRET");
  const expected = await hmacSha256(secret, `${headerSeg}.${payloadSeg}`);
  const provided = Uint8Array.from(atob(signatureSeg.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (!timingSafeEqualBytes(expected, provided)) {
    throw new ApiError("UNAUTHENTICATED", 401, "Access token signature is not valid for this project.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) throw new ApiError("UNAUTHENTICATED", 401, "Access token has expired.");
  if (typeof claims.iat === "number" && claims.iat > now + 60) throw new ApiError("UNAUTHENTICATED", 401, "Access token is issued in the future.");

  const aud = Array.isArray(claims.aud) ? claims.aud.join(",") : claims.aud;
  if (aud && aud !== "authenticated") throw new ApiError("UNAUTHENTICATED", 401, `Unexpected token audience ${String(aud)}.`);
  if (!claims.sub) throw new ApiError("UNAUTHENTICATED", 401, "Access token has no subject.");
  return claims;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || (scheme ?? "").toLowerCase() !== "bearer") return null;
  return value.trim();
}

/** `Authorization: Bearer <access_token>` → Principal with the role the database holds right now. */
export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const token = bearer(request);
  if (!token) return ANONYMOUS;

  const claims = await verifyAccessToken(env, token);
  const userId = String(claims.sub);

  // Read *as the caller*: `profiles` is readable to `authenticated` under RLS, so the Worker needs no
  // elevated key just to learn who is calling. `select(PROFILE_COLUMNS)` keeps the projection narrow.
  const row = await supabaseAsUser(env, token).from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle<ProfileRow>();
  if (!row || !isProfileRow(row)) {
    // Valid token, no profile: created before the signup trigger existed, or deleted. Failing closed
    // here is what stops a stale token from keeping a half-account alive.
    throw new ApiError("UNAUTHENTICATED", 401, "This account has no profile row; sign out and back in.");
  }

  const role = APP_ROLES.includes(row.role as AppRole) ? (row.role as AppRole) : "fan";
  // `email` is deliberately not read any more (Phase 10 narrowed the column grant so that a fan's own JWT
  // cannot list the directory); `Principal.email` stays on the interface because `SafeProfile` maps it, and it
  // answers null rather than the client reaching for `profiles` itself.
  return { userId: row.id, email: row.email ?? null, username: row.username, role, token };
}

/**
 * The reusable authentication guard: anonymous callers get 401 here, before a handler can see `{}`.
 * `authorizeForRoute` calls it for every capability except `public.read`, so no individual route has to
 * remember it; a handler that resolves a principal from something other than the pipeline (a future
 * queue consumer, say) calls it directly.
 */
export function requireAuth(principal: Principal): Principal & { role: AppRole; userId: string } {
  if (!principal.userId || principal.role === null) {
    throw new ApiError("UNAUTHENTICATED", 401, "Authentication required.");
  }
  return principal as Principal & { role: AppRole; userId: string };
}
