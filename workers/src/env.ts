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
   * Declared in Phase 2, because `middleware/ratelimit.ts` reads it and degrades to an in-isolate counter when
   * it is absent. R2 (media) stayed undeclared until Phase 6 gave it code, for the reason stated there:
   * scaffolding a binding with nothing behind it produces a config that looks real and a deploy that fails.
   * Queues became real in Phase 5, below.
   */
  readonly RATE_LIMIT_KV?: KVNamespace | undefined;

  /**
   * Phase 3: the per-match live room (`do/MatchRoom.ts`). Declared optional because a mis-deployed
   * environment must produce "the live room is not bound on this Worker" at the first request, not a
   * `undefined.get` TypeError; `routes/live.ts` checks it before use. Set in `workers/wrangler.toml`
   * per environment, which is also where the class name is registered.
   */
  readonly LIVE_MATCH_ROOM?: DurableObjectNamespace | undefined;

  // ── Phase 5 · notifications ───────────────────────────────────────────────
  //
  // One queue binding and six plain vars, of which only the first is required. Everything secret about push
  // lives in `FCM_SERVICE_ACCOUNT`, which is a secret and therefore absent from `wrangler.toml` entirely.

  /** Queue producer binding (`queues.producers[].binding`). The queue is a wake-up, never the record (§11). */
  readonly NOTIFICATION_QUEUE?: Queue<unknown> | undefined;

  /** FCM project id — *not* the Firebase `projectId` in the SPA's config, which is the same value only by luck. */
  readonly FCM_PROJECT_ID?: string | undefined;

  /**
   * The downloaded service-account JSON, verbatim, as a secret. Contains a private key, so: never echoed by a
   * route, never logged, never written to `wrangler.toml`/`.dev.vars` (only to `.dev.vars` locally, git-ignored).
   */
  readonly FCM_SERVICE_ACCOUNT?: string | undefined;

  /** How many recipients an admin blast may address before it is refused rather than truncated. */
  readonly NOTIFICATIONS_MAX_AUDIENCE?: string | undefined;

  /** Minutes before kick-off that a reminder fires. `0` switches the reminder sweep off. */
  readonly NOTIFICATIONS_REMINDER_LEAD_MINUTES?: string | undefined;

  /** Per-send timeout in ms. A hang must not consume the queue visibility window. */
  readonly FCM_TIMEOUT_MS?: string | undefined;

  /**
   * Deep-link origin for a push tap (`https://kicklive.app` in production). A relative URL is what the service
   * worker opens, so this is only needed when the click may land outside the SPA's own origin.
   */
  readonly NOTIFICATIONS_LINK_BASE?: string | undefined;

  // ── Phase 6 · media on R2 ─────────────────────────────────────────────────
  //
  // Two fields, and neither is a credential — that is the point of the phase. The bucket is reached through a
  // binding, so there is no access key to store, rotate or leak, and `workers/wrangler.toml` names a *different*
  // bucket per environment for the same reason it names a different queue: a shared bucket is a shared outage.

  /**
   * R2 bucket binding (`r2_buckets[].binding`). Optional because an environment without it still deploys: the
   * media routes answer 503 naming the missing binding instead of half-working against a bucket nobody made.
   */
  readonly MEDIA_BUCKET?: R2Bucket | undefined;

  /**
   * Ceiling on one uploaded file, in bytes, across every category (25 MB default). Per-kind caps are tighter and
   * live in `lib/mediaPolicy.ts`; this is the outer bound that stops a category with a generous limit from
   * becoming a request that outlives the Worker's own patience.
   */
  readonly MEDIA_MAX_BYTES?: string | undefined;
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
