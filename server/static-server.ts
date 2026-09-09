/**
 * KickLive hardened static host — used for `npm run serve:web`, by the CI gates, and as the
 * desktop shell's fallback renderer source (the Electron main process embeds it on loopback).
 *
 * Guarantees (each one has a test in tests/integration/static-server.test.ts):
 *  1. Path traversal is refused in every form: raw `..`, `.%2e`, `%2e%2e`, double-encoded
 *     `%252e%252e`, `%2f`, `%5c`, raw backslashes, NUL bytes, absolute-form request targets.
 *  2. A missing *asset* (any request whose path carries a non-HTML extension) is a real `404`,
 *     never an HTML app-shell answer — because `200 + text/html` for `index-abc123.js` is the
 *     classic "module MIME type text/html" white screen.
 *  3. Navigation routes (extension-less, `Accept: text/html`) do fall back to `index.html`.
 *  4. Content types come from an explicit map (ESM `text/javascript`, manifest+json, wasm…) and
 *     `X-Content-Type-Options: nosniff` is always set.
 *  5. Hashed assets are `immutable`; `index.html`/`sw.js`/`version.json` are `no-cache`.
 *  6. Loopback binds verify `Host` (DNS-rebinding guard) unless explicitly allowed.
 *
 * No dependencies: plain `node:http` + `node:fs`.
 */

import { createHash } from "node:crypto";
import { type FSWatcher, type Stats } from "node:fs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

import { cspHeader } from "../shared/branding.ts";
import { contentTypeFor, hasAnyExtension, isAssetExtension } from "./mime.ts";

export const SERVER_NAME = "kicklive-static";

export type ResolveResult =
  | { kind: "file"; absPath: string; urlPath: string; stats: Stats }
  | { kind: "app-shell"; absPath: string; urlPath: string; stats: Stats }
  | { kind: "redirect"; location: string }
  | { kind: "error"; status: number; reason: string; message: string };

export type ResolveOptions = {
  root: string;
  /** fall back to index.html for extension-less navigation routes */
  spa?: boolean;
  indexDocument?: string;
};

const MAX_DECODE_ROUNDS = 5;

function decodeFully(input: string): { value: string; rounds: number; failed: boolean } {
  let value = input;
  let rounds = 0;
  for (; rounds < MAX_DECODE_ROUNDS; rounds++) {
    if (!value.includes("%")) break;
    let next: string;
    try {
      next = decodeURIComponent(value);
    } catch {
      return { value, rounds, failed: true };
    }
    if (next === value) break;
    value = next;
  }
  return { value, rounds, failed: false };
}

function containsControlChars(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(v);
}

function hasTraversalSegment(v: string): boolean {
  return v.split("/").some((s) => s === ".." || s === ".%2e" || s === "%2e%2e");
}

function startsWithOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function statOrNull(p: string): Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Map a request target onto a file inside `root`, refusing anything that tries to escape.
 * Kept pure (no req/res) so unit tests can hammer it with adversarial strings.
 */
