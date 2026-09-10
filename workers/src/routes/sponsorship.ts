/**
 * The sponsorship routes (Phase 8).
 *
 * Rights, not delivery. Advertising answers "what should this slot show to this viewer right now"; this
 * answers "who is entitled to appear on this competition, season, team, match, award or event, in what order,
 * for how long". The two systems share a bucket, a cache layer and the word "sponsor", and no table: the
 * join between them is one nullable column (`sponsorships.advertisement_campaign_id`) that nothing here
 * writes.
 *
 * Three rules shape every handler in this file:
 *
 *   - **The decision is made in SQL.** Visibility, the status arcs, exclusivity, package windows and the
 *     size caps all live in `supabase/migrations/20260914120000_phase8_sponsorship.sql`. What a route owns is
 *     what SQL cannot see: the cache header, the ETag, the multipart body, the field errors, and the choice of
 *     which credential a call goes out on.
 *   - **Every call is made as the caller, including the staff ones.** This is the opposite of the advertising
 *     plane and it is not an accident: each sponsorship function decides the caller's role from the JWT
 *     (`is_admin()` reads `profiles where id = auth.uid()`), and a request sent on the service-role key has
 *     *no subject at all* — so the same call that looks like "the trusted backend" arrives as a stranger and
 *     is refused by its own check. The route therefore forwards the admin's own token, `supabaseAsUser` is the
 *     only staff client here, and the database gets to make the decision rather than take ours on faith.
 *     (Phase 7 calls staff writes on the admin client; see the note in `docs/SPONSORSHIP_ARCHITECTURE.md` §9.)
 *   - **A public response says how long it may be held.** The band's `max-age` comes from the database, and
 *     the ETag carries the config epoch, so a change at the desk is visible on the next request instead of
 *     after a TTL. Nothing here purges a CDN: an image at a versioned key never needs purging, and a band
 *     that is 120 seconds stale is a badge in the wrong place, not a billing error.
 */
import { ApiError, ok } from "../lib/response.ts";
import { Fields, readJsonBody, readQuery } from "../lib/validation.ts";
import { logError } from "../lib/debug.ts";
import { supabaseAnon, supabaseAsUser } from "../services/supabase.ts";
import { publishAsset, repositoryFor, type ReserveOutcome } from "../services/mediaStore.ts";
import { bucketFor } from "./media.ts";
import type { HandlerContext } from "./index.ts";

/** The keys each route accepts, and nothing else — `Fields.assertOnlyDeclared` refuses a typo instead of
 *  ignoring it, which matters most here because a silently dropped `packageId` reads as a saved record. */
const BAND_KEYS = ["kind", "ids", "limit"] as const;
const SPONSOR_KEYS = [
  "id",
  "slug",
  "displayName",
  "legalName",
  "description",
  "websiteUrl",
  "contactName",
  "contactEmail",
  "contactPhone",
  "contactConsentAt",
  "brandColour",
  "onDark",
  "defaultPriority",
  "valueAmount",
  "valueCurrency",
  "valueBasis",
  "invoiceReference",
  "renewalTerms",
  "internalNotes",
] as const;
const PACKAGE_KEYS = [
  "id",
  "code",
  "label",
  "description",
  "kind",
  "tier",
  "seasonLabel",
  "exclusivity",
  "entitlements",
  "allowedTargetKinds",
  "sortOrder",
  "isActive",
  "priceAmount",
  "priceCurrency",
  "priceBasis",
] as const;
const ASSIGNMENT_KEYS = [
  "id",
  "sponsorId",
  "packageId",
  "targetKind",
  "targetId",
  "startsAt",
  "endsAt",
  "priority",
  "displayOrder",
  "attribution",
  "namingOverride",
  "logoVariant",
  "backgroundColour",
  "linkUrl",
  "logoAssetId",
  "bannerAssetId",
  // No `isActive` here, and that is a refusal rather than an omission: the display switch is the status
  // route's (`kicklive_sponsorship_set_status`), which writes the transition row and the author. Declaring
  // it on the save would let a form send it, and the save would answer `ok: true` having changed nothing.
  "valueAmount",
  "valueCurrency",
  "valueBasis",
  "invoiceReference",
  "renewalTerms",
  "internalNotes",
] as const;
const STATUS_KEYS = ["status", "reason", "isActive"] as const;
const LIST_KEYS = ["q", "status", "targetKind", "targetId", "sponsorId", "includeExpired", "limit", "offset"] as const;
const PREVIEW_KEYS = ["targets"] as const;

