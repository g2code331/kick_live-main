/**
 * Rate limiting hook. Declared in Phase 1 because the *key design* has to be agreed before any write
 * route exists: per-identity for authenticated traffic, per-IP for anonymous, and a shared store.
 *
 * Not a security boundary on its own: the durable protection comes from KV (shared across isolates)
 * and the WAF rules at the edge. The in-memory map below exists so `wrangler dev` behaves like the
 * production limiter shape without a namespace provisioned, and it is honest about that in its name.
 */
import type { Env } from "../env";

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export interface RateLimiter {
  /** `key` must be `route:identity` — e.g. `match_control.write:8f3a…` or `sign-up:1.2.3.4`. */
  check(key: string, limit: number, windowSeconds: number): Promise<RateDecision>;
}

const memory = new Map<string, { count: number; resetAt: number }>();

/** Per-route budgets, so a burst of goal clicks cannot starve the read path. */
export const BUDGETS = {
  "public.read": { limit: 600, windowSeconds: 60 },
  "match_control.write": { limit: 60, windowSeconds: 60 },
  "media.publish": { limit: 20, windowSeconds: 60 },
  "identity.request_role": { limit: 5, windowSeconds: 3600 },
  "identity.grant_role": { limit: 30, windowSeconds: 60 },
  signup: { limit: 5, windowSeconds: 3600 },
  anonymous_write: { limit: 10, windowSeconds: 3600 },
} as const;

export function createRateLimiter(env: Env): RateLimiter {
  const kv = env.RATE_LIMIT_KV;

  if (!kv) {
    return {
      async check(key, limit, windowSeconds) {
        const now = Date.now();
        const hit = memory.get(key);
        if (!hit || hit.resetAt <= now) {
          memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
          return { allowed: true, retryAfterSeconds: 0, remaining: limit - 1 };
        }
        hit.count += 1;
        const allowed = hit.count <= limit;
        return {
          allowed,
          retryAfterSeconds: allowed ? 0 : Math.ceil((hit.resetAt - now) / 1000),
          remaining: Math.max(0, limit - hit.count),
        };
      },
    };
  }

  return {
    async check(key, limit, windowSeconds) {
      const bucket = `${key}:${String(Math.floor(Date.now() / (windowSeconds * 1000)))}`;
      const current = Number((await kv.get<number>(bucket, { type: "json" })) ?? 0);
      if (current >= limit) {
        return { allowed: false, retryAfterSeconds: windowSeconds, remaining: 0 };
      }
      await kv.put(bucket, JSON.stringify(current + 1), { expirationTtl: Math.max(60, windowSeconds) });
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - current - 1) };
    },
  };
}

/** Best available client identity for a limit key; never used for authorisation. */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
