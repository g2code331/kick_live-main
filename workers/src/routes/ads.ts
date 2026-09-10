/**
 * The advertising routes.
 *
 * Three things are true of every handler here, and they are the reason the file looks the way it does:
 *
 *   - **The decision is not made in this file.** Eligibility, status transitions, targeting, caps, dedupe and
 *       the audience floor are all decided by the definer functions in
 *       `supabase/migrations/20260913120000_phase7_advertising.sql`. A route either passes a request to its
 *       function or refuses it for a reason the function would also refuse. What the route *does* own is the
 *       transport concerns SQL cannot see: the cache header, the queue, the viewer key, the field errors.
 *   - **The envelope is unwrapped in one place** (`refuseFrom`), so no handler can forget to check `ok` and
 *       answer 200 with an error inside it — the failure mode of a naive `data`-only proxy, and the reason
 *       these functions return `{ok:false, reason}` rather than raising: a raised exception arrives as a
 *       PostgREST string with a code we would have to pattern-match.
 *   - **Staff is checked here *and* in SQL.** `capabilities.ts` maps `ads.manage` to admin-only-implicitly, so
 *       the router already refuses a fan; the handler re-checks the role so a route table that is edited
 *       wrongly does not silently open the write surface, and the function checks the caller identity again for
 *       everything that is admin-only (a media editor may save a creative but may not approve an advertiser or
 *       switch a slot off).
 */
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readJsonBody, readQuery } from "../lib/validation.ts";
import {
  AD_EVENT_NAMES,
  DEFAULT_DISCLOSURE_LABEL,
  DISCLOSURE_LABELS,
  MAX_EVENTS_PER_BODY,
  PLACEMENT_CODE_PATTERN,
  VIEWER_KEY_PATTERN,
  VIEWER_SEED_PATTERN,
  adCacheControl,
  adErrorStatus,
  deriveViewerKey,
  isSafeDestination,
  viewerKeyDay,
  type AdEventName,
} from "../lib/adPolicy.ts";
import { logError } from "../lib/debug.ts";
import { supabaseAdmin, supabaseAnon, supabaseAsUser } from "../services/supabase.ts";
import { parseAdEvent, recordAdEvents, type AdEventMessage } from "../queues/ads.ts";
import type { HandlerContext } from "./index.ts";

const SERVE_KEYS = ["placement", "matchId", "competitionId", "seasonId", "pageType"] as const;
const VIEWER_KEY_KEYS = ["seed"] as const;
const EVENT_KEYS = ["events"] as const;
const LIST_KEYS = ["q", "advertiserId", "campaignId", "placement", "status", "limit", "offset"] as const;
const STATUS_KEYS = ["status", "reason"] as const;
const TOGGLE_KEYS = ["isActive"] as const;
const SAVE_KEYS = [
  "id",
  "advertiserId",
  "campaignId",
  "advertisementId",
  "name",
  "title",
  "body",
  "label",
  "destinationUrl",
  "targeting",
  "format",
  "mediaAssetId",
  "imageWidth",
  "imageHeight",
  "creativeRef",
  "html",
  "placements",
  "priority",
  "weight",
  "startsAt",
  "endsAt",
  "maxImpressionsPerDay",
  "businessName",
  "contactName",
  "contactEmail",
  "phone",
  "whatsapp",
  "website",
  "location",
  "kind",
  "tier",
  "termsAcceptedAt",
  "logoUrl",
  "status",
] as const;
const EXPLAIN_KEYS = ["placements"] as const;
const ANALYTICS_KEYS = ["from", "to", "advertiserId", "campaignId", "placement", "groupBy"] as const;

/** camelCase in the API, snake_case in the database: one mapping, applied to the request and the response. */
const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
function mapKeys(value: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[fn(k)] = mapKeys(v, fn);
    return out;
  }
  return value;
}

