import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Phase 10 — final production hardening, first change: the contact columns on `profiles`.
 *
 * What this file is really testing is a *direction*: a narrowing that only touches the UI is a narrowing that
 * a curl can walk around, so the assertions sit on the database (column privileges), on the Worker (the
 * projection it is allowed to make), and on the deployment documents (which had been telling an operator to
 * paste a superseded schema — a documentation bug that would have re-opened privilege escalation on a fresh
 * install, which is how this phase found the thing in the first place).
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const MIGRATION = "supabase/migrations/20260916120000_phase10_privilege_tightening.sql";

describe("phase 10 · the profiles narrowing", () => {
  const sql = existsSync(path.join(REPO, MIGRATION)) ? read(MIGRATION) : "";

  it("exists, is additive, and drops nothing", () => {
    assert.ok(sql.length > 2000, "the migration is present and substantive");
    assert.match(sql, /^-- Phase 10 · privilege tightening/m, "it says what it is");
    for (const forbidden of [/drop table/i, /truncate/i, /drop schema/i, /delete from public\./i, /drop policy/i, /alter table .* drop column/i]) {
      const hit = sql.split("\n").filter((line) => !line.trimStart().startsWith("--") && forbidden.test(line));
      assert.deepEqual(hit, [], `a tightening migration must not contain ${forbidden}: ${hit.join(" | ")}`);
    }
  });

  it("revokes the table-wide select and grants an explicit column list that excludes the contacts", () => {
    assert.match(sql, /revoke select on public\.profiles from authenticated;/, "revoke first, or the grant is an addition rather than a narrowing");
    const grant = sql.match(/grant select \(([^)]*)\)\s*\n?\s*on public\.profiles to authenticated;/);
    assert.ok(grant, "the replacement is a column list");
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim());
    assert.ok(!cols.includes("email") && !cols.includes("phone"), `contacts leaked back into the grant: ${cols.join(", ")}`);
    for (const needed of ["id", "username", "role", "avatar_url", "team_id"]) {
      assert.ok(cols.includes(needed), `${needed} is still readable — every public surface needs it`);
    }
  });

  it("gives the owner their own row through a function that takes no argument", () => {
    const self = sql.slice(sql.indexOf("function public.kicklive_profile_self"));
    assert.match(self.slice(0, 200), /kicklive_profile_self\(\)/, "no parameter: an id argument is a function that gets pointed at someone else");
    assert.match(self, /security definer/, "the definer is what makes the column readable at all");
    assert.match(self, /set search_path = public, pg_temp/, "pinned, like every other definer in this repository");
    assert.match(self, /where id = auth\.uid\(\)/, "auth.uid() is the only selector");
  });

  it("gives the admin desks a bounded, gated directory read", () => {
    const contacts = sql.slice(sql.indexOf("function public.kicklive_profile_contacts"));
    assert.match(contacts, /if not public\.is_admin\(\) then\s*\n\s*return jsonb_build_object\('ok', false, 'code', 'FORBIDDEN'/, "the refusal is a value, not an exception");
    assert.match(contacts, /least\(greatest\(coalesce\(p_limit, 100\), 1\), 200\)/, "clamped to 1..200, the same rule kicklive_audit_list follows");
    assert.ok(!/phone/.test(contacts.slice(contacts.indexOf("returns jsonb"), contacts.indexOf("$fn$"))), "the projection stops short of phone");
    assert.match(
      sql,
      /grant execute on function public\.kicklive_profile_contacts\(uuid\[\], integer\) to authenticated, service_role;/,
      "granted to authenticated, because the gate is is_admin() on the caller's token",
    );
    assert.match(sql, /revoke all on function public\.kicklive_profile_contacts\(uuid\[\], integer\) from public;/, "and closed to nobody else");
  });

  it("asserts its own effect at apply time, because a grant that parses is not a grant that lands", () => {
    const verify = sql.slice(sql.indexOf("do $verify$"), sql.indexOf("$verify$;"));
    assert.ok(verify.length > 200, "the verify block is present");
    for (const [needle, why] of [
      [/has_column_privilege\('authenticated', 'public\.profiles', 'email', 'select'\)/, "the email column is checked"],
      [/has_column_privilege\('authenticated', 'public\.profiles', 'phone', 'select'\)/, "and the phone column"],
      [/has_column_privilege\('service_role', 'public\.profiles', 'email', 'select'\)/, "service_role must keep email or the Worker's admin client breaks"],
      [/has_column_privilege\('anon', 'public\.profiles', 'username', 'select'\)/, "anon must still be excluded"],
      [/policyname = 'profiles: authenticated read'/, "the row policy survives the column change"],
      [/has_function_privilege\('anon'[\s\S]{0,240}execute'\)/, "and a stranger cannot execute the new functions"],
    ] as const) {
      assert.match(verify, needle, why);
    }
    assert.match(verify, /raise exception 'phase 10 verify[^\n]*' using errcode = '42501'/, "each failure raises rather than warning");
  });
});

describe("phase 10 · nothing left reads the columns from the browser", () => {
  const CLIENT_FILES = [
    "src/contexts/AuthContext.tsx",
    "src/lib/access.ts",
    "src/lib/DataLoader.ts",
    "src/pages/ProfilePage.tsx",
    "src/pages/portals/AdminPortal.tsx",
    "src/pages/portals/admin/UserManagement.tsx",
    "src/pages/portals/admin/TeamDashboard.tsx",
  ];

  it("no client query projects email or phone out of profiles", () => {
    const offenders: string[] = [];
    for (const rel of CLIENT_FILES) {
      const source = read(rel);
      // Both shapes that reach a column: a select list, and an embedded resource.
      for (const match of source.matchAll(/from\(\s*["']profiles["']\s*\)\s*(?:\.\w+\([^)]*\)\s*)*\.select\(\s*["'`]([^"'`]*)["'`]/g)) {
        if (/\b(email|phone)\b/.test(match[1])) offenders.push(`${rel}: select("${match[1]}")`);
      }
      for (const match of source.matchAll(/profiles[:!][\w(],?\s*[^"]*\b(email|phone)\b/g)) offenders.push(`${rel}: embedded ${match[1]}`);
      for (const match of source.matchAll(/profiles!\w*\(([^)]*)\)/g)) {
        if (/\b(email|phone)\b/.test(match[1])) offenders.push(`${rel}: embed profiles(${match[1]})`);
      }
    }
    assert.deepEqual(offenders, [], `a browser that selects a contact column is the hole again: ${offenders.join(", ")}`);
  });

  it("the three admin desks and the account read go through the functions", () => {
    assert.match(read("src/contexts/AuthContext.tsx"), /supabase\.rpc\("kicklive_profile_self"\)/, "own row via the definer door");
    for (const rel of ["src/lib/access.ts", "src/pages/portals/AdminPortal.tsx", "src/pages/portals/admin/UserManagement.tsx", "src/pages/portals/admin/TeamDashboard.tsx"]) {
      assert.match(read(rel), /kicklive_profile_contacts/, `${rel} reads contacts through the gated function`);
    }
  });

  it("and each of them tolerates a refusal instead of rendering undefined into a cell", () => {
    // The functions answer `{ ok, contacts }` for an admin and `{ ok: false, code }` for everyone else, so the
    // call sites must read `.contacts` rather than treat the payload as an array — a shape a reviewer can
    // check in one line, and the failure mode of every "just swap the query" privacy fix.
    for (const rel of ["src/lib/access.ts", "src/pages/portals/AdminPortal.tsx", "src/pages/portals/admin/UserManagement.tsx", "src/pages/portals/admin/TeamDashboard.tsx"]) {
      assert.match(read(rel), /contacts/, `${rel} unwraps the projection`);
    }
  });
});

describe("phase 10 · the Worker stopped reading a contact column too", () => {
  it("PROFILE_COLUMNS is identity only", () => {
    const source = read("workers/src/services/profiles.ts");
    const columns = source.match(/export const PROFILE_COLUMNS = "([^"]*)"/);
    assert.ok(columns, "the projection is still one constant in one place");
    for (const banned of ["email", "phone", "avatar_url", "team_id"]) {
      assert.ok(!(columns?.[1] ?? "").includes(banned), `the Worker no longer needs ${banned}`);
    }
    assert.equal(columns?.[1], "id, username, role");
  });

  it("keeps the /me shape stable while returning no address", () => {
    const source = read("workers/src/services/profiles.ts");
    assert.match(source, /email: principal\.email/, "the field is still there — a client that reads /me must not break");
    assert.match(source, /export interface SafeProfile \{[\s\S]{0,400}email: string \| null;/, "nullable, which is how it was typed");
  });
});

describe("phase 10 · the deployment documents match the repository", () => {
  const DOCS = ["DEPLOYMENT_CHECKLIST.md", "DEPLOYMENT_GUIDE.md", "README.md", "supabase/README.md"];

  it("never tells an operator to paste a superseded schema file", () => {
    for (const rel of DOCS) {
      const lines = read(rel).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!/SUPABASE_NEW_PROJECT_SETUP|SUPABASE_COMPLETE_SCHEMA|supabase_migrations\.sql/.test(line)) continue;
        const context = lines
          .slice(Math.max(0, index - 4), index + 5)
          .join("\n")
          .toLowerCase();
        assert.ok(
          /\b(do not|never|not paste|superseded|reference only|weaker|kept for)\b/.test(context),
          `${rel}:${String(index + 1)} instructs a paste of a superseded file with no warning:\n${line}`,
        );
      }
    }
  });

  it("and lists the migration set in apply order, including phase 10", () => {
    const checklist = read("DEPLOYMENT_CHECKLIST.md");
    for (const file of ["20260915120000_phase9_observability", "20260916120000_phase10_privilege_tightening"]) {
      assert.ok(checklist.includes(file), `the checklist names ${file}`);
    }
    assert.match(checklist, /in filename order|filename order/, "and says the order is the filename order");
  });
});

describe("phase 10 · the migration history is one path, not a crowd", () => {
  const files = readdirSync(path.join(REPO, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("is strictly ordered by timestamp, and numbered by phase", () => {
    assert.ok(
      files.every((f) => /^\d{14}_/.test(f)),
      "every migration starts with a timestamp",
    );
    assert.ok(files.length >= 9, `expected the phase migrations, found ${String(files.length)}`);
    const stamps = files.map((f) => Number(f.slice(0, 14)));
    assert.deepEqual(
      [...stamps].sort((a, b) => a - b),
      stamps,
      "filenames are already in apply order",
    );
    const phases = files.map((f) => Number(f.match(/_phase(\d+)_/)?.[1] ?? -1));
    assert.deepEqual(phases, [1, 3, 4, 5, 6, 7, 8, 9, 10], "phase 2 has no migration because it is Worker-only — a gap is fine, a renumbering is not");
  });

  it("names every file for what it does, so the authoritative path is guessable", () => {
    for (const f of files) {
      assert.match(f, /^\d{14}_phase\d+_[a-z0-9_]+\.sql$/, `${f} must be <timestamp>_phase<N>_<slug>.sql`);
    }
  });
});
