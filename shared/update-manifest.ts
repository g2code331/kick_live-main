/**
 * KickLive update contract — the single definition shared by the desktop shell, the PWA and CI.
 *
 * Everything about "is there an update?" is derived here so that the shipped behaviour and the
 * contract tests cannot drift:
 *
 *  - strict manifest schema (`validateUpdateManifest`) — unknown keys are errors, so a typo in a
 *    published manifest fails loudly instead of resolving to "no update";
 *  - semver comparison with a hard never-downgrade rule;
 *  - checksum gate that must pass before an artifact is handed to the system installer;
 *  - offline => `unknown(lastSeenAt)` (we never claim "up to date" from a stale answer);
 *  - snooze persisted per candidate version, ignored for mandatory updates;
 *  - at most one automatic prompt per app open.
 */

import { compare, isValid } from "./semver.ts";

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_PRODUCT = "kicklive" as const;

export const CHANNELS = ["stable", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PLATFORM_IDS = ["linux_x64", "linux_arm64", "darwin_arm64", "win32_x64"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const SURFACES = ["desktop", "pwa"] as const;
export type Surface = (typeof SURFACES)[number];

export const ARTIFACT_KINDS = ["deb", "appimage", "tar.gz", "zip", "dmg", "nsis"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type PlatformArtifact = {
  kind: ArtifactKind;
  fileName: string;
  url: string;
  /** lowercase hex sha256 of the published artifact */
  sha256: string;
  size: number;
  /** optional floor for glibc, so an old distro does not try to install a too-new build */
  minGlibc?: string;
};

export type WebBundle = {
  version: string;
  swUrl: string;
  precache?: string[];
};

export type UpdateManifest = {
  schemaVersion: 1;
  product: "kicklive";
  channel: Channel;
  version: string;
  releasedAt: string;
  notes?: string;
  notesUrl?: string;
  /** clients older than this MUST update (snooze is ignored) */
  mandatoryBelow?: string;
  /** clients below this are unsupported: the update becomes mandatory by policy */
  minSupportedVersion?: string;
  platforms: Partial<Record<PlatformId, PlatformArtifact>>;
  web?: WebBundle;
};

export type ValidationError = { path: string; code: string; message: string };
export type ValidationResult<T> = { ok: true; value: T; errors: [] } | { ok: false; value?: T; errors: ValidationError[] };

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type Opts = {
  /** tests + the local dev feed serve over http; production must stay https */
  allowInsecureUrls?: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkUrl(value: unknown, path: string, errors: ValidationError[], o: Opts): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push({ path, code: "type", message: "must be a non-empty string" });
    return;
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    errors.push({ path, code: "format.url", message: "must be an absolute URL" });
    return;
  }
  const secure = u.protocol === "https:";
  if (!secure && !(o.allowInsecureUrls && u.protocol === "http:")) {
    errors.push({
      path,
      code: "format.url-scheme",
      message: `protocol must be https: (got ${u.protocol})`,
    });
  }
}

/**
 * Extension keys are explicitly allowed: the release tooling attaches provenance fields
 * (`xGitHubRun`, `x-signed-by`) that must NOT invalidate the feed on clients built against an
 * older schema. Anything else unknown is still reported, so a typo never goes unnoticed.
 */
function isExtensionKey(key: string): boolean {
  return /^x[-A-Z0-9][A-Za-z0-9-]*$/.test(key) && !allowedIsSuspicious(key);
}

/** `x` alone, or `xx-`, would be too clever to allow. */
function allowedIsSuspicious(key: string): boolean {
  return key === "x" || /^xx/i.test(key);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationError[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key) && !isExtensionKey(key)) {
      errors.push({ path: path ? `${path}.${key}` : key, code: "unknown-field", message: "not part of the manifest schema" });
    }
  }
}

