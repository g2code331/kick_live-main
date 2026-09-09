/**
 * The one place the SPA talks to the Worker.
 *
 * What this file is for:
 *   - **base URL** — resolved by `src/lib/env.ts`, never hardcoded per page;
 *   - **token** — supplied by an injected `getToken`, so this module has no opinion about Supabase and
 *     can be imported by `node --test` (the app's auth object cannot be);
 *   - **JSON** — encode, parse, and survive a response that is *not* JSON (an edge 502 returns HTML);
 *   - **errors** — a `Promise<ApiResult<T>>`, never a thrown HTTP error. `ok: false` carries the code,
 *     the field list and the `retry-after`, which is what a form needs in order to say something useful;
 *   - **timeouts** — every request is aborted, so a hung Worker cannot pin a spinner to the screen.
 *
 * What it is not: a cache, a retry queue, or a replacement for `src/lib/db.ts`. Reads that the app
 * makes 20 times a minute stay on the path they are on today until the route behind them exists.
 */
import type { ApiErrorCode, ApiFieldError, ApiFailure, ApiRequestOptions, ApiResult, ApiSuccess } from "./types.ts";

/** Path prefix the Worker serves alongside the `/v1` alias. */
export const API_ROOT = "/api";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface ApiClientOptions {
  /** Origin only, e.g. `https://api.kicklive.football` or `""` for same-origin. */
  baseUrl?: string;
  /**
   * Resolves the current Supabase access token, or `null` for an anonymous call. Called once per
   * request, and again on a 401 — that second call is how a just-refreshed session recovers without a
   * reload.
   */
  getToken?: () => Promise<string | null>;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Fired on 401/403 after the retry, for a global "your session ended" reaction. */
  onUnauthorized?: (info: { path: string; code: ApiErrorCode; requestId?: string }) => void;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(method: HttpMethod, path: string, options?: ApiRequestOptions): Promise<ApiResult<T>>;
  get<T>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>>;
  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>>;
  put<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>>;
  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>>;
  del<T>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const JSON_ERROR_FALLBACK: Record<number, ApiErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
  501: "NOT_IMPLEMENTED",
  502: "DEPENDENCY_FAILED",
  503: "DEPENDENCY_FAILED",
  504: "DEPENDENCY_FAILED",
};

