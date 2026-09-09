/**
 * The route table. This is the boundary document for the API: which paths exist, what each one
 * requires, and which phase owns it. Handlers are intentionally absent — `routes/index.ts` returns
 * `501` for all of them so a half-moved feature can never shadow the working Supabase path.
 *
 * Naming rules, so the table stays reviewable:
 *   - `/v1/` prefix on everything (the SPA ships independently of the API; unversioned routes can
 *     never be changed safely);
 *   - nouns are resources, and only `POST` bodies carry intent verbs (`/finalize`, `/publish`);
 *   - one capability per route; if a route wants two capabilities, it is two routes.
 */
import type { Capability } from "./lib/capabilities";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDef {
  readonly method: Method;
  /** Path pattern with `:param` segments, matched after the `/v1` prefix. */
  readonly pattern: string;
  readonly capability: Capability | null;
  /**
   * 'edge' = cacheable at Cloudflare (public, no per-user content); 'private' = must not be cached
   * by a shared cache; 'none' = write or streaming route, no caching either way.
   */
  readonly cache: "edge" | "private" | "none";
  readonly phase: 2 | 3 | 4 | 5 | 6;
  readonly summary: string;
  /** What the handler has to enforce beyond the capability, so it is not "discovered" later. */
  readonly invariants?: string;
}

