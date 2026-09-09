/**
 * The update state machine used by BOTH surfaces.
 *
 *  - desktop: instantiated in the main process (for startup logs + the privileged install
 *    handoff) and in the renderer (for the header control);
 *  - PWA: instantiated in the page, where "install" means "activate the new service worker".
 *
 * Policy lives here, once: never-downgrade, offline => unknown(lastSeenAt), snooze per version,
 * one automatic prompt per app open, mandatory overrides snooze. Handlers (download/reload) are
 * injected so nothing in this file touches node or the DOM.
 */

import { maxOf } from "./semver.ts";
import { sleep } from "./renderer-load.ts";
import type { Channel, PlatformId, Surface, UpdateDecision, ValidationError } from "./update-manifest.ts";
import { decideUpdate, summariseDecision, snoozeExpiry } from "./update-manifest.ts";
import type { ManifestOutcome } from "./update-client.ts";
import { fetchUpdateManifest } from "./update-client.ts";

export type UpdateStore = {
  lastSeen: { version: string; at: string; channel: Channel } | null;
  lastCheckAt: string | null;
  lastOutcome: "ok" | "unreachable" | "invalid" | null;
  lastError?: string;
  /** candidate version -> ISO expiry */
  snoozedUntil: Record<string, string>;
  schemaVersion: 1;
};

export interface UpdateStorage {
  load(): Promise<UpdateStore | null>;
  save(store: UpdateStore): Promise<void>;
}

export function emptyStore(): UpdateStore {
  return { lastSeen: null, lastCheckAt: null, lastOutcome: null, snoozedUntil: {}, schemaVersion: 1 };
}

export type InstallHandler = (decision: UpdateDecision) => Promise<{ ok: boolean; detail: string }>;

export type ControllerOptions = {
  surface: Surface;
  currentVersion: string;
  channel: Channel;
  platformId?: PlatformId;
  storage: UpdateStorage;
  manifestUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  allowInsecureUrls?: boolean;
  log?: (line: string) => void;
  /** injected privileged step (desktop only): download + verify + hand off to the package manager */
  onInstall?: InstallHandler;
  /** injected activation step (PWA only) */
  onReload?: () => Promise<void> | void;
  now?: () => Date;
  /** retries for a flaky network: total attempts, backoff ms */
  attempts?: number;
  backoffMs?: number[];
};

export type CheckSummary = {
  decision: UpdateDecision;
  /** true when the caller may surface a prompt right now */
  mayPrompt: boolean;
  outcome: ManifestOutcome;
  errors?: ValidationError[];
};

function safeLog(fn: ((line: string) => void) | undefined, line: string): void {
  try {
    fn?.(line);
  } catch {
    /* logging must never break the update path */
  }
}