const TARGET_KINDS = ["competition", "season", "match", "team", "award", "event"] as const;
const SLOTS = ["logo", "banner"] as const;

/** camelCase in the API, snake_case in the database — the same mapping the advertising plane uses, because a
 *  sponsor row's `display_name` and the form's `displayName` are one fact written two ways. */
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

function clientFor(ctx: HandlerContext) {
  // No `supabaseAdmin` branch, on purpose — see the file header. A staff route that cannot present a subject
  // refuses the request here rather than forwarding a call the database will read as anonymous.
  return ctx.principal.token ? supabaseAsUser(ctx.env, ctx.principal.token) : supabaseAnon(ctx.env);
}

/** Copy for the reasons a client may act on. The rule is the advertising plane's: name what the reader can
 *  change, because "sponsorship error" is not actionable and a form cannot render a stack trace. */
function refusalMessage(reason: string, field?: string): string {
  switch (reason) {
    case "ADMIN_ONLY":
      return "Sponsorship is managed by an administrator.";
    case "IDENTITY_REQUIRED":
      return "Sign in to change sponsorship.";
    case "STATUS_VIA_SET_STATUS_ONLY":
      return "Status is changed by the status action, which records who did it.";
    case "BRANDING_IS_UPLOADED_NOT_TYPED":
      return `${field === "bannerUrl" ? "The banner" : "The logo"} is uploaded, not pasted in — the address is derived from the stored file.`;
    case "SLUG_IMMUTABLE":
      return "A sponsor's short name cannot be changed once pages link to it. Archive this one and create a new record.";
    case "CODE_IMMUTABLE":
      return "A package code cannot be renamed while assignments point at it. Retire it and create a new package.";
    case "PACKAGE_CODE_TAKEN":
      return "Another package already uses that code.";
    case "KIND_NOT_IN_PACKAGE":
      return "That package is not sold against this kind of target.";
    case "TARGET_NOT_FOUND":
      return "The competition, season, team or match you named is not in the database.";
    case "EXCLUSIVITY_TAKEN":
      return "Another sponsor already holds the exclusive slot for that target and window.";
    case "PACKAGE_LIMIT_FOR_TARGET":
      return "That package allows fewer sponsorships on this target than this would be.";
    case "DUPLICATE_ASSIGNMENT_IN_WINDOW":
      return "This sponsor, package and window are already assigned.";
    case "TRANSITION_NOT_ALLOWED":
      return "That status change is not one the flow allows.";
    case "NOT_READY_TO_DISPLAY":
      return "It is not displayable yet — the sponsor must be approved, the package active, and the window open.";
    case "ASSET_FOR_OTHER_ENTITY":
      return "That file was uploaded for a different sponsor.";
    case "UNSUPPORTED_TYPE":
      return "Sponsor artwork has to be a PNG, JPEG, WebP or GIF.";
    case "TOO_LARGE":
      return "That file is larger than this slot allows.";
    case "QUOTA_EXCEEDED":
      return "Today's storage allowance is used up.";
    case "UNKNOWN_TARGET_KIND":
      return "Sponsorships attach to a competition, season, match, team, award or event.";
    case "TARGET_IDS_REQUIRED":
      return "Name at least one target to look up.";
    case "BODY_MUST_BE_OBJECT":
      return "The request body must be a JSON object.";
    case "HTTPS_URL_WITH_HOST_REQUIRED":
      return "The link must be a full https address.";
    case "UNKNOWN_FIELD":
      return "That field is not one sponsorship stores.";
    default:
      return "The sponsorship request could not be completed.";
  }
}

/** The one place a `{ok:false, code, field, reason}` envelope becomes an HTTP error. `detail` carries the
 *  reason code verbatim, because a support conversation starts from it rather than from the prose. */