/**
 * Which Supabase client a call goes out on, and it is a security decision rather than a plumbing detail.
 *
 * A viewer-facing call is made **as the caller** — their own JWT on the request when they have one, the anon
 * key when they do not — because the definer functions read `auth.uid()` to decide targeting and to refuse
 * anything an admin ought to be. Proxying them on the service-role key with no JWT would make every browser
 * look like the same anonymous principal: harmless for `serve`, wrong for a signed-in viewer whose club
 * context is the whole point of the slot, and quietly disabling for the `is_admin()` checks inside SQL.
 *
 * The staff calls go out on `supabaseAdmin` because those functions are granted to `service_role` only, and
 * a call on the caller's token would die on a privilege error before the function's own identity check could
 * produce a refusal a client can read.
 */
function clientFor(ctx: HandlerContext, asCaller: boolean) {
  if (!asCaller) return supabaseAdmin(ctx.env);
  return ctx.principal.token ? supabaseAsUser(ctx.env, ctx.principal.token) : supabaseAnon(ctx.env);
}

/** Human copy for the reasons the client is allowed to see. Same rule as media's `refusalMessage`: name what
 *  the reader can change, because "advertising error" is not actionable. */
function refusalMessage(reason: string, field?: string): string {
  switch (reason) {
    case "ADMIN_ONLY":
      return "Advertising is managed by an administrator.";
    case "CAMPAIGN_NOT_READY":
      return "The flight this creative belongs to is not active yet — it needs an approved advertiser, a window that has started, and an active status.";
    case "NO_ELIGIBLE_CREATIVE":
      return "No creative is currently eligible for that slot.";
    case "CREATIVE_INACTIVE":
      return "That creative is not active, so it cannot be counted.";
    case "ACTIVE_CREATIVE_EXISTS":
      return "This slot is already carrying another active creative.";
    case "ADVERTISER_NOT_APPROVED":
    case "CREATIVES_NOT_READY":
      return "This flight has no active creative in an active slot yet, so it cannot go live.";
    case "TRANSITION_NOT_ALLOWED":
      return field === "status" ? "That status change is not one the flow allows." : "That status change is not one the flow allows.";
    case "DUPLICATE_TITLE_IN_CAMPAIGN":
      return "This flight already has a creative with that name. Two creatives called the same thing split the numbers.";
    case "WINDOW_NOT_ORDERED":
      return "The end of that window is before its start.";
    case "WINDOW_TOO_WIDE":
      return "Reports cover one quarter at a time. Anything longer is an export.";
    case "LIMIT_UNBOUNDED":
      return "That request would read an unbounded range.";
    case "CONFLICT":
      return "That change lost a race with another one. Reload and try again.";
    case "PLACE_CODE_IMMUTABLE":
      return "Slot codes cannot be renamed once an assignment points at one.";
    case "IDENTITY_REQUIRED":
      return "Sign in to change advertising.";
    case "TOO_MANY_EVENTS":
      return `No more than ${String(MAX_EVENTS_PER_BODY)} interactions may be reported at once.`;
    case "MALFORMED_VIEWER_KEY":
      return "That measurement reference is not valid for today.";
    case "HTTPS_URL_WITH_HOST_REQUIRED":
      return "The link must be a full https address.";
    case "FORMAT_NOT_ALLOWED_IN_SLOT":
      return "That slot does not accept this creative format.";
    case "UNKNOWN_PLACEMENT":
    case "PLACEMENT_UNKNOWN":
      return "No slot has that code.";
    default:
      return "The advertising request could not be completed.";
  }
}

/**
 * Turn a `{ok:false, code, field, reason}` envelope into the API's error shape. The reason code is carried in
 * `detail` so a client can branch on it without parsing prose — the one place the database's vocabulary is
 * allowed to appear in the response, and it appears verbatim because a support conversation starts from it.
 */
function refuse(payload: unknown): never {
  const p = (payload ?? {}) as { code?: string; field?: string; reason?: string; detail?: string };
  const status = adErrorStatus(p.code ?? "VALIDATION_FAILED");
  throw new ApiError(status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "VALIDATION_FAILED", status, refusalMessage(p.reason ?? "", p.field), {
    detail: [p.code, p.field, p.reason].filter(Boolean).join(" "),
    ...(p.field ? { fields: [{ field: p.field, message: refusalMessage(p.reason ?? "", p.field) }] } : {}),
  });
}

