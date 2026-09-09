/**
 * Server-side authorisation matrix — the single place a capability is decided.
 *
 * This table is the reason the browser can stop being the authority. Today `src/App.tsx` compares
 * `profile?.role` against a route and `src/pages/portals/admin/*` calls Supabase directly, so the
 * only real gate is RLS. When a write moves behind a route, the route names a capability and this
 * table answers yes/no — from a role read out of the database, not from a client claim.
 *
 * Invariants worth preserving while endpoints get built:
 *   - `admin` is never implied by another role and is never self-grantable;
 *   - `team_manager` grants actions on *their own* club only; ownership is a row check
 *     (`teams.owner_id = auth.uid()`), so it is deliberately absent from this table;
 *   - capability names are verbs in the domain language (`match_control.write`), not screen names
 *     (`admin.matchcontrol_page`), so the same capability can serve app, portal and CLI callers.
 */
import type { AppRole } from "../env.ts";

export type Capability =
  // read
  | "public.read"
  | "profile.read_own"
  // identity administration
  | "identity.request_role"
  | "identity.grant_role"
  | "identity.read_directory"
  // live match operation
  | "match_control.read"
  | "match_control.write"
  | "match_control.finalize"
  | "match_control.lock"
  /** Assign officials to a match. Admin-only: whoever picks the referee decides who may score the game. */
  | "match.assign"
  // competition administration
  | "competition.manage"
  | "fixtures.generate"
  | "standings.recompute"
  // club data
  | "team.register"
  | "team.read_own"
  | "team.update_own"
  | "player.manage_own_team"
  // publishing
  | "media.publish"
  | "media.publish_featured"
  | "media.delete"
  // notifications
  | "notifications.broadcast"
  // future monetisation surfaces (kept as separate capability families on purpose)
  | "advertiser.manage"
  | "campaign.manage"
  | "placement.manage"
  | "placement_event.record"
  | "sponsor_package.manage"
  | "sponsorship.manage"
  // platform
  | "admin.audit_read"
  | "admin.settings_write";

const ALL_ROLES: readonly AppRole[] = ["fan", "team_manager", "media", "admin"];

/** Explicit lists rather than "everything except fan": a new role must not inherit by accident. */
const MATRIX: Record<Capability, readonly AppRole[]> = {
  "public.read": ALL_ROLES,
  "profile.read_own": ALL_ROLES,

  "identity.request_role": ALL_ROLES,
  "identity.grant_role": ["admin"],
  "identity.read_directory": ["admin"],

  // These four say "this role may do this *without* a per-match grant". They are deliberately
  // admin-only, and `Phase 3` adds the assignment path rather than widening them: a route marked
  // `orAssigned` in `router.ts` lets an authenticated caller through the coarse gate, after which
  // `services/matchAccess.ts` must prove the caller is an assigned official **for that match**, and the
  // database re-checks the same fact inside the write function. Role alone is still never enough —
  // `tests/unit/phase1-security.test.ts` pins exactly that, and it passes unchanged.
  "match_control.read": ["admin", "media"],
  "match_control.write": ["admin"],
  "match_control.finalize": ["admin"],
  "match_control.lock": ["admin"],
  "match.assign": ["admin"],

  "competition.manage": ["admin"],
  "fixtures.generate": ["admin"],
  "standings.recompute": ["admin"],

  "team.register": ALL_ROLES,
  // Any authenticated caller may ask which clubs are theirs. A fan gets an empty list, which is the
  // truthful answer, so this grants no data another role could not already read about itself.
  "team.read_own": ALL_ROLES,
  "team.update_own": ["team_manager", "admin"],
  "player.manage_own_team": ["team_manager", "admin"],

  "media.publish": ["media", "admin"],
  "media.publish_featured": ["admin"],
  "media.delete": ["admin"],

  "notifications.broadcast": ["admin"],

  "advertiser.manage": ["admin"],
  "campaign.manage": ["admin"],
  "placement.manage": ["admin"],
  "placement_event.record": ["admin"],
  "sponsor_package.manage": ["admin"],
  "sponsorship.manage": ["admin"],

  "admin.audit_read": ["admin"],
  "admin.settings_write": ["admin"],
};

export function roleHasCapability(role: AppRole | null, capability: Capability): boolean {
  if (role === null) return capability === "public.read";
  return MATRIX[capability].includes(role);
}

/** For tests and the route review: every capability with the roles that hold it. */
export function capabilityTable(): { capability: Capability; roles: readonly AppRole[] }[] {
  return (Object.keys(MATRIX) as Capability[]).map((capability) => ({ capability, roles: MATRIX[capability] }));
}

/**
 * Everything a role holds. `/api/me` returns this so a client can grey out an action for the right
 * reason; it is a display hint, and the same matrix rejects the request if the client ignores it.
 */
export function capabilitiesFor(role: AppRole | null): Capability[] {
  return (Object.keys(MATRIX) as Capability[]).filter((capability) => roleHasCapability(role, capability));
}

/** Every capability name, so a typo in a route table entry fails loudly instead of meaning "public". */
export const ALL_CAPABILITIES: readonly Capability[] = Object.keys(MATRIX) as readonly Capability[];

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (ALL_CAPABILITIES as readonly string[]).includes(value);
}
