/**
 * The error taxonomy: ten categories, one place, no stack traces.
 *
 * Every failure in this Worker already arrives at exactly one function — `fail()` in `lib/response.ts`, plus
 * the queue/DO paths that cannot answer with a response — so "standardized error categories" is not a request
 * to rewrite those call sites. It is a request for one mapping table that can be read, tested and agreed with,
 * and this file is that table.
 *
 * Three rules the whole file follows:
 *
 *   - **A category describes the layer that failed, not the message.** `SUPABASE_ANON_KEY is not configured`
 *     is a `DATABASE_ERROR` because the dependency that could not be reached is the database, whatever the
 *     sentence says. Messages are for humans and change constantly; a category that moved with them would
 *     make every rate and alert on the other side of this line meaningless.
 *   - **Nothing here is a stack trace, a file path or a driver error string.** The category is the *public*
 *     half of what goes into the log, and it rides on the response as `x-error-category`. The detail stays
 *     where `fail()` already keeps it: out of production bodies, into the log with a request id.
 *   - **`INTERNAL_ERROR` is the only category with no information in it**, which is why `classify` is total:
 *     a new `ApiCode` that nobody mapped is a red test (`tests/unit/phase9-observability.test.ts` walks the
 *     union), not a silent default.
 */
import { ApiError, fail, type ApiCode } from "./response.ts";