async function callOk<T = Record<string, unknown>>(ctx: HandlerContext, fn: string, params: Record<string, unknown> = {}, asCaller = false): Promise<T> {
  let data: unknown;
  try {
    data = await clientFor(ctx, asCaller).call(fn, params);
  } catch (err) {
    // `call` already turns a non-2xx PostgREST answer into an ApiError; anything else here is a raised
    // exception in SQL — a defect, not a decision — so it gets a log line and an honest 502 rather than a
    // message that implies the database made a judgement it never made.
    if (err instanceof ApiError) throw err;
    logError(`ads-${fn}`, err);
    throw new ApiError("DEPENDENCY_FAILED", 502, "The advertising service could not be reached.");
  }
  const payload = data as T & { ok?: boolean };
  if (payload && payload.ok === false) refuse(payload);
  return payload;
}

function requireStaff(ctx: HandlerContext, what: string): void {
  const role = ctx.principal.role;
  if (role !== "admin" && role !== "media") {
    throw new ApiError("FORBIDDEN", 403, `Only staff may ${what}.`);
  }
}
function requireAdmin(ctx: HandlerContext, what: string): void {
  if (ctx.principal.role !== "admin") {
    throw new ApiError("FORBIDDEN", 403, `Only an administrator may ${what}.`);
  }
}

// ── the viewer plane ────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/ads/viewer-key` — today's measurement reference.
 *
 * A signed-in caller gets a key derived from their id and cannot choose one; an anonymous caller presents a
 * first-party id it generated and gets a key derived from that. The second sentence is the whole privacy
 * argument for this route: the value that ties two views together is issued by us for one day, and the id it
 * came from never leaves the browser. The response is `no-store` because a key is only stable for a UTC day,
 * and a week-old cache entry would be a viewer that no longer exists.
 */