function refuse(payload: unknown): never {
  const p = (payload ?? {}) as { code?: string; field?: string; reason?: string; detail?: string; allowed?: unknown };
  const code = p.code ?? "VALIDATION_FAILED";
  const status = code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "RATE_LIMITED" ? 429 : 400;
  throw new ApiError(status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "VALIDATION_FAILED", status, refusalMessage(p.reason ?? "", p.field), {
    detail: [code, p.field, p.reason].filter(Boolean).join(" "),
    ...(p.field ? { fields: [{ field: p.field, message: refusalMessage(p.reason ?? "", p.field) }] } : {}),
    // The status refusals answer with what *is* allowed from here. It comes back as a value rather than
    // being folded into prose because the admin form renders the buttons from it, and a form that guessed
    // the flow from its own copy is how a UI ends up offering an action the database will refuse.
    ...(p.allowed !== undefined ? { allowed: p.allowed } : {}),
  });
}

async function call<T = Record<string, unknown>>(ctx: HandlerContext, fn: string, params: Record<string, unknown> = {}): Promise<T> {
  let data: unknown;
  try {
    data = await clientFor(ctx).call(fn, params);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // `call` already turns a non-2xx PostgREST answer into an ApiError. Anything else is a raised exception
    // in SQL — a defect, not a decision — so it is logged and answered 502 rather than dressed up as a
    // refusal the database never made.
    logError(`sponsorship-${fn}`, err);
    throw new ApiError("DEPENDENCY_FAILED", 502, "The sponsorship service could not be reached.");
  }
  const payload = data as T & { ok?: boolean };
  if (payload && payload.ok === false) refuse(payload);
  return payload;
}

function requireAdmin(ctx: HandlerContext, what: string): void {
  if (!ctx.principal.token) {
    throw new ApiError("UNAUTHENTICATED", 401, "Sign in to change sponsorship.", { detail: "the sponsorship functions decide the caller from the token" });
  }
  if (ctx.principal.role !== "admin") {
    throw new ApiError("FORBIDDEN", 403, `Only an administrator may ${what}.`);
  }
}
function requireStaff(ctx: HandlerContext, what: string): void {
  if (!ctx.principal.token) {
    throw new ApiError("UNAUTHENTICATED", 401, "Sign in to view sponsorship administration.");
  }
  if (ctx.principal.role !== "admin" && ctx.principal.role !== "media") {
    throw new ApiError("FORBIDDEN", 403, `Only staff may ${what}.`);
  }
}

/** A quoted SQL literal for the flow-style call helpers in this file. Nothing is concatenated into a query
 *  here — the Worker only ever sends JSON to PostgREST — so the parameters below are named, not embedded. */
function targetIds(raw: string | undefined, kind: string): string[] {
  if (!raw) {
    throw new ApiError("VALIDATION_FAILED", 400, "Name at least one target to look up.", { fields: [{ field: "ids", message: "is required" }] });
  }
  const ids = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // The database caps this at 50 and the page never needs more than a handful; the smaller bound here is the
  // one that protects a browser from itself, and an over-long list is a bug in the caller rather than a
  // request to be served.
  if (ids.length === 0 || ids.length > 8) {
    throw new ApiError("VALIDATION_FAILED", 400, `Pass between one and eight ${kind} ids.`, { fields: [{ field: "ids", message: "1–8, comma separated" }] });
  }
  for (const id of ids) {
    if (!/^[0-9a-fA-F-]{1,64}$/.test(id)) {
      throw new ApiError("VALIDATION_FAILED", 400, "Every target id must be a numeric id or a uuid.", { fields: [{ field: "ids", message: "unknown character in id list" }] });
    }
  }
  return ids;
}

// ── the public plane ────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/sponsorship?kind=match&ids=42&limit=6` — the active band for one or more targets.
 *
 * The handler decides nothing about visibility; `kicklive_sponsorship_for` does, and its projection is why
 * this response can be public at all: contact details and money columns are not in its select list, so they
 * are unreachable rather than filtered. Two things are genuinely this route's business: the cache header,
 * taken from the database's own `maxAgeSeconds` so the two cannot disagree, and an ETag carrying the config
 * epoch, which turns "the desk just changed it" into a 304 rather than a wrong badge for two minutes.
 */