export function validateUpdateManifest(input: unknown, opts: Opts = {}): ValidationResult<UpdateManifest> {
  const errors: ValidationError[] = [];
  const o: Opts = { allowInsecureUrls: opts.allowInsecureUrls === true };
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", code: "type", message: "manifest must be a JSON object" }] };
  }

  unknownKeys(input, ["schemaVersion", "product", "channel", "version", "releasedAt", "notes", "notesUrl", "mandatoryBelow", "minSupportedVersion", "platforms", "web"], "", errors);

  if (input.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      code: "schemaVersion",
      message: `expected ${MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(input.schemaVersion)}`,
    });
  }
  if (input.product !== MANIFEST_PRODUCT) {
    errors.push({ path: "product", code: "product", message: `expected "${MANIFEST_PRODUCT}" (refusing to update from a foreign feed)` });
  }
  if (typeof input.channel !== "string" || !(CHANNELS as readonly string[]).includes(input.channel)) {
    errors.push({ path: "channel", code: "enum", message: `must be one of ${CHANNELS.join(", ")}` });
  }
  if (typeof input.version !== "string" || !isValid(input.version)) {
    errors.push({ path: "version", code: "semver", message: "must be a valid semver version" });
  }
  if (typeof input.releasedAt !== "string" || !ISO_DATE.test(input.releasedAt) || Number.isNaN(Date.parse(input.releasedAt))) {
    errors.push({ path: "releasedAt", code: "format.date", message: "must be an ISO-8601 date-time with timezone" });
  }
  if (typeof input.mandatoryBelow !== "undefined") {
    if (typeof input.mandatoryBelow !== "string" || !isValid(input.mandatoryBelow)) {
      errors.push({ path: "mandatoryBelow", code: "semver", message: "must be a valid semver version" });
    } else if (typeof input.version === "string" && isValid(input.version) && compare(input.mandatoryBelow, input.version) > 0) {
      errors.push({
        path: "mandatoryBelow",
        code: "range",
        message: "must not be newer than version (nothing could ever satisfy it)",
      });
    }
  }
  if (typeof input.minSupportedVersion !== "undefined") {
    if (typeof input.minSupportedVersion !== "string" || !isValid(input.minSupportedVersion)) {
      errors.push({ path: "minSupportedVersion", code: "semver", message: "must be a valid semver version" });
    } else if (typeof input.version === "string" && isValid(input.version) && compare(input.minSupportedVersion, input.version) > 0) {
      errors.push({
        path: "minSupportedVersion",
        code: "range",
        message: "must not be newer than version (the release would mark itself unsupported)",
      });
    }
  }
  if (typeof input.notes !== "undefined") {
    if (typeof input.notes !== "string" || input.notes.length === 0 || input.notes.length > 4000) {
      errors.push({ path: "notes", code: "length", message: "must be a 1..4000 character string" });
    }
  }
  if (typeof input.notesUrl !== "undefined") checkUrl(input.notesUrl, "notesUrl", errors, o);

  if (!isRecord(input.platforms)) {
    errors.push({ path: "platforms", code: "type", message: "must be an object" });
  } else {
    const keys = Object.keys(input.platforms);
    if (keys.length === 0) {
      errors.push({ path: "platforms", code: "minItems", message: "at least one platform is required" });
    }
    for (const key of keys) {
      const path = `platforms.${key}`;
      if (!(PLATFORM_IDS as readonly string[]).includes(key)) {
        errors.push({ path, code: "enum", message: `unknown platform id (expected one of ${PLATFORM_IDS.join(", ")})` });
        continue;
      }
      const a = input.platforms[key];
      if (!isRecord(a)) {
        errors.push({ path, code: "type", message: "artifact must be an object" });
        continue;
      }
      unknownKeys(a, ["kind", "fileName", "url", "sha256", "size", "minGlibc"], path, errors);
      if (typeof a.kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(a.kind)) {
        errors.push({ path: `${path}.kind`, code: "enum", message: `must be one of ${ARTIFACT_KINDS.join(", ")}` });
      }
      if (typeof a.fileName !== "string" || !SAFE_FILE.test(a.fileName) || a.fileName.includes("..")) {
        errors.push({ path: `${path}.fileName`, code: "pattern", message: "must be a single safe path segment" });
      }
      checkUrl(a.url, `${path}.url`, errors, o);
      if (typeof a.url === "string" && typeof a.fileName === "string" && SAFE_FILE.test(a.fileName)) {
        let base = "";
        try {
          base = new URL(a.url).pathname.split("/").pop() ?? "";
        } catch {
          base = "";
        }
        if (base && base !== a.fileName) {
          errors.push({ path: `${path}.fileName`, code: "consistency", message: `fileName "${a.fileName}" != basename(url) "${base}"` });
        }
      }
      if (typeof a.sha256 !== "string" || !SHA256.test(a.sha256)) {
        errors.push({ path: `${path}.sha256`, code: "pattern", message: "must be 64 lowercase hex characters" });
      }
      if (!Number.isSafeInteger(a.size) || (typeof a.size === "number" && a.size <= 0)) {
        errors.push({ path: `${path}.size`, code: "type", message: "must be a positive safe integer" });
      }
      if (typeof a.minGlibc !== "undefined") {
        if (typeof a.minGlibc !== "string" || !/^\d+\.\d+$/.test(a.minGlibc)) {
          errors.push({ path: `${path}.minGlibc`, code: "pattern", message: "must look like 2.28" });
        }
      }
    }
  }

  if (typeof input.web !== "undefined") {
    if (!isRecord(input.web)) {
      errors.push({ path: "web", code: "type", message: "must be an object" });
    } else {
      unknownKeys(input.web, ["version", "swUrl", "precache"], "web", errors);
      if (typeof input.web.version !== "string" || !isValid(input.web.version)) {
        errors.push({ path: "web.version", code: "semver", message: "must be a valid semver version" });
      }
      if (typeof input.web.swUrl !== "string" || !input.web.swUrl.startsWith("/")) {
        errors.push({ path: "web.swUrl", code: "pattern", message: "must be a same-origin absolute path" });
      }
      if (typeof input.web.precache !== "undefined" && !Array.isArray(input.web.precache)) {
        errors.push({ path: "web.precache", code: "type", message: "must be an array of paths" });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as UpdateManifest, errors: [] };
}

export function parseUpdateManifest(text: string, opts: Opts = {}): ValidationResult<UpdateManifest> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: "", code: "json", message: (e as Error).message }] };
  }
  return validateUpdateManifest(json, opts);
}