function newRequestId(): string {
  const c = globalThis.crypto;
  return typeof c?.randomUUID === "function" ? c.randomUUID() : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withQuery(url: string, query: ApiRequestOptions["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

function joinUrl(baseUrl: string, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const rooted = clean.startsWith(`${API_ROOT}/`) || clean === API_ROOT ? clean : `${API_ROOT}${clean}`;
  return baseUrl ? `${baseUrl}${rooted}` : rooted;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : undefined;
}

function failure(res: Response, text: string, requestId?: string): ApiFailure {
  let code: ApiErrorCode = JSON_ERROR_FALLBACK[res.status] ?? "INTERNAL_ERROR";
  let message = `The API responded with HTTP ${String(res.status)}.`;
  let fields: ApiFieldError[] | undefined;
  let detail: string | undefined;

  const body = safeJson(text);
  if (body && body.success === false && body.error) {
    // The Worker's envelope: trust it over the status line.
    const err = body.error as { code?: string; message?: string; fields?: ApiFieldError[]; detail?: string };
    if (typeof err.code === "string") code = err.code as ApiErrorCode;
    if (typeof err.message === "string" && err.message.length > 0) message = err.message;
    if (Array.isArray(err.fields)) fields = err.fields;
    if (typeof err.detail === "string") detail = err.detail;
    if (typeof body.requestId === "string") requestId = body.requestId;
  } else if (body) {
    message = "The API returned a response that was not in the expected format.";
    detail = text.slice(0, 500);
  } else if (text.trim().startsWith("<")) {
    // An HTML error page means something in front of the Worker answered (proxy, WAF, cold-start 5xx).
    message = "The API is not reachable right now.";
  }

  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  return {
    ok: false,
    status: res.status,
    code,
    message,
    ...(fields ? { fields } : {}),
    ...(detail ? { detail } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function safeJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An error only for code that prefers `try`/`catch`; the client itself never throws on HTTP status. */
export class ApiRequestError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiRequestError";
    this.failure = failure;
  }
}

export async function unwrap<T>(result: Promise<ApiResult<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new ApiRequestError(settled);
  return settled.data;
}

export function isApiFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return result.ok === false;
}

/** Field-keyed message map, which is the shape the existing forms render. */
export function fieldErrors(result: ApiFailure): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of result.fields ?? []) map[field.field] = field.message;
  return map;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));

  async function send<T>(method: HttpMethod, path: string, opts: ApiRequestOptions = {}, attempt = 0): Promise<ApiResult<T>> {
    const url = withQuery(joinUrl(baseUrl, path), opts.query);
    const requestId = newRequestId();
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

    const headers: Record<string, string> = { accept: "application/json", "x-request-id": requestId, ...opts.headers };
    if (options.getToken) {
      const token = await options.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    let body: BodyInit | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof FormData !== "undefined" && opts.body instanceof FormData) body = opts.body;
      else if (typeof URLSearchParams !== "undefined" && opts.body instanceof URLSearchParams) body = opts.body.toString();
      else if (typeof opts.body === "string") body = opts.body;
      else {
        body = JSON.stringify(opts.body);
        if (!("content-type" in lowerKeys(headers))) headers["content-type"] = "application/json";
      }
    }

    let res: Response;
    try {
      res = await doFetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
      const aborted = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      // A caller-initiated abort is not an API failure worth reporting; surface it as a cancelled read.
      return {
        ok: false,
        status: 0,
        code: aborted && !opts.signal?.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        message: opts.signal?.aborted ? "The request was cancelled." : aborted ? `The API did not answer within ${String(Math.round(timeoutMs / 1000))}s.` : "The API could not be reached. Check your connection.",
        requestId,
      } satisfies ApiFailure;
    }
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);

    if (res.status === 401 && attempt === 0 && options.getToken) {
      // Almost always a token refreshed between page render and click. One retry, then report.
      return send<T>(method, path, opts, 1);
    }

    const text = await res.text().catch(() => "");
    if (res.ok) {
      const parsed = safeJson(text);
      if (parsed && parsed.success === true && "data" in parsed) {
        const ok: ApiSuccess<T> = { ok: true, status: res.status, data: parsed.data as T, ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}) };
        return ok;
      }
      if (text === "") return { ok: true, status: res.status, data: null as T, requestId };
      // 2xx that is not the envelope is a contract violation, not a success: say so instead of
      // handing the caller `undefined` and letting a component crash two frames later.
      return { ok: false, status: res.status, code: "DEPENDENCY_FAILED", message: "The API answered with an unexpected body shape.", detail: text.slice(0, 300), requestId } satisfies ApiFailure;
    }

    const failed = failure(res, text, requestId);
    if ((failed.code === "UNAUTHENTICATED" || failed.code === "FORBIDDEN") && options.onUnauthorized) {
      options.onUnauthorized({ path, code: failed.code, requestId });
    }
    return failed;
  }

  return {
    baseUrl,
    request: <T>(method: HttpMethod, path: string, opts?: ApiRequestOptions) => send<T>(method, path, opts ?? {}),
    get: <T>(path: string, opts?: ApiRequestOptions) => send<T>("GET", path, opts ?? {}),
    post: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => send<T>("POST", path, { ...opts, body }),
    put: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => send<T>("PUT", path, { ...opts, body }),
    patch: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => send<T>("PATCH", path, { ...opts, body }),
    del: <T>(path: string, opts?: ApiRequestOptions) => send<T>("DELETE", path, opts ?? {}),
  };
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) out[key.toLowerCase()] = headers[key] ?? "";
  return out;
}
