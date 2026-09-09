/**
 * Build-time configuration, in one place.
 *
 * Rule this file exists to enforce (docs/SECURITY_AUDIT_PHASE1.md F-03): a frontend bundle never
 * carries a fallback Supabase project. Before this module, `src/lib/supabase.ts` fell back to a
 * hardcoded URL *and* a hardcoded anon key belonging to a **different** project than the URL, so a
 * deploy that forgot its env vars silently talked to the wrong database instead of failing loudly.
 *
 * Anything secret (service role key, R2 secret, turnstile secret) must never appear here or in a
 * `VITE_*` variable: everything a browser bundle contains is public. Authorisation therefore lives
 * in Postgres RLS and (from Phase 2) in the Worker layer — never in a client-side constant.
 */

export interface SupabaseEnv {
  /** e.g. `https:<comment>` — the project URL, no trailing slash. */
  url: string;
  /** The publishable/anon key. Public by design; RLS is what protects rows. */
  anonKey: string;
  /** The project ref parsed out of the URL, used for config sanity checks and logs. */
  projectRef: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function read(name: string): string {
  // `?? {}` so this module is importable from plain node (the unit tests exercise the ref-mismatch
  // check); in a Vite build `import.meta.env` is always present.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Parse `https://<ref>.supabase.co` (or a self-hosted/`realtime` variant) into its project ref. */
export function projectRefFromUrl(url: string): string {
  const m = /^https?:\/\/([a-z0-9]+)\.[a-z-]+\.[a-z]+/i.exec(url);
  return m ? m[1] : "";
}

/**
 * The key's `ref` claim, decoded *without* verifying anything (anon keys are unsigned-safe to
 * decode, and we only read the project ref). Used to catch copy-paste of a URL and a key from two
 * different projects — the exact state the repository shipped in.
 */
export function refFromAnonKey(key: string): string {
  const payload = key.split(".")[1];
  if (!payload) return "";
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json?.ref === "string" ? json.ref : "";
  } catch {
    return "";
  }
}

function missing(name: string): never {
  throw new ConfigError(
    `Missing required environment variable ${name}.\n\n` +
      `Copy .env.example to .env.local (Vite) or set it in your host's environment, then rebuild.\n` +
      `  ${name}=...\n\n` +
      `Refusing to start with a default project on purpose: a silent fallback points real users at ` +
      `the wrong database, which is worse than a red screen.`,
  );
}

/**
 * Resolved once, at module load, so a misconfigured deploy fails at boot rather than on the first
 * privileged click. `null` is never returned: use `isSupabaseConfigured()` for the "should we even
 * render the app" check, which is what `src/main.tsx` does to show a readable error screen.
 */
export function getSupabaseEnv(): SupabaseEnv {
  const url = read("VITE_SUPABASE_URL") || missing("VITE_SUPABASE_URL");
  const anonKey = read("VITE_SUPABASE_ANON_KEY") || missing("VITE_SUPABASE_ANON_KEY");

  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(url)) {
    throw new ConfigError(`VITE_SUPABASE_URL must be an https:// URL (got "${url.replace(/[^\x20-\x7e]/g, "?").slice(0, 80)}").`);
  }
  if (anonKey.length < 32) {
    throw new ConfigError("VITE_SUPABASE_ANON_KEY looks truncated — paste the full publishable key from the dashboard.");
  }

  const urlRef = projectRefFromUrl(url);
  const keyRef = refFromAnonKey(anonKey);
  if (urlRef && keyRef && urlRef !== keyRef) {
    throw new ConfigError(`Config mismatch: VITE_SUPABASE_URL points at project "${urlRef}" but VITE_SUPABASE_ANON_KEY was ` + `issued for project "${keyRef}". Both must come from the same project.`);
  }

  return { url: url.replace(/\/+$/, ""), anonKey, projectRef: urlRef };
}

/**
 * Cheap, throw-free check used by the boot screen. Deliberately does not decode anything.
 */
export function isSupabaseConfigured(): boolean {
  return read("VITE_SUPABASE_URL").length > 0 && read("VITE_SUPABASE_ANON_KEY").length > 0;
}

/**
 * The API origin, or "" for same-origin.
 *
 * Rules, in order of how much trouble they prevent:
 *   - a **dev** build may not point at a non-local API unless `VITE_API_ALLOW_REMOTE=1` is also set.
 *     Without it, `npm run dev` against a production Worker turns every local experiment into a real
 *     write; with it, the intent is explicit and reviewable in the shell history;
 *   - a **production** build may not point at localhost — that bundle has no API and would fail only
 *     when somebody clicks something;
 *   - empty means same-origin `/api`, which is what the Cloudflare custom-domain and the Vite dev
 *     proxy both set up, so nobody has to configure anything for the common case.
 */
export interface ApiBaseUrlRules {
  raw: string;
  dev: boolean;
  prod: boolean;
  allowRemote: boolean;
}

/**
 * Pure half of `getApiBaseUrl`, exported so the guards are testable without a Vite environment: the
 * rules below are the only thing standing between `npm run dev` and production data, and a rule that
 * cannot be tested is a rule that will be quietly edited out later.
 */
export function resolveApiBaseUrl(rules: ApiBaseUrlRules): string {
  const raw = rules.raw.replace(/\/+$/, "");
  if (!raw) return "";

  if (!/^https?:\/\/[a-z0-9.:-]+$/i.test(raw)) {
    throw new ConfigError(`VITE_API_BASE_URL must be an origin with no path (e.g. https://api.kicklive.football), got "${raw.slice(0, 80)}". API paths are appended by src/lib/api/client.ts.`);
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(raw);
  if (rules.dev && !isLocal && !rules.allowRemote) {
    throw new ConfigError(
      `Refusing to run the dev server against a remote API (${raw}).\n` +
        `That is how a local experiment writes production data. Start the Worker locally (npm run worker:dev)\n` +
        `or set VITE_API_BASE_URL + VITE_API_ALLOW_REMOTE=1 if you really mean it.`,
    );
  }
  if (rules.prod && isLocal) {
    throw new ConfigError(`A production build cannot point at a localhost API (${raw}). Set VITE_API_BASE_URL to the deployed Worker origin.`);
  }
  return raw;
}

export function getApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
  return resolveApiBaseUrl({
    raw: read("VITE_API_BASE_URL"),
    dev: env.DEV === true,
    prod: env.PROD === true,
    allowRemote: read("VITE_API_ALLOW_REMOTE") === "1",
  });
}

/** Optional: where the desktop/PWA update manifest is published (see docs/RELEASE-PIPELINE.md). */
export const updateManifestUrl: string = read("VITE_UPDATE_MANIFEST_URL");

/** Optional: 'stable' | 'beta' | anything used to filter the update feed. */
export const updateChannel: string = read("VITE_UPDATE_CHANNEL") || "stable";