/* ------------------------------------------------------------------ *
 * Decision reducer
 * ------------------------------------------------------------------ */

export const UPDATE_STATES = ["up-to-date", "available", "unknown", "error"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_REASONS = [
  "current-is-newest",
  "never-downgrade",
  "update-available",
  "platform-missing",
  "channel-mismatch",
  "manifest-unreachable",
  "manifest-invalid",
  "checksum-mismatch",
  "size-mismatch",
  "snoozed",
  "already-prompted",
  "no-web-bundle",
  "ok",
] as const;
export type UpdateReason = (typeof UPDATE_REASONS)[number];

export type CheckOutcome = { ok: true; manifest: UpdateManifest } | { ok: false; kind: "unreachable" | "invalid"; detail: string; errors?: ValidationError[] };

export type LastSeen = { version: string; at: string } | null;

export type CheckInput = {
  surface: Surface;
  currentVersion: string;
  channel: Channel;
  platformId?: PlatformId;
  outcome: CheckOutcome;
  /** version -> ISO expiry, persisted by the client */
  snoozedUntil?: Record<string, string>;
  lastSeen?: LastSeen;
  now?: Date | string;
  alreadyPromptedThisSession?: boolean;
};

export type UpdateDecision = {
  state: UpdateState;
  reason: UpdateReason;
  detail?: string;
  candidateVersion?: string;
  artifact?: PlatformArtifact;
  /** true when the UI may show a prompt this run */
  prompt: boolean;
  mandatory: boolean;
  /** for the PWA surface: activation is "reload", not "install" */
  action?: "install" | "reload";
  /** passthrough from the manifest, so the UI can offer a link without re-reading it */
  notesUrl?: string;
  notes?: string;
  errors?: ValidationError[];
  lastSeenVersion?: string;
  lastSeenAt?: string;
  checkedAt: string;
};

function nowIso(now?: Date | string): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string") return new Date(now).toISOString();
  return new Date().toISOString();
}

