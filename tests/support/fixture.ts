/**
 * Shared fixtures for the update tests. Everything here is deliberately explicit (no random data):
 * a release gate that occasionally fails is a gate people mute.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import type { Channel, PlatformArtifact, PlatformId, UpdateManifest } from "../../shared/update-manifest.ts";

export const HEX_A = "a".repeat(64);

export function sha256Of(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function artifactFor(bytes: Buffer, overrides: Partial<PlatformArtifact> = {}): PlatformArtifact {
  return {
    kind: "deb",
    fileName: "kicklive_1.1.0_amd64.deb",
    url: `http://127.0.0.1:0/placeholder`,
    sha256: sha256Of(bytes),
    size: bytes.length,
    ...overrides,
  };
}

export type ManifestOptions = {
  version?: string;
  channel?: Channel;
  product?: string;
  platformId?: PlatformId | null;
  artifact?: Partial<PlatformArtifact>;
  notes?: string;
  mandatoryBelow?: string;
  minSupportedVersion?: string;
  web?: false | Record<string, unknown>;
  releasedAt?: string;
  extra?: Record<string, unknown>;
};

/** A manifest that passes the shared validator; mutate the returned object to build negatives. */
export function manifest(opts: ManifestOptions = {}): Record<string, unknown> {
  const version = opts.version ?? "1.1.0";
  const bytes = Buffer.from(`kicklive-deb-bytes-for-${version}`);
  const artifact: PlatformArtifact = {
    kind: "deb",
    fileName: `kicklive_${version}_amd64.deb`,
    url: `https://example.invalid/releases/kicklive_${version}_amd64.deb`,
    sha256: sha256Of(bytes),
    size: bytes.length,
    ...(opts.artifact ?? {}),
  };
  const platforms: Record<string, PlatformArtifact> = opts.platformId === null ? {} : { [opts.platformId ?? "linux_x64"]: artifact };
  const m: Record<string, unknown> = {
    schemaVersion: 1,
    product: opts.product ?? "kicklive",
    channel: opts.channel ?? "stable",
    version,
    releasedAt: opts.releasedAt ?? "2026-09-01T12:00:00.000Z",
    notes: opts.notes ?? "KickLive " + version + ": fixes the feed refresh loop.",
    platforms,
    web:
      opts.web === false
        ? undefined
        : {
            version,
            swUrl: "/sw.js",
            ...(opts.web ?? {}),
          },
    ...manifestExtra(opts),
  };
  if (m.web === undefined) delete m.web;
  return m;
}

function manifestExtra(opts: ManifestOptions): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(opts.extra ?? {}) };
  if (opts.mandatoryBelow) out.mandatoryBelow = opts.mandatoryBelow;
  if (opts.minSupportedVersion) out.minSupportedVersion = opts.minSupportedVersion;
  return out;
}

export function asManifest(value: unknown): UpdateManifest {
  return value as UpdateManifest;
}

export function tmpDir(prefix = "kicklive-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export const NOOP_LOG = (): void => {};

export function collectLogs(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

/** fetch impl for tests: maps path -> response, records how often each path was hit. */
export function fakeFetch(routes: Record<string, { status?: number; body: string | Buffer | Uint8Array; headers?: Record<string, string> }>): { fetch: typeof fetch; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    hits[key ?? url] = (hits[key ?? url] ?? 0) + 1;
    if (!key) return new Response("not found", { status: 404 });
    const route = routes[key];
    const body = route.body instanceof Buffer || route.body instanceof Uint8Array ? route.body : Buffer.from(String(route.body));
    return new Response(new Uint8Array(body), { status: route.status ?? 200, headers: route.headers });
  };
  return { fetch: fn as unknown as typeof fetch, hits };
}
