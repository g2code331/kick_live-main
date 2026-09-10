/**
 * Phase 8 · the sponsorship desk's invariants, asserted from the artifacts.
 *
 * The executable half of Phase 8 lives in `scripts/sql-flow.mjs` (it runs against a real Postgres, and it is
 * the only place the eligibility arcs, the media attach order and the grant matrix are actually *executed*).
 * What lives here is the class of bug that file cannot see, because it needs two artifacts at once:
 *
 *   1. **Drift between the Worker's declared fields and the database's consumed fields.** Both sides hold a
 *      list — `SPONSOR_KEYS`/`PACKAGE_KEYS`/`ASSIGNMENT_KEYS` in the route, the `p_data->>'…'` reads in the
 *      migration — and either half can be edited without the other. A key the route declares and SQL never
 *      reads is the silent-drop bug (an admin saves, sees `ok: true`, and the field never moved); a key SQL
 *      reads and the route never declares is a field the desk cannot reach. Both directions are asserted.
 *   2. **The projection's privacy promise.** The public band read must not carry a contact or a number, and
 *      the frontend type must not either. There is no runtime here to catch a stray `to_jsonb(row)`, so the
 *      text of the function is the test, and it is labelled as such rather than pretending to execute SQL.
 *
 * Plus the three things that are cheap to state and expensive to get wrong: which functions a stranger may
 * execute, which capability gates the desk, and the rule that a sponsor's artwork is uploaded rather than
 * typed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ROUTES } from "../../workers/src/router.ts";
import { HANDLERS } from "../../workers/src/routes/index.ts";
import { MEDIA_CATEGORIES, MEDIA_KINDS, UPLOADABLE_KINDS } from "../../workers/src/lib/mediaPolicy.ts";
import { capabilitiesFor, roleHasCapability, capabilityTable } from "../../workers/src/lib/capabilities.ts";
import { isExpired } from "../../src/lib/sponsorship/display.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

/** SQL comments explain what the code refuses, so a scan of the code has to remove them first or it fails
 *  on its own documentation. Same helper shape `phase6-media.test.ts` uses, for the same reason. */
const sqlCode = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const MIGRATION_REL = "supabase/migrations/20260914120000_phase8_sponsorship.sql";
const MIGRATION = read(MIGRATION_REL);
const ROUTE_REL = "workers/src/routes/sponsorship.ts";
const ROUTE = read(ROUTE_REL);
const PHASE6_REL = "supabase/migrations/20260912120000_phase6_r2_media.sql";

