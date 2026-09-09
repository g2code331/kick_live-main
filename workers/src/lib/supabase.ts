/**
 * Minimal PostgREST client for the Worker — enough for Phase 2's handlers, no dependency.
 *
 * Why `fetch` instead of `@supabase/supabase-js`: the SDK in a Worker buys nothing (no session, no
 * storage, no realtime listener here) and costs a cold-start parse plus a version to keep in step
 * with the SPA. The REST surface is stable and it is one file to audit.
 *
 * Which key is used is a security decision, so it is explicit at the call site:
 *   - `supabaseAnon()` → RLS applies. Default for reads. A Worker bug then exposes no more than the
 *     caller could already read.
 *   - `supabaseAdmin()` → service role, RLS bypassed. Only for the handful of operations that must
 *     cross rows a user cannot address (approve a request, write an audit row, fan out notifications),
 *     and each one has to re-check authorisation before calling.
 */
import type { Env } from "../env";
import { requireEnv, requireSecret } from "../env";
import { ApiError } from "./response";

export type FilterValue = string | number | boolean | null | readonly (string | number)[];

interface Row {
  [key: string]: unknown;
}

class Builder {
  private readonly params = new URLSearchParams();
  private readonly headers: Record<string, string>;
  private selecting = false;

  private readonly baseUrl: string;
  private readonly tableUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, tableUrl: string, authHeader: string, prefer: readonly string[]) {
    this.baseUrl = baseUrl;
    this.tableUrl = tableUrl;
    this.authHeader = authHeader;
    this.params.set("select", "*");
    this.headers = { authorization: authHeader, accept: "application/json", "content-type": "application/json" };
    for (const p of prefer) {
      const existing = this.headers["prefer"];
      this.headers["prefer"] = existing ? `${existing},${p}` : p;
    }
  }

  select(columns = "*"): this {
    this.params.set("select", columns);
    this.selecting = true;
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
    this.params.set("limit", String(Math.max(1, Math.min(500, Math.trunc(n)))));
    return this;
  }

  /** Refuses an unbounded read: a forgotten `limit()` on a hot route is how a cache gets evicted. */
  async rows<T = Row>(): Promise<T[]> {
    if (!this.selecting) this.params.set("limit", "100");
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
    if (!first) throw new ApiError("dependency_failed", 502, "The database accepted the write but returned no row.");
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
}

/** `POST /rest/v1/rpc/<fn>` — the only way a route may reach a SECURITY DEFINER function. */
async function callRpc(baseUrl: string, authHeader: string, fn: string, args: Row): Promise<unknown> {
  const headers = { authorization: authHeader, accept: "application/json", "content-type": "application/json" };
  const res = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw await asApiError(res, `rpc ${fn}`);
  const text = await res.text();
  return text === "" ? null : (JSON.parse(text) as unknown);
}

async function asApiError(res: Response, op: string): Promise<ApiError> {
  let detail = `${op}: HTTP ${String(res.status)}`;
  try {
    const body = (await res.json()) as { message?: string; hint?: string; code?: string };
    detail = `${op}: ${body.message ?? res.status}${body.hint ? ` (${body.hint})` : ""}${body.code ? ` [${body.code}]` : ""}`;
  } catch {
    /* body was not JSON — keep the status line */
  }
  // Never leak the upstream message to the browser in production; `fail()` strips this to `detail`.
  if (res.status === 401 || res.status === 403) return new ApiError("forbidden", 403, "The database refused this operation.", detail);
  return new ApiError("dependency_failed", 502, "The database could not complete this operation.", detail);
}

export interface SupabaseRest {
  from(table: string): Builder;
  /** Call a `SECURITY DEFINER` function; this is how role/access decisions reach Postgres. */
  call<T = unknown>(fn: string, args: Row): Promise<T>;
}

function client(env: Env, key: string): SupabaseRest {
  const baseUrl = requireEnv(env, "SUPABASE_URL");
  const authHeader = `Bearer ${key}`;
  return {
    from: (table) => new Builder(baseUrl, `${baseUrl}/rest/v1/${encodeURIComponent(table)}`, authHeader, ["return=representation"]),
    call: async <T>(fn: string, args: Row): Promise<T> => (await callRpc(baseUrl, authHeader, fn, args)) as T,
  };
}

/** RLS-governed client. Use for anything a signed-in user could do themselves. */
export function supabaseAnon(env: Env): SupabaseRest {
  return client(env, requireEnv(env, "SUPABASE_ANON_KEY"));
}

/**
 * Service-role client. Bypasses RLS on every table. Keep the number of call sites small and greppable:
 *   grep -rn "supabaseAdmin(" workers/src
 */
export function supabaseAdmin(env: Env): SupabaseRest {
  return client(env, requireSecret(env, "SUPABASE_SERVICE_ROLE_KEY"));
}