export async function handleSponsorshipBand(ctx: HandlerContext): Promise<Response> {
  const fields = readQuery(ctx.url, BAND_KEYS);
  const kind = fields.enumValue("kind", TARGET_KINDS as unknown as readonly string[], { required: true, label: TARGET_KINDS.join(", ") }) as (typeof TARGET_KINDS)[number] | undefined;
  const idsRaw = fields.string("ids");
  const limit = fields.integer("limit", { min: 1, max: 24, default: 12 });
  fields.throwIfInvalid();
  if (!kind) throw new ApiError("VALIDATION_FAILED", 400, "`kind` must be one of " + TARGET_KINDS.join(", ") + ".");
  const ids = targetIds(idsRaw, kind);

  const payload = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_for", {
    p_target_kind: kind,
    p_target_ids: ids,
    p_limit: limit ?? 12,
  });
  const maxAge = Number(payload.maxAgeSeconds ?? 120);
  const epoch = String(payload.epoch ?? "0");
  const etag = `W/"${epoch}-${kind}-${ids.join(".")}"`;
  if (ctx.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": `public, max-age=${String(maxAge)}` } });
  }
  return ok(mapKeys(payload, toCamel), {
    requestId: ctx.requestId,
    headers: {
      // The band is the same for every viewer — targeting here is by target, not by person — so it is
      // cacheable at the edge, and `s-maxage` is what makes that worth doing. `stale-while-revalidate` covers
      // a match kicking off while the desk is mid-edit.
      "cache-control": `public, max-age=${String(Math.min(maxAge, 60))}, s-maxage=${String(maxAge)}, stale-while-revalidate=300`,
      vary: "Accept-Encoding",
      etag,
      "x-sponsorship-epoch": epoch,
    },
  });
}

/** `GET /api/sponsorship/packages` — the published rate card. Prices are not in the function's select list. */
export async function handleSponsorshipPackages(ctx: HandlerContext): Promise<Response> {
  const payload = await call<Record<string, unknown>>(ctx, "kicklive_sponsor_package_card", {});
  const epoch = String(payload.epoch ?? "0");
  const etag = `W/"card-${epoch}"`;
  if (ctx.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "public, max-age=300" } });
  }
  return ok(mapKeys(payload, toCamel), {
    requestId: ctx.requestId,
    headers: { "cache-control": "public, max-age=120, s-maxage=300, stale-while-revalidate=3600", etag },
  });
}

// ── the desk ─────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/sponsorship/admin/sponsors` — the list with the contact block, for the desk that has to phone it. */
export async function handleSponsorshipAdminSponsors(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the sponsor list");
  return listRoute(ctx, "sponsors");
}
/** `GET /api/sponsorship/admin/packages` */
export async function handleSponsorshipAdminPackages(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the package list");
  return listRoute(ctx, "packages");
}
/** `GET /api/sponsorship/admin/assignments` */
export async function handleSponsorshipAdminAssignments(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the sponsorship list");
  return listRoute(ctx, "sponsorships");
}

async function listRoute(ctx: HandlerContext, resource: string): Promise<Response> {
  const fields = readQuery(ctx.url, LIST_KEYS);
  const q = fields.string("q", { max: 120 });
  const status = fields.string("status", { max: 16 });
  const targetKind = fields.string("targetKind", { max: 16 });
  const targetId = fields.string("targetId", { max: 64 });
  const sponsorId = fields.uuid("sponsorId");
  const includeExpired = fields.boolean("includeExpired", { default: false });
  const limit = fields.integer("limit", { min: 1, max: 200, default: 50 });
  const offset = fields.integer("offset", { min: 0, default: 0 });
  fields.throwIfInvalid();
  const payload = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_admin_list", {
    p_resource: resource,
    p_q: q ?? null,
    p_status: status ?? null,
    p_target_kind: targetKind ?? null,
    p_target_id: targetId ?? null,
    p_sponsor_id: sponsorId ?? null,
    p_include_expired: includeExpired ?? false,
    p_limit: limit ?? 50,
    p_offset: offset ?? 0,
  });
  // `private, no-store`: this is the response that contains a sponsor's email address and the value of their
  // agreement. `no-store` is not a performance decision here — nobody lists sponsors 200 times a minute — it
  // is the reason a shared browser in an office can still show the page afterwards.
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/** The three saves are one shape: a JSON body whose keys are the function's own accepted set, mapped to
 *  snake_case and handed over. No defaults are filled in here — a value the route invented is a value nobody
 *  approved, and the functions already know what a new row starts as. */