export const ERROR_CATEGORIES = [
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "VALIDATION_ERROR",
  "DATABASE_ERROR",
  "R2_ERROR",
  "QUEUE_ERROR",
  "FCM_ERROR",
  "WEBSOCKET_ERROR",
  "NOT_FOUND_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Every category, so a route table or a health probe can be validated against the list rather than a string. */
export const isCategory = (value: unknown): value is ErrorCategory => typeof value === "string" && (ERROR_CATEGORIES as readonly string[]).includes(value);

/**
 * Wire code → category. This is exhaustive over `ApiCode` on purpose: TypeScript will fail the build if a
 * code is added to `response.ts` without saying what layer it belongs to, which is the cheapest possible way
 * to keep the two files from drifting.
 */
const BY_CODE: Record<ApiCode, ErrorCategory> = {
  BAD_REQUEST: "VALIDATION_ERROR",
  VALIDATION_FAILED: "VALIDATION_ERROR",
  PAYLOAD_TOO_LARGE: "VALIDATION_ERROR",
  BOT_CHECK_FAILED: "VALIDATION_ERROR",
  UNAUTHENTICATED: "AUTHENTICATION_ERROR",
  FORBIDDEN: "AUTHORIZATION_ERROR",
  NOT_FOUND: "NOT_FOUND_ERROR",
  METHOD_NOT_ALLOWED: "AUTHORIZATION_ERROR",
  CONFLICT: "VALIDATION_ERROR",
  RATE_LIMITED: "AUTHORIZATION_ERROR",
  NOT_IMPLEMENTED: "INTERNAL_ERROR",
  DEPENDENCY_FAILED: "DATABASE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * The subsystem-specific codes that are not `ApiCode`s: they come back in a Postgres refusal's `code`, in a
 * bucket error, or in a queue rejection, and each has exactly one place in the taxonomy. A refusal whose
 * reason names a media or FCM problem is *that* subsystem's failure wearing a generic status, and the
 * metrics only mean something if they are sorted by what broke.
 */
/**
 * Case-insensitive and prefix-matched on purpose: `PGRST202` and `pgrst` are the same failure, and a trailing
 * word boundary is omitted because `SUPABASE_ANON_KEY` and `PGRST_missing` are both database-layer problems: `SUPABASE_ANON_KEY` and
 * `PGRST202_missing` are both database-layer failures, and a `\b` after the alternative would stop matching at
 * the underscore that joins the credential or the code to its context. A category that misses because of a
 * punctuation rule is a category that silently becomes `INTERNAL_ERROR`, which is the one value that teaches
 * nobody anything.
 */
const BY_REASON: [RegExp, ErrorCategory][] = [
  [/\b(AUTHENTICATION|UNAUTHENTICATED|TOKEN_EXPIRED|TOKEN_INVALID|JWT_INVALID)/, "AUTHENTICATION_ERROR"],
  [/\b(ADMIN_ONLY|FORBIDDEN|ROLE_|CAPABILITY|OWNER_ONLY|NOT_ASSIGNED|ASSIGNMENT)/i, "AUTHORIZATION_ERROR"],
  [/\b(VALIDATION|REQUIRED|MALFORMED|IMMUTABLE|NOT_ALLOWED|REFUSED|DUPLICATE|EXCLUSIVITY|LIMIT)/i, "VALIDATION_ERROR"],
  [/\b(R2|BUCKET|OBJECT|S3|PUT_FAILED|HEAD_FAILED)/i, "R2_ERROR"],
  [/\b(QUEUE|DLQ|PRODUCER|CONSUMER|BATCH)/i, "QUEUE_ERROR"],
  [/\b(FCM|FIREBASE|SENDER_ID|API_KEY_INVALID|THIRD_PARTY_FAILED)/i, "FCM_ERROR"],
  [/\b(WEBSOCKET|SOCKET|HIBERNAT|WS_|CLOSE_10)/i, "WEBSOCKET_ERROR"],
  [/\b(SUPABASE|POSTGREST|PGRST|DATABASE|CONSTRAINT|FOREIGN_KEY|UNIQUE_VIOLATION|DEPENDENCY)/i, "DATABASE_ERROR"],
  [/\b(NOT_FOUND|UNKNOWN_|NO_)/i, "NOT_FOUND_ERROR"],
];

/** A coarse severity, so one field decides both "does this page a log line?" and "does it move the error rate?". */
export type Severity = "info" | "warn" | "error";

export interface Classified {
  readonly category: ErrorCategory;
  readonly severity: Severity;
  readonly status: number;
  readonly retryable: boolean;
  /** The code a client is allowed to see. Never a message. */
  readonly code: ApiCode;
}

/**
 * Classify anything that was thrown, or any response status, into the taxonomy.
 *
 * Total by construction: `ApiError` → its code, an `Error` whose message names a subsystem → that category
 * (the path a raw `fetch` rejection takes), and everything else → `INTERNAL_ERROR` with a 500.
 */
export function classify(err: unknown, fallbackStatus = 500): Classified {
  if (err instanceof ApiError) {
    const category = BY_CODE[err.code] ?? "INTERNAL_ERROR";
    return {
      category,
      severity: severityFor(category, err.status),
      status: err.status,
      retryable: err.status === 429 || err.status === 503 || err.status >= 500,
      code: err.code,
    };
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  for (const [pattern, category] of BY_REASON) {
    if (pattern.test(message)) {
      const status = category === "DATABASE_ERROR" || category === "R2_ERROR" || category === "QUEUE_ERROR" || category === "FCM_ERROR" ? 502 : fallbackStatus;
      return { category, severity: "error", status, retryable: true, code: status === 502 ? "DEPENDENCY_FAILED" : "INTERNAL_ERROR" };
    }
  }
  return { category: "INTERNAL_ERROR", severity: "error", status: fallbackStatus, retryable: false, code: "INTERNAL_ERROR" };
}

/** A status code alone is enough to categorise a response that nobody threw — `fail()`'s happy path and the
 *  metrics buffer both land here. */
export function categoryForStatus(status: number): ErrorCategory {
  if (status === 401) return "AUTHENTICATION_ERROR";
  if (status === 403 || status === 405 || status === 429) return "AUTHORIZATION_ERROR";
  if (status === 400 || status === 409 || status === 413) return "VALIDATION_ERROR";
  if (status === 404) return "NOT_FOUND_ERROR";
  if (status >= 500) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

export function severityFor(category: ErrorCategory, status: number): Severity {
  if (status >= 500) return "error";
  if (status >= 400) return category === "VALIDATION_ERROR" || category === "NOT_FOUND_ERROR" ? "warn" : "error";
  return "info";
}

/**
 * The one sentence a log line about a failure is allowed to carry. Truncated and single-line, because a log
 * that can contain a newline can contain a forged entry, and a log that can contain 4 kB of driver text is a
 * credential with extra steps. Redaction is applied by the caller's `redact()`, not here, so this stays pure.
 */
export const safeMessage = (err: unknown, max = 240): string => {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * `fail()` plus the taxonomy on the wire. One place joins the two files, and it is a *response header*:
 * the body of an error stays byte-for-byte what Phases 1–8 promised, because a client that branches on
 * `error.code` is fine with a category, while a client that hashes the envelope is not.
 *
 * `x-error-category` answers "which layer broke" without a message parse, which is what a dashboard and a
 * browser console both want. It is a debugging aid, not a contract: nothing in this repository is allowed to
 * change user-visible behaviour on it, and the value is always one of the ten categories above.
 */
export function failWithCategory(err: unknown, opts: { exposeDetail: boolean; requestId?: string }): Response {
  const response = fail(err, opts);
  const headers = new Headers(response.headers);
  headers.set("x-error-category", classify(err).category);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
