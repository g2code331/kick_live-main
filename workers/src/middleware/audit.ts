/**
 * Audit trail for privileged actions, written by the Worker rather than by the browser.
 *
 * `activity_logs` predates every phase directory in this repository: the baseline schema created it, Phase 1
 * stopped any signed-in user from writing a row attributed to somebody else, and Phase 3 writes it inside the
 * match functions. What was missing was *coverage* and *irreversibility*, and Phase 9 supplies both: this
 * module writes a row for every privileged action the API takes (coverage), and the migration's
 * `activity_logs_append_only` trigger means the row cannot be edited or deleted afterwards by any role,
 * including the admin whose action it records (irreversibility).
 *
 * Three rules decide what goes in and what does not:
 *
 *   - **One row per action, from whichever layer can describe it best.** Seven functions in Phases 1 and 3
 *     already insert their own audit rows *inside the transaction that made the change*, which is a stronger
 *     guarantee than anything a caller can offer afterwards. Those routes are in `AUDITED_IN_SQL` and the
 *     hook below skips them, so a match event produces one rich row rather than a rich one and a stub.
 *   - **A fan's own account is not a privileged action.** Registering a device, reading the inbox, editing a
 *     club's own profile — `SELF_SERVICE` holds those capabilities. Auditing them would put ~10 000 rows in
 *     the evidence file for every goal, and an audit trail nobody can read is decoration.
 *   - **Nothing free-text.** `action` and `entityType` come from the catalogue below, and `details` is built
 *     from ids and outcome codes that `redact()` has been through. The database re-checks the same shapes
 *     (`kicklive_audit_record` refuses an `action` that is not a dotted identifier and any detail containing
 *     something that looks like a credential), so a well-meaning future edit that starts pasting an error
 *     message into `details` gets a refusal instead of a leak.
 */
import type { Env } from "../env.ts";
import type { AppRole } from "../env.ts";
import { supabaseAdmin, supabaseAsUser } from "../services/supabase.ts";
import { redact } from "../lib/observability.ts";
import { safeMessage } from "../lib/errors.ts";
import { logDebug } from "../lib/debug.ts";
import type { Principal } from "./auth.ts";