async function saveRoute(ctx: HandlerContext, fn: string, keys: readonly string[], guard: (fields: Fields) => void = () => {}): Promise<Response> {
  const body = await readJsonBody(ctx.request, keys as unknown as readonly string[]);
  const fields = new Fields(body.raw, keys as unknown as readonly string[]);
  fields.assertOnlyDeclared();
  guard(fields);
  fields.throwIfInvalid();
  const payload = await call<Record<string, unknown>>(ctx, fn, { p_data: mapKeys(body.raw, toSnake) });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

export async function handleSponsorshipSaveSponsor(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "create or edit a sponsor");
  return saveRoute(ctx, "kicklive_sponsor_save", SPONSOR_KEYS, (fields) => {
    fields.string("displayName", { max: 160 });
    fields.string("websiteUrl", { max: 2000 });
    fields.string("brandColour", { max: 9 });
    fields.integer("defaultPriority", { min: 1, max: 9999 });
    // A uuid is checked as a uuid so the error names the field instead of arriving as `invalid input syntax
    // for type uuid`, which is a 500 the client can do nothing with.
    fields.uuid("id");
  });
}

export async function handleSponsorshipSavePackage(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "create or edit a sponsorship package");
  return saveRoute(ctx, "kicklive_sponsor_package_save", PACKAGE_KEYS, (fields) => {
    fields.string("code", { max: 32, pattern: /^[a-z0-9][a-z0-9_-]{1,31}$/, patternMessage: "is used in links and cache keys: lower-case letters, digits, - and _" });
    fields.string("label", { max: 120 });
    fields.integer("tier", { min: 1, max: 9 });
    fields.integer("sortOrder", { min: 0, max: 10000 });
    fields.boolean("isActive");
    fields.uuid("id");
  });
}

export async function handleSponsorshipSaveAssignment(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "assign a sponsorship");
  return saveRoute(ctx, "kicklive_sponsorship_save", ASSIGNMENT_KEYS, (fields) => {
    fields.string("targetKind", { max: 16 });
    fields.string("targetId", { max: 64, pattern: /^[0-9a-fA-F-]{1,64}$/, patternMessage: "must be a numeric id or a uuid" });
    fields.string("startsAt", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "must be a calendar date, YYYY-MM-DD" });
    fields.string("endsAt", { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/, patternMessage: "must be a calendar date, YYYY-MM-DD" });
    fields.integer("priority", { min: 1, max: 9999 });
    fields.integer("displayOrder", { min: 0, max: 9999 });
    fields.uuid("sponsorId");
    fields.uuid("packageId");
    fields.uuid("id");
  });
}

/**
 * `POST /api/sponsorship/admin/sponsors/:id/status` and `…/assignments/:id/status` — the two status doors.
 *
 * They are separate from the saves for one reason: a status change is an act with an author. `approved_by`
 * and `activated_at` are stamped from `auth.uid()` inside SQL, which is only possible because the route
 * forwarded a real subject.
 */
export async function handleSponsorshipSponsorStatus(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "change a sponsor's status");
  return statusRoute(ctx, "kicklive_sponsor_set_status", "p_id", false);
}
export async function handleSponsorshipAssignmentStatus(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "change a sponsorship's status");
  // The display switch rides on the same door (`isActive`), because "hide it this fortnight" and "this is
  // over" are the one place an operator stands; the function keeps them as two columns.
  return statusRoute(ctx, "kicklive_sponsorship_set_status", "p_id", true);
}

async function statusRoute(ctx: HandlerContext, fn: string, idParam: string, withActive: boolean): Promise<Response> {
  const body = await readJsonBody(ctx.request, STATUS_KEYS);
  const fields = new Fields(body.raw, STATUS_KEYS);
  fields.assertOnlyDeclared();
  const status = fields.string("status", { required: true, max: 16 });
  const reason = fields.prose("reason", { max: 500 });
  const isActive = withActive ? fields.boolean("isActive") : undefined;
  fields.throwIfInvalid();
  if (!status) throw new ApiError("VALIDATION_FAILED", 400, "A status change must name the status.", { fields: [{ field: "status", message: "is required" }] });
  const id = ctx.params.id;
  if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new ApiError("VALIDATION_FAILED", 400, "That record id is not valid.", { fields: [{ field: "id", message: "expected a uuid" }] });
  }
  const payload = await call<Record<string, unknown>>(ctx, fn, {
    [idParam]: id,
    p_status: status,
    p_reason: reason ?? null,
    ...(withActive ? { p_is_active: isActive ?? null } : {}),
  });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/**
 * `POST /api/sponsorship/admin/sponsors/:id/branding` — a logo or a banner, into the sponsor's own prefix.
 *
 * This is Phase 6's pipeline with one step replaced: the reservation is `kicklive_sponsor_reserve_asset`,
 * which knows the slot vocabulary and whose sponsor is allowed to be written. The attachment is a second,
 * explicit call, because attaching is the moment the bytes are known to exist — a write that fails between R2
 * and the entity column must leave the sponsor showing what it showed before, which is exactly what a
 * separately-issued attach gives us. The URL is never accepted from the browser.
 */
