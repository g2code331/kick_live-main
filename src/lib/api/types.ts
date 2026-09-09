/**
 * Types the SPA mirrors from the Worker's contract.
 *
 * Deliberately a copy rather than a shared import: the two sides are built by different bundlers with
 * different `lib` settings (`DOM` vs `@cloudflare/workers-types`), and a shared `types/` directory
 * would need its own project reference and a build order for a dozen lines. `workers/src/types/api.ts`
 * is the authority; a test in `tests/unit/phase2-api-boundary.test.ts` pins the field names of both so
 * the copy cannot drift silently.
 */

/** Must stay a superset of `ApiCode` in `workers/src/lib/response.ts`, plus client-only codes. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "BOT_CHECK_FAILED"
  | "NOT_IMPLEMENTED"
  | "DEPENDENCY_FAILED"
  | "INTERNAL_ERROR"
  /** Nothing came back, or the request was aborted — a network fact, not a server answer. */
  | "NETWORK_ERROR"
  | "TIMEOUT";

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiRequestOptions {
  /** Query parameters. `undefined`, `null` and `""` are dropped; arrays repeat the key. */
  query?: Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra headers, e.g. `{ "idempotency-key": crypto.randomUUID() }` on a retryable write. */
  headers?: Record<string, string>;
  /** Override the default timeout for a slow route (imports, exports). */
  timeoutMs?: number;
}

export interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
  requestId?: string;
}

export interface ApiFailure {
  ok: false;
  /** 0 when the request never reached the Worker. */
  status: number;
  code: ApiErrorCode;
  /** Safe to render. The Worker guarantees this is user-facing text, never a stack trace. */
  message: string;
  fields?: ApiFieldError[];
  /** Upstream detail, present only when the Worker runs with `APP_ENV != production`. */
  detail?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface HealthData {
  service: "kick-live-api";
  status: "healthy";
  version: string;
  environment: string;
  routes: { total: number; declared: number; implemented: number };
  time: string;
}

export interface MeData {
  userId: string;
  email: string | null;
  username: string | null;
  role: "fan" | "team_manager" | "media" | "admin";
  capabilities: string[];
}

export interface ManagedTeamSummary {
  id: number;
  name: string;
  short_name: string;
  status: string;
  owner_id: string | null;
}

export interface ManagedTeamsData {
  teams: ManagedTeamSummary[];
  reason: "ok" | "role_has_no_clubs" | "no_clubs_registered";
}
