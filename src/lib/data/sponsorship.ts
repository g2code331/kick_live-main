/**
 * KICKLIVE · sponsorship reads (Phase 8)
 *
 * The one place a screen asks "who is sponsoring this". Like every other spec in `src/lib/data`, a query here
 * is the question, the cache key, the invalidation tags and the freshness class together — but it is a
 * different *shape* of read from the rest of the file, and that is worth stating before the code:
 *
 *  - **It goes through the Worker, not Supabase.** The only sanctioned public read of sponsorship data is
 *    `kicklive_sponsorship_for`, and the route in front of it is what sets the cache header and the ETag from
 *    the config epoch. A browser calling the RPC directly would get the same rows and lose the invalidation,
 *    which is the half that makes a stale badge acceptable rather than wrong for an hour.
 *  - **The response is already the safe projection.** Names, logos, an https link, a display order. There is
 *    no contact field, no amount and no internal note in it — not because this file filters, but because the
 *    SQL function's select list does not contain them. So a page here cannot accidentally render a phone
 *    number, and `tests/unit/phase8-sponsorship.test.ts` is what keeps that true if someone widens the
 *    projection later.
 *  - **Tags are how the desk reaches the fan's screen.** A mutation invalidates `sponsors` and the specific
 *    `sponsorship:<kind>:<id>`; every spec below carries both, so an admin saving a title sponsor drops the
 *    home page's band and that match's band and nothing else.
 */
import { defineQuery, type DataCtx } from "./context.ts";
import { FRESHNESS, SECOND } from "./freshness.ts";
import { invalidate } from "./useResource.ts";
import { api, isApiFailure, unwrap } from "../api/index.ts";

/** One entry in a sponsor band, exactly as `kicklive_sponsorship_for` projects it. */
export interface SponsorBandEntry {
  sponsorshipId: string;
  sponsorId: string;
  slug: string;
  name: string;
  /** The line a page shows: the assignment's own attribution, or the package's label. Never invented here. */
  attribution: string;
  packageCode: string;
  packageLabel: string;
  packageKind: string;
  tier: number;
  logoUrl: string | null;
  bannerUrl: string | null;
  brandColour: string | null;
  onDark: boolean;
  /** Already validated as https in SQL, and re-checked on read; absent when the sponsor has no safe link. */
  href?: string | null;
  rel: string;
  namingOverride: string | null;
  priority: number;
  displayOrder: number;
  startsAt: string;
  endsAt: string;
  targetKind: string;
  targetId: string;
}

export interface SponsorBandResponse {
  ok: boolean;
  sponsors: SponsorBandEntry[];
  epoch: number;
  maxAgeSeconds: number;
  /** Present when the request was answered from the edge cache with a matching ETag. */
  notModified?: boolean;
}

export interface SponsorPackageCard {
  code: string;
  label: string;
  description: string | null;
  kind: string;
  tier: number;
  seasonLabel: string | null;
  exclusivity: string;
  allowedTargetKinds: string[];
  entitlements: Record<string, unknown> | null;
}

export interface SponsorPackageCardResponse {
  ok: boolean;
  epoch: number;
  packages: SponsorPackageCard[];
}

export type SponsorTargetKind = "competition" | "season" | "match" | "team" | "award" | "event";

export const SPONSOR_TARGET_KINDS: readonly SponsorTargetKind[] = ["competition", "season", "match", "team", "award", "event"];

/**
 * The band for one target.
 *
 * `key` deliberately does *not* include the epoch: the epoch is what the edge uses to decide whether the
 * cached answer is current, and putting it in the browser key would mean a page that already has a good
 * answer asking for it again under a new name.
 *
 * The TTL is `min(the database's maxAgeSeconds, FRESHNESS.page)`, and the min matters: the route says how
 * long an answer may be held, and a browser that held it longer would be the one thing that makes "the desk
 * changed it" look broken. A band is not live match data — it changes when a human signs something.
 */
export const sponsorBand = defineQuery<SponsorBandResponse, { kind: SponsorTargetKind; id: string | number; limit?: number }>({
  key: (a) => `sponsorship|${a.kind}|${a.id}|${String(a.limit ?? 12)}`,
  tags: (a) => ["sponsors", `sponsorship:${a.kind}:${String(a.id)}`],
  ttlMs: 2 * 60 * SECOND,
  persist: true,
  async fetch(ctx: DataCtx, a) {
    void ctx; // the API client is on the context; the argument is here so a fake can be injected in a test
    const result = await api.get<SponsorBandResponse>("/sponsorship", {
      query: { kind: a.kind, ids: String(a.id), limit: a.limit ?? 12 },
    });
    if (isApiFailure(result)) return null;
    const data = result.data;
    const capMs = Math.max(15_000, Math.min((data.maxAgeSeconds ?? 120) * SECOND, FRESHNESS.page));
    // Re-describe the entry with the shorter of the two lifetimes, so a `max-age=15` from the edge is not
    // held for two minutes in memory. `prime` is the cache's own door for "the answer knows its TTL".
    if (capMs < 2 * 60 * SECOND) {
      const { queryCache } = await import("./cache.ts");
      queryCache.prime(`sponsorship|${a.kind}|${a.id}|${String(a.limit ?? 12)}`, data, {
        ttlMs: capMs,
        tags: ["sponsors", `sponsorship:${a.kind}:${String(a.id)}`],
      });
    }
    return data;
  },
});

