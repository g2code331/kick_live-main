/**
 * Manifest transport: where to look, how to fetch it, and what "we know nothing" means.
 *
 * Shared by the desktop main process and the web/PWA renderer so both surfaces parse the exact
 * same bytes with the exact same rules (see shared/update-manifest.ts for the schema).
 */

import type { Channel, UpdateManifest, ValidationError } from "./update-manifest.ts";
import { parseUpdateManifest } from "./update-manifest.ts";

export const MANIFEST_FETCH_TIMEOUT_MS = 8_000;

/** Published per channel; the beta feed lives on a moving tag so it can be repointed instantly. */
export const DEFAULT_MANIFEST_URLS: Record<Channel, string> = {
  stable: "https://github.com/g2code331/kick_live-main/releases/latest/download/kicklive-update-stable.json",
  beta: "https://github.com/g2code331/kick_live-main/releases/download/update-channel-beta/kicklive-update-beta.json",
};

export function resolveManifestUrl(input: { env?: Record<string, string | undefined>; channel: Channel }): string {
  const explicit = input.env?.["KICKLIVE_UPDATE_MANIFEST_URL"] ?? input.env?.["VITE_UPDATE_MANIFEST_URL"] ?? "";
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  return DEFAULT_MANIFEST_URLS[input.channel];
}

export function resolveChannel(env?: Record<string, string | undefined>): Channel {
  const raw = (env?.["KICKLIVE_UPDATE_CHANNEL"] ?? env?.["VITE_UPDATE_CHANNEL"] ?? "stable").trim();
  return raw === "beta" ? "beta" : "stable";
}

export type ManifestOutcome =
  | { ok: true; manifest: UpdateManifest; raw: string; status: number }
  | { ok: false; kind: "unreachable"; detail: string; status?: number }
  | { ok: false; kind: "invalid"; detail: string; errors?: ValidationError[] };

export type FetchManifestOptions = {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** local dev feed + the contract tests serve plain http */
  allowInsecureUrls?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** Never throws: every transport failure collapses into `{ ok: false, kind: "unreachable" }`. */
export async function fetchUpdateManifest(opts: FetchManifestOptions): Promise<ManifestOutcome> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, kind: "unreachable", detail: "no fetch implementation available" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    // Cast: `cache`/`redirect` exist on the DOM RequestInit but not on undici's, and this file has
    // to typecheck in both projects (renderer = DOM, main + tests = @types/node).
    const init = {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "KickLive-Updates/1",
        ...(opts.headers ?? {}),
      },
    } as RequestInit;
    const response = await doFetch(opts.url, init);
    if (!response.ok) {
      return {
        ok: false,
        kind: "unreachable",
        detail: `HTTP ${String(response.status)} from update feed`,
        status: response.status,
      };
    }
    const raw = await response.text();
    const parsed = parseUpdateManifest(raw, { allowInsecureUrls: opts.allowInsecureUrls === true });
    if (!parsed.ok) {
      return {
        ok: false,
        kind: "invalid",
        detail: `update manifest failed schema validation (${String(parsed.errors.length)} error(s))`,
        errors: parsed.errors,
      };
    }
    return { ok: true, manifest: parsed.value, raw, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      kind: "unreachable",
      detail: aborted ? `timed out after ${String(opts.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS)}ms` : message,
    };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const LOG_PREFIX = "[kicklive:updates]" as const;

export const UPDATE_LOG_PATTERNS = {
  line: /^\[kicklive:updates\] (\w+) (.*)$/,
  refused: /\[kicklive:updates\] REFUSE_INSTALL reason=(\S+) detail="([^"]*)"/,
  checked: /\[kicklive:updates\] CHECKED (.*)/,
} as const;

export function formatUpdateLog(event: string, detail: string): string {
  return `${LOG_PREFIX} ${event} ${detail}`.trimEnd();
}