/** The body of one `as $fn$ … $fn$;` function, by name. */
function sqlFunction(name: string): string {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} is defined in ${MIGRATION_REL}`);
  const open = MIGRATION.indexOf("\n", MIGRATION.indexOf("as $fn$", start));
  assert.notEqual(open, -1, `${name} opens a $fn$ body`);
  const close = MIGRATION.indexOf("\n$fn$;", open);
  assert.notEqual(close, -1, `${name} closes its $fn$ body`);
  return MIGRATION.slice(open, close);
}

/** `const X_KEYS = [ … ] as const` in the route file. */
function declaredKeys(listName: string): string[] {
  const m = new RegExp(`const ${listName} = \\[[\\s\\S]*?\\] as const`).exec(ROUTE);
  assert.ok(m, `${listName} is declared in ${ROUTE_REL}`);
  return [...m[0].matchAll(/"([a-zA-Z_]+)"/g)].map((k) => k[1]);
}

/**
 * Which fields a save reads (`p_data->>'x'`) and which it refuses outright.
 *
 * `p_data ? 'x'` on its own only means "the key was present", which is also what a conditional validator looks
 * like (`if p_data ? 'attribution' and not label_ok(…) then`). A refusal is the narrower thing: a key probed
 * for presence that is *never read*, because there is nothing it could legitimately write. So `refused` is the
 * set difference, and that is exactly the rule the desk needs — a field with no column behind it must be
 * named and refused, and a field with a column must not be.
 */
function fieldAccess(body: string): { consumed: Set<string>; refused: Set<string> } {
  const consumed = new Set([...body.matchAll(/p_data\s*->>?\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]));
  const probed = new Set([...body.matchAll(/p_data\s*\?\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]));
  return { consumed, refused: new Set([...probed].filter((key) => !consumed.has(key))) };
}
const toCamel = (key: string): string => key.replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase());

// ── 1 · the field contract ──────────────────────────────────────────────────

describe("phase8 · the save contract between the Worker and SQL", () => {
  const writers: [string, string][] = [
    ["SPONSOR_KEYS", "kicklive_sponsor_save"],
    ["PACKAGE_KEYS", "kicklive_sponsor_package_save"],
    ["ASSIGNMENT_KEYS", "kicklive_sponsorship_save"],
  ];

  for (const [listName, fn] of writers) {
    it(`${fn} consumes every field ${listName} declares, and refuses none of them`, () => {
      const declared = declaredKeys(listName);
      const { consumed, refused } = fieldAccess(sqlCode(sqlFunction(fn)));
      assert.ok(declared.length >= 12, `${listName} is a real list, not an empty one`);
      const dropped = declared.filter((key) => key !== "id" && !consumed.has(key) && !consumed.has(snakeOf(key)));
      assert.deepEqual(dropped, [], `${fn} must read every field the route forwards — a field it ignores is a save that lies`);
      const forged = declared.filter((key) => refused.has(key));
      assert.deepEqual(forged, [], `${fn} refuses ${forged.join(", ")} on purpose, so the route must not declare them`);
    });
  }

  it("a field SQL accepts that the Worker does not forward is a documented exception, not an accident", () => {
    // `advertisement_campaign_id` is Phase 7's seam: the function will store it, and no client can send it yet,
    // because wiring it means deciding which campaign a sponsor may point at. When that screen exists the
    // route gains the key and this list loses it — the point of the assertion is that it cannot rot quietly.
    const unreachable = new Map<string, string[]>([["kicklive_sponsorship_save", ["advertisementCampaignId"]]]);
    for (const [listName, fn] of writers) {
      const declared = new Set(declaredKeys(listName).map(toCamel));
      const { consumed } = fieldAccess(sqlCode(sqlFunction(fn)));
      const extra = [...consumed].map(toCamel).filter((key) => key !== "id" && !declared.has(key));
      assert.deepEqual([...new Set(extra)].sort(), (unreachable.get(fn) ?? []).sort(), `${fn}: unexpected fields in SQL that the route does not declare`);
    }
  });

  it("every field that has its own door is refused by name and undeclared by the route", () => {
    // `status` and the approval columns are acts with an author, and a sponsor's two branding URLs are written
    // only by the upload path. Declaring any of them would give a form a control that either does nothing or,
    // worse, bypasses the audit row — so each is refused with a reason rather than ignored. Per writer,
    // because the list is not the same for all three: a package has an `isActive` of its own (retiring a
    // package is not an act with an author), and a sponsorship has no approval columns to forge.
    const refusals: [string, string[]][] = [
      ["kicklive_sponsor_save", ["status", "approved_by", "approved_at", "logoUrl", "bannerUrl", "logo_url", "banner_url"]],
      ["kicklive_sponsor_package_save", []],
      ["kicklive_sponsorship_save", ["status", "isActive", "is_active"]],
    ];
    for (const [listName, fn] of writers) {
      const declared = declaredKeys(listName);
      const expected = refusals.find(([name]) => name === fn)?.[1] ?? [];
      const leaked = expected.filter((key) => declared.includes(key));
      assert.deepEqual(leaked, [], `${listName} must not declare ${leaked.join(", ")}`);
      const body = sqlCode(sqlFunction(fn));
      for (const key of expected) {
        assert.match(body, new RegExp(`p_data \\? '${key}'`), `${fn} should refuse \`${key}\` rather than ignore it`);
      }
      // And the reverse, so a refusal cannot be silently deleted: a key no writer documents must still not be
      // declared, because the alternative is a form field with no column behind it.
      const refused = [...fieldAccess(body).refused].map(toCamel);
      const invented = declared.filter((key) => refused.includes(toCamel(key)));
      assert.deepEqual(invented, [], `${listName} declares fields SQL refuses: ${invented.join(", ")}`);
    }
  });

  it("the sponsorship save refuses the display switch, which is the status route's", () => {
    // This one is a regression of a bug found while writing the desk: the create form sent `isActive`, the
    // Worker's list accepted it, and the function never read it — so unticking "display" saved a record that
    // looked saved. The refusal is what turns that class of mistake into a 400 with a field name.
    const body = sqlCode(sqlFunction("kicklive_sponsorship_save"));
    assert.match(body, /'isActive'\s*,\s*'reason',\s*'DISPLAY_SWITCH_VIA_SET_STATUS_ONLY'/);
    assert.doesNotMatch(body, /p_data->>'isActive'/, "and it must not read it, or the refusal is decoration");
    assert.match(read("scripts/sql-flow.mjs"), /DISPLAY_SWITCH_VIA_SET_STATUS_ONLY/, "the flow executes the refusal too");
  });
});