/** The rate card. Nearly static: it changes when the desk re-prices a season, not during a match. */
export const sponsorPackages = defineQuery<SponsorPackageCardResponse, void>({
  key: () => "sponsorship|packages",
  tags: () => ["sponsors", "sponsorship:packages"],
  ttlMs: FRESHNESS.slow,
  persist: true,
  async fetch() {
    const result = await api.get<SponsorPackageCardResponse>("/sponsorship/packages");
    if (isApiFailure(result)) return { ok: false, epoch: 0, packages: [] };
    return result.data;
  },
});

/**
 * What a mutation calls after a successful write.
 *
 * Both tags, always: `sponsors` so the rate card and any page-level band refresh, and the specific target so
 * the band on *that* match or club page drops without emptying every other page's cache. The `epoch` is
 * bumped by the database too, which is what makes a browser that is nowhere near this tab converge on its
 * own — this call is only about the one that is open.
 */
export function invalidateSponsorship(target?: { kind: SponsorTargetKind; id: string | number }): number {
  if (!target) return invalidate("sponsors");
  return invalidate("sponsors", `sponsorship:${target.kind}:${String(target.id)}`, `sponsorship:${target.kind}:${String(target.id)}|`);
}

/**
 * The desk's own reads and writes.
 *
 * They live here rather than in the component so the URL list is one file, and so a screen cannot invent a
 * path the Worker does not serve. Every one of these requires an admin's token, which `api` attaches; none
 * of them takes a `sponsorId` in the body where a path parameter belongs, because the route's `:id` is what
 * SQL cross-checks the asset against.
 */
export interface SponsorRow {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string | null;
  description: string | null;
  website_url: string | null;
  status: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  logo_url: string | null;
  banner_url: string | null;
  brand_colour: string | null;
  on_dark: boolean;
  default_priority: number;
  value_amount: number | null;
  value_currency: string | null;
  invoice_reference: string | null;
  approved_at: string | null;
  updated_at: string;
}

export interface SponsorshipRow {
  id: string;
  sponsor_id: string;
  package_id: string;
  target_kind: string;
  target_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  is_active: boolean;
  priority: number;
  display_order: number;
  attribution: string | null;
  activation_error: string | null;
  sponsor?: { display_name?: string; slug?: string; status?: string } | null;
  package?: { label?: string; code?: string; tier?: number } | null;
}

export interface PackageRow extends SponsorPackageCard {
  id: string;
  isActive: boolean;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceBasis?: string | null;
  sortOrder: number;
}

export const admin = {
  sponsors: (query: Record<string, string | number | boolean | undefined> = {}) => api.get<{ sponsors: SponsorRow[]; total?: number }>("/sponsorship/admin/sponsors", { query }),
  saveSponsor: (body: Record<string, unknown>) => api.post<{ ok: boolean; sponsor: SponsorRow; created?: boolean }>("/sponsorship/admin/sponsors", body),
  sponsorStatus: (id: string, status: string, reason?: string | null) =>
    api.post<{ ok: boolean; sponsor: SponsorRow }>(`/sponsorship/admin/sponsors/${encodeURIComponent(id)}/status`, { status, ...(reason ? { reason } : {}) }),
  packages: (query: Record<string, string | number | boolean | undefined> = {}) => api.get<{ packages: PackageRow[] }>("/sponsorship/admin/packages", { query }),
  savePackage: (body: Record<string, unknown>) => api.post<{ ok: boolean; package: PackageRow }>("/sponsorship/admin/packages", body),
  assignments: (query: Record<string, string | number | boolean | undefined> = {}) => api.get<{ sponsorships: SponsorshipRow[] }>("/sponsorship/admin/assignments", { query }),
  saveAssignment: (body: Record<string, unknown>) => api.post<{ ok: boolean; sponsorship: SponsorshipRow }>("/sponsorship/admin/assignments", body),
  assignmentStatus: (id: string, status: string, options: { reason?: string | null; isActive?: boolean | null } = {}) =>
    api.post<{ ok: boolean; sponsorship: SponsorshipRow }>(`/sponsorship/admin/assignments/${encodeURIComponent(id)}/status`, {
      status,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
    }),
  preview: (targets: { kind: SponsorTargetKind; id: string | number }[]) => api.post<{ results: Record<string, unknown>[] }>("/sponsorship/admin/preview", { targets }),
  transitions: (kind: "sponsor" | "sponsorship") => api.get<{ statuses: string[]; transitions: { from: string; to: string; note: string | null }[] }>("/sponsorship/admin/transitions", { query: { kind } }),
  diagnostics: () => api.get<Record<string, number | string>>("/sponsorship/admin/diagnostics"),
};

export { unwrap };