export function resolveRequestTarget(rawTarget: string, opts: ResolveOptions): ResolveResult {
  const root = path.resolve(opts.root);
  const spa = opts.spa !== false;
  const indexDocument = opts.indexDocument ?? "index.html";

  if (typeof rawTarget !== "string" || rawTarget.length === 0) {
    return { kind: "error", status: 400, reason: "empty-target", message: "missing request target" };
  }

  // Absolute-form / proxy-form / authority-form targets are never valid for a static host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget) || rawTarget.startsWith("//")) {
    return { kind: "error", status: 400, reason: "absolute-target", message: "absolute-form request target is refused" };
  }

  const targetPath = rawTarget.split(/[?#]/, 1)[0] ?? "/";

  if (targetPath.includes("\\")) {
    return { kind: "error", status: 400, reason: "backslash", message: "backslashes are not path separators here" };
  }
  if (containsControlChars(targetPath)) {
    return { kind: "error", status: 400, reason: "control-char", message: "control characters are not allowed" };
  }
  // Reject before any decoding: raw "..", "%2e", "%5c", "%2f", "«", double encodings.
  const lowered = targetPath.toLowerCase();
  if (lowered.includes("..") || lowered.includes("..%")) {
    return { kind: "error", status: 400, reason: "traversal", message: "dot segments are refused" };
  }
  if (/%2e|%252e|%c0%ae|%e0%80%ae/i.test(targetPath)) {
    return { kind: "error", status: 400, reason: "encoded-dot", message: "encoded dot segments are refused" };
  }
  if (/%2f|%c0%af|%5c|%c1%9c|%00|%2500/i.test(targetPath)) {
    return { kind: "error", status: 400, reason: "encoded-separator", message: "encoded separators and NUL bytes are refused" };
  }

  const single = decodeOnce(targetPath);
  if (single.failed) {
    return { kind: "error", status: 400, reason: "bad-percent-encoding", message: "malformed percent-encoding" };
  }
  // A separator that only appears after one decode round is a smuggled traversal.
  if (single.value.includes("\\") || /%2f|%5c/i.test(single.value)) {
    return { kind: "error", status: 400, reason: "encoded-separator", message: "encoded separators are refused" };
  }

  const fully = decodeFully(targetPath);
  if (fully.failed) {
    return { kind: "error", status: 400, reason: "bad-percent-encoding", message: "malformed percent-encoding" };
  }
  if (fully.rounds > 1) {
    return { kind: "error", status: 400, reason: "double-encoded", message: "double percent-encoding is refused" };
  }
  const decoded = fully.value;
  if (decoded.includes("\0") || containsControlChars(decoded)) {
    return { kind: "error", status: 400, reason: "control-char", message: "NUL and control characters are refused" };
  }
  if (hasTraversalSegment(decoded) || decoded.includes("..") || decoded.includes("\\")) {
    return { kind: "error", status: 400, reason: "traversal", message: "dot segments are refused" };
  }

  const rawSegments = decoded.split("/").filter((s) => s.length > 0);
  const segments: string[] = [];
  for (const segment of rawSegments) {
    const perSegment = decodeFully(segment);
    if (perSegment.failed || perSegment.rounds > 1) {
      return { kind: "error", status: 400, reason: "bad-percent-encoding", message: "malformed percent-encoding" };
    }
    const clean = perSegment.value;
    if (clean === ".") continue;
    if (clean === ".." || clean.includes("..") || clean.includes("/") || clean.includes("\\") || clean.includes("\0")) {
      return { kind: "error", status: 400, reason: "traversal", message: "dot segments are refused" };
    }
    if (clean.startsWith(".")) {
      return { kind: "error", status: 404, reason: "dotfile", message: "dotfiles are not served" };
    }
    segments.push(clean);
  }

  const candidatePath = "/" + segments.join("/");
  let abs = path.resolve(root, ...segments);
  if (!startsWithOrEqual(abs, root)) {
    return { kind: "error", status: 403, reason: "escapes-root", message: "resolved path leaves the document root" };
  }

  let stats = statOrNull(abs);
  if (stats?.isDirectory()) {
    const withIndex = path.join(abs, indexDocument);
    const indexStats = statOrNull(withIndex);
    if (indexStats?.isFile()) {
      if (segments.length > 0 && !decoded.endsWith("/")) {
        return { kind: "redirect", location: `/${segments.map(encodeURIComponent).join("/")}/` };
      }
      abs = withIndex;
      stats = indexStats;
    } else {
      return { kind: "error", status: 404, reason: "no-index", message: "directory listing is disabled" };
    }
  }

  if (!stats) {
    return missing(candidatePath, { spa, root, indexDocument });
  }
  if (!stats.isFile()) {
    return { kind: "error", status: 403, reason: "not-a-file", message: "not a regular file" };
  }

  // Symlink escape: resolve the real path and re-check containment.
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { kind: "error", status: 404, reason: "not-found", message: "no such file" };
  }
  const realRoot = fs.realpathSync(root);
  if (!startsWithOrEqual(real, realRoot)) {
    return { kind: "error", status: 403, reason: "escapes-root", message: "symlink leaves the document root" };
  }

  return { kind: "file", absPath: abs, urlPath: candidatePath, stats };
}

