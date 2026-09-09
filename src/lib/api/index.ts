/**
 * The app-configured API client, and the typed calls for the routes that exist today.
 *
 * Import this module from components (`import { api, getMe } from "@/lib/api"` or a relative path), not
 * `client.ts` — this is the file that knows where the token comes from and which base URL to use.
 *
 * Deliberately **not** migrated: the ~27 files that write to Supabase directly (audit finding F-10) keep
 * working exactly as they do now. Each one moves when its route is implemented, and the only caller
 * changed in this phase is the demonstration in the admin user-management screen.
 */
import { getApiBaseUrl } from "../env.ts";
import { createApiClient } from "./client.ts";
import type { ApiResult, HealthData, ManagedTeamsData, MeData } from "./types.ts";

/**
 * The current Supabase access token, read fresh on every request.
 *
 * The `await import()` is load-bearing: importing `src/lib/supabase.ts` at module scope would (a) make
 * this module throw in `node --test`, where the unit tests exercise the client, and (b) create a cycle
 * through `AuthContext` for no benefit. Supabase refreshes the session itself, so a fresh read is all
 * that is needed — no token cache here, and nothing stored.
 */
export async function readAccessToken(): Promise<string | null> {
  try {
    const mod = (await import("../supabase.ts")) as { supabase?: { auth: { getSession: () => Promise<{ data: { session?: { access_token?: string } | null } }> } } };
    const session = (await mod.supabase?.auth.getSession())?.data.session;
    return session?.access_token ?? null;
  } catch {
    // Unconfigured/failed auth is an anonymous call; the Worker answers 401 and the caller shows that.
    return null;
  }
}

export const api = createApiClient({
  baseUrl: getApiBaseUrl(),
  getToken: readAccessToken,
  // Kept as an event rather than an import of AuthContext: the API layer must not depend on the React
  // tree, or every test of the client has to render something.
  onUnauthorized: (info) => {
    globalThis.dispatchEvent?.(new CustomEvent("kicklive:api-unauthorized", { detail: info }));
  },
});

export const apiHealth = (): Promise<ApiResult<HealthData>> => api.get<HealthData>("/health");

export const apiMe = (): Promise<ApiResult<MeData>> => api.get<MeData>("/me");

export const apiMyTeams = (): Promise<ApiResult<ManagedTeamsData>> => api.get<ManagedTeamsData>("/teams/mine");

export { unwrap, isApiFailure, fieldErrors, ApiRequestError, API_ROOT, createApiClient } from "./client.ts";
export type { ApiClient, ApiClientOptions, HttpMethod } from "./client.ts";
export type { ApiFailure, ApiResult, ApiSuccess, ApiFieldError, ApiErrorCode, ApiRequestOptions, HealthData, MeData, ManagedTeamsData, ManagedTeamSummary } from "./types.ts";
