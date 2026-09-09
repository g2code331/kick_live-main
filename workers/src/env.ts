/**
 * Everything the Worker can be configured with, in one typed place.
 *
 * Two kinds of entry, and the difference matters:
 *   - plain `readonly` strings are `[vars]` in wrangler.toml → visible in the deployed config, so
 *     they must never hold a secret;
 *   - anything documented as a secret arrives only through `wrangler secret put` and appears here as
 *     optional, because a missing secret has to produce a clear runtime error rather than `undefined`
 *     being sent in an Authorization header.
 */

export type AppRole = "fan" | "team_manager" | "media" | "admin";

export interface Env {
  /** e.g. https://<ref>.supabase.co — same project the SPA uses. */
  readonly SUPABASE_URL: string;

  /**
   * Publishable key. Used for reads that should still be governed by RLS (so an over-permissive
   * Worker bug cannot read what the user could not read).
   */
  readonly SUPABASE_ANON_KEY?: string | undefined;

  /**
   * Service role key. BYPASSES RLS ON EVERY TABLE. Secret: `wrangler secret put
   * SUPABASE_SERVICE_ROLE_KEY`. Never logged, never returned to a client, never used for a read
   * that anon could perform.
   */
  readonly SUPABASE_SERVICE_ROLE_KEY?: string | undefined;

  /** Project JWT secret, to verify the HS256 access token the SPA sends us. Secret. */
  readonly SUPABASE_JWT_SECRET?: string | undefined;

  /** Comma-separated exact origins. Empty/unset = no cross-origin access at all (never `*`). */
  readonly ALLOWED_ORIGINS?: string | undefined;

  /** 'development' | 'staging' | 'production'; drives verbose errors and Turnstile enforcement. */
  readonly APP_ENV?: string | undefined;

  /** Turnstile secret for signup/write routes. Secret. Unset = the check is skipped in dev only. */
  readonly TURNSTILE_SECRET_KEY?: string | undefined;

  /** Optional bindings, declared now so routes can be written against them in Phase 2. */
  readonly RATE_LIMIT_KV?: KVNamespace | undefined;
  readonly MEDIA_BUCKET?: R2Bucket | undefined;
  readonly JOB_QUEUE?: Queue<JobMessage> | undefined;
  readonly MATCH_ROOM?: DurableObjectNamespace | undefined;
}

export interface JobMessage {
  readonly kind: "standings.recompute" | "notifications.fanout" | "media.optimize" | "import.fixtures";
  readonly matchId?: number;
  readonly competitionId?: number;
  readonly requestId?: string;
}

export class ConfigError extends Error {
  readonly status = 500;
  constructor(name: string) {
    super(`Worker is missing required configuration: ${name}`);
    this.name = "ConfigError";
  }
}

export function requireEnv(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(name);
  return value.trim();
}

export function requireSecret(env: Env, name: keyof Env, wranglerName = name): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${name} (set it with: npx wrangler secret put ${wranglerName})`);
  }
  return value.trim();
}

export function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "development") === "production";
}

export function allowedOrigins(env: Env): readonly string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
}