export const ROUTES: readonly RouteDef[] = [
  {
    method: "GET",
    pattern: "/health",
    capability: null,
    cache: "edge",
    phase: 2,
    summary: "Liveness + build version. Implemented today so deploy wiring is provable.",
  },

  // ── identity ──────────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/auth/sign-up",
    capability: null,
    cache: "none",
    phase: 2,
    summary: "Create a fan account (Turnstile-gated).",
    invariants: "Role is never accepted from the request body; the created profile is always a fan.",
  },
  {
    method: "POST",
    pattern: "/auth/access-requests",
    capability: "identity.request_role",
    cache: "none",
    phase: 2,
    summary: "Queue a team_manager/media request for admin review.",
    invariants: "At most one open request per user; `admin` is not requestable.",
  },

  // ── public reads ──────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/matches",
    capability: "public.read",
    cache: "edge",
    phase: 2,
    summary: "Fixture + score list, filtered by competition/date/status, bounded page size.",
    invariants: "Replaces whole-table `matches` selects from 6+ components; max limit 100.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId",
    capability: "public.read",
    cache: "edge",
    phase: 2,
    summary: "One match with events, commentary and statistics in a single round trip.",
  },
  {
    method: "GET",
    pattern: "/media/feed",
    capability: "public.read",
    cache: "edge",
    phase: 2,
    summary: "Published articles, paginated; the only media read the public pages need.",
  },
  {
    method: "GET",
    pattern: "/teams",
    capability: "public.read",
    cache: "edge",
    phase: 2,
    summary: "Active clubs with the columns the UI actually renders.",
  },

  // ── live match operation ──────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/matches/:matchId/stream",
    capability: "public.read",
    cache: "none",
    phase: 3,
    summary: "SSE handoff to the match Durable Object; replaces setInterval polling.",
    invariants: "Server assigns sequence numbers; clients resume with Last-Event-ID.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/events",
    capability: "match_control.write",
    cache: "none",
    phase: 2,
    summary: "Append one validated match event (goal, card, substitution…).",
    invariants:
      "Idempotent on client_event_id; event_type checked against the profile CHECK list; score/minute derived from events rather than trusted from the client; rejected when the match is locked.",
  },
  {
    method: "PUT",
    pattern: "/matches/:matchId/state",
    capability: "match_control.write",
    cache: "none",
    phase: 2,
    summary: "Clock/status transition (kickoff, pause, half time, full time).",
    invariants: "Legal transitions only; the DO is the authority once Phase 3 lands.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/finalize",
    capability: "match_control.finalize",
    cache: "none",
    phase: 2,
    summary: "Lock the result, enqueue standings recompute + notification fan-out.",
    invariants: "Sets is_locked + confirmed_at in one transaction; refuses if events disagree with the score.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/lock",
    capability: "match_control.lock",
    cache: "none",
    phase: 2,
    summary: "Freeze a match for review (today the column exists but nothing writes it).",
  },

  // ── club management ───────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/teams/mine",
    capability: "team.update_own",
    cache: "private",
    phase: 2,
    summary: "The caller’s own club(s), resolved by owner_id in SQL.",
  },
  {
    method: "PATCH",
    pattern: "/teams/:teamId",
    capability: "team.update_own",
    cache: "none",
    phase: 2,
    summary: "Edit club profile, lineup, gallery.",
    invariants: "Owner-or-admin re-check inside the handler: the capability alone is not enough.",
  },
  {
    method: "POST",
    pattern: "/players",
    capability: "player.manage_own_team",
    cache: "none",
    phase: 2,
    summary: "Add a player to a squad the caller manages.",
  },

  // ── publishing ────────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/media",
    capability: "media.publish",
    cache: "none",
    phase: 2,
    summary: "Create an article; author_id set from the JWT.",
    invariants: "Fixes today’s gap where MediaPublisher never writes author_id at all.",
  },
  {
    method: "POST",
    pattern: "/media/:mediaId/publish",
    capability: "media.publish",
    cache: "none",
    phase: 2,
    summary: "Flip an article public, with the featured flag needing a separate capability.",
  },
  {
    method: "DELETE",
    pattern: "/media/:mediaId",
    capability: "media.delete",
    cache: "none",
    phase: 2,
    summary: "Delete an article. Admin-only, unlike the current media-role policy.",
  },

  // ── notifications ─────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/notifications/subscriptions",
    capability: "profile.read_own",
    cache: "none",
    phase: 5,
    summary: "Register an FCM/APNs device token for the caller.",
    invariants: "Tokens are per-user and per-device; never stored on profiles.",
  },

  // ── administration ────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/admin/access-requests",
    capability: "identity.read_directory",
    cache: "private",
    phase: 2,
    summary: "The pending queue behind User Control.",
  },
  {
    method: "POST",
    pattern: "/admin/access-requests/:requestId/decision",
    capability: "identity.grant_role",
    cache: "none",
    phase: 2,
    summary: "Approve or reject a request; grants the role in the same transaction.",
  },
  {
    method: "POST",
    pattern: "/admin/users/:userId/role",
    capability: "identity.grant_role",
    cache: "none",
    phase: 2,
    summary: "Set a role, audited, last-admin-guarded (same RPC the SPA calls today).",
  },
  {
    method: "GET",
    pattern: "/admin/audit",
    capability: "admin.audit_read",
    cache: "private",
    phase: 2,
    summary: "activity_logs, filtered, for the admin overview.",
  },

  // ── media plane (R2) ──────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/uploads/sign",
    capability: "media.publish",
    cache: "none",
    phase: 4,
    summary: "Signed R2 PUT for an image/video upload with size and MIME bounds.",
  },
  {
    method: "GET",
    pattern: "/uploads/:key",
    capability: "public.read",
    cache: "edge",
    phase: 4,
    summary: "R2 read-through with image resizing + immutable cache keys.",
  },

  // ── advertising (placements and delivery) ─────────────────────────────────
  { method: "GET", pattern: "/advertising/campaigns/active", capability: "public.read", cache: "edge", phase: 6, summary: "Campaigns eligible to serve, by placement slot." },
  {
    method: "POST",
    pattern: "/advertising/events",
    capability: "placement_event.record",
    cache: "none",
    phase: 6,
    summary: "Impression/click events, deduplicated, written once and never aggregated in the browser.",
  },
  { method: "PATCH", pattern: "/advertising/campaigns/:id", capability: "campaign.manage", cache: "none", phase: 6, summary: "Start/pause/retarget a campaign." },

  // ── sponsorship (rights, not delivery) ────────────────────────────────────
  { method: "GET", pattern: "/sponsorship/packages", capability: "public.read", cache: "edge", phase: 6, summary: "Published rate card for a season." },
  { method: "PATCH", pattern: "/sponsorship/sponsorships/:id", capability: "sponsorship.manage", cache: "none", phase: 6, summary: "Renewals and rights changes; separate table from ad campaigns." },
];

export interface Matched {
  readonly route: RouteDef;
  readonly params: Record<string, string>;
}

/** Segment-wise match; `:name` captures. No regex per route on purpose — it is a hot path. */
export function matchRoute(method: string, pathname: string): Matched | null {
  const withoutPrefix = pathname.replace(/^\/v1/, "") || "/";
  const parts = withoutPrefix.split("/").filter((p) => p.length > 0);

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const template = route.pattern.split("/").filter((p) => p.length > 0);
    if (template.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const seg = template[i] ?? "";
      const actual = parts[i] ?? "";
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(actual);
      else if (seg !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** Used by the Phase 2 review: which routes are declared, and how many are still stubs. */
export function routeInventory(): { total: number; byPhase: Record<string, number> } {
  const byPhase: Record<string, number> = {};
  for (const r of ROUTES) byPhase[`phase ${String(r.phase)}`] = (byPhase[`phase ${String(r.phase)}`] ?? 0) + 1;
  return { total: ROUTES.length, byPhase };
}