export interface AuditEntry {
  /** Namespaced action, from `AUDIT_ACTIONS` — `sponsorship.sponsor_save`, not a sentence. */
  action: string;
  entityType: string;
  /** Numeric entity id where one exists. `profiles.id` is a uuid while `activity_logs.entity_id` is an
   *  integer, so uuid subjects are named in `entityName` rather than keyed. */
  entityId?: number | null;
  entityName?: string | null;
  /**
   * Who acted, when there is no JWT for the database to read a subject from — a queue consumer or a cron.
   * `kicklive_audit_record` prefers `auth.uid()` and only falls back to this, so a wrong value here cannot
   * attribute an action to somebody else while the caller is authenticated.
   */
  actorId?: string | null;
  details?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Routes whose audit row is written by the database, in the transaction that made the change. The list is
 * asserted against the migrations by `tests/unit/phase9-observability.test.ts`: a phase that starts auditing
 * a route inside SQL and is not added here produces two rows for one action, and the test says so.
 */
export const AUDITED_IN_SQL: readonly string[] = [
  "POST /auth/access-requests",
  "POST /admin/access-requests/:requestId/decision",
  "POST /admin/users/:userId/role",
  "POST /matches/:matchId/events",
  "PUT /matches/:matchId/state",
  "POST /matches/:matchId/finalize",
  "POST /matches/:matchId/lock",
  "POST /matches/:matchId/corrections",
  "POST /matches/:matchId/assignments",
  "POST /matches/:matchId/assignments/stand-down",
];

/** Capabilities that describe a caller acting on their own data. No audit row: it is not an act of office. */
export const SELF_SERVICE_CAPABILITIES: readonly string[] = [
  "public.read",
  "profile.read_own",
  "team.update_own",
  "player.manage_own_team",
  "identity.request_role",
  // A broadcaster claiming a match and standing down from it: an action on their own assignment, and
  // `kicklive_assign_match` / `kicklive_stand_down_assignment` already write the audit row themselves.
  "match.assign",
];

/**
 * Every privileged mutating route, with the action name and the entity it acts on. Explicit rather than
 * derived from the URL, because `DELETE /media/:mediaId` and `DELETE /media/assets/:id` are different acts
 * (one unpublishes an article, the other removes a stored object) and a mechanical name would hide that.
 *
 * `read: true` marks a `POST` that reads — a preview, an analytics query. They are listed so the completeness
 * test can see they were *considered*, and skipped so the trail does not fill up with lookups.
 */
export const AUDIT_ACTIONS: Record<string, { action: string; entityType: string; read?: boolean }> = {
  // media — Phase 2 and 6
  "POST /media": { action: "media.publish", entityType: "media" },
  "POST /media/:mediaId/publish": { action: "media.publish_state", entityType: "media" },
  "DELETE /media/:mediaId": { action: "media.delete", entityType: "media" },
  "DELETE /media/assets/:id": { action: "media.asset_delete", entityType: "media_asset" },
  "POST /media/assets/:id/restore": { action: "media.asset_restore", entityType: "media_asset" },
  "POST /media/sweep": { action: "media.sweep", entityType: "system", read: false },
  "POST /media/migration": { action: "media.migrate", entityType: "system" },
  // advertising — Phase 7
  "POST /advertising/placements/:code": { action: "advertising.placement_set", entityType: "ad_placements" },
  "POST /advertising/advertisers": { action: "advertising.advertiser_save", entityType: "advertisers" },
  "POST /advertising/advertisers/:id/status": { action: "advertising.advertiser_status", entityType: "advertisers" },
  "POST /advertising/campaigns": { action: "advertising.campaign_save", entityType: "advertisement_campaigns" },
  "POST /advertising/campaigns/:id/status": { action: "advertising.campaign_status", entityType: "advertisement_campaigns" },
  "POST /advertising/creatives": { action: "advertising.creative_save", entityType: "advertisements" },
  "POST /advertising/creatives/:id/status": { action: "advertising.creative_status", entityType: "advertisements" },
  "POST /advertising/preview": { action: "advertising.preview", entityType: "advertisements", read: true },
  "POST /advertising/analytics": { action: "advertising.analytics", entityType: "advertisement_analytics", read: true },
  "POST /advertising/maintenance": { action: "advertising.maintenance", entityType: "system" },
  // sponsorship — Phase 8
  "POST /sponsorship/admin/sponsors": { action: "sponsorship.sponsor_save", entityType: "sponsors" },
  "POST /sponsorship/admin/sponsors/:id/status": { action: "sponsorship.sponsor_status", entityType: "sponsors" },
  "POST /sponsorship/admin/sponsors/:id/branding": { action: "sponsorship.branding_upload", entityType: "sponsors" },
  "POST /sponsorship/admin/packages": { action: "sponsorship.package_save", entityType: "sponsorship_packages" },
  "POST /sponsorship/admin/assignments": { action: "sponsorship.assignment_save", entityType: "sponsorships" },
  "POST /sponsorship/admin/assignments/:id/status": { action: "sponsorship.assignment_status", entityType: "sponsorships" },
  "POST /sponsorship/admin/preview": { action: "sponsorship.preview", entityType: "sponsorships", read: true },
  "POST /sponsorship/admin/maintenance": { action: "sponsorship.maintenance", entityType: "system" },
  // notifications — Phase 5, staff side
  "POST /admin/notifications/broadcast": { action: "notifications.broadcast", entityType: "notification_jobs" },
  // observability — Phase 9
  "POST /observability/admin/maintenance": { action: "observability.maintenance", entityType: "system" },
  "POST /observability/admin/probe": { action: "observability.health_probe", entityType: "system" },
};

/** The action for a route, or `null` when the route is deliberately not audited. */
export function auditActionFor(method: string, pattern: string): { action: string; entityType: string } | null {
  const key = `${method} ${pattern}`;
  if (AUDITED_IN_SQL.includes(key)) return null;
  if (method === "GET") return null;
  const entry = AUDIT_ACTIONS[key];
  if (!entry || entry.read) return null;
  return { action: entry.action, entityType: entry.entityType };
}

/** Whether a route should even reach the audit path: capability first, because that is the cheap test. */
export function shouldAuditRoute(route: { readonly method: string; readonly pattern: string; readonly capability?: string | null }): boolean {
  if (route.method === "GET") return false;
  if (!route.capability) return false;
  if (SELF_SERVICE_CAPABILITIES.includes(route.capability)) return false;
  // The catalogue is the whole test: `auditActionFor` already returns null for a GET, for a route whose SQL
  // function writes its own richer row, and for a POST that only reads. Naming those cases here as well would
  // put the same rule in two functions, and the second copy is the one that goes stale.
  return auditActionFor(route.method, route.pattern) !== null;
}

/**
 * Write one row, as the admin who acted when there is one.
 *
 * The token is forwarded so `kicklive_audit_record` can take the actor from `auth.uid()` rather than from
 * this process's belief about who was calling — a Worker bug in `principal` would otherwise be able to
 * attribute an action to the wrong person, and the audit trail's whole value is that it cannot. A call with
 * no token (a cron, a queue consumer) is recorded as `via = worker-system` with no subject, which is the
 * truth: no human did it.
 */
export async function writeAudit(env: Env, entry: AuditEntry, opts: { token?: string | null } = {}): Promise<boolean> {
  const args = {
    p_action: entry.action,
    p_entity_type: entry.entityType,
    p_entity_id: typeof entry.entityId === "number" && Number.isFinite(entry.entityId) ? Math.trunc(entry.entityId) : null,
    p_entity_name: entry.entityName ? redact(entry.entityName, 200) : null,
    p_details: safeDetails(entry.details),
    p_request_id: entry.requestId && /^[A-Za-z0-9._-]{8,64}$/.test(entry.requestId) ? entry.requestId : null,
    p_actor_id: typeof entry.actorId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.actorId) ? entry.actorId : null,
  };
  const client = opts.token ? supabaseAsUser(env, opts.token) : supabaseAdmin(env);
  try {
    const reply = (await client.call("kicklive_audit_record", args)) as { ok?: boolean; reason?: string } | null;
    if (reply && reply.ok === false) {
      // A refusal from the function is a contract breach in the caller, not a runtime fault, so it is
      // reported loudly and once — never to the user, who is not the audience for an audit row.
      logDebug(`audit refused: ${entry.action} ${reply.reason ?? ""}`.trim());
      return false;
    }
    return true;
  } catch (err) {
    // Never fail a business write because the audit row could not be written — but shout about it, because an
    // audit trail that silently drops rows is worse than none: nobody can trust the rows that did arrive.
    logDebug(`audit write failed: ${entry.action}: ${safeMessage(err)}`);
    return false;
  }
}

