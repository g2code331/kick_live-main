/**
 * Request validation. Nothing that reaches a handler may assume the browser sent sensible JSON.
 *
 * Hand-rolled rather than pulling in zod/valibot: the surface this API needs is a dozen primitives,
 * the rules that matter are already written in Postgres (CHECK constraints, FKs, NOT NULL), and the
 * enum lists below are copied from `KICKLIVE_FINAL_SCHEMA.sql` so a 400 from the API and a 23514 from
 * the database say the same thing. Zero dependencies also keeps the Worker's cold-start parse small.
 * Add a library in the phase that needs generated types from the schema; not before.
 *
 * Three rules every reader here follows:
 *   - unknown keys are reported, never silently ignored: a body carrying `{"role":"admin"}` to a route
 *     that does not declare `role` must fail loudly, or someone will "fix" it by reading it;
 *   - a field becomes a safe, typed value or a `fields[]` entry — no partial mutation;
 *   - limits mirror the column (a `text` with a CHECK list still needs a length cap before it reaches
 *     Postgres, because the error you want is the one you wrote).
 */
import { ApiError } from "./response.ts";
import type { ApiFieldError } from "./response.ts";

/** `public.matches.status` CHECK list. */
export const MATCH_STATUSES = [
  "scheduled",
  "waiting",
  "first_half",
  "half_time",
  "second_half",
  "extra_time",
  "penalty_shootout",
  "full_time",
  "suspended",
  "postponed",
  "abandoned",
  "cancelled",
  "completed",
  "live",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** `public.match_events.event_type` CHECK list. */
export const MATCH_EVENT_TYPES = [
  "kickoff",
  "goal",
  "own_goal",
  "penalty_goal",
  "penalty_missed",
  "yellow_card",
  "second_yellow",
  "red_card",
  "substitution",
  "substitution_off",
  "substitution_on",
  "corner",
  "offside",
  "free_kick",
  "throw_in",
  "goal_kick",
  "var_check",
  "var_overturned",
  "injury",
  "water_break",
  "half_time",
  "second_half_start",
  "extra_time_start",
  "extra_time_half_time",
  "penalty_shootout_start",
  "full_time",
  "match_abandoned",
] as const;
export type MatchEventType = (typeof MATCH_EVENT_TYPES)[number];

/** `public.match_events.goal_type` CHECK list. */
export const GOAL_TYPES = ["normal", "header", "penalty", "free_kick", "own_goal", "volley", "long_shot", "tap_in"] as const;

export const ROLE_VALUES = ["fan", "team_manager", "media", "admin"] as const;
/** What a *request body* may ask for. `admin` is deliberately absent — see F-01/F-02 in the audit. */
export const REQUESTABLE_ROLES = ["team_manager", "media"] as const;

export const MAX_BODY_BYTES = 64 * 1024;

export class Fields {
  errors: ApiFieldError[];
  private readonly data: Record<string, unknown>;
  private readonly touched: Set<string>;
  private readonly declared: Set<string>;

  constructor(source: unknown, declaredKeys: readonly string[] = []) {
    if ((source !== null && typeof source !== "object") || Array.isArray(source)) {
      throw new ApiError("BAD_REQUEST", 400, "Expected a JSON object body.");
    }
    this.data = (source ?? {}) as Record<string, unknown>;
    this.errors = [];
    this.touched = new Set();
    this.declared = new Set(declaredKeys);
  }

  /** The body may not name a field the route never asked for. Checked before any handler runs. */
  assertOnlyDeclared(): void {
    for (const key of Object.keys(this.data)) {
      if (!this.declared.has(key)) {
        this.errors.push({ field: key, message: "is not a field this endpoint accepts" });
      }
    }
    this.throwIfInvalid();
  }

  throwIfInvalid(): void {
    if (this.errors.length === 0) return;
    throw new ApiError("VALIDATION_FAILED", 400, `${String(this.errors.length)} field(s) in the request are not valid.`, {
      fields: this.errors,
    });
  }

  private note(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  private take(key: string): unknown {
    this.touched.add(key);
    return this.data[key];
  }

  get raw(): Record<string, unknown> {
    return this.data;
  }

  /** Keys this route actually read — useful for the audit row's `details`. */
  get read(): readonly string[] {
    return [...this.touched];
  }

  string(key: string, opts: { required?: boolean; min?: number; max?: number; pattern?: RegExp; patternMessage?: string; default?: string } = {}): string | undefined {
    const value = this.take(key);
    if (value === undefined || value === null || value === "") {
      if (opts.default !== undefined) return opts.default;
      if (opts.required) this.note(key, "is required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.note(key, `must be a string (got ${typeof value})`);
      return undefined;
    }
    const out = value.trim();
    const min = opts.min ?? 1;
    if (out.length < min) this.note(key, `must be at least ${String(min)} character(s)`);
    if (opts.max !== undefined && out.length > opts.max) this.note(key, `must be at most ${String(opts.max)} characters`);
    if (opts.pattern && !opts.pattern.test(out)) this.note(key, opts.patternMessage ?? "has an unsupported format");
    return out;
  }

  /** Text that is stored and re-rendered next to other people's content: no control bytes, capped. */
  prose(key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    // eslint-disable-next-line no-control-regex
    const value = this.string(key, { required: opts.required, max: opts.max ?? 2000, pattern: /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/, patternMessage: "contains control characters" });
    return value;
  }

  integer(key: string, opts: { required?: boolean; min?: number; max?: number; default?: number } = {}): number | undefined {
    const value = this.take(key);
    if (value === undefined || value === null || value === "") {
      if (opts.default !== undefined) return opts.default;
      if (opts.required) this.note(key, "is required");
      return undefined;
    }
    const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
    if (!Number.isInteger(n)) {
      this.note(key, "must be a whole number");
      return undefined;
    }
    if (opts.min !== undefined && n < opts.min) this.note(key, `must be ${String(opts.min)} or more`);
    if (opts.max !== undefined && n > opts.max) this.note(key, `must be ${String(opts.max)} or less`);
    return n;
  }

  /** Scores: small, non-negative, and never a float — a `2.5` in a score column is a client bug. */
  score(key: string, opts: { required?: boolean } = {}): number | undefined {
    return this.integer(key, { required: opts.required, min: 0, max: 99 });
  }

  /**
   * A match minute. `90` is not the ceiling: stoppage time and extra time are real, and refusing a
   * legitimate `94` is how operators start editing the clock backwards to make the form accept reality.
   */
  minute(key: string, opts: { required?: boolean; extraTime?: boolean; shootout?: boolean } = {}): number | undefined {
    const ceiling = opts.shootout ? 120 : opts.extraTime ? 120 : 130;
    return this.integer(key, { required: opts.required, min: 0, max: ceiling });
  }

  enumValue<K extends readonly string[]>(key: string, allowed: K, opts: { required?: boolean; label?: string } = {}): K[number] | undefined {
    const value = this.string(key, { required: opts.required, max: 64 });
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      this.note(key, `${opts.label ?? "value"} must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return value as K[number];
  }

  uuid(key: string, opts: { required?: boolean } = {}): string | undefined {
    return this.string(key, {
      required: opts.required,
      max: 36,
      pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      patternMessage: "must be a uuid",
    });
  }

  boolean(key: string, opts: { default?: boolean } = {}): boolean | undefined {
    const value = this.take(key);
    if (value === undefined || value === null) return opts.default;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    this.note(key, "must be true or false");
    return undefined;
  }

  /** ISO-8601 instant. Postgres columns are `timestamptz`, so a bare date is accepted and normalised. */
  timestamp(key: string, opts: { required?: boolean } = {}): string | undefined {
    const value = this.string(key, { required: opts.required, max: 40, pattern: /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/ });
    if (value === undefined) return undefined;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      this.note(key, "is not a real date");
      return undefined;
    }
    return new Date(ms).toISOString();
  }

  /** Positive small integers: team/player ids in this schema are `serial`, so no uuid pattern here. */
  rowId(key: string, opts: { required?: boolean } = {}): number | undefined {
    return this.integer(key, { required: opts.required, min: 1, max: 2147483647 });
  }
}

/** Read + size-bound a JSON body. `Content-Length` alone is not trusted: a chunked request has none. */
export async function readJsonBody(request: Request, declaredKeys: readonly string[], opts: { maxBytes?: number } = {}): Promise<Fields> {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", 413, `Request body must be ${String(maxBytes)} bytes or smaller.`);
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", 413, `Request body must be ${String(maxBytes)} bytes or smaller.`);
  }
  if (buffer.byteLength === 0) return new Fields({}, declaredKeys);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new ApiError("BAD_REQUEST", 400, "Request body is not valid JSON.");
  }
  return new Fields(parsed, declaredKeys);
}

/** Query strings get the same treatment as bodies: whitelist the names, reject the rest. */
export function readQuery(url: URL, declaredKeys: readonly string[]): Fields {
  const data: Record<string, string> = {};
  for (const [k, v] of url.searchParams) data[k] = v;
  const fields = new Fields(data, declaredKeys);
  fields.assertOnlyDeclared();
  return fields;
}