export async function handleSponsorshipBrandingUpload(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "upload sponsor branding");
  const sponsorId = ctx.params.id;
  if (!sponsorId || !/^[0-9a-fA-F-]{36}$/.test(sponsorId)) {
    throw new ApiError("VALIDATION_FAILED", 400, "That sponsor id is not valid.", { fields: [{ field: "id", message: "expected a uuid" }] });
  }
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new ApiError("BAD_REQUEST", 400, "Expected a multipart/form-data upload with a `file` field.");
  }
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch (cause) {
    throw new ApiError("BAD_REQUEST", 400, "The upload body could not be parsed as multipart form data.", {
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const scalars: Record<string, unknown> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") {
      if (key !== "file") {
        throw new ApiError("VALIDATION_FAILED", 400, "Only a `file` part may carry binary content.", { fields: [{ field: key, message: "expected a text field" }] });
      }
      file = value as File;
      continue;
    }
    scalars[key] = value;
  }
  const fields = new Fields(scalars, ["slot", "alt"]);
  fields.assertOnlyDeclared();
  const slot = fields.enumValue("slot", SLOTS as unknown as readonly string[], { required: true, label: SLOTS.join(" or ") });
  const alt = fields.prose("alt", { max: 300 });
  fields.throwIfInvalid();
  if (!slot) throw new ApiError("VALIDATION_FAILED", 400, "A sponsor upload must name its slot.", { fields: [{ field: "slot", message: "logo or banner" }] });
  if (!file) throw new ApiError("VALIDATION_FAILED", 400, "No `file` part was found in the upload.", { fields: [{ field: "file", message: "is required" }] });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const db = clientFor(ctx);
  const result = await publishAsset(
    { kind: "sponsors", entityId: sponsorId, variant: slot, alt: alt ?? null, bytes },
    {
      bucket: bucketFor(ctx),
      // The only difference from a club crest: who may reserve, and where the key goes. Everything after the
      // reservation — the write, the head, the size check, the publish — is the shared pipeline, unchanged.
      repo: repositoryFor(ctx.env, ctx.principal.token, async (input, rpc) =>
        rpc<SponsorReserveReply>("kicklive_sponsor_reserve_asset", {
          p_sponsor_id: input.entityId,
          p_slot: input.variant,
          p_content_type: input.contentType,
          p_byte_size: input.byteSize,
          p_sha256: input.sha256,
          p_width: input.width,
          p_height: input.height,
          p_alt_text: input.alt,
        }).then(toReserveOutcome),
      ),
    },
  );
  if (result.outcome === "refused") {
    throw new ApiError(result.code, result.status, refusalMessage(result.reason, "file"), {
      detail: result.reason,
      fields: [{ field: "file", message: result.reason }],
    });
  }

  const attached = await call<Record<string, unknown>>(ctx, "kicklive_sponsor_attach_asset", {
    p_sponsor_id: sponsorId,
    p_asset_id: result.assetId,
    p_slot: slot,
  });
  return ok(
    {
      assetId: result.assetId,
      slot,
      url: result.url,
      objectKey: result.objectKey,
      version: result.version,
      bytes: result.bytes,
      contentType: result.contentType,
      width: result.width,
      height: result.height,
      reused: result.outcome === "existing",
      sponsor: mapKeys(attached.sponsor ?? {}, toCamel),
    },
    { status: 201, requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } },
  );
}

/** `kicklive_sponsor_reserve_asset` answers the sponsor envelope, and `publishAsset` speaks
 *  `ReserveOutcome`. The mapping is here rather than in mediaStore so the shared pipeline keeps one
 *  vocabulary and each entity plane translates its own refusal codes into it once. */
