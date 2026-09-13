/**
 * Phase 1 security invariants, pinned as tests.
 *
 * These are the properties the whole phase exists to establish, and each one is cheap to break by
 * accident: someone copy-pastes a working Supabase URL "just for local dev", a new route asks for a
 * role in its body, a capability list gains `team_manager`. They assert on source text and on the pure
 * helpers rather than rendering components, because `node --test` cannot import `.tsx` and the
 * property under test is "the shipped code contains no other path", not "a component looks right".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { assertSupabaseEnv, getSupabaseEnv, isSupabaseConfigured, projectRefFromUrl, refFromAnonKey, ConfigError } from "../../src/lib/env.ts";
import { roleHasCapability, capabilityTable } from "../../workers/src/lib/capabilities.ts";
import { scanSource } from "../../scripts/check-secrets.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

/**
 * The "must not contain X" assertions look at code, not prose: several of these files *document* the
 * removed insecure pattern, and a scan that fired on that comment would be a test that rewards
 * deleting the explanation.
 */
function codeOf(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function keyForRef(ref: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role: "anon" })}.signature-not-checked-here`;
}

describe("supabase config resolution", () => {
  it("extracts the project ref from the supported host forms", () => {
    assert.equal(projectRefFromUrl("https://xvksxqrmdbbinlrjctri.supabase.co"), "xvksxqrmdbbinlrjctri");
    // A local project has no dotted host, so the ref is simply unknown — which also means the
    // URL/key mismatch check stays silent there rather than blocking `npm run dev`.
    assert.equal(projectRefFromUrl("http://localhost:54321"), "");
    assert.equal(projectRefFromUrl("not a url"), "");
  });

  it("reads the ref claim out of a key without verifying anything", () => {
    assert.equal(refFromAnonKey(keyForRef("opvkvbabryuipzwcanrv")), "opvkvbabryuipzwcanrv");
    assert.equal(refFromAnonKey("garbage"), "");
  });

  it("refuses to start with no configuration instead of a default project", () => {
    // In node there is no import.meta.env, which is exactly the "deploy lost its env vars" shape.
    assert.equal(isSupabaseConfigured(), false);
    assert.throws(() => getSupabaseEnv(), ConfigError);
  });

  it("refuses a *consistently wrong* environment, which the URL/key cross-check cannot see", () => {
    // The Pages failure this closes is not "the operator forgot a variable" — the boot screen already says
    // that, loudly. It is a production bundle built from the staging pair: both values real, both matching
    // each other, every existing check green, and the deployed site quietly reads and writes another project.
    // `VITE_EXPECTED_PROJECT_REF` is what makes the bundle itself carry the answer to "which project am I?".
    const staging = "opvkvbabryuipzwcanrv";
    const prod = "xvksxqrmdbbinlrjctri";
    const ok = (ref: string) => ({ url: `https://${ref}.supabase.co`, anonKey: keyForRef(ref), expectedRef: ref });
    assert.doesNotThrow(() => assertSupabaseEnv(ok(prod)), "the right pair must build");
    assert.doesNotThrow(() => assertSupabaseEnv(ok(staging)), "and so must the right staging pair");
    const crossed = { url: `https://${prod}.supabase.co`, anonKey: keyForRef(prod), expectedRef: staging };
    assert.throws(
      () => assertSupabaseEnv(crossed),
      (e: Error) => /Wrong environment.*built for project .*staging-ref.*|Wrong environment/.test(e.message) && e instanceof ConfigError,
    );
    // a bundle built for prod but handed staging's URL: same rule, different half
    assert.throws(() => assertSupabaseEnv({ url: `https://${staging}.supabase.co`, anonKey: keyForRef(staging), expectedRef: prod }), /Wrong environment/);
    // unbuilt-by-mode (dev, and CI which exports its own pair) must not be blocked by an absent expectation
    assert.doesNotThrow(() => assertSupabaseEnv({ url: `https://${prod}.supabase.co`, anonKey: keyForRef(prod), expectedRef: "" }), "no expectedRef means no third opinion");
    // a local project has no dotted ref, so the URL/key cross-check stays silent there — but the https rule is
    // not relaxed for it, and this file's own generator only ever writes a `*.supabase.co` URL. Plain http to
    // a self-hosted project is a refused configuration, not a supported one.
    assert.throws(() => assertSupabaseEnv({ url: "http://localhost:54321", anonKey: keyForRef("anyref").padEnd(40, "0"), expectedRef: "anyref" }), /must be an https:\/\/ URL/);
  });

  it("the per-mode build config exists, is generated, and matches the Worker's own config", () => {
    // A build must not depend on an operator remembering to export a pair on the *build* line. The mode files
    // are derived from workers/wrangler.toml — the same file the Worker is deployed from — so there is one
    // place a project's identity is written, and `web:env:check` fails CI if a mode file has gone stale.
    for (const [mode, ref] of [
      ["staging", "opvkvbabryuipzwcanrv"],
      ["production", "xvksxqrmdbbinlrjctri"],
    ] as const) {
      const text = fs.readFileSync(path.join(REPO, `.env.${mode}`), "utf8");
      assert.match(text, new RegExp(`VITE_SUPABASE_URL=https://${ref}\.supabase\.co`), `build:web:${mode} must point at ${ref}`);
      assert.match(text, /VITE_SUPABASE_ANON_KEY=eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, "a real anon key, not a placeholder");
      assert.match(text, new RegExp(`VITE_EXPECTED_PROJECT_REF=${ref}`), "and the bundle must carry its own expected ref");
      assert.match(text, /GENERATED by scripts\/build-web-env\.mjs/, "and say so, so nobody hand-edits it");
      // an assignment, not the word: each file explains in its own header that a service-role key must never be
      // written here, and a rule that fires on prose teaches people to edit the prose.
      assert.ok(!/^VITE_.*SERVICE_ROLE.*=\S/m.test(text), "a mode file may never carry a service-role key");
      const toml = fs.readFileSync(path.join(REPO, "workers/wrangler.toml"), "utf8");
      const block = toml.slice(toml.indexOf(`[env.${mode}.vars]`));
      const key = /SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(block)?.[1];
      assert.ok(text.includes(String(key)), `the mode file's key must equal [env.${mode}.vars].SUPABASE_ANON_KEY`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    assert.match(pkg.scripts?.["build:web:staging"] ?? "", /--mode=staging/, "npm run build:web:staging must select the mode, not expect exported vars");
    assert.match(pkg.scripts?.["build:web:production"] ?? "", /--mode=production/);
    assert.match(pkg.scripts?.["web:env:check"] ?? "", /--check/, "and drift must be a checkable thing, not folklore");
    // the mode files are tracked, so a fresh clone can build; `.env.local` is still ignored
    assert.ok(!/(^|\n)\.env\.\*\n!\.env\.example\n$/.test(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8")), "the ignore rule must not re-hide the mode files");
  });
});

describe("no hardcoded backend in shipped source", () => {
  it("finds nothing in the current tree", () => {
    assert.deepEqual(scanSource(REPO), [], "src/, pwa/, shared/, server/, desktop/src, workers/src must contain no Supabase URL or key literal");
  });

  it("does find one when it is planted", () => {
    const probe = path.join(REPO, "src/__scan_probe.ts");
    const fakeKey = `eyJ${"a".repeat(20)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    fs.writeFileSync(probe, `const url = "https://xvksxqrmdbbinlrjctri.supabase.co";\nconst key = "${fakeKey}";\nexport default [url, key];\n`);
    try {
      const findings = scanSource(REPO);
      assert.equal(findings.length, 2, `expected url + jwt findings, got ${JSON.stringify(findings)}`);
      assert.ok(findings.every((f: { file: string }) => f.file.startsWith("src/")));
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
});

describe("role privileges are server-side", () => {
  it("the capability matrix grants nothing privileged to fan, media or team_manager", () => {
    const rows = capabilityTable();
    assert.ok(rows.length >= 20, `expected the full matrix, saw ${String(rows.length)} capabilities`);
    for (const row of rows) {
      assert.ok(row.roles.length > 0, `${row.capability} has no roles at all — a capability nobody holds is dead weight`);
      assert.ok(new Set(row.roles).size === row.roles.length, `${row.capability} lists a role twice`);
      if (row.roles.includes("fan")) {
        assert.deepEqual(row.roles, ["fan", "team_manager", "media", "admin"] as const, `fan must only hold capabilities that every role holds (${row.capability})`);
      }
    }
    for (const cap of ["identity.grant_role", "match_control.write", "match_control.finalize", "media.delete", "admin.settings_write", "competition.manage"] as const) {
      assert.deepEqual(capabilityTable().find((r) => r.capability === cap)?.roles, ["admin"], `${cap} must be admin-only`);
    }
  });

  it("an anonymous caller can read and nothing else", () => {
    assert.equal(roleHasCapability(null, "public.read"), true);
    for (const cap of ["match_control.write", "media.publish", "identity.grant_role", "team.update_own"] as const) {
      assert.equal(roleHasCapability(null, cap), false, `anon must not hold ${cap}`);
    }
  });

  it("a manager or a media user is not an admin by inheritance", () => {
    assert.equal(roleHasCapability("team_manager", "identity.grant_role"), false);
    assert.equal(roleHasCapability("media", "match_control.write"), false);
    assert.equal(roleHasCapability("media", "media.delete"), false);
    assert.equal(roleHasCapability("admin", "media.delete"), true);
  });
});

describe("the browser cannot mint a role", () => {
  it("signup form has no role-password table and cannot submit a role", () => {
    const s = codeOf("src/pages/auth/SignupPage.tsx");
    assert.ok(!/rolePasswords/.test(s), "SignupPage must not contain a client-side privileged-role secret");
    assert.ok(!/mejojO|wojojO|isjojO/.test(s), "the old access passwords must not reappear anywhere");
    assert.ok(/signUp\(email\.trim\(\)\.toLowerCase\(\), password, username\.trim\(\), phone\)/.test(s), "signup is called with four arguments");
    assert.ok(/submitAccessRequest\(/.test(s), "manager/media access is a request, not a selection");
  });

  it("AuthContext never sends a role to the API", () => {
    const s = codeOf("src/contexts/AuthContext.tsx");
    assert.ok(!/options:\s*{[^}]*role/.test(s), "no role in signUp metadata");
    assert.ok(/upsert\(\{ id: data\.user\.id, email, username, phone \}/.test(s), "profile upsert writes display fields only");
    assert.ok(!/signUp\([^)]*role:/.test(s), "signUp takes no role parameter");
  });

  it("admin cannot be requested, and role changes go through an RPC", () => {
    const supabaseLib = codeOf("src/lib/supabase.ts");
    assert.ok(/REQUESTABLE_ROLES[^=]*=\s*\['team_manager', 'media'\]/.test(supabaseLib), "the requestable list excludes admin and fan");
    assert.match(supabaseLib, /export const SIGNUP_ROLE: UserRole = 'fan';/);
    const access = codeOf("src/lib/access.ts");
    assert.ok(/supabase\.rpc\(["']kicklive_set_user_role["']/.test(access), "role changes call the audited RPC");
    assert.ok(!/\.update\(/.test(access), "access.ts must not contain any direct table update");
    const users = codeOf("src/pages/portals/admin/UserManagement.tsx");
    assert.ok(!/\.update\(\{ role:/.test(users), "the admin UI must not write profiles.role directly either");
    assert.match(users, /setUserRole\(/);
  });

  it("the hardening migration keeps the profiles privilege guard and the authenticated-only read", () => {
    const sql = read("supabase/migrations/20260909120000_phase1_security_hardening.sql");
    // Statements only: the file documents (and offers a commented rollback for) the destructive
    // operations it deliberately does not perform, so the check has to look past comments.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.match(sql, /create or replace function public\.kicklive_guard_profile_privileges\(\)/);
    // This assertion used to pin `revoke update (role) on public.profiles from authenticated`, which looked
    // right and did nothing: a column revoke cannot remove the table-wide `=arwdDxt` entry Supabase's default
    // privileges create, and a table-wide UPDATE already covers every column. Executed on a real Postgres, the
    // old statement left profiles.role writable; the narrowing call below is what actually closes it, so that is
    // what is pinned now — the *mechanism*, not a spelling that was wrong.
    assert.match(statements, /select public\.kicklive_narrow_column_grant\('update', 'public\.profiles', 'authenticated', array\['role', 'email'\]\)/);
    assert.match(statements, /select public\.kicklive_narrow_column_grant\('update', 'public\.profiles', 'anon', array\['role', 'email'\]\)/);
    assert.match(statements, /revoke update on public\.profiles from public;/);
    assert.doesNotMatch(
      statements,
      /revoke update \(role\)\s+on public\.profiles from authenticated;/,
      "a bare column revoke on a table Supabase granted ALL to is a statement that looks like a control and is not one",
    );
    assert.match(sql, /profiles: authenticated read/);
    assert.doesNotMatch(statements, /drop\s+table|drop\s+column|\bdelete\s+from\b/i, "Phase 1 SQL must stay additive");
    assert.match(statements, /create table if not exists public\.access_requests/);
    assert.match(statements, /alter table public\.access_requests enable row level security;/);
    assert.match(sql, /set search_path = public, pg_temp/);
    assert.match(sql, /only team_manager and media can be requested/);
    assert.match(sql, /this is the last admin account/);
  });
});