/**
 * Two ways a release becomes mandatory: an explicit `mandatoryBelow` line, or dropping below
 * `minSupportedVersion` — a client older than the floor is not supported against the API, so the
 * update prompt cannot be snoozed away.
 */
function isMandatory(manifest: UpdateManifest, currentVersion: string): boolean {
  try {
    if (manifest.mandatoryBelow && compare(currentVersion, manifest.mandatoryBelow) < 0) return true;
    if (manifest.minSupportedVersion && compare(currentVersion, manifest.minSupportedVersion) < 0) return true;
  } catch {
    return false;
  }
  return false;
}

function snoozedFor(input: CheckInput, candidate: string, nowMs: number): { snoozed: boolean; until?: string } {
  if (input.surface === "pwa") return { snoozed: false };
  const table = input.snoozedUntil ?? {};
  const until = table[candidate];
  if (typeof until !== "string") return { snoozed: false };
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return { snoozed: false };
  return ms > nowMs ? { snoozed: true, until } : { snoozed: false };
}

export function decideUpdate(input: CheckInput): UpdateDecision {
  const checkedAt = nowIso(input.now);
  const nowMs = Date.parse(checkedAt);
  const base: UpdateDecision = {
    state: "unknown",
    reason: "manifest-unreachable",
    prompt: false,
    mandatory: false,
    checkedAt,
    lastSeenVersion: input.lastSeen?.version,
    lastSeenAt: input.lastSeen?.at,
  };

  if (!input.outcome.ok) {
    if (input.outcome.kind === "invalid") {
      return {
        ...base,
        state: "error",
        reason: "manifest-invalid",
        detail: input.outcome.detail,
        errors: input.outcome.errors,
      };
    }
    // Offline / DNS / timeout: we know nothing. Never render "up to date" here.
    return { ...base, state: "unknown", reason: "manifest-unreachable", detail: input.outcome.detail };
  }

  const manifest = input.outcome.manifest;
  if (manifest.channel !== input.channel) {
    return {
      ...base,
      state: "error",
      reason: "channel-mismatch",
      detail: `feed is "${manifest.channel}", client is on "${input.channel}"`,
    };
  }
  if (!isValid(manifest.version)) {
    return { ...base, state: "error", reason: "manifest-invalid", detail: "version is not valid semver" };
  }

  let ordering: number;
  try {
    ordering = compare(manifest.version, input.currentVersion);
  } catch (e) {
    return { ...base, state: "error", reason: "manifest-invalid", detail: (e as Error).message };
  }
  if (ordering < 0) {
    // Rolled back or stale manifest: refuse, report "up to date", never offer the older build.
    return {
      ...base,
      state: "up-to-date",
      reason: "never-downgrade",
      detail: `manifest ${manifest.version} is older than running ${input.currentVersion}`,
      candidateVersion: manifest.version,
      lastSeenVersion: manifest.version,
      lastSeenAt: checkedAt,
    };
  }
  if (ordering === 0) {
    return {
      ...base,
      state: "up-to-date",
      reason: "current-is-newest",
      candidateVersion: manifest.version,
      lastSeenVersion: manifest.version,
      lastSeenAt: checkedAt,
    };
  }

  const mandatory = isMandatory(manifest, input.currentVersion);

  if (input.surface === "pwa") {
    const web = manifest.web;
    if (!web || !isValid(web.version)) {
      return {
        ...base,
        state: "available",
        reason: "no-web-bundle",
        candidateVersion: manifest.version,
        prompt: false,
        mandatory,
        lastSeenVersion: manifest.version,
        lastSeenAt: checkedAt,
      };
    }
    if (compare(web.version, input.currentVersion) <= 0) {
      return {
        ...base,
        state: "up-to-date",
        reason: "current-is-newest",
        candidateVersion: web.version,
        lastSeenVersion: web.version,
        lastSeenAt: checkedAt,
      };
    }
    return {
      ...base,
      state: "available",
      reason: "update-available",
      candidateVersion: web.version,
      notesUrl: manifest.notesUrl,
      notes: manifest.notes,
      prompt: !input.alreadyPromptedThisSession,
      action: "reload",
      mandatory,
      lastSeenVersion: web.version,
      lastSeenAt: checkedAt,
    };
  }

  const platformId = input.platformId;
  const artifact = platformId ? manifest.platforms[platformId] : undefined;
  if (!artifact) {
    return {
      ...base,
      state: "error",
      reason: "platform-missing",
      detail: `no "${String(platformId)}" artifact in the ${manifest.channel} manifest`,
      candidateVersion: manifest.version,
      mandatory,
      lastSeenVersion: manifest.version,
      lastSeenAt: checkedAt,
    };
  }

  const snooze = snoozedFor(input, manifest.version, nowMs);
  let reason: UpdateReason = "update-available";
  let prompt = true;
  if (!mandatory && snooze.snoozed) {
    reason = "snoozed";
    prompt = false;
  } else if (input.alreadyPromptedThisSession) {
    reason = "already-prompted";
    prompt = false;
  }

  return {
    state: "available",
    reason,
    candidateVersion: manifest.version,
    notesUrl: manifest.notesUrl,
    notes: manifest.notes,
    artifact,
    prompt,
    mandatory,
    action: "install",
    lastSeenVersion: manifest.version,
    lastSeenAt: checkedAt,
    detail: snooze.until ? `snoozed until ${snooze.until}` : undefined,
    checkedAt,
  };
}

