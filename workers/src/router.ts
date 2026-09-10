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
   * by a shared cache; 'none' = write or streaming route, no caching either way; 'handler' = the
   * handler sets `cache-control` itself and `finalise` leaves it alone (per-object media policy).
   */
  readonly cache: CacheClass;
  readonly phase: 2 | 3 | 4 | 5 | 6 | 7 | 8;
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
  //
  // Phase 6 replaced the two signed-upload stubs that used to sit here. The design changed on
  // purpose: a presigned R2 PUT would put a size and type bound in the *signature*, and therefore
  // in the client's hands, while the object still arrived with no registry row, no version, and no
  // place for the database to decide ownership. Uploading through the Worker costs one extra
  // request and buys the audit trail, the quota, the dedupe and the "no half-published entity"
  // guarantee, all of which are the parts that were ever hard.
  {
    method: "POST",
    pattern: "/media/uploads",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 6,
    implemented: true,
    summary: "Store one image for an entity: sniff, reserve, write to R2, publish in that order.",
    invariants:
      "multipart with a `file` part; the body names a kind and an entity id, never a key, a bucket, a version or a visibility. Type comes from magic bytes, not the declared MIME. `kicklive_reserve_asset_upload` enforces ownership per kind and the per-role 24 h quota before any byte is written; a failed bucket write closes the reservation as `failed` and leaves the entity row untouched.",
  },
  {
    method: "GET",
    pattern: "/media/assets/*",
    capability: "public.read",
    cache: "handler",
    rateLimit: "public",
    phase: 6,
    implemented: true,
    summary: "Read-through for a stored object, with the key carried in the path.",
    invariants:
      "The captured path is validated against the object-key charset and refused for `..` before storage is asked. Public assets answer anonymously; a private asset requires a session and `kicklive_asset_authorized`, so visibility is checked per request rather than hidden behind an unguessable URL. `cache-control` is set by the handler per object: a versioned key is immutable, a private key is no-store, and the route class exists so the entry point does not overwrite either.",
  },
  {
    method: "GET",
    pattern: "/media/config",
    capability: "public.read",
    cache: "edge",
    rateLimit: "public",
    phase: 6,
    implemented: true,
    summary: "The media policy: prefixes, per-kind size caps, accepted types, retention.",
    invariants: "Reads the same table the upload path enforces, so a client can state the limit it will hit.",
  },
  {
    method: "GET",
    pattern: "/media/entities/:kind/:id",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "authenticated",
    phase: 6,
    implemented: true,
    summary: "Version history for one entity, newest first.",
    invariants: "Filtered by the same ownership predicate that authorizes uploads; a caller who may not see the entity gets an empty list, not a 403 to probe with.",
  },
  {
    method: "DELETE",
    pattern: "/media/assets/:id",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 6,
    implemented: true,
    summary: "Soft-delete an asset; `?purge=true` (admin) also removes the object.",
    invariants:
      "Ownership re-checked in SQL. Soft by default, and the current version's URL column is cleared rather than left dangling. Purge marks the row first and deletes the object second, so a failure leaves a reportable orphan instead of a row claiming bytes that are still there.",
  },
  {
    method: "POST",
    pattern: "/media/assets/:id/restore",
    capability: "profile.read_own",
    cache: "none",
    rateLimit: "mutation",
    phase: 6,
    implemented: true,
    summary: "Bring back a soft-deleted or superseded version.",
    invariants: "Only from `deleted`/`superseded`; restoring supersedes whatever took the slot, because the render path relies on exactly one current version.",
  },
  {
    method: "GET",
    pattern: "/media/diagnostics",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "authenticated",
    phase: 6,
    implemented: true,
    summary: "Counts by status and kind, storage bytes, stale reservations, still-on-legacy-URL rows, orphan reconciliation.",
    invariants: "Counts and keys only — never file contents. A listing is bounded and reports `complete: false` when it was not exhaustive, so a partial check is never read as a clean one.",
  },
  {
    method: "POST",
    pattern: "/media/sweep",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "mutation",
    phase: 6,
    implemented: true,
    summary: "Run the retention step now: expire stale reservations, retire objects past retention, delete what the database named.",
    invariants: "The same function the hourly cron runs, so the schedule is testable from a request. The database decides what is old; the Worker only deletes keys it was given.",
  },
  {
    method: "POST",
    pattern: "/media/migration",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "admin-blast",
    phase: 6,
    implemented: true,
    summary: "Copy one kind's published Supabase Storage objects into R2, bounded per run, dry run by default.",
    invariants:
      "Only `https://<SUPABASE_PROJECT_REF>.supabase.co/storage/v1/object/{public,sign}/{media,avatars}/…` is fetched — an allowlist of one host, so a row value can never aim the Worker at an internal endpoint. External links (unsplash, YouTube) are skipped permanently by that same check. Each object is recorded through `kicklive_record_migrated_asset`, idempotent on the source URL, and an entity URL is repointed only for a successful copy.",
  },

  // ── advertising (measurement and the admin surface) ─────────────────────
  //
  // Phase 6 declared three advertising routes and never built them. Two of them are replaced here rather than
  // implemented as declared, and the reason is worth keeping next to the change:
  //
  //   - `POST /advertising/events` was gated on `placement_event.record`, an admin-only capability. The caller
  //       of that route is a browser watching a match page, so the declaration would have answered 403 to every
  //       viewer and the numbers would have been silently empty forever — the exact class of bug where a route
  //       table is written from what a capability is *called* rather than from who stands in front of it. It
  //       is now `public.read`, and the safety of opening it to anonymous callers lives in the payload caps,
  //       the per-day viewer key and the database's dedupe.
  //   - `GET /advertising/campaigns/active` ("campaigns eligible to serve, by placement slot", public) would
  //       have published which advertisers are booked and when, before a single one of them has been shown to
  //       anybody. What a page may legitimately ask for is one slot's current answer, which is the
  //       `/advertising/placement/:code` route below — same information a viewer can see, none a viewer cannot.
  //   - `PATCH /advertising/campaigns/:id` becomes a `POST …/status`: this file's own naming rule is that only
  //       POST bodies carry intent verbs, and a status change is an intent verb.
  //
  // The staff routes are `campaign.manage` / `placement.manage` / `admin.settings_write`, all admin-only in the
  // matrix, while the definer functions accept `admin` *or* `media` for saves. The edge is narrower than the
  // database on purpose: what the API does not expose cannot be reached by a role the matrix has not been
  // amended for, and opening a route later is a one-line review rather than a migration.
  {
    method: "POST",
    pattern: "/advertising/viewer-key",
    capability: "public.read",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Today's measurement reference for this viewer, derived and never stored.",
    invariants:
      "A signed-in caller gets a key derived from their user id and may not supply a seed; an anonymous caller supplies a first-party id and gets the same derivation. `AD_VIEWER_KEY_SECRET` is the HMAC input, so rotating it invalidates every key ever issued — which is the whole answer to 'delete this viewer's history'. `no-store`, because a key is only meaningful for the UTC day it was minted for.",
  },
  {
    method: "GET",
    pattern: "/advertising/placement/:code",
    capability: "public.read",
    cache: "handler",
    rateLimit: "public",
    phase: 7,
    implemented: true,
    summary: "The one creative a slot should show, or nothing at all.",
    invariants:
      "`kicklive_ad_serve` decides eligibility (slot active, creative active, inside the flight's window, advertiser approved, format allowed, daily cap, targeting) and returns the creative's own disclosure label. This handler decides only the cache header: a response built for a signed-in or targeted caller is `private, no-store`, everything else is public for the seconds the function asked for (never above 90). Nothing is served for a live match the slot has agreed to yield to.",
  },
  {
    method: "POST",
    pattern: "/advertising/events",
    capability: "public.read",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Impression/click events, deduplicated, written once and never aggregated in the browser.",
    invariants:
      "At most 20 events per body; every entry re-validated against the same shapes the database enforces. Handed to `AD_EVENTS_QUEUE` and written by the consumer, or inline where no queue is bound. Answers 202 whether or not the write landed and never returns a count: a client that learns a report was dropped retries it, and a retried measurement is how a number becomes a fiction. Double-reporting is impossible below us — `ad_events.dedupe_key` is one impression per viewer, slot and UTC day.",
  },
  {
    method: "GET",
    pattern: "/advertising/config",
    capability: "public.read",
    cache: "edge",
    rateLimit: "public",
    phase: 7,
    implemented: true,
    summary: "The closed vocabularies of advertising: labels, formats, statuses, the destination rule.",
    invariants:
      "Reads the same constants the admin form enforces and the migration checks, so a client states the rule it will be held to rather than copying it out of a form. Carries no advertiser, campaign or slot data.",
  },
  {
    method: "GET",
    pattern: "/advertising/placements",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "The slot registry with what each slot is carrying: assigned, serving, eligible.",
    invariants: "A function and not a table read — every advertising table has RLS enabled with no policies, so a client-side `select` would be a door rather than a view. Lists no advertiser names.",
  },
  {
    method: "POST",
    pattern: "/advertising/placements/:code",
    capability: "placement.manage",
    cache: "none",
    rateLimit: "admin-blast",
    phase: 7,
    implemented: true,
    summary: "Switch one slot of the product on or off, immediately and for everyone.",
    invariants:
      "The global kill switch, so admin-only in the matrix *and* re-checked as `is_admin()` in SQL. Serving caches expire in seconds, not hours; a slot switched off answers `not_served/slot_disabled` and refuses to count events for what nobody could have seen.",
  },
  {
    method: "GET",
    pattern: "/advertising/advertisers",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "The advertiser book, filtered and paginated.",
    invariants:
      "Staff only. Contact fields are present because the reader is the person who has to call them; the response is `no-store` and the route is rate limited like any other read of a business record.",
  },
  {
    method: "POST",
    pattern: "/advertising/advertisers",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Create or update an advertiser, and nothing else.",
    invariants:
      "`kicklive_ad_save_advertiser` owns the rules: a new advertiser starts `pending`, approval is a separate route with a separate author, the terms timestamp is write-once, and suspension is refused while a flight is live. Only the listed form fields may appear in the body.",
  },
  {
    method: "POST",
    pattern: "/advertising/advertisers/:id/status",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Approve or suspend an advertiser, recording who did it.",
    invariants:
      "Admin only, in the matrix and in SQL. Approving a first time also stamps the flight that was waiting on the approval; suspending pauses every live creative of every live flight, which is the difference between a business decision and a colour in a table.",
  },
  {
    method: "GET",
    pattern: "/advertising/campaigns",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "Flights, filtered by advertiser, slot, status or text.",
    invariants: "Staff only. `budget_amount` is returned as the reference it is — no spend is tracked, and the screen says so next to the number.",
  },
  {
    method: "POST",
    pattern: "/advertising/campaigns",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Create or update a flight, including its overlap and cap settings.",
    invariants:
      "`kicklive_ad_save_campaign` refuses to activate (that is the status route), refuses a backwards window, keeps one flight per advertiser overlapping, and enforces `max_concurrent` before a creative can go active.",
  },
  {
    method: "POST",
    pattern: "/advertising/campaigns/:id/status",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Move a flight along the flow: draft, pending, active, paused, completed, archived.",
    invariants:
      "`kicklive_ad_status_transitions` is the authority on both sides of the call, and going `active` requires an approved advertiser and at least one active creative in an active slot — the refusal comes back with the reason and the field to fix.",
  },
  {
    method: "GET",
    pattern: "/advertising/creatives",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "Creatives with their slot assignments, eligibility and measured counts.",
    invariants: "Staff only. `counts.impressions` is a distinct-viewer-day floor and is never an invoice; the response says which definition produced it.",
  },
  {
    method: "POST",
    pattern: "/advertising/creatives",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Create or update a creative: copy, destination, slot list, rotation knobs, targeting.",
    invariants:
      "`kicklive_ad_save_advertisement` validates the disclosure label against the closed set, the destination against the https rule, the targeting against six known keys, the format against each slot's `allowed_formats`, and the flight's approval state before it will write `active`. A partial edit needs only the id.",
  },
  {
    method: "POST",
    pattern: "/advertising/creatives/:id/status",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "Activate, pause, expire or archive one creative.",
    invariants:
      "Only the declared arcs of `ad_status_transitions` are possible, so 'draft to active' is refused with the list of what is allowed; activation stamps the approver and re-checks the flight; a refusal writes `activation_error` for the row.",
  },
  {
    method: "POST",
    pattern: "/advertising/preview",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 7,
    implemented: true,
    summary: "What each listed slot would show, and the exact reason it would not.",
    invariants:
      "`kicklive_ad_explain` is the same eligibility code the serve route runs — a preview that agrees with production is the feature; a preview that agrees with the form is a lie. Never anonymous, because it names advertisers and exposes who is booked where.",
  },
  {
    method: "POST",
    pattern: "/advertising/analytics",
    capability: "campaign.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "Rollups by creative, flight, slot or day, over a window of at most 92 days.",
    invariants:
      "Reads `advertisement_analytics`, never `ad_events`, so a report is not a re-scan of the log. An explicit null window means the default 30 days rather than no filter, which is the difference between an empty screen and a wrong one.",
  },
  {
    method: "GET",
    pattern: "/advertising/diagnostics",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "authenticated",
    phase: 7,
    implemented: true,
    summary: "Counts of the states that must not exist, plus queue depth and retention.",
    invariants: "Integers and short tokens only — no advertiser names, no viewer keys, no creative text — so the response is safe to keep open in a support channel.",
  },
  {
    method: "POST",
    pattern: "/advertising/maintenance",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "admin-blast",
    phase: 7,
    implemented: true,
    summary: "Expire what has run out and prune what retention says is old, now rather than at the next hour.",
    invariants:
      "The same three steps the cron runs, in the same order, and idempotent: `kicklive_ad_expire_due`, `kicklive_ad_sweep` (bounded, raw events only, rollups kept), `kicklive_ad_diagnostics`. Admin-only in the matrix and re-checked as `is_admin()` in SQL.",
  },

  // ── sponsorship (rights, not delivery) ────────────────────────────────────
  // Phase 8. Two planes, and the split is the point: one read a browser may cache, and one surface a desk
  // uses. `advertising` decides what to show per request against a slot; this decides who is *entitled* to
  // appear on a competition, season, team, match, award or event, for how long, in what order. They share the
  // word "sponsor" and one foreign key (`sponsorships.advertisement_campaign_id`), which is why `sponsors`
  // and `advertisers` remain two tables and why no route here reads or writes an ad table.
  {
    method: "GET",
    pattern: "/sponsorship",
    capability: "public.read",
    cache: "handler",
    rateLimit: "public",
    phase: 8,
    implemented: true,
    summary: "The active sponsor band for one target — competition, season, team, match, award or event.",
    invariants:
      "`kicklive_sponsorship_for` is the only public read and the only thing that decides visibility: active status *and* the display switch, today inside the window, an approved sponsor, an active package. The projection has no contact and no money columns, ordering is `priority, display_order` with no randomness and no bidding, and the cache header is the database's `maxAgeSeconds` with the config epoch in the ETag, so a change at the desk is visible on the next request rather than after a TTL.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/packages",
    capability: "public.read",
    cache: "edge",
    rateLimit: "public",
    phase: 8,
    implemented: true,
    summary: "The published rate card: what each package promises, and against what it may be sold.",
    invariants:
      "`kicklive_sponsor_package_card` selects code, label, description, kind, tier, exclusivity, allowed kinds and entitlements. The price columns are not in its select list, so they are unreachable rather than filtered — the admin list is the surface that carries them.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/admin/sponsors",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 8,
    implemented: true,
    summary: "Sponsors with their contact block and their commercial terms, for the desk.",
    invariants:
      "Admin-only in the matrix and re-checked as `is_admin()` in SQL. This is the one read that returns `contact_email`, `contact_phone` and `value_amount`, and it never becomes a public projection: the public route has its own function with its own column list.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/sponsors",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Create or update a sponsor: identity, links, contacts, branding colour, defaults.",
    invariants:
      "`kicklive_sponsor_save` refuses `status` (approval is the status route, which records who did it), refuses a typed `logoUrl`/`bannerUrl` (branding is uploaded, and the URL is derived from an asset in the right bucket), validates the website against the same https rule advertising uses, and names the field for any value it will not cast. Slug is derived, then immutable.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/sponsors/:id/status",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Submit, approve, suspend, reinstate or archive a sponsor.",
    invariants:
      "Only the arcs in `sponsorship_status_transitions` (kind = sponsor) exist; a refusal answers with the list of what is allowed from there, which is an empty list once a row is archived. Approval stamps `auth.uid()`; suspension requires a reason and pauses the sponsor's active sponsorships in the same transaction, so a page never keeps billing for a partner that has been switched off.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/sponsors/:id/branding",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Upload a logo or banner into the sponsor's own R2 prefix, then point the sponsor at it.",
    invariants:
      "Phase 6's pipeline, unchanged: sniff, reserve, write, head, publish. Reservation is `kicklive_sponsor_reserve_asset` (slot ∈ logo|banner, per-slot size caps, no SVG, key derived under `sponsors/<id>/<slot>/`), and `logo_url`/`banner_url` are written only by `kicklive_sponsor_attach_asset`, which refuses an asset reserved for somebody else. `sponsors` is asset-only in `kicklive_asset_url_column`, so the generic publish path cannot attach a sponsor's logo by accident.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/admin/packages",
    capability: "sponsor_package.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 8,
    implemented: true,
    summary: "Every package, active or not, with the terms and prices the public card withholds.",
    invariants:
      "`sponsorship_packages` is configuration, not a per-kind table: six seeded rows today, and a new kind of deal is a row. Retiring one is `isActive: false`, which stops new assignments without touching what has been sold.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/packages",
    capability: "sponsor_package.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Define or edit a package: label, tier, allowed target kinds, entitlements, terms.",
    invariants:
      "`code` is immutable once assigned (it names the package in URLs and cache keys), entitlements are checked against a closed key set so a renderer may switch on a name and treat anything else as absent, and `allowedTargetKinds` is what the assignment route validates against.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/admin/assignments",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 8,
    implemented: true,
    summary: "Sponsorships by target, sponsor or status, including the expired ones a report needs.",
    invariants:
      "One table for six target kinds, addressed by `(target_kind, target_id)`; `p_include_expired` is explicit because the default view of a live system is not the default view of an audit.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/assignments",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Sell a package against a competition, season, match, team, award or event.",
    invariants:
      "Package must be active and must permit the target kind, the target must exist (`award`/`event` are format-checked because they have no table yet), the window must be ordered and real, exclusivity and `max_per_target` are refused by name, and a duplicate assignment for the same sponsor/package/window answers CONFLICT instead of a raw unique-violation. New rows are always `draft`.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/assignments/:id/status",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "Schedule, activate, pause, complete or archive one sponsorship; the display switch is separate.",
    invariants:
      "Activation re-checks the sponsor's approval, the package, the window and the target before it will set `active`, and says which of those was missing (`missing` in the refusal). `isActive` is an independent switch: it can hide a row the contract still keeps, which is what a sponsor's request to pause a campaign for a fortnight actually is.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/preview",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "mutation",
    phase: 8,
    implemented: true,
    summary: "What one or more targets would show right now, and the reason for anything that would not.",
    invariants:
      "`kicklive_sponsorship_explain` runs the same eligibility code as the public read, so the preview agrees with production rather than with the form. Between one and eight targets, never anonymous — it names sponsors and their arrangements.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/admin/transitions",
    capability: "sponsorship.manage",
    cache: "none",
    rateLimit: "authenticated",
    phase: 8,
    implemented: true,
    summary: "The status machine, so the admin UI renders the arcs instead of duplicating them.",
    invariants: "As stored: `exists(row)` means allowed, so the absence of a transition is the rule and the client is handed the same table the database consulted.",
  },
  {
    method: "GET",
    pattern: "/sponsorship/admin/diagnostics",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "authenticated",
    phase: 8,
    implemented: true,
    summary: "Counts of the states that must not exist, plus the config epoch.",
    invariants:
      "Integers and short tokens only — no sponsor names, no contacts, no amounts — so the response is safe to leave open in a support channel. A non-zero `active_but_expired` or `double_title` is a bug in a writer, not a business state.",
  },
  {
    method: "POST",
    pattern: "/sponsorship/admin/maintenance",
    capability: "admin.settings_write",
    cache: "none",
    rateLimit: "admin-blast",
    phase: 8,
    implemented: true,
    summary: "End what has run out, then report, without waiting for the next hour.",
    invariants:
      "`kicklive_sponsorship_expire_due` (bounded) then `kicklive_sponsorship_diagnostics`, in that order, idempotent. Expiry is a state change and an epoch bump, so the public band stops serving an expired sponsor on the next request instead of when a CDN entry ages out.",
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
    // A trailing `*` captures the rest of the path. Exactly one route needs it:
    // `GET /media/assets/*` answers for objects whose keys contain slashes, and a
    // media URL has to carry the key verbatim or the cache in front of it is
    // useless. It is honoured only as the final segment, and the handler must
    // validate what it captured — this hands over raw path text, not an
    // identifier. Static routes are still listed earlier in ROUTES, so a literal
    // `/media/assets/…` path never gets swallowed by the wildcard.
    const wildcard = template[template.length - 1] === "*";
    if (wildcard ? parts.length < template.length : template.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    const fixed = wildcard ? template.length - 1 : template.length;
    for (let i = 0; i < fixed; i++) {
      const seg = template[i] ?? "";
      const actual = parts[i] ?? "";
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(actual);
      else if (seg !== actual) {
        ok = false;
        break;
      }
    }
    if (ok && wildcard) {
      const rest = parts.slice(template.length - 1);
      if (rest.length === 0) continue;
      params["*"] = rest.map((seg) => decodeURIComponent(seg)).join("/");
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
