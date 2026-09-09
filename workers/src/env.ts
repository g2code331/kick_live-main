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
   * The project ref this environment is *supposed* to talk to. Not a secret, and the one line of
   * defence against a staging key reaching production data (or vice versa): `services/supabase.ts`
   * refuses to build a client when the URL's host does not start with it, so a copy-paste mistake in
   * wrangler.toml is a loud 500 at the first request instead of a quiet write to the wrong project.
   */
  readonly SUPABASE_PROJECT_REF?: string | undefined;

  /** Same project the SPA uses. */

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

  /** 'development' | 'staging' | 'production'; drives error detail exposure, CORS defaults, Turnstile enforcement. */
  readonly APP_ENV?: string | undefined;

  /** Turnstile secret for signup/write routes. Secret. Unset = the check is skipped in dev only. */
  readonly TURNSTILE_SECRET_KEY?: string | undefined;

  /**
   * The only optional binding Phase 2 declares, because `middleware/ratelimit.ts` reads it and
   * degrades to an in-isolate counter when it is absent. R2 (media), Durable Objects (match rooms) and
   * Queues (background jobs) are deliberately NOT declared here: scaffolding bindings with no code
   * behind them produces a config that looks real and a deploy that fails. They arrive in the phase
   * that implements their first route.
   */
  readonly RATE_LIMIT_KV?: KVNamespace | undefined;
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

/** 'development' | 'staging' | 'production' — echoed by `/api/health` and used to pick log/detail policy. */
export function envName(env: Env): string {
  const raw = (env.APP_ENV ?? "development").trim().toLowerCase();
  return raw === "production" || raw === "staging" || raw === "development" ? raw : "development";
}

/**
 * The version a build stamp overwrites at deploy time (`wrangler deploy --var APP_VERSION:$GIT_SHA`).
 * Declared as a constant rather than read from `package.json` because a Worker bundle has no fs.
 */
export const APP_VERSION = "0.1.0-phase2";

export function allowedOrigins(env: Env): readonly string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
}
