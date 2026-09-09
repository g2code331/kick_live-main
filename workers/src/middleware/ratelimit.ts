/**
 * Rate limiting — deliberately small, deliberately in the pipeline before any handler runs.
 *
 * The design decision that matters is *where the budget comes from*, not the algorithm:
 *
 *   - every route declares a class in `router.ts` (`rateLimit?: RateLimitClass`);
 *   - the class maps to one window and one limit here;
 *   - the bucket key is the caller's **identity** when they are authenticated and their **IP** when
 *     they are not, so a shared office NAT does not lock out a whole neighbourhood of fans, and one
 *     compromised account cannot spend somebody else's budget.
 *
 * Adding a route therefore costs one word in the route table, which is the whole point: the failure
 * mode of an ad-hoc limiter is the endpoint somebody forgot to protect.
 *
 * `RATE_LIMIT_KV` is the shared store; without it the bucket lives in this isolate's memory. That is
 * fine for `wrangler dev` and useless as a defence, so the limiter says so in a response header
 * (`x-ratelimit-store: memory`) instead of pretending. Turnstile and the Supabase-side quotas remain
 * the real barrier for credential-exchange endpoints until KV is provisioned.
 */
import type { Env } from "../env.ts";

export type RateLimitClass = "public" | "authenticated" | "mutation" | "auth-exchange" | "admin-blast";

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
  windowSeconds: number;
  store: "memory" | "kv";
}

export interface RateLimiter {
  check(key: string, budget: { limit: number; windowSeconds: number }): Promise<RateDecision>;
}

/** Named budgets, so "strict" means the same thing on every route. */
export const BUDGETS: Record<RateLimitClass, { limit: number; windowSeconds: number }> = {
  /** Reads a fan can issue continuously (fixtures, standings, articles). A page load is ~5 of these. */
  public: { limit: 600, windowSeconds: 60 },
  /** Authenticated reads, incl. the 15 s polls the SPA does today. Sized so polling is never punished. */
  authenticated: { limit: 240, windowSeconds: 60 },
  /** Any write: an event, a lineup save, an article. A human cannot click faster than this. */
  mutation: { limit: 60, windowSeconds: 60 },
  /** Credential exchange (sign-up, token issue, role request). The brute-force target list. */
  "auth-exchange": { limit: 5, windowSeconds: 900 },
  /** Fan-out from a single action (broadcast to every device) — cheap to trigger, expensive to serve. */
  "admin-blast": { limit: 10, windowSeconds: 60 },
};

/**
 * The endpoints that need it most, written down so the next phase cannot "forget" one:
 * `POST /api/auth/sign-up` and `POST /api/auth/access-requests` (Turnstile applies too),
 * `POST /api/matches/:matchId/events`, `PUT /api/matches/:matchId/state`, `POST /api/media`,
 * `POST /api/admin/notifications/broadcast`, `POST /api/admin/users/:userId/role`.
 */
export const RATE_LIMITED_BY_DEFAULT: readonly string[] = [
  "POST /auth/sign-up",
  "POST /auth/access-requests",
  "POST /matches/:matchId/events",
  "PUT /matches/:matchId/state",
  // Phase 3's other ways to change what thousands of people are watching. Listed here so the census test
  // fails if one of them is ever "refactored" into an unthrottled route.
  "POST /matches/:matchId/corrections",
  "POST /matches/:matchId/finalize",
  "POST /matches/:matchId/lock",
  "POST /matches/:matchId/assignments",
  "POST /matches/:matchId/assignments/stand-down",
  "POST /media",
  "POST /admin/notifications/broadcast",
  "POST /admin/users/:userId/role",
];

const memory = new Map<string, { count: number; resetAt: number }>();

/** Tests need a clean slate; the map is per-isolate anyway, so this is not a production affordance. */
export function resetRateLimitMemory(): void {
  memory.clear();
}

export function createRateLimiter(env: Env): RateLimiter {
  const kv = env.RATE_LIMIT_KV;

  if (!kv) {
    return {
      async check(key, budget) {
        const now = Date.now();
        const hit = memory.get(key);
        if (!hit || hit.resetAt <= now) {
          memory.set(key, { count: 1, resetAt: now + budget.windowSeconds * 1000 });
          return { allowed: true, retryAfterSeconds: 0, remaining: budget.limit - 1, limit: budget.limit, windowSeconds: budget.windowSeconds, store: "memory" };
        }
        hit.count += 1;
        const allowed = hit.count <= budget.limit;
        return {
          allowed,
          retryAfterSeconds: allowed ? 0 : Math.ceil((hit.resetAt - now) / 1000),
          remaining: Math.max(0, budget.limit - hit.count),
          limit: budget.limit,
          windowSeconds: budget.windowSeconds,
          store: "memory",
        };
      },
    };
  }

  return {
    async check(key, budget) {
      // Fixed window keyed by the window instant: one KV read, no CAS loop, and the ttl does the purge.
      const bucket = `${key}:${String(Math.floor(Date.now() / (budget.windowSeconds * 1000)))}`;
      const current = Number((await kv.get<number>(bucket, { type: "json" })) ?? 0);
      if (current >= budget.limit) {
        return { allowed: false, retryAfterSeconds: budget.windowSeconds, remaining: 0, ...budget, store: "kv" };
      }
      await kv.put(bucket, JSON.stringify(current + 1), { expirationTtl: Math.max(60, budget.windowSeconds) });
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, budget.limit - current - 1), ...budget, store: "kv" };
    },
  };
}

/** Identity when we have it, IP when we do not. Never used for authorisation — it is a bucket name. */
export function limitKeyFor(route: string, class_: RateLimitClass, userId: string | null, ip: string): string {
  return `${class_}:${route}:${userId ?? `ip:${ip}`}`;
}

/** Best available client IP for an anonymous bucket. `cf-connecting-ip` is the only trustworthy one. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? (forwarded ? (forwarded.split(",")[0]?.trim() ?? "unknown") : "unknown");
}

export function rateLimitHeaders(decision: RateDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-store": decision.store,
  };
  if (!decision.allowed) headers["retry-after"] = String(decision.retryAfterSeconds);
  return headers;
}
