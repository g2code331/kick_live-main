/**
 * Supabase access for the Worker — the only module in `workers/src` that knows how to talk to PostgREST.
 *
 * Three clients, and picking between them is an authorisation decision, so the choice is made here and
 * named at the call site:
 *
 *   `supabaseAsUser(env, token)`  the caller's own JWT. RLS applies exactly as it does for the browser.
 *                                Default for everything a signed-in user could legitimately do
 *                                themselves: if the Worker has a bug, it can read no more than that
 *                                user could.
 *   `supabaseAnon(env)`          the publishable key. For public reads that should not depend on a
 *                                session (fixtures, published articles).
 *   `supabaseAdmin(env)`         the service-role key. BYPASSES RLS ON EVERY TABLE. Only for the few
 *                                operations that must cross rows a user cannot address — deciding an
 *                                access request, writing the audit row another role must not read,
 *                                notification fan-out. Keep the call sites greppable:
 *                                    grep -rn "supabaseAdmin(" workers/src
 *
 * Why `fetch` and not `@supabase/supabase-js`: in a Worker the SDK buys nothing (no session to persist,
 * no storage, no realtime listener here) and costs a cold-start parse plus a second version to keep in
 * step with the SPA. The REST surface is stable and it is one file to audit.
 */
import type { Env } from "../env.ts";
import { requireEnv, requireSecret } from "../env.ts";
import { ApiError } from "../lib/response.ts";

export type FilterValue = string | number | boolean | null | readonly (string | number)[];

export interface Row {
  [key: string]: unknown;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

class Builder {
  private readonly params: URLSearchParams;
  private readonly headers: Record<string, string>;
  private selectCalled = false;

  private readonly tableUrl: string;

  constructor(baseUrl: string, table: string, key: string, prefer: readonly string[]) {
    this.tableUrl = `${baseUrl}/rest/v1/${encodeURIComponent(table)}`;
    this.params = new URLSearchParams({ select: "*" });
    this.headers = { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" };
    for (const p of prefer) {
      const existing = this.headers["prefer"];
      this.headers["prefer"] = existing ? `${existing},${p}` : p;
    }
  }

  select(columns = "*"): this {
    this.params.set("select", columns);
    this.selectCalled = true;
    return this;
  }

  eq(column: string, value: FilterValue): this {
    this.params.append(column, `eq.${String(value)}`);
    return this;
  }

  neq(column: string, value: FilterValue): this {
    this.params.append(column, `neq.${String(value)}`);
    return this;
  }

  in(column: string, values: readonly (string | number)[]): this {
    this.params.append(column, `in.(${values.map((v) => String(v)).join(",")})`);
    return this;
  }

  gte(column: string, value: string | number): this {
    this.params.append(column, `gte.${String(value)}`);
    return this;
  }

  lte(column: string, value: string | number): this {
    this.params.append(column, `lte.${String(value)}`);
    return this;
  }

  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.params.set("order", `${column}.${opts.ascending === false ? "desc" : "asc"}`);
    return this;
  }