interface SponsorReserveReply {
  ok?: boolean;
  existing?: boolean;
  assetId?: number | string;
  objectKey?: string;
  version?: number;
  url?: string;
  reason?: string;
  code?: string;
}
function toReserveOutcome(r: SponsorReserveReply): ReserveOutcome {
  if (!r || r.ok !== true) {
    return { status: "rejected", reason: String(r?.reason ?? r?.code ?? "REFUSED") };
  }
  return {
    status: r.existing ? "skip_upload" : "proceed",
    asset: {
      id: Number(r.assetId),
      object_key: String(r.objectKey),
      version: Number(r.version ?? 1),
      visibility: "public",
      status: r.existing ? "ready" : "uploading",
    },
  };
}

/**
 * `POST /api/sponsorship/admin/preview` — what these targets would show, and why anything is missing.
 *
 * The preview runs `kicklive_sponsorship_explain`, which is the same eligibility code the public read runs.
 * That is the whole point: a preview that agreed with the form instead of with production would be a lie
 * people make decisions on.
 */
export async function handleSponsorshipPreview(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "preview sponsorship");
  const body = await readJsonBody(ctx.request, PREVIEW_KEYS);
  const fields = new Fields(body.raw, PREVIEW_KEYS);
  fields.assertOnlyDeclared();
  fields.throwIfInvalid();
  const targets = (body.raw as Record<string, unknown>).targets;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 8) {
    throw new ApiError("VALIDATION_FAILED", 400, "`targets` must name between one and eight targets.", { fields: [{ field: "targets", message: "1–8 entries of {kind, id}" }] });
  }
  const rows: unknown[] = [];
  for (const item of targets) {
    const t = (item ?? {}) as { kind?: string; id?: string };
    if (!t.kind || !TARGET_KINDS.includes(t.kind as (typeof TARGET_KINDS)[number]) || !t.id || !/^[0-9a-fA-F-]{1,64}$/.test(String(t.id))) {
      throw new ApiError("VALIDATION_FAILED", 400, "Every target needs a known kind and a numeric id or uuid.", { fields: [{ field: "targets", message: "unknown kind or malformed id" }] });
    }
    rows.push(await call(ctx, "kicklive_sponsorship_explain", { p_target_kind: t.kind, p_target_id: String(t.id) }));
  }
  return ok({ results: rows.map((r) => mapKeys(r, toCamel)) }, { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/** `GET /api/sponsorship/admin/transitions?kind=sponsor` — the status machine, as stored. */
export async function handleSponsorshipTransitions(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the sponsorship status flow");
  const fields = readQuery(ctx.url, ["kind"]);
  const kind = fields.string("kind", { max: 16, default: "sponsorship" });
  fields.throwIfInvalid();
  const payload = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_status_transitions", { p_kind: kind ?? "sponsorship" });
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/** `GET /api/sponsorship/admin/diagnostics` — counts of the states that must not exist. */
export async function handleSponsorshipDiagnostics(ctx: HandlerContext): Promise<Response> {
  requireStaff(ctx, "read the sponsorship diagnostics");
  const payload = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_diagnostics", {});
  return ok(mapKeys(payload, toCamel), { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}

/**
 * `POST /api/sponsorship/admin/maintenance` — end what has run out, now.
 *
 * There is no cron for this on purpose: a sponsorship that ended yesterday is a badge on a page, not money,
 * and the epoch bump that comes with the expiry is what makes the fix visible. If a scheduled sweep is added
 * later it must call the same function with no subject — `kicklive_sponsorship_expire_due` accepts a call
 * from `service_role` precisely so a timer can run it without pretending to be a person.
 */
export async function handleSponsorshipMaintenance(ctx: HandlerContext): Promise<Response> {
  requireAdmin(ctx, "run sponsorship maintenance");
  const body = await readJsonBody(ctx.request, ["limit"]);
  const limit = new Fields(body.raw, ["limit"]).integer("limit", { min: 1, max: 2000, default: 500 });
  const ended = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_expire_due", { p_limit: limit ?? 500 });
  const diagnostics = await call<Record<string, unknown>>(ctx, "kicklive_sponsorship_diagnostics", {});
  return ok({ ended: mapKeys(ended, toCamel), diagnostics: mapKeys(diagnostics, toCamel) }, { requestId: ctx.requestId, headers: { "cache-control": "private, no-store" } });
}