function decodeOnce(v: string): { value: string; failed: boolean } {
  try {
    return { value: decodeURIComponent(v), failed: false };
  } catch {
    return { value: v, failed: true };
  }
}

/** Missing file: assets 404, navigation routes get the app shell. */
function missing(urlPath: string, opts: { spa: boolean; root: string; indexDocument: string }): ResolveResult {
  if (isAssetExtension(urlPath)) {
    return {
      kind: "error",
      status: 404,
      reason: "missing-asset",
      message: "asset not found (no HTML fallback for asset requests)",
    };
  }
  if (hasAnyExtension(urlPath)) {
    return { kind: "error", status: 404, reason: "missing-page", message: "page not found" };
  }
  if (!opts.spa) {
    return { kind: "error", status: 404, reason: "not-found", message: "not found" };
  }
  const index = path.join(opts.root, opts.indexDocument);
  const stats = statOrNull(index);
  if (!stats?.isFile()) {
    return { kind: "error", status: 404, reason: "no-app-shell", message: `${opts.indexDocument} is missing from the root` };
  }
  return { kind: "app-shell", absPath: index, urlPath, stats };
}

/* ------------------------------------------------------------------ *
 * Cache policy
 * ------------------------------------------------------------------ */

const HASHED_ASSET = /(?:^|\/)assets\/[^/]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const ALWAYS_REVALIDATE = /(?:^|\/)(?:index\.html|sw\.js|version\.json|site\.webmanifest|manifest\.webmanifest)$/;

export type CacheClass = "immutable" | "revalidate";

export function cacheClassFor(urlPath: string): CacheClass {
  return HASHED_ASSET.test(urlPath) ? "immutable" : "revalidate";
}

export function cacheControlFor(urlPath: string): string {
  return cacheClassFor(urlPath) === "immutable" ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
}

export function etagFor(stats: Stats): string {
  const raw = `${stats.size}-${Math.round(stats.mtimeMs)}-${stats.ino}`;
  return `W/"${createHash("sha1").update(raw).digest("base64url").slice(0, 22)}"`;
}

/* ------------------------------------------------------------------ *
 * Host + request plumbing
 * ------------------------------------------------------------------ */