/** The detail keys the database accepts, each value reduced to one printable scalar. */
export function safeDetails(details: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details ?? {}).slice(0, 12)) {
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(key)) continue;
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") out[key] = redact(value, 120);
    // A nested object is flattened to a short, redacted preview rather than rejected: the existing call
    // sites in `routes/live.ts` describe a transition with one, and dropping it would hide the change.
    else if (typeof value === "object") out[key] = redact(JSON.stringify(value), 120);
  }
  return out;
}

export interface RouteOutcome {
  readonly env: Env;
  readonly method: string;
  readonly pattern: string;
  readonly status: number;
  readonly requestId: string;
  readonly principal: Principal;
  readonly params: Record<string, string>;
  readonly role?: AppRole | null;
  readonly detail?: Record<string, string | number | boolean | null>;
}

/**
 * Whether this route's outcome should produce an audit row *from this layer*. True only when the catalogue
 * has an action for it, which is the single source of truth for the three skip rules in the header.
 */
export function isAuditedByWorker(route: { readonly method: string; readonly pattern: string }): boolean {
  return auditActionFor(route.method, route.pattern) !== null;
}

/**
 * The central hook: one row per privileged mutation, taken from the response that was actually sent.
 *
 * It runs after the handler so the status is the truth rather than an intention, it never awaits on the
 * request path (the caller passes `waitUntil`), and it derives as much as it can from the route itself: the
 * entity id from the path params, so a handler that forgot to log anything still leaves a trace.
 */
export function auditRouteOutcome(outcome: RouteOutcome, ctx: { waitUntil(promise: Promise<unknown>): void }): void {
  const identity = auditActionFor(outcome.method, outcome.pattern);
  if (!identity) return;
  if (outcome.status < 400 && outcome.status >= 300) return;
  const ids = Object.entries(outcome.params)
    .filter(([, value]) => /^[0-9]{1,9}$/.test(value))
    .map(([key, value]) => `${key}:${value}`)
    .slice(0, 4);
  ctx.waitUntil(
    writeAudit(
      outcome.env,
      {
        ...identity,
        entityId: numericParam(outcome.params),
        entityName: ids.length > 0 ? ids.join(" ") : outcome.pattern,
        details: {
          status: outcome.status,
          method: outcome.method,
          route: outcome.pattern,
          role: String(outcome.role ?? outcome.principal.role ?? "anonymous"),
          ...(outcome.detail ?? {}),
        },
        requestId: outcome.requestId,
      },
      { token: outcome.principal.token ?? null },
    ),
  );
}

/** The id this action was about, if the path named one — uuids are named, integers are keyed. */
function numericParam(params: Record<string, string>): number | null {
  for (const [key, value] of Object.entries(params)) {
    if (/^(match|media|asset|advertisement|campaign|sponsor|sponsorship|package)Id$/i.test(key) && /^[0-9]{1,9}$/.test(value)) {
      return Number(value);
    }
  }
  return null;
}