export function createUpdateController(opts: ControllerOptions) {
  const log = opts.log;
  const now = opts.now ?? (() => new Date());
  const attempts = Math.max(1, Math.min(opts.attempts ?? 2, 5));
  const backoff = opts.backoffMs ?? [400];
  /** per-app-open memory: at most one automatic prompt, regardless of how many checks run */
  let promptedThisSession = false;
  let last: CheckSummary | null = null;
  let inFlight: Promise<CheckSummary> | null = null;

  async function readStore(): Promise<UpdateStore> {
    try {
      const loaded = await opts.storage.load();
      if (loaded && loaded.schemaVersion === 1 && typeof loaded.snoozedUntil === "object") return loaded;
    } catch (err) {
      safeLog(log, `[kicklive:updates] STORE_READ_FAILED detail="${(err as Error).message}"`);
    }
    return emptyStore();
  }

  async function writeStore(store: UpdateStore): Promise<void> {
    try {
      await opts.storage.save(store);
    } catch (err) {
      safeLog(log, `[kicklive:updates] STORE_WRITE_FAILED detail="${(err as Error).message}"`);
    }
  }

  async function attemptFetch(): Promise<ManifestOutcome> {
    const url = opts.manifestUrl ?? "";
    if (!url) {
      return { ok: false, kind: "unreachable", detail: "no update feed configured" };
    }
    let lastOutcome: ManifestOutcome | null = null;
    for (let i = 0; i < attempts; i++) {
      const outcome = await fetchUpdateManifest({
        url,
        fetchImpl: opts.fetchImpl,
        allowInsecureUrls: opts.allowInsecureUrls,
      });
      if (outcome.ok) return outcome;
      lastOutcome = outcome;
      // A schema-invalid manifest will not become valid by retrying; only transport is retried.
      if (outcome.kind === "invalid") return outcome;
      if (i < attempts - 1) await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 400);
    }
    return lastOutcome ?? { ok: false, kind: "unreachable", detail: "fetch failed" };
  }

  function decide(outcome: ManifestOutcome, store: UpdateStore, alreadyPrompted: boolean): UpdateDecision {
    return decideUpdate({
      surface: opts.surface,
      currentVersion: opts.currentVersion,
      channel: opts.channel,
      platformId: opts.platformId,
      outcome,
      snoozedUntil: store.snoozedUntil,
      lastSeen: store.lastSeen,
      now: now(),
      alreadyPromptedThisSession: alreadyPrompted,
    });
  }

  async function check(reason: "startup" | "manual" | "focus" = "startup"): Promise<CheckSummary> {
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<CheckSummary> => {
      const store = await readStore();
      const outcome = await attemptFetch();
      const decision = decide(outcome, store, promptedThisSession);

      const next: UpdateStore = {
        ...store,
        lastCheckAt: decision.checkedAt,
        lastOutcome: outcome.ok ? "ok" : outcome.kind,
        lastError: outcome.ok ? undefined : (outcome.detail ?? undefined),
      };
      if (outcome.ok) {
        // Track the *highest* version ever seen, so a rolled-back manifest cannot make the client
        // forget that it already knows about a newer release.
        const newest = maxOf([store.lastSeen?.version ?? "0.0.0", outcome.manifest.version]) ?? outcome.manifest.version;
        next.lastSeen = { version: newest, at: decision.checkedAt, channel: opts.channel };
      } else {
        // Offline/invalid: keep lastSeen untouched so the UI can say unknown(lastSeenAt).
        next.lastSeen = store.lastSeen;
      }
      await writeStore(next);

      if (decision.state === "available" && decision.prompt) {
        promptedThisSession = true;
      }
      const summary: CheckSummary = {
        decision,
        mayPrompt: decision.state === "available" && decision.prompt,
        outcome,
        errors: !outcome.ok && outcome.kind === "invalid" ? outcome.errors : undefined,
      };
      last = summary;
      safeLog(log, `[kicklive:updates] CHECKED reason=${reason} surface=${opts.surface} ${summariseDecision(decision)}`);
      return summary;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function snooze(hours?: number): Promise<CheckSummary> {
    const store = await readStore();
    const current = last?.decision ?? decide(await attemptFetch(), store, true);
    const version = current.candidateVersion ?? current.lastSeenVersion;
    if (version) {
      store.snoozedUntil = { ...store.snoozedUntil, [version]: snoozeExpiry(now(), hours) };
      await writeStore(store);
      safeLog(log, `[kicklive:updates] SNOOZED version=${version} until=${store.snoozedUntil[version]}`);
    }
    const decision = decide(await attemptFetch(), store, true);
    const summary: CheckSummary = { decision, mayPrompt: false, outcome: { ok: false, kind: "unreachable", detail: "snoozed" } };
    last = summary;
    return summary;
  }

  async function install(): Promise<{ ok: boolean; detail: string }> {
    if (opts.surface !== "desktop" || !opts.onInstall) {
      return { ok: false, detail: "this surface has no privileged installer" };
    }
    const store = await readStore();
    const outcome = await attemptFetch();
    const decision = decide(outcome, store, true);
    if (decision.state !== "available" || !decision.artifact) {
      safeLog(log, `[kicklive:updates] REFUSE_INSTALL reason=${decision.reason} detail="${decision.detail ?? ""}"`);
      return { ok: false, detail: `refused: ${decision.reason}` };
    }
    // Re-confirm "never downgrade" against the running version right before touching the system.
    if (decision.reason === "never-downgrade") {
      return { ok: false, detail: "refused: manifest offers an older version" };
    }
    return opts.onInstall(decision);
  }

  async function reload(): Promise<void> {
    await opts.onReload?.();
  }

  function state(): CheckSummary | null {
    return last;
  }

  /** Test/debug helper: forget the "one prompt per open" latch. */
  function resetPromptLatch(): void {
    promptedThisSession = false;
  }

  return { check, snooze, install, reload, state, resetPromptLatch };
}

export type UpdateController = ReturnType<typeof createUpdateController>;