export type VerifyInput = {
  declared: { sha256: string; size: number };
  actual: { sha256: string; size: number };
};

/** Gate run after download, before anything touches the system package manager. */
export function verifyDownloadedArtifact({ declared, actual }: VerifyInput): { ok: boolean; reason: UpdateReason; detail?: string } {
  const want = declared.sha256.toLowerCase();
  const got = actual.sha256.toLowerCase();
  if (got !== want) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      detail: `expected sha256 ${want}, computed ${got}`,
    };
  }
  if (declared.size !== actual.size) {
    return {
      ok: false,
      reason: "size-mismatch",
      detail: `manifest says ${declared.size} bytes, downloaded ${actual.size}`,
    };
  }
  return { ok: true, reason: "ok" };
}

/** Default snooze window used by both surfaces. */
export const SNOOZE_HOURS = 12;

export function snoozeExpiry(now: Date = new Date(), hours: number = SNOOZE_HOURS): string {
  return new Date(now.getTime() + hours * 3600_000).toISOString();
}

/** Compact, log-friendly summary — the desktop writes this verbatim. */
export function summariseDecision(d: UpdateDecision): string {
  const parts = [`state=${d.state}`, `reason=${d.reason}`];
  if (d.candidateVersion) parts.push(`candidate=${d.candidateVersion}`);
  if (d.mandatory) parts.push("mandatory=true");
  if (d.state === "unknown" && d.lastSeenAt) parts.push(`lastSeen=${d.lastSeenAt}`);
  parts.push(`prompt=${String(d.prompt)}`);
  return parts.join(" ");
}
