/**
 * The route table. This is the boundary document for the API: which paths exist, what each one
 * requires, and which phase owns it. Everything not marked `implemented: true` answers
 * `501 NOT_IMPLEMENTED` from `routes/index.ts`, so a half-moved feature can never shadow the working
 * Supabase path — a declared route is a *promise about the future*, and this table is where that
 * promise is written down, complete with the invariants its handler will have to enforce.
 *
 * Naming rules, so the table stays reviewable:
 *   - paths are matched under `API_PREFIXES` (`/api` and the `/v1` alias the Phase 1 documents use);
 *   - nouns are resources, and only `POST` bodies carry intent verbs (`/finalize`, `/publish`);
 *   - one capability per route; if a route wants two capabilities, it is two routes;
 *   - `rateLimit` is a named budget from `middleware/ratelimit.ts`, absent means the public one.
 */
import type { CacheClass } from "./lib/headers.ts";
import type { Capability } from "./lib/capabilities.ts";
import type { RateLimitClass } from "./middleware/ratelimit.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDef {
  readonly method: Method;
  /** Path pattern with `:param` segments, matched after the API prefix. */
  readonly pattern: string;
  /** Null means "no capability required" — only ever for public reads and the liveness probe. */
  readonly capability: Capability | null;
  /** Present exactly when `routes/index.ts` has a handler for this pattern. */
  readonly implemented?: true;
  /**
   * "Assigned to this match" is an alternative to the role in the matrix: the coarse gate asks only for
   * an authenticated caller, and the handler must then prove the assignment (`services/matchAccess.ts`)
   * before the write function repeats the check in SQL. Set it only on a route whose handler resolves a
   * `:matchId` — there is no row to be assigned to on any other kind of route.
   */
  readonly orAssigned?: true;
  /** Writes and credential exchanges must name a class; reads may rely on `public`. */
  readonly rateLimit?: RateLimitClass;
  /**
   * 'edge' = cacheable at Cloudflare (public, no per-user content); 'private' = must not be cached
   * by a shared cache; 'none' = write or streaming route, no caching either way.
   */
  readonly cache: CacheClass;
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
    implemented: true,
    summary: "Liveness + build version. Implemented today so deploy wiring is provable.",
  },
  // ── identity (own) ────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/me",
    capability: "profile.read_own",
    cache: "private",
    rateLimit: "authenticated",
    phase: 2,
    implemented: true,
    summary: "Who the caller is, per the database: role, email, username, capability hints.",
    invariants: "Role is read from `profiles` by the Worker; nothing in the request may name a role.",
  },
  // ── identity ──────────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/auth/sign-up",
    capability: null,
    cache: "none",
    rateLimit: "auth-exchange",
    phase: 2,
    summary: "Create a fan account (Turnstile-gated).",
    invariants: "Role is never accepted from the request body; the created profile is always a fan.",
  },
  {
    method: "POST",
    pattern: "/auth/access-requests",
    capability: "identity.request_role",
    cache: "none",
    rateLimit: "auth-exchange",
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
    cache: "none",
    phase: 2,
    implemented: true,
    summary: "One match with live state and its timeline in a single round trip.",
    invariants: "cache flips to `none`: a live match answer must never be served from the edge cache, or the score a fan reads depends on which PoP they hit.",
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
    implemented: true,
    summary: "SSE handoff to the match Durable Object; replaces setInterval polling.",
    invariants: "Read-only; server-assigned sequence; resumes from Last-Event-ID; 15s keepalive comment; ends rather than lying.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/events",
    capability: "match_control.write",
    orAssigned: true,
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    implemented: true,
    summary: "Append one validated match event (goal, card, substitution…).",
    invariants:
      "Idempotent on client_event_id; event_type checked against the profile CHECK list; score/minute derived from events rather than trusted from the client; rejected when the match is locked; sequence allocated by Postgres; written through the Durable Object so broadcast order equals commit order.",
  },
  {
    method: "PUT",
    pattern: "/matches/:matchId/state",
    capability: "match_control.write",
    orAssigned: true,
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    implemented: true,
    summary: "Clock/status transition (kickoff, half time, second half, full time, suspend…).",
    invariants: "Legal transitions only, from lib/matchLifecycle.ts, enforced again in SQL; the DO owns the clock and derives the minute; the browser never names a status it likes.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/finalize",
    capability: "match_control.finalize",
    orAssigned: true,
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    implemented: true,
    summary: "Freeze the result from the event log: derived score written once, confirmed_at set, match completed.",
    invariants: "Head referee, match commissioner or admin; refuses while the clock is running; refuses if events disagree with the stored score; notifications/standings remain Phase 5.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/lock",
    capability: "match_control.lock",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    implemented: true,
    summary: "Freeze a match for review (admin-only: a lock outranks the officials' own rights).",
    invariants: "Reason required; broadcast to the room so a console mid-entry sees the lock before it writes.",
  },

  // ── live match room (Phase 3: snapshot, socket, corrections, assignments) ─
  {
    method: "GET",
    pattern: "/matches/:matchId/snapshot",
    capability: "public.read",
    cache: "none",
    phase: 3,
    implemented: true,
    summary: "Authoritative live state: score, status, server-derived clock, recent events, connection counts.",
    invariants: "Served by the Durable Object and rehydrated from Postgres when the room is cold; no client-supplied minute or score.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId/events",
    capability: "public.read",
    cache: "none",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "Timeline page, oldest first, with sequence cursor for backfill (`?after_sequence=&limit=`).",
    invariants: "Includes corrected rows with their replacement, so a dispute can be read as it happened.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId/access",
    capability: "profile.read_own",
    cache: "private",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "What this caller may do in this match, and which transitions are legal from its current status.",
    invariants: "Computed from the assignment rows, never from a client claim; the console renders disabled buttons from this and the server refuses anyway.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/corrections",
    capability: "match_control.write",
    orAssigned: true,
    cache: "none",
    rateLimit: "mutation",
    phase: 3,
    implemented: true,
    summary: "Correct an event: the original row stays, marked corrected, with who/when/why and a replacement.",
    invariants: "Reason required; own events while live, any event at any time for admins; score recalculated from the surviving rows.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId/audit",
    capability: "match_control.read",
    cache: "private",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "Who recorded, corrected or reopened what, from activity_logs, newest first.",
    invariants: "Read-only; admin and media roles only — officials see the same facts in the timeline itself.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId/assignments",
    capability: "profile.read_own",
    cache: "private",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "Officials assigned to this match (own rows for an official, all rows for an admin — RLS decides).",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/assignments",
    capability: "match.assign",
    cache: "none",
    rateLimit: "mutation",
    phase: 3,
    implemented: true,
    summary: "Assign a user as head referee / assistant / fourth official / VAR / commissioner / data operator.",
    invariants: "Admin only; the assignee must have a profile row; a match may not be controlled before this exists.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/assignments/stand-down",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 3,
    implemented: true,
    summary: "Stand down from an assignment — the caller's own row, or anyone's for an admin.",
    invariants: "Never deletes history: the row becomes `stood_down`.",
  },
  {
    method: "POST",
    pattern: "/matches/:matchId/live-ticket",
    capability: "public.read",
    cache: "none",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "Short-lived, single-match credential for the WebSocket handshake (a browser cannot set headers there).",
    invariants: "`controller` tickets are refused unless the caller is an assigned official; carries no role the caller lacks.",
  },
  {
    method: "GET",
    pattern: "/live/matches/:matchId",
    capability: "public.read",
    cache: "none",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "WebSocket upgrade into the match room (read-only fan updates; writes always go through REST).",
    invariants: "Hibernating sockets; snapshot on connect; resume from the last sequence; no client frame can write.",
  },
  {
    method: "GET",
    pattern: "/matches/:matchId/diagnostics",
    capability: "admin.audit_read",
    cache: "none",
    rateLimit: "authenticated",
    phase: 3,
    implemented: true,
    summary: "Room internals for incident triage: sequence, retained buffer, clock source, sockets, alarm.",
  },

  // ── club management ───────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/teams/mine",
    capability: "team.read_own",
    cache: "private",
    rateLimit: "authenticated",
    phase: 2,
    implemented: true,
    summary: "The caller’s own club(s), resolved by owner_id in SQL.",
  },
  {
    method: "PATCH",
    pattern: "/teams/:teamId",
    capability: "team.update_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Edit club profile, lineup, gallery.",
    invariants: "Owner-or-admin re-check inside the handler: the capability alone is not enough.",
  },
  {
    method: "POST",
    pattern: "/players",
    capability: "player.manage_own_team",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Add a player to a squad the caller manages.",
  },

  // ── publishing ────────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/media",
    capability: "media.publish",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Create an article; author_id set from the JWT.",
    invariants: "Fixes today’s gap where MediaPublisher never writes author_id at all.",
  },
  {
    method: "POST",
    pattern: "/media/:mediaId/publish",
    capability: "media.publish",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Flip an article public, with the featured flag needing a separate capability.",
  },
  {
    method: "DELETE",
    pattern: "/media/:mediaId",
    capability: "media.delete",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Delete an article. Admin-only, unlike the current media-role policy.",
  },

  // ── notifications (Phase 5) ───────────────────────────────────────────────
  //
  // The self-service half and the admin half, and the difference between them is the whole design: a user may
  // describe *their own* device and *their own* categories, and only an admin may cause a send. Nine of these
  // routes are `implemented` against `SECURITY DEFINER` functions that derive the user from `auth.uid()`; the
  // tenth queues a job and returns 202 without ever calling FCM in the request.
  //
  // `GET /notifications/subscriptions` never existed as a route — it was the declared stub below, named for a
  // table nobody had. `devices` is the honest name, and renaming a 501 nobody could call costs nothing.
  {
    method: "POST",
    pattern: "/notifications/devices",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 5,
    implemented: true,
    summary: "Register the caller's FCM/web-push device token. Identity comes from the JWT, never the body.",
    invariants:
      "Rejects an undeclared `user_id`; caps 10 active devices per account in SQL; a token that already belongs to another account moves here rather than duplicating; returns no token in any response.",
  },
  {
    method: "GET",
    pattern: "/notifications/devices",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "authenticated",
    phase: 5,
    implemented: true,
    summary: "List the caller's devices, without the token column.",
    invariants: "Served from notification_devices_public, which does not select `token`; no admin path returns a token.",
  },
  {
    method: "DELETE",
    pattern: "/notifications/devices/:id",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 5,
    implemented: true,
    summary: "Revoke one of the caller's devices.",
    invariants: "The row is addressed by id AND owner in the statement; an id that is not yours answers the same as one that does not exist.",
  },
  {
    method: "GET",
    pattern: "/notifications/preferences",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "authenticated",
    phase: 5,
    implemented: true,
    summary: "The caller's full preference document, merged over the server's defaults.",
    invariants: "Absent means the default, not off; the merge happens in SQL so the client renders one shape.",
  },
  {
    method: "PUT",
    pattern: "/notifications/preferences",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 5,
    implemented: true,
    summary: "Save categories. Full-document semantics: an omitted category means its default.",
    invariants: "Unknown category names are refused with the field named, never dropped; the response is the authoritative document after the write.",
  },
  {
    method: "GET",
    pattern: "/notifications/inbox",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "authenticated",
    phase: 5,
    implemented: true,
    summary: "Notification history with the unread count, in one call.",
    invariants: "Owner-scoped in SQL (not only by policy); page size bounded in the function; expired rows filtered.",
  },
  {
    method: "POST",
    pattern: "/notifications/inbox/:id/read",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 5,
    implemented: true,
    summary: "Mark one notification read.",
    invariants: "`where id = $1 and user_id = auth.uid()` — the owner is in the statement; a policy alone would be one bug away from a cross-user write.",
  },
  {
    method: "POST",
    pattern: "/notifications/inbox/read-all",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 5,
    implemented: true,
    summary: "Mark the caller's unread notifications read, up to a bound.",
    invariants: "Capped at 500 rows per call and reports `capped: true` rather than silently doing less.",
  },
  {
    method: "GET",
    pattern: "/notifications/config",
    capability: null,
    cache: "none",
    rateLimit: "public",
    phase: 5,
    implemented: true,
    summary: "Categories, defaults, limits, and whether this deployment can push at all.",
    invariants: "Public and user-free by construction: it carries no row from any table a person owns.",
  },
  {
    method: "GET",
    pattern: "/notifications/diagnostics",
    capability: "notifications.broadcast",
    cache: "none",
    rateLimit: "authenticated",
    phase: 5,
    implemented: true,
    summary: "Queue depth, oldest pending age, transport in use.",
    invariants: "Admin-only, and counts only: no notification bodies, no devices, no tokens.",
  },
  {
    method: "POST",
    pattern: "/admin/notifications/broadcast",
    capability: "notifications.broadcast",
    cache: "none",
    rateLimit: "admin-blast",
    phase: 5,
    implemented: true,
    summary: "Fan-out push/notification to an audience; the only route allowed to write many rows per call.",
    invariants:
      "Audience size is capped and the send itself runs in a Queue, never in the request; `is_admin()` is re-checked inside the SQL function; over the cap the call is refused, not truncated; confirm: true is required above 1000.",
  },
  // ── administration ────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/admin/access-requests",
    capability: "identity.read_directory",
    cache: "private",
    rateLimit: "authenticated",
    phase: 2,
    summary: "The pending queue behind User Control.",
  },
  {
    method: "POST",
    pattern: "/admin/access-requests/:requestId/decision",
    capability: "identity.grant_role",
    cache: "none",
    rateLimit: "auth-exchange",
    phase: 2,
    summary: "Approve or reject a request; grants the role in the same transaction.",
  },
  {
    method: "POST",
    pattern: "/admin/users/:userId/role",
    capability: "identity.grant_role",
    cache: "none",
    rateLimit: "mutation",
    phase: 2,
    summary: "Set a role, audited, last-admin-guarded (same RPC the SPA calls today).",
  },
  {
    method: "GET",
    pattern: "/admin/audit",
    capability: "admin.audit_read",
    cache: "private",
    rateLimit: "authenticated",
    phase: 2,
    summary: "activity_logs, filtered, for the admin overview.",
  },

  // ── media plane (R2) ──────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/uploads/sign",
    capability: "media.publish",
    cache: "none",
    rateLimit: "mutation",
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
    rateLimit: "mutation",
    phase: 6,
    summary: "Impression/click events, deduplicated, written once and never aggregated in the browser.",
  },
  { method: "PATCH", pattern: "/advertising/campaigns/:id", capability: "campaign.manage", cache: "none", phase: 6, summary: "Start/pause/retarget a campaign.", rateLimit: "mutation" },

  // ── sponsorship (rights, not delivery) ────────────────────────────────────
  { method: "GET", pattern: "/sponsorship/packages", capability: "public.read", cache: "edge", phase: 6, summary: "Published rate card for a season." },
  {
    method: "PATCH",
    pattern: "/sponsorship/sponsorships/:id",
    capability: "sponsorship.manage",
    cache: "none",
    phase: 6,
    summary: "Renewals and rights changes; separate table from ad campaigns.",
    rateLimit: "mutation",
  },
];

export interface Matched {
  readonly route: RouteDef;
  readonly params: Record<string, string>;
}

/** Segment-wise match; `:name` captures. No regex per route on purpose — it is a hot path. */
export function matchRoute(method: string, pathname: string): Matched | null {
  const withoutPrefix = stripApiPrefix(pathname);
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

/**
 * Accepted path prefixes. `/api` is the stable name the SPA uses; `/v1` keeps working because the
 * Phase 1 architecture documents and the planned desktop build already refer to it. One route table,
 * two spellings — never two handlers.
 */
export const API_PREFIXES = ["/api", "/v1"] as const;

export function stripApiPrefix(pathname: string): string {
  for (const prefix of API_PREFIXES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || "/";
  }
  return pathname || "/";
}

/** Used by the Phase 2 review: which routes are declared, and how many are still stubs. */
export function routeInventory(): { total: number; byPhase: Record<string, number> } {
  const byPhase: Record<string, number> = {};
  for (const r of ROUTES) byPhase[`phase ${String(r.phase)}`] = (byPhase[`phase ${String(r.phase)}`] ?? 0) + 1;
  return { total: ROUTES.length, byPhase };
}
