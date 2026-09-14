/**
 * The sign-up failure the user actually saw, pinned as behaviour rather than as a screenshot.
 *
 * Symptom (staging, 2026-09-13/14, right after the project was moved to a fresh Supabase instance): the account is
 * created, then `POST /rest/v1/profiles?on_conflict=id` returns `401 … permission denied for table profiles`, and
 * the UI reads "Account created, but the profile could not be saved". Two different databases produced that one
 * message, and they need opposite responses:
 *
 *   * the new project had only the base schema — no `handle_new_user` trigger, no `kicklive_profile_update()` — so
 *     there was genuinely no profile row. The fix is to paste `supabase/SETUP.sql`;
 *   * a hardened project refuses the client's *table* write by design (RLS has no write policy on `profiles`; the
 *     owner's row is written through a definer function) and sign-up failed for a reason the user could not act on.
 *
 * `src/lib/profile-write-rule.ts` classifies those shapes and `src/lib/profile-write.ts` holds the single write
 * path. These tests pin the classification — and that the app never goes back to writing `email`/`role` into the
 * table — so a future "simplification" back to `if (error) return error` fails a test instead of shipping the same
 * confusing message.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeniedProfileWrite, isMissingSchemaObject, profileSetupErrorMessage } from "../../src/lib/profile-write-rule.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const strip = (text: string) => text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("sign-up profile fallback", () => {
  it("recognises a refused write (grants or RLS) — the 401 the browser saw", () => {
    // PostgREST reports an RLS refusal as a bare 401 whose body says "permission denied for table profiles".
    assert.equal(isDeniedProfileWrite({ message: 'permission denied for table "profiles"' }), true, "no code, message only — still a refused write");
    assert.equal(isDeniedProfileWrite({ code: "42501", message: "permission denied for table profiles" }), true, "42501 is the grant/RLS refusal");
    assert.equal(isDeniedProfileWrite({ code: "42501", message: "row-level security policy for table profiles" }), true);
    assert.equal(isDeniedProfileWrite(null), false, "no error is never a denial");
    assert.equal(isDeniedProfileWrite(undefined), false);
  });

  it("does not mistake a missing object or a stale schema cache for a refused write", () => {
    const missingRelation = { code: "42P01", message: 'relation "public.profiles" does not exist' };
    assert.equal(isDeniedProfileWrite(missingRelation), false, "no table is not 'would not let me write'");
    assert.equal(isMissingSchemaObject(missingRelation), true, "…and it *is* the un-applied-bundle shape");
    const staleCache = { code: "PGRST204", message: "Could not find the `phone` column in the schema cache" };
    assert.equal(isDeniedProfileWrite(staleCache), false);
    assert.equal(isMissingSchemaObject(staleCache), false, "a stale cache is reloaded, not re-pasted");
    assert.equal(isMissingSchemaObject({ code: "PGRST202", message: "Could not find the function public.kicklive_profile_update" }), true);
    assert.equal(isMissingSchemaObject({ code: "42883", message: "function public.kicklive_profile_update(text, text) does not exist" }), true);
  });

  it("explains the un-pasted-bundle state in terms of the file that fixes it", () => {
    const msg = profileSetupErrorMessage();
    for (const needle of ["supabase/SETUP.sql", "db:check", "CREATE_ADMIN_PROFILE"]) {
      assert.ok(msg.includes(needle), `the operator message must name "${needle}" (got: ${msg})`);
    }
    assert.ok(!/role/i.test(msg), "it must not suggest granting anything to fix this");
  });
});

describe("the browser's profile write path", () => {
  it("goes through the self-only RPC everywhere, with no direct table write to fall back to", () => {
    const lib = read("src/lib/profile-write.ts");
    assert.match(lib, /supabase\.rpc\("kicklive_profile_update"/, "the supported verb is the definer function");
    assert.match(read("src/contexts/AuthContext.tsx"), /await writeOwnProfile\(\{ username, phone \}\)/, "sign-up writes through the same helper");
    assert.match(read("src/pages/ProfilePage.tsx"), /await writeOwnProfile\(\{ username, phone \}\)/, "…and so does the profile page");
    // A "fallback" straight to the table was considered and rejected: it would keep a half-migrated project
    // *working*, which is precisely how a project stays half-migrated forever.
    assert.ok(!/from\(\s*["']profiles["']\s*\)\s*\.\s*(upsert|update|insert|delete)/.test(strip(lib)), "no silent table write in the helper");
    // Comments are stripped first: this repo documents the forbidden shape in prose (including in this helper's own
    // header), and a checker that reads prose as code turns an explanation into a false alarm — which is how people
    // end up deleting the explanation instead of the bug.
    for (const rel of ["src/contexts/AuthContext.tsx", "src/pages/ProfilePage.tsx"]) {
      const source = strip(read(rel));
      const offenders: string[] = [];
      for (const m of source.matchAll(/from\(\s*["']profiles["']\s*\)/g)) {
        let at = (m.index ?? 0) + m[0].length;
        for (;;) {
          const call = /^\s*\.([a-zA-Z]+)\s*\(/.exec(source.slice(at));
          if (!call) break;
          if (["upsert", "insert", "update", "delete"].includes(call[1])) offenders.push(`${rel}: .${call[1]}(`);
          at += call[0].length;
          const skip = /^[^)]*\)/.exec(source.slice(at));
          if (!skip) break;
          at += skip[0].length;
        }
      }
      assert.deepEqual(offenders, [], `${rel} must not write the profiles table directly: ${offenders.join(", ")}`);
    }
  });

  it("never offers role or email to the write, in the payload or in the parameter names", () => {
    const lib = read("src/lib/profile-write.ts");
    assert.match(lib, /p_username: input\.username/, "the RPC is called by parameter name, not position");
    assert.match(lib, /p_phone: input\.phone/);
    assert.ok(!/p_role|p_email/.test(lib), "a client that offers profiles.role or .email is the escalation hole again");
    const sql = read("supabase/migrations/20260916120000_phase10_privilege_tightening.sql");
    assert.match(
      sql,
      /create or replace function public\.kicklive_profile_update\(\s*\n\s*p_username text default null,\s*\n\s*p_phone\s+text default null\s*\n\s*\)/,
      "and the function accepts exactly those two parameters",
    );
  });

  it("keeps a degraded database loud rather than pretending the save worked", () => {
    const lib = read("src/lib/profile-write.ts");
    assert.match(lib, /degraded: true/, "the result carries a flag the call site can branch on");
    const ctx = read("src/contexts/AuthContext.tsx");
    assert.match(ctx, /if \(!write\.ok\)/, "sign-up checks the result instead of throwing it away");
    assert.match(ctx, /if \(!existing\) return \{ error: profileSetupErrorMessage\(\) \}/, "…and a missing profile row is still a hard failure");
    assert.match(ctx, /Sign-up continued on the trigger-created profile/, "…while a present row with refused display fields is not");
  });
});
