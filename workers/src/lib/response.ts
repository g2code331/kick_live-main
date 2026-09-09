/**
 * The one response envelope, so the SPA branches on `error.code` instead of parsing prose.
 *
 * ```
 * 200  { "success": true,  "data": { … }, "meta"?: { requestId } }
 * 4xx  { "success": false, "error": { "code": "UNAUTHORIZED", "message": "…", "fields"?, "detail"? } }
 * ```
 *
 * `message` is safe to show a user. `detail` (the upstream Postgres/PostgREST text) and `fields` are
 * emitted only when `APP_ENV` is not `production`, so a deployed API never returns a constraint name,
 * a column list or a stack frame. Server-side logging keeps the full text with the request id.
 */

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export type ApiCode =
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
  | "INTERNAL_ERROR";

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: ApiCode;
    message: string;
    fields?: ApiFieldError[];
    detail?: string;
  };
  requestId?: string;
}

export interface ApiOkBody<T> {
  success: true;
  data: T;
  requestId?: string;
}

export class ApiError extends Error {
  code: ApiCode;
  status: number;
  detail: string | undefined;
  fields: ApiFieldError[] | undefined;

  constructor(code: ApiCode, status: number, message: string, opts: { detail?: string; fields?: ApiFieldError[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = opts.detail;
    this.fields = opts.fields && opts.fields.length > 0 ? opts.fields : undefined;
  }
}

/** A declared-but-unbuilt route. Thrown *after* authn+authz, so a fan never sees 501 for an admin route. */
export const notImplemented = (what: string, phase: number, why?: string): ApiError =>
  new ApiError("NOT_IMPLEMENTED", 501, `${what} is not implemented yet (planned for phase ${phase}).`, { detail: why });

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
}

export function ok<T>(data: T, opts: { requestId?: string; status?: number; headers?: Record<string, string> } = {}): Response {
  const body: ApiOkBody<T> = { success: true, data, ...(opts.requestId ? { requestId: opts.requestId } : {}) };
  return json(body, { status: opts.status ?? 200, headers: opts.headers });
}

export function fail(err: unknown, opts: { exposeDetail: boolean; requestId?: string }): Response {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
        ...(err.detail && opts.exposeDetail ? { detail: err.detail } : {}),
      },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    };
    return json(body, {
      status: err.status,
      headers: err.code === "RATE_LIMITED" ? { "retry-after": "30" } : undefined,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  const body: ApiErrorBody = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      ...(opts.exposeDetail ? { detail: message } : {}),
    },
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  return json(body, { status: 500 });
}

/** Maps a thrown validation problem set into the envelope, used by `routes/*` through `readJson`. */
export function validationFailed(fields: ApiFieldError[]): ApiError {
  return new ApiError("VALIDATION_FAILED", 400, `${String(fields.length)} field(s) in the request are not valid.`, { fields });
}
