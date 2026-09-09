/**
 * The response envelope every route uses, so the SPA can branch on `code` instead of parsing prose.
 *
 * Error shape rules: `message` is safe to show a user; `detail` exists only outside production
 * (`APP_ENV=production` strips it) so a stack trace or a constraint name never reaches a browser.
 */

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export interface ErrorBody {
  error: { code: ApiCode; message: string; detail?: string };
  requestId?: string;
}

export type ApiCode = "not_implemented" | "bad_request" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "payload_too_large" | "dependency_failed" | "internal_error";

export class ApiError extends Error {
  code: ApiCode;
  status: number;
  detail: string | undefined;

  constructor(code: ApiCode, status: number, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const notImplemented = (what: string, phase: number, why?: string): ApiError => new ApiError("not_implemented", 501, `${what} is not implemented yet (planned for phase ${phase}).`, why);

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
}

export function fail(err: unknown, opts: { exposeDetail: boolean; requestId?: string }): Response {
  if (err instanceof ApiError) {
    const body: ErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail && opts.exposeDetail ? { detail: err.detail } : {}),
      },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    };
    return json(body, {
      status: err.status,
      headers: err.code === "rate_limited" ? { "retry-after": "30" } : undefined,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  const body: ErrorBody = {
    error: {
      code: "internal_error",
      message: "The request could not be completed.",
      ...(opts.exposeDetail ? { detail: message } : {}),
    },
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  return json(body, { status: 500 });
}

/** `GET /v1/health` is the one route that is real today: it proves the wiring exists. */
export function health(version: string, routeCount: number): Response {
  return json({
    ok: true,
    service: "kicklive-api",
    version,
    routes: routeCount,
    implemented: false,
    note: "Phase 1 skeleton: routes are declared, handlers are pending. See workers/README.md.",
  });
}