export function isLoopbackHost(host: string): boolean {
  // "[::1]:4123" must not be split on the first colon (that yields "[").
  const bracketed = /^\[([^\]]*)\]/.exec(host);
  const hostname = (bracketed?.[1] ?? host.split(":")[0] ?? "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

export function checkHostHeader(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  // "*" is an explicit operator opt-out ("--allow-any-host"), so it accepts a missing Host header
  // too; every other configuration requires one, because HTTP/1.1 does.
  if (allowedHosts.includes("*")) return true;
  if (!hostHeader) return false;
  const hostname = hostHeader
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const loopbackOk = allowedHosts.includes("loopback") && (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1");
  return loopbackOk || allowedHosts.includes(hostname);
}

export type StaticServerOptions = {
  root: string;
  spa?: boolean;
  /** host names accepted in the Host header; "loopback" keeps 127.0.0.1/localhost; "*" disables the check */
  allowedHosts?: string[];
  csp?: boolean;
  /** used by the desktop shell for its diagnostic page; appended to 404 bodies */
  name?: string;
};

export type SentResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Pure response planner — the handler and the tests both go through it. */
export function planResponse(req: { method?: string; url?: string; headers: http.IncomingHttpHeaders }, opts: StaticServerOptions): SentResult & { absPath?: string; isHead?: boolean } {
  const method = (req.method ?? "GET").toUpperCase();
  const isHead = method === "HEAD";
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-KickLive-Server": SERVER_NAME,
    "Referrer-Policy": "same-origin",
  };
  if (opts.csp !== false) headers["Content-Security-Policy"] = cspHeader();

  const fail = (status: number, reason: string, message: string): SentResult & { isHead: boolean } => ({
    status,
    headers: {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-KickLive-Reason": reason,
    },
    body: isHead ? "" : `${status} ${reason}: ${message}\n`,
    isHead,
  });

  if (method !== "GET" && method !== "HEAD") {
    const response = fail(405, "method-not-allowed", `${method} is not supported`);
    return { ...response, headers: { ...response.headers, Allow: "GET, HEAD" } };
  }

  const allowedHosts = opts.allowedHosts ?? ["loopback"];
  if (!checkHostHeader(req.headers.host, allowedHosts)) {
    return fail(403, "host-mismatch", `Host "${String(req.headers.host ?? "")}" is not allowed`);
  }

  const resolved = resolveRequestTarget(req.url ?? "/", {
    root: opts.root,
    spa: opts.spa,
  });

  if (resolved.kind === "error") {
    return fail(resolved.status, resolved.reason, resolved.message);
  }
  if (resolved.kind === "redirect") {
    return {
      status: 301,
      headers: { ...headers, Location: resolved.location, "Cache-Control": "no-store" },
      body: isHead ? "" : "redirecting…",
      isHead,
    };
  }

  const type = contentTypeFor(resolved.absPath);
  const etag = etagFor(resolved.stats);
  const inm = req.headers["if-none-match"];
  const baseHeaders: Record<string, string> = {
    ...headers,
    "Content-Type": type,
    "Content-Length": String(resolved.stats.size),
    ETag: etag,
    "Last-Modified": resolved.stats.mtime.toUTCString(),
    "Cache-Control": cacheControlFor(resolved.urlPath),
  };
  if (resolved.kind === "app-shell") baseHeaders["X-KickLive-App-Shell"] = "1";

  if (
    typeof inm === "string" &&
    inm
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  ) {
    return {
      status: 304,
      headers: {
        ...baseHeaders,
        "Content-Length": "0",
      },
      body: "",
      isHead: true,
      absPath: resolved.absPath,
    };
  }

  return {
    status: 200,
    headers: baseHeaders,
    body: "",
    isHead,
    absPath: resolved.absPath,
  };
}

export type HandleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export function createRequestHandler(opts: StaticServerOptions): HandleRequest {
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) {
    throw new Error(`static root does not exist: ${root}`);
  }
  return function handle(req, res) {
    const planned = planResponse(req, { ...opts, root });
    if (planned.status === 200 && planned.absPath) {
      res.writeHead(200, planned.headers);
      if (planned.isHead) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(planned.absPath);
      stream.on("error", () => {
        res.destroy();
      });
      stream.pipe(res);
      return;
    }
    res.writeHead(planned.status, planned.headers);
    res.end(planned.body);
  };
}

export type RunningServer = {
  server: http.Server;
  port: number;
  host: string;
  origin: string;
  root: string;
  address: string;
  close: () => Promise<void>;
};

export async function startStaticServer(opts: StaticServerOptions & { port?: number; host?: string }): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const handler = createRequestHandler({ ...opts, root: path.resolve(opts.root) });
  const server = http.createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 31_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const address = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
  return {
    server,
    port,
    host,
    address,
    root: path.resolve(opts.root),
    origin: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections?.();
      }),
  };
}

export type Watcher = { close: () => void; watcher: FSWatcher };

/** Hot-swap the root when a dev build rewrites dist (used by scripts/dev-desktop.mjs). */
export function watchRoot(dir: string, onChange: () => void): Watcher {
  const watcher = fs.watch(dir, { persistent: false }, () => onChange());
  return { watcher, close: () => watcher.close() };
}