export async function handleAdViewerKey(ctx: HandlerContext): Promise<Response> {
  const signedIn = Boolean(ctx.principal.userId);
  const fields = signedIn ? null : await readJsonBody(ctx.request, VIEWER_KEY_KEYS);
  const seed = fields ? new Fields(fields.raw, VIEWER_KEY_KEYS).string("seed", { max: 128, pattern: VIEWER_SEED_PATTERN }) : undefined;
  if (!signedIn && !seed) {
    throw new ApiError("VALIDATION_FAILED", 400, "An anonymous viewer-key request must carry a `seed`.", {
      detail: "expected a 8–128 character first-party identifier matching [A-Za-z0-9_-]",
    });
  }
  const day = viewerKeyDay();
  const viewerKey = await deriveViewerKey(ctx.env, signedIn ? `u:${ctx.principal.userId}` : `a:${seed}`, day);
  return ok({ viewerKey, day, ttlSeconds: 900, reuses: false }, { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/**
 * `GET /api/ads/serve?placement=HOME_TOP` — one eligible creative, or nothing.
 *
 * The cache header is the handler's only real judgement call, and it is made from two facts: whether the
 * response was built for *this* viewer (a targeting context, which only a signed-in caller can supply) and
 * what the database said its answer may be held for. An empty answer is cached too — the common case is a slot
 * with nothing in it, and fetching the origin to learn that once per page view is a cost with no benefit.
 */
export async function handleAdServe(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, SERVE_KEYS);
  const placement = fields.string("placement", { required: true, max: 32, pattern: PLACEMENT_CODE_PATTERN, patternMessage: "is not a slot code" });
  fields.throwIfInvalid();
  const competitionId = fields.uuid("competitionId");
  const seasonId = fields.uuid("seasonId");
  const matchId = fields.uuid("matchId");
  const pageType = fields.string("pageType", { max: 32 });
  fields.throwIfInvalid();

  const personalised = Boolean(ctx.principal.userId) || Boolean(competitionId || seasonId || matchId);
  const payload = await callOk<Record<string, unknown>>(
    ctx,
    "kicklive_ad_serve",
    {
      p_placement_code: placement,
      p_competition_id: competitionId ?? null,
      p_season_id: seasonId ?? null,
      p_match_id: matchId ?? null,
      p_page_type: pageType ?? null,
    },
    true,
  );
  const advertisement = payload.advertisement;
  return ok(
    {
      status: payload.status,
      placementCode: payload.placement_code,
      advertisement: advertisement ? mapKeys(advertisement, toCamel) : null,
      maxAgeSeconds: payload.cache_max_age_seconds,
    },
    { requestId: ctx.requestId, headers: adCacheControl({ ttlSeconds: payload.cache_max_age_seconds as number, personalised, empty: advertisement === null }) },
  );
}

/**
 * `POST /api/ads/events` — the measurement report, handed to the queue.
 *
 * `202 Accepted` even when the queue is absent and the inline write also failed, and never a count in the
 * response body: a client that learns its report was dropped will retry it, and a retry of a *measurement* is
 * how a number becomes a fiction. The dedupe in the database means a genuine network loss is not double
 * counted either, so the honest answer ("we accepted this") and the safe answer are the same one.
 */
export async function handleAdEvents(ctx: HandlerContext): Promise<Response> {
  const fields = await readJsonBody(ctx.request, EVENT_KEYS);
  const raw = new Fields(fields.raw, EVENT_KEYS).raw.events;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError("VALIDATION_FAILED", 400, "Expected a non-empty `events` array.", { detail: "shape: {events: [{advertisementId, placementCode, event, viewerKey}]}" });
  }
  if (raw.length > MAX_EVENTS_PER_BODY) {
    throw new ApiError("VALIDATION_FAILED", 413, `No more than ${String(MAX_EVENTS_PER_BODY)} events per request.`, {
      detail: "a browser reports what it saw on one page; a larger batch is not a browser",
      fields: [{ field: "events", message: `at most ${String(MAX_EVENTS_PER_BODY)}` }],
    });
  }
  const events: AdEventMessage[] = [];
  for (const candidate of raw) {
    const parsed = parseAdEvent(candidate);
    if (parsed === null) {
      throw new ApiError("VALIDATION_FAILED", 400, "One of the reported events is not in the expected form.", {
        detail: `every event needs an advertisementId (uuid), placementCode, event (${AD_EVENT_NAMES.join("|")}) and a 16-hex viewerKey`,
        fields: [{ field: "events", message: "malformed entry" }],
      });
    }
    events.push({ ...parsed, requestId: ctx.requestId });
  }
  const outcome = await recordAdEvents(ctx.env, events);
  if (outcome.path === "dropped") logError("ad-events-dropped", new Error(`${String(events.length)} event(s): ${outcome.note ?? "no reason"}`));
  return ok({ accepted: events.length, path: outcome.path }, { requestId: ctx.requestId, status: 202, headers: { "cache-control": "no-store" } });
}

// ── the staff plane ─────────────────────────────────────────────────────────────────────────────────

/** `GET /api/ads/config` — the closed vocabularies the form is built from, so the client never hardcodes them. */
export async function handleAdConfig(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "manage advertising");
  return ok(
    {
      disclosureLabels: DISCLOSURE_LABELS,
      defaultDisclosureLabel: DEFAULT_DISCLOSURE_LABEL,
      formats: ["image", "html"],
      advertiserKinds: ["retailer", "bookmaker", "transport", "bank", "telco", "NGO", "club_shop", "other"],
      statuses: {
        advertiser: ["pending", "approved", "suspended"],
        campaign: ["draft", "pending", "active", "paused", "completed", "archived"],
        advertisement: ["draft", "pending", "active", "paused", "expired", "archived"],
      },
      destinationRule: "https, with a host, no credentials, 2048 characters or fewer",
      destinationSafe: (url: unknown) => typeof url === "string" && isSafeDestination(url),
    },
    { requestId: ctx.requestId, headers: { "cache-control": "public, max-age=300" } },
  );
}

/** `GET /api/ads/placements` — the registry, with what each slot is carrying. */
export async function handleAdPlacements(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "manage advertising");
  const payload = await callOk<{ placements?: unknown }>(ctx, "kicklive_ad_placements");
  return ok({ placements: mapKeys(payload.placements ?? [], toCamel) }, { requestId: ctx.requestId, headers: { "cache-control": "no-store" } });
}