function snakeOf(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ── 2 · the projection ──────────────────────────────────────────────────────

describe("phase8 · what a stranger is allowed to see", () => {
  const PRIVATE_COLUMNS = [
    "contact_email",
    "contact_phone",
    "contact_name",
    "contact_consent_at",
    "value_amount",
    "value_currency",
    "value_basis",
    "invoice_reference",
    "renewal_terms",
    "internal_notes",
    "approved_by",
    "approved_at",
  ];

  it("the band read never names a contact column or a money column", () => {
    const body = sqlCode(sqlFunction("kicklive_sponsorship_for"));
    const leaked = PRIVATE_COLUMNS.filter((column) => body.includes(column));
    assert.deepEqual(leaked, [], `the public projection reads ${leaked.join(", ")} — it must not even read it to filter on it`);
    // Two columns are read for reasons that are not secrets: `website_url` is the wordmark's fallback link,
    // and `legal_name` is what a badge shows when `display_name` is blank. A sponsor's legal name on a
    // sponsorship page is a fact the partnership has an interest in publishing; a phone number is not.
    assert.match(body, /website_url/, "the wordmark's fallback link still comes from the row");
  });

  it("the rate card has no price in it", () => {
    const body = sqlCode(sqlFunction("kicklive_sponsor_package_card"));
    assert.doesNotMatch(body, /price_/, "the published card is what a package promises, not what it costs");
    assert.match(body, /entitlements/, "and it does carry what is promised");
  });

  it("the frontend's public types mirror that boundary", () => {
    // A column added to the SQL projection but not to this type is a drift the desk will notice as a missing
    // badge; a column in this type that the projection does not send is a component that renders `undefined`.
    const data = read("src/lib/data/sponsorship.ts");
    const band = /export interface SponsorBandEntry \{([\s\S]*?)\n\}/.exec(data);
    assert.ok(band, "SponsorBandEntry is declared");
    const keys = [...band[1].matchAll(/^\s{2}([a-zA-Z_]+)\??:/gm)].map((m) => m[1]);
    const projection = [...sqlCode(sqlFunction("kicklive_sponsorship_for")).matchAll(/'([a-zA-Z_]+)'\s*,/g)].map((m) => toCamel(m[1]));
    assert.deepEqual(
      keys.filter((k) => !projection.includes(k)),
      [],
      `${keys.filter((k) => !projection.includes(k)).join(", ")} is not sent by the band read`,
    );
    const privateLeak = keys.filter((k) => PRIVATE_COLUMNS.map(toCamel).includes(k));
    assert.deepEqual(privateLeak, [], "the public entry type must not carry a private field");
  });
});

// ── 3 · who may execute what ────────────────────────────────────────────────

describe("phase8 · the grant matrix", () => {
  const loop = /do \$grant\$([\s\S]*?)\n\$grant\$;/.exec(MIGRATION);
  assert.ok(loop, "the grant loop exists");

  it("exactly three functions answer an anonymous caller", () => {
    const anon = /if f\.proname in \(([^)]*)\)/.exec(loop![1])![1];
    const names = [...anon.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(names, ["kicklive_sponsorship_for", "kicklive_sponsorship_epoch", "kicklive_sponsor_package_card"]);
  });

  it("the cache writer is excluded by name, so the exception list stays one edit from the grant list", () => {
    const excluded = /elsif f\.proname <> '([a-z_]+)'/.exec(loop![1]);
    assert.equal(excluded?.[1], "kicklive_sponsorship_touch_epoch");
  });

  it("the asset-url helper is not reachable by pattern, so it is granted by name", () => {
    // Phase 6 granted this one to PUBLIC and the `like 'kicklive_sponsor%'` loop cannot see its name. The
    // comment in the migration says so; this asserts the fix rather than the prose.
    const revoke = /revoke all on function public\.kicklive_asset_url_for_asset\(bigint\) from ([^;]*);/.exec(MIGRATION);
    assert.ok(revoke, "the helper is revoked by name");
    for (const role of ["public", "anon", "authenticated"]) assert.ok(revoke![1].includes(role), `${role} must not execute it`);
    const grant = /grant execute on function public\.kicklive_asset_url_for_asset\(bigint\) to ([^;]*);/.exec(MIGRATION);
    assert.equal(grant?.[1].trim(), "service_role");
  });

  it("no client role holds a table privilege on the sponsorship tables", () => {
    // The reason the definer-only design is safe: nothing a client can do directly reaches these rows.
    const tables = ["sponsors", "sponsorship_packages", "sponsorships", "sponsorship_status_transitions", "sponsorship_config"];
    for (const table of tables) {
      for (const line of MIGRATION.split("\n")) {
        if (!line.includes(`on table public.${table}`)) continue;
        const stripped = line.replace(/--.*$/, "").trim();
        if (!stripped.startsWith("grant")) continue;
        assert.match(stripped, /to service_role;$/, `${table}: ${stripped} grants to a role that can call PostgREST`);
      }
    }
  });
});

// ── 4 · the media seam ──────────────────────────────────────────────────────

describe("phase8 · sponsor artwork", () => {
  it("sponsors is a registry kind and never a generic upload kind", () => {
    assert.ok(MEDIA_KINDS.includes("sponsors"), "the asset row must be able to name its entity");
    assert.ok(!UPLOADABLE_KINDS.includes("sponsors"), "and `POST /media/uploads` must not accept it");
    assert.equal(MEDIA_CATEGORIES.sponsors.urlColumn, "", "no column for the generic publish path to repoint");
    assert.equal(MEDIA_CATEGORIES.sponsors.uploadable, false);
    assert.equal(MEDIA_CATEGORIES.sponsors.visibility, "public", "a badge is shown to everyone who sees the page");
  });

  it("Phase 6's publish helper has no sponsors arm, so it cannot attach one", () => {
    const phase6 = read(PHASE6_REL);
    const start = phase6.indexOf("create or replace function public.kicklive_asset_url_column");
    assert.notEqual(start, -1);
    const body = sqlCode(phase6.slice(start, phase6.indexOf("\n$fn$;", start)));
    assert.doesNotMatch(body, /'sponsors'/, "the only writer of logo_url/banner_url is kicklive_sponsor_attach_asset");
  });

  it("the branding route is an upload, and it is declared as one", () => {
    const row = ROUTES.find((r) => r.pattern === "/sponsorship/admin/sponsors/:id/branding");
    assert.ok(row, "the route is catalogued");
    // A `POST` to a per-sponsor path rather than a `PUT` to a per-asset path: the upload is what creates the
    // asset, so there is nothing to replace yet, and the sponsor id is the only subject the desk knows.
    assert.equal(row.method, "POST");
    assert.equal(row.capability, "sponsorship.manage");
    assert.equal(row.rateLimit, "mutation");
    assert.match(ROUTE, /kicklive_sponsor_reserve_asset/, "reserve first");
    assert.match(ROUTE, /kicklive_sponsor_attach_asset/, "attach last");
    assert.ok(ROUTE.indexOf("kicklive_sponsor_attach_asset") > ROUTE.indexOf("publishAsset"), "and only after the bytes are in the bucket");
  });
});

// ── 5 · the routes ──────────────────────────────────────────────────────────

describe("phase8 · the surface", () => {
  const sponsorship = ROUTES.filter((r) => r.pattern === "/sponsorship" || r.pattern.startsWith("/sponsorship/"));

  it("fifteen routes, all of them implemented and registered", () => {
    assert.equal(sponsorship.length, 15);
    for (const row of sponsorship) {
      assert.equal(row.implemented, true, `${row.method} ${row.pattern}`);
      const key = `${row.method} ${row.pattern}`;
      assert.equal(typeof HANDLERS[key as keyof typeof HANDLERS], "function", `${key} has a handler`);
    }
  });

  it("the two public reads are cacheable and everything else is not", () => {
    for (const row of sponsorship) {
      const isPublic = row.pattern === "/sponsorship" || row.pattern === "/sponsorship/packages";
      if (isPublic) {
        assert.notEqual(row.cache, "none", `${row.pattern} is the one thing in the app worth caching at the edge`);
        assert.equal(row.capability, "public.read");
      } else {
        assert.equal((row.cache ?? "none") as string, "none", `${row.pattern} carries contacts and money, so it must not be cached`);
        assert.notEqual(row.capability, "public.read", `${row.pattern} is not a public surface`);
        const expected = row.pattern.startsWith("/sponsorship/admin/packages") ? "sponsor_package.manage" : "sponsorship.manage";
        // The observability rows deliberately answer to `system.diagnostics` instead — they are operator
        // tooling, not the sponsorship desk — so the assertion only binds the rows that write or read agreements.
        if (!/transitions|diagnostics|maintenance|expire/.test(row.pattern)) {
          assert.equal(row.capability, expected, `${row.pattern} is gated by the wrong capability`);
        }
      }
      if (row.method !== "GET") assert.ok(row.rateLimit, `${row.pattern} writes, so it is rate limited`);
    }
  });

  it("every path the client reaches for is a declared route", () => {
    // The frontend's endpoint strings and the router's patterns are the same fact written twice; this is the
    // assertion that keeps a renamed route from becoming a 404 in production.
    const files = ["src/lib/data/sponsorship.ts", "src/lib/media/assets.ts", "src/lib/media/upload.ts"];
    const declared = new Set(sponsorship.map((r) => `${r.method} ${r.pattern}`));
    const found: [string, string][] = [];
    for (const rel of files) {
      const text = read(rel);
      for (const m of text.matchAll(/api\.(get|post|put|patch|del)(?:<[^>]*>)?\(\s*[`"]([^`"]*)[`"]/g)) {
        const method = m[1] === "del" ? "DELETE" : m[1].toUpperCase();
        found.push([`${method} ${m[2]}`, rel]);
      }
      for (const m of text.matchAll(/[`"]\/sponsorship[^`"]*[`"]/g)) {
        found.push([`ANY ${m[0]}`, rel]);
      }
    }
    const misses: string[] = [];
    for (const [entry, rel] of found) {
      if (entry.startsWith("ANY ")) {
        const raw = entry
          .slice(4)
          .replace(/[`"]/g, "")
          .replace(/\$\{[^}]*\}/g, "x");
        if (!sponsorship.some((r) => toRegExp(r.pattern).test(raw))) misses.push(`${rel}: ${raw} matches no sponsorship route`);
        continue;
      }
      const [method, raw] = entry.split(" ");
      const path = raw.replace(/\$\{[^}]*\}/g, "x").split("?")[0];
      if (!declared.has(`${method} ${path.replace(/\/x(?=\/|$)/g, ":id")}`) && !sponsorship.some((r) => toRegExp(r.pattern).test(path))) {
        misses.push(`${rel}: ${method} ${path}`);
      }
    }
    assert.deepEqual(misses, []);
  });
});

function toRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, "[^/]+").replace(/\//g, "\\/")}$`);
}

// ── 6 · the desk and the badge ─────────────────────────────────────────────

describe("phase8 · the client side", () => {
  const BADGE = sqlCodeJs(read("src/components/SponsorBadge.tsx"));
  const BAND = sqlCodeJs(read("src/components/SponsorBand.tsx"));

  it("no sponsor is named in the renderer", () => {
    // The requirement this phase exists to satisfy: adding a partner is a row in a table, not a pull request.
    // Comments are excluded because they *talk about* brands on purpose ("a `case "betway"` is how this rots").
    for (const brand of ["betway", "sportybet", "bet9ja", "1xbet", "mtn", "airtelelt", "tigo", "star times", "guinness", "coca-cola"]) {
      assert.ok(!BADGE.toLowerCase().includes(brand) && !BAND.toLowerCase().includes(brand), `${brand} appears in a component`);
    }
    assert.doesNotMatch(BADGE, /case\s+"[a-z]/i, "a component must not branch on a sponsor's identity");
    assert.doesNotMatch(BAND, /case\s+"[a-z]/i);
  });

  it("the band renders nothing at all when it is empty", () => {
    assert.match(BAND, /length === 0\) return null;/, "an empty box is worse than no box");
    assert.doesNotMatch(BAND, /No sponsors/i, "and a fan is never told the competition is unsponsored");
  });

  it("the badge marks a paid placement as paid", () => {
    assert.match(BADGE, /sponsored/, "search engines and readers both want the rel");
  });

  it("the desk never types a URL into a branding column", () => {
    const manager = sqlCodeJs(read("src/pages/portals/admin/SponsorshipManager.tsx"));
    // Reading `row.logo_url` off the admin list is fine and necessary (a desk has to see what is current);
    // *sending* it back is the part that would bypass `kicklive_sponsor_attach_asset`. So the scan is for the
    // database's own spelling in a request body, which is how a smuggled field would arrive, and it runs on
    // the module that builds the request as well — a `: string` type annotation next to a JSX prop is not a write.
    assert.doesNotMatch(manager, /[,{]\s*(logo_url|banner_url)\s*:/, "branding is uploaded, never typed");
    // The request builders, specifically. `SponsorRow` above them is the *admin* row type and may show the
    // current logo to the person who uploads it; nothing that goes out in a body may.
    const adminBlock = /export const admin = \{([\s\S]*?)\n\};/.exec(read("src/lib/data/sponsorship.ts"));
    assert.ok(adminBlock, "the admin request builders are one object, so this scan cannot miss one");
    assert.doesNotMatch(adminBlock[1], /logo_url|banner_url|logoUrl|bannerUrl/, "the client cannot spell a branding column into a body");
    assert.match(manager, /uploadSponsorBranding/, "and the desk uses that endpoint");
    assert.doesNotMatch(manager, /supabase/, "the desk talks to the Worker, never to the database");
  });

  it("the browser never holds a service key and never calls Supabase for a sponsor", () => {
    for (const rel of ["src/lib/data/sponsorship.ts", "src/components/SponsorBadge.tsx", "src/components/SponsorBand.tsx", "src/pages/portals/admin/SponsorshipManager.tsx"]) {
      const text = sqlCodeJs(read(rel));
      assert.doesNotMatch(text, /service_role|createClient|from\s+"\.\.\/\.\.\/lib\/supabase/, rel);
      assert.doesNotMatch(text, /https:\/\/[a-z0-9-]+\.supabase\.co/, `${rel} hardcodes a project host`);
    }
  });

  it("expiry is enforced in the browser too, because a cache can straddle midnight", () => {
    const today = new Date(Date.UTC(2026, 8, 10, 12));
    assert.equal(isExpired("2026-09-09", today), true, "yesterday is over");
    assert.equal(isExpired("2026-09-10", today), false, "the last day is still the day");
    assert.equal(isExpired("2026-09-11", today), false);
    assert.equal(isExpired(null, today), false, "open-ended is not expired");
    assert.equal(isExpired(undefined, today), false);
    assert.equal(isExpired("when the season ends", today), false, "a value that is not a date is not a reason to hide a paid placement");
  });
});

/** Strips `//` and block comments from TypeScript source, for scans that must not trip on prose. */
function sqlCodeJs(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

// ── 7 · the capability matrix ──────────────────────────────────────────────

describe("phase8 · who is allowed at the desk", () => {
  it("sponsorship is an admin capability, and the band stays public", () => {
    for (const role of ["fan", "team_manager", "media"]) {
      const caps = capabilitiesFor(role as never);
      assert.ok(!caps.includes("sponsorship.manage"), `${role} must not reach the desk`);
      assert.ok(!caps.includes("sponsor_package.manage"), `${role} must not edit the rate card`);
      assert.ok(caps.includes("public.read"), `${role} still sees a band`);
    }
    // A signed-out reader has no role at all, and the band is still theirs to see: `null` is the anonymous
    // caller, and this is the one line that keeps the whole "sponsors are visible without an account" promise
    // from being an accident of the middleware order.
    assert.deepEqual(capabilitiesFor(null), ["public.read"]);
    // `admin` is the only role at the desk, and it is not implied by anything else: there is no `super_admin`
    // in this app, so the assertion is that the *list* is one long.
    assert.deepEqual(
      capabilityTable()
        .filter((row) => row.capability === "sponsorship.manage" || row.capability === "sponsor_package.manage")
        .map((row) => row.roles),
      [["admin"], ["admin"]],
    );
  });

  it("the route itself asks for it before a request is built", () => {
    assert.match(ROUTE, /requireAdmin\(ctx, "create or edit a sponsor"\)/);
    assert.ok(ROUTE.includes('capability: "sponsor_package.manage"') || ROUTES.some((r) => r.capability === "sponsor_package.manage"), "the rate card is gated too, by the catalogue if not by hand");
  });
});
