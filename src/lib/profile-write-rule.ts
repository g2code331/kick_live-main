/**
 * The two questions a refused profile write has to answer, kept free of imports so the rule can be unit-tested
 * without a Supabase client (and so `src/lib/profile-write.ts` stays the only module that touches one).
 *
 * The failure this exists for: sign-up created an account, then `POST /rest/v1/profiles?on_conflict=id` came back
 * `401 … permission denied for table profiles`, and the UI said "Account created, but the profile could not be
 * saved". That single string can mean "this project never got supabase/SETUP.sql" *or* "this project is hardened
 * and a browser is not allowed to write that table, by design" — and only one of those needs a human to do
 * something. Classifying wrongly is how a cosmetic event blocked registration and how a real outage got
 * swallowed; both shapes appeared in staging within one day of each other.
 */

export interface SchemaErrorShape {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * True when the database refused the *write* (grants or row-level security) — as opposed to refusing because a
 * table/column is missing, or because the request never reached it, which must stay loud and be explained
 * differently. PostgREST reports an RLS refusal as HTTP 401 with `permission denied for table <t>` and no code at
 * all; a policyless write on a plain database arrives as SQLSTATE 42501.
 */
export function isDeniedProfileWrite(error: SchemaErrorShape | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  if (code === "42501") return true;
  if (/permission denied for (table|relation|column)/.test(text)) return true;
  if (/row-level security/.test(text) && /policy/.test(text)) return true;
  return false;
}

/** The object (function/table/column) is not in this project at all — i.e. the bundle was never applied here. */
export function isMissingSchemaObject(error: SchemaErrorShape | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const text = String(error.message ?? "").toLowerCase();
  if (code === "42883" || code === "PGRST202") return true;
  // `Could not find the function …` is PostgREST's wording for an unknown RPC; `relation … does not exist` is
  // 42P01. Deliberately not a bare "does not exist": a stale *schema cache* after a migration (PGRST204) is a
  // different fix — reload the cache, do not paste SQL.
  if (/could not find the function/.test(text)) return true;
  if (/relation .* does not exist/.test(text)) return true;
  return false;
}

/** The explanation for an account that exists in `auth.users` but has no `profiles` row. */
export function profileSetupErrorMessage(): string {
  return (
    "Account created, but this Supabase project has no profile row and would not let one be written — that is what a database without " +
    "supabase/SETUP.sql looks like (no on-signup trigger, no self-service profile function). Paste the whole supabase/SETUP.sql into this " +
    "project's SQL editor, then sign out and register again. `npm run db:check` lists exactly what is missing, and " +
    "CREATE_ADMIN_PROFILE.sql refuses to run until it is applied."
  );
}