/** `POST /api/ads/placements/:code` — the per-slot switch. Admin only, as it is in SQL. */
export async function handleAdPlacementToggle(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "switch a slot on or off");
  const code = ctx.params.code ?? "";
  if (!PLACEMENT_CODE_PATTERN.test(code)) throw new ApiError("VALIDATION_FAILED", 400, "That is not a slot code.", { fields: [{ field: "code", message: "expected an upper-case slot code" }] });
  const fields = await readJsonBody(ctx.request, TOGGLE_KEYS);
  const parsed = new Fields(fields.raw, TOGGLE_KEYS);
  if (typeof parsed.raw.isActive !== "boolean") {
    throw new ApiError("VALIDATION_FAILED", 400, "`isActive` must be true or false.", { fields: [{ field: "isActive", message: "expected a boolean" }] });
  }
  const isActive = parsed.boolean("isActive", { default: false }) as boolean;
  const payload = await callOk<{ placement?: unknown }>(ctx, "kicklive_ad_set_placement", { p_code: code, p_is_active: isActive });
  return ok({ placement: mapKeys(payload.placement, toCamel) }, { requestId: ctx.requestId });
}

async function listRoute(ctx: HandlerContext, resource: "advertisers" | "campaigns" | "advertisements"): Promise<Response> {
  requireStaff(ctx, "manage advertising");
  const fields = readQuery(ctx.url, LIST_KEYS);
  const status = fields.string("status", { max: 24 });
  const q = fields.string("q", { max: 128 });
  const advertiserId = fields.uuid("advertiserId");
  const campaignId = fields.uuid("campaignId");
  const placement = fields.string("placement", { max: 32 });
  const limit = fields.integer("limit", { min: 1, max: 200, default: 50 });
  const offset = fields.integer("offset", { min: 0, max: 10000, default: 0 });
  fields.throwIfInvalid();
  const payload = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_admin_list", {
    p_resource: resource,
    p_q: q ?? null,
    p_status: status ?? null,
    p_advertiser_id: advertiserId ?? null,
    p_campaign_id: campaignId ?? null,
    p_placement_code: placement ?? null,
    p_limit: limit ?? 50,
    p_offset: offset ?? 0,
  });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "no-store" } });
}

export async function handleAdAdvertisers(ctx: HandlerContext): Promise<Response> {
  return listRoute(ctx, "advertisers");
}
export async function handleAdCampaigns(ctx: HandlerContext): Promise<Response> {
  return listRoute(ctx, "campaigns");
}
export async function handleAdvertisements(ctx: HandlerContext): Promise<Response> {
  return listRoute(ctx, "advertisements");
}

/**
 * The three saves are one handler each, and all three pass the whole body through as `p_data` — the database
 * owns which fields are legal in which state, including the `id` that makes it an update. `assertOnlyDeclared`
 * still applies, so a typo in a form field is a 400 naming the field instead of a silently ignored value.
 */
async function saveRoute(ctx: HandlerContext, fn: string, param: string): Promise<Response> {
  requireStaff(ctx, "manage advertising");
  const fields = await readJsonBody(ctx.request, SAVE_KEYS);
  fields.assertOnlyDeclared();
  const payload = await callOk<Record<string, unknown>>(ctx, fn, { [param]: mapKeys(fields.raw, toSnake) });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId });
}

export async function handleAdSaveAdvertiser(ctx: HandlerContext): Promise<Response> {
  return saveRoute(ctx, "kicklive_ad_save_advertiser", "p_data");
}
export async function handleAdSaveCampaign(ctx: HandlerContext): Promise<Response> {
  return saveRoute(ctx, "kicklive_ad_save_campaign", "p_data");
}
export async function handleAdSaveAdvertisement(ctx: HandlerContext): Promise<Response> {
  return saveRoute(ctx, "kicklive_ad_save_advertisement", "p_data");
}

async function statusRoute(ctx: HandlerContext, fn: string, idParam: string): Promise<Response> {
  const fields = await readJsonBody(ctx.request, STATUS_KEYS);
  const parsed = new Fields(fields.raw, STATUS_KEYS);
  const status = parsed.string("status", { required: true, max: 24 });
  const reason = parsed.string("reason", { max: 500 });
  parsed.throwIfInvalid();
  const id = ctx.params.id ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError("VALIDATION_FAILED", 400, "That id is not a record id.", { fields: [{ field: "id", message: "expected a uuid" }] });
  const payload = await callOk<Record<string, unknown>>(ctx, fn, {
    [idParam]: id,
    p_status: status,
    p_reason: reason ?? null,
  });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId });
}