  limit(n: number): this {
    this.params.set("limit", String(Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)))));
    return this;
  }

  /** Refuses an unbounded read: a forgotten `limit()` on a hot route is how a cache gets evicted. */
  async rows<T = Row>(): Promise<T[]> {
    if (!this.selectCalled && !this.params.has("limit")) this.params.set("limit", String(DEFAULT_LIMIT));
    const res = await fetch(`${this.tableUrl}?${this.params}`, { headers: this.headers });
    if (!res.ok) throw await asApiError(res, "read");
    return (await res.json()) as T[];
  }

  async maybeSingle<T = Row>(): Promise<T | null> {
    const rows = await this.rows<T>();
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async insertOne<T = Row>(values: Row): Promise<T> {
    const res = await fetch(this.tableUrl, { method: "POST", headers: this.headers, body: JSON.stringify(values) });
    if (!res.ok) throw await asApiError(res, "insert");
    const rows = (await res.json()) as T[];
    const first = rows[0];
    if (!first) throw new ApiError("DEPENDENCY_FAILED", 502, "The database accepted the write but returned no row.");
    return first;
  }

  async updateMany(values: Row): Promise<void> {
    const res = await fetch(this.tableUrl, { method: "PATCH", headers: this.headers, body: JSON.stringify(values) });
    if (!res.ok) throw await asApiError(res, "update");
  }

  async deleteMany(): Promise<void> {
    const res = await fetch(this.tableUrl, { method: "DELETE", headers: this.headers });
    if (!res.ok) throw await asApiError(res, "delete");
  }

  async rpc<T = unknown>(fn: string, args: Row): Promise<T> {
    const res = await fetch(`${this.tableUrl.replace(/\/rest\/v1\/.*$/, "")}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) throw await asApiError(res, `rpc ${fn}`);
    const text = await res.text();
    return text === "" ? (null as T) : ((JSON.parse(text) as T) ?? (null as T));
  }
}

/**
 * Upstream text is kept in `detail` (dev/staging only) and in the server log — never in the browser
 * payload. A PostgREST error can name columns, constraints and row counts, which is precisely the
 * reconnaissance an unauthenticated prober wants.
 */
async function asApiError(res: Response, op: string): Promise<ApiError> {
  let detail = `${op}: HTTP ${String(res.status)}`;
  try {
    const body = (await res.json()) as { message?: string; hint?: string; code?: string; details?: string };
    detail = `${op}: ${body.message ?? String(res.status)}${body.code ? ` [${body.code}]` : ""}${body.details ? ` ${body.details}` : ""}${body.hint ? ` (${body.hint})` : ""}`;
  } catch {
    /* body was not JSON — keep the status line */
  }
  if (res.status === 401 || res.status === 403) return new ApiError("FORBIDDEN", 403, "The database refused this operation.", { detail });
  if (res.status === 404) return new ApiError("NOT_FOUND", 404, "The requested record does not exist.", { detail });
  if (res.status === 409 || (res.status === 400 && /duplicate key|already exists/.test(detail))) {
    return new ApiError("CONFLICT", 409, "That record conflicts with an existing one.", { detail });
  }
  return new ApiError("DEPENDENCY_FAILED", 502, "The database could not complete this operation.", { detail });
}

/**
 * `SUPABASE_URL` must agree with `SUPABASE_PROJECT_REF`, and must be https unless it is a local
 * PostgREST for tests. Both checks are configuration errors, not user errors: they are reported as 500
 * with the host named (a hostname is already public in the SPA's own config) and never as a redirect
 * or a silent fallback — the Phase 1 audit (F-03) found the app quietly falling back to a *different
 * project* when a key was missing, which is exactly the failure this makes impossible.
 */
export function assertSupabaseUrl(env: Env): string {
  const raw = requireEnv(env, "SUPABASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("INTERNAL_ERROR", 500, "SUPABASE_URL is not a valid URL on this deployment.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ApiError("INTERNAL_ERROR", 500, `SUPABASE_URL must be https (got ${url.protocol}//${url.host}).`);
  }
  const expectedRef = (env.SUPABASE_PROJECT_REF ?? "").trim();
  if (expectedRef && !url.hostname.startsWith(`${expectedRef}.`)) {
    throw new ApiError("INTERNAL_ERROR", 500, `SUPABASE_URL points at ${url.hostname}, but this environment is configured for project ${expectedRef}. Fix the deployment, do not work around it.`);
  }
  return `${url.protocol}//${url.host}`.replace(/\/$/, "");
}

export interface SupabaseRest {
  from(table: string): Builder;
  /** The only way a route may reach a `SECURITY DEFINER` function. */
  call<T = unknown>(fn: string, args: Row): Promise<T>;
}

function client(env: Env, key: string): SupabaseRest {
  const baseUrl = assertSupabaseUrl(env);
  return {
    from: (table) => new Builder(baseUrl, table, key, ["return=representation"]),
    call: async <T>(fn: string, args: Row): Promise<T> => new Builder(baseUrl, "rpc", key, []).rpc<T>(fn, args),
  };
}

/** RLS applies as the caller. Prefer this: a Worker bug then exposes nothing the user lacked. */
export function supabaseAsUser(env: Env, accessToken: string): SupabaseRest {
  return client(env, accessToken);
}

/** RLS applies as `anon`. */
export function supabaseAnon(env: Env): SupabaseRest {
  return client(env, requireEnv(env, "SUPABASE_ANON_KEY"));
}

/**
 * RLS bypassed. Every use must be justified in a comment at the call site, and must re-check the
 * caller's capability first — this client is what makes an unauthorised write possible if it is used
 * to serve a request the caller was never allowed to make.
 */
export function supabaseAdmin(env: Env): SupabaseRest {
  return client(env, requireSecret(env, "SUPABASE_SERVICE_ROLE_KEY"));
}

export type { Builder as TableQueryBuilder };
