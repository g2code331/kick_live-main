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

import { getSupabaseEnv, isSupabaseConfigured, projectRefFromUrl, refFromAnonKey, ConfigError } from "../../src/lib/env.ts";
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
    assert.equal(refFromAnonKey(keyForRef("fnefpcjeebawsebxjhcf")), "fnefpcjeebawsebxjhcf");
    assert.equal(refFromAnonKey("garbage"), "");
  });

  it("refuses to start with no configuration instead of a default project", () => {
    // In node there is no import.meta.env, which is exactly the "deploy lost its env vars" shape.
    assert.equal(isSupabaseConfigured(), false);
    assert.throws(() => getSupabaseEnv(), ConfigError);
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
    assert.match(sql, /revoke update \(role\)\s+on public\.profiles from authenticated;/);
    assert.match(sql, /profiles: authenticated read/);
    assert.doesNotMatch(statements, /drop\s+table|drop\s+column|\bdelete\s+from\b/i, "Phase 1 SQL must stay additive");
    assert.match(statements, /create table if not exists public\.access_requests/);
    assert.match(statements, /alter table public\.access_requests enable row level security;/);
    assert.match(sql, /set search_path = public, pg_temp/);
    assert.match(sql, /only team_manager and media can be requested/);
    assert.match(sql, /this is the last admin account/);
  });
});
