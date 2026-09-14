import { supabase } from "./supabase";
import { log } from "./log";
import { isDeniedProfileWrite, isMissingSchemaObject, profileSetupErrorMessage } from "./profile-write-rule";

export { isDeniedProfileWrite, isMissingSchemaObject, profileSetupErrorMessage };

/**
 * The one place the browser writes its own profile.
 *
 * Why a function and not `supabase.from('profiles').upsert(...)`, which is what both call sites used to do: the
 * hardened schema (phases 1 and 10) deliberately gives a browser session **no** write access to `public.profiles`
 * — no INSERT/UPDATE row policy, and the table-wide column grants revoked. PostgREST reports that as
 * `401 … permission denied for table profiles`, which reads like a bad API key and is not one. What the client
 * keeps is a narrow verb: `public.kicklive_profile_update(username, phone)`, a `security definer` function that
 * can only touch the caller's own row (`auth.uid()`) and does not accept a `role` or `email` parameter at all.
 * That keeps "a user cannot promote themselves or rewrite their login" true in the database rather than in this
 * file, which is the property the whole privilege-hardening exercise was for.
 *
 * Validation is not here either: the function answers with structured refusals (`BAD_USERNAME`, `BAD_PHONE`) so a
 * stale bundle and a fresh one behave identically, and so the name/phone rules cannot drift from the trigger's.
 */
export interface ProfileWriteResult {
  ok: boolean;
  /** Set for an inline, expected refusal (bad phone format, blank name) — show it, do not toast an outage. */
  fieldError?: { field: "username" | "phone"; message: string };
  error?: string;
  /** True when the database could not honour the request at all (no RPC, no grant): not the user's fault. */
  degraded?: boolean;
  values?: { username?: string; phone?: string | null };
}

interface RpcEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
  username?: string;
  phone?: string | null;
}

/**
 * Write the signed-in user's own username and phone. `undefined` means "leave that field alone"; `''` means
 * "clear it" (only meaningful for the phone). Both call sites — the profile page and the sign-up fallback — go
 * through here so a future third writer cannot quietly reintroduce a direct table write.
 */
export async function writeOwnProfile(input: { username?: string; phone?: string }): Promise<ProfileWriteResult> {
  const { data, error } = await supabase.rpc("kicklive_profile_update", {
    p_username: input.username,
    p_phone: input.phone,
  });
  const env = (data ?? null) as RpcEnvelope | null;

  if (!error && env && env.ok === false) {
    const field: "username" | "phone" = String(env.code ?? "").startsWith("BAD_PHONE") ? "phone" : "username";
    return { ok: false, fieldError: { field, message: env.message || "the database refused that value" } };
  }
  if (!error && env) {
    return { ok: true, values: { username: env.username, phone: env.phone ?? null } };
  }
  if (error && isDeniedProfileWrite(error)) {
    // The RPC exists but this role may not execute it: a half-applied bundle (the function landed, the grant did
    // not). Loud, and naming the file to paste.
    return {
      ok: false,
      degraded: true,
      error:
        "the database refused the profile write for this session. Every phase of supabase/SETUP.sql has to be applied for a user to save " +
        "their own profile — re-paste the whole bundle (it is idempotent), then try again. `npm run db:check` lists what is missing.",
    };
  }
  if (error && isMissingSchemaObject(error)) {
    return {
      ok: false,
      degraded: true,
      error:
        "public.kicklive_profile_update() is not installed in this Supabase project, which means the bundled hardening has not been applied here. " +
        "Paste the whole supabase/SETUP.sql into the SQL editor of this project (not one migration file), then try again. `npm run db:check` proves the state.",
    };
  }
  if (error) {
    // A raise from inside the function (e.g. the auth account was deleted mid-session): its own message is the
    // useful one, so it is passed through rather than paraphrased.
    return { ok: false, degraded: true, error: String((error as { message?: unknown }).message ?? "the profile could not be saved") };
  }
  log.warn("kicklive_profile_update returned no envelope");
  return { ok: false, degraded: true, error: "the profile write returned nothing at all — check the API's log" };
}