export async function handleAdvertiserStatus(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "approve or suspend an advertiser");
  return statusRoute(ctx, "kicklive_ad_set_advertiser_status", "p_advertiser_id");
}
export async function handleCampaignStatus(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "change a flight's status");
  return statusRoute(ctx, "kicklive_ad_set_campaign_status", "p_campaign_id");
}
export async function handleAdvertisementStatus(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "change a creative's status");
  return statusRoute(ctx, "kicklive_ad_set_status", "p_advertisement_id");
}

/** `POST /api/ads/analytics` — the rollups, from the day table and not from the log. */
export async function handleAdAnalytics(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the advertising report");
  const fields = await readJsonBody(ctx.request, ANALYTICS_KEYS);
  const parsed = new Fields(fields.raw, ANALYTICS_KEYS);
  const from = parsed.string("from", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const to = parsed.string("to", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const advertiserId = parsed.uuid("advertiserId");
  const campaignId = parsed.uuid("campaignId");
  const placement = parsed.string("placement", { max: 32 });
  const groupBy = parsed.string("groupBy", { max: 16, default: "advertisement" });
  parsed.throwIfInvalid();
  const payload = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_analytics", {
    p_from: from ?? null,
    p_to: to ?? null,
    p_advertiser_id: advertiserId ?? null,
    p_campaign_id: campaignId ?? null,
    p_placement_code: placement ?? null,
    p_group_by: groupBy ?? "advertisement",
  });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "no-store" } });
}

/** `POST /api/ads/preview` — why an answer is what it is, from the same code that produced it. */
export async function handleAdPreview(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "preview advertising");
  const fields = await readJsonBody(ctx.request, EXPLAIN_KEYS);
  const parsed = new Fields(fields.raw, EXPLAIN_KEYS);
  const placements = parsed.raw.placements;
  parsed.throwIfInvalid();
  if (!Array.isArray(placements) || placements.length === 0 || placements.length > 8) {
    throw new ApiError("VALIDATION_FAILED", 400, "`placements` must name between one and eight slots.", { fields: [{ field: "placements", message: "1–8 slot codes" }] });
  }
  const out = [];
  for (const item of placements) {
    const placementCode = typeof item === "string" ? item : (item as { placementCode?: string })?.placementCode;
    const advertisementId = typeof item === "object" ? (item as { advertisementId?: string })?.advertisementId : undefined;
    if (!placementCode || !PLACEMENT_CODE_PATTERN.test(placementCode)) {
      throw new ApiError("VALIDATION_FAILED", 400, "Every entry needs a valid slot code.", { fields: [{ field: "placements", message: "unknown slot code" }] });
    }
    out.push(await callOk<Record<string, unknown>>(ctx, "kicklive_ad_explain", { p_advertisement_id: advertisementId ?? null, p_placement_code: placementCode }));
  }
  return ok({ results: out.map((r) => mapKeys(r, toCamel)) }, { requestId: ctx.requestId, headers: { "cache-control": "no-store" } });
}

/** `POST /api/ads/maintenance` — expire what has run out, and prune what retention says is old. */
export async function handleAdMaintenance(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "run advertising maintenance");
  const expired = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_expire_due");
  const swept = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_sweep");
  const diagnostics = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_diagnostics");
  return ok(
    {
      expired: mapKeys(expired, toCamel),
      swept: mapKeys(swept, toCamel),
      diagnostics: mapKeys(diagnostics, toCamel),
    },
    { requestId: ctx.requestId, headers: { "cache-control": "no-store" } },
  );
}

/** `GET /api/ads/diagnostics` — the health of the advertising plane, and nothing else. */
export async function handleAdDiagnostics(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the advertising diagnostics");
  const payload = await callOk<Record<string, unknown>>(ctx, "kicklive_ad_diagnostics");
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "no-store" } });
}
