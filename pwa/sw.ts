/**
 * KickLive service worker (PWA surface).
 *
 * Built by `scripts/build-pwa.mjs` (esbuild) into `dist/web/sw.js` so it can share the exact same
 * "asset vs navigation" rule as the static host: a missing asset must stay a 404 and never be
 * answered with the app shell. The desktop build has no service worker at all.
 *
 * Update model on this surface (see docs/RELEASE-PIPELINE.md § "two surfaces"):
 *   install -> precache core shell;  activate -> drop caches from other versions;
 *   navigation -> network-first, cache fallback;  asset -> cache-first, network fallback;
 *   `KICKLIVE_SKIP_WAITING` -> skipWaiting so "Reload app" in the header control activates.
 */

/// <reference lib="webworker" />

import { isAssetExtension } from "../server/mime.ts";

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

const BUILD_VERSION: string = typeof __APP_VERSION__ === "undefined" ? "0.0.0-dev" : __APP_VERSION__;
const CORE = ["./", "./index.html", "./version.json", "./site.webmanifest"] as const;

const staticCache = () => `kicklive-static-v${BUILD_VERSION}`;
const pageCache = () => `kicklive-pages-v${BUILD_VERSION}`;

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** Same classification the node static host uses, so both surfaces agree. */
function classify(request: Request, url: URL): "navigation" | "asset" | "other" {
  if (request.mode === "navigate" || request.destination === "document") return "navigation";
  if (url.pathname === "/" || url.pathname.endsWith(".html")) return "navigation";
  if (isAssetExtension(url.pathname)) return "asset";
  return "asset";
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: false });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function networkFirst(request: Request, cacheName: string, fallbackUrl: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (err) {
    const offline = await cache.match(request);
    if (offline) return offline;
    const shell = await cache.match(fallbackUrl);
    if (shell) {
      return new Response(shell.body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-KickLive-App-Shell": "1",
          "Cache-Control": "no-cache",
        },
      });
    }
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(pageCache());
      // Bounded precache: only the shell, never a walk of /assets.
      await Promise.allSettled(CORE.map((href) => cache.add(new Request(href, { cache: "reload" }))));
    })().catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([staticCache(), pageCache()]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key);
      }
      // Deliberately NOT claiming clients: an update is applied on the user's terms only.
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === "KICKLIVE_SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }
  if (data?.type === "KICKLIVE_CHECK_VERSION") {
    event.waitUntil(
      (async () => {
        try {
          const res = await fetch("./version.json", { cache: "no-store" });
          if (!res.ok) return;
          const json = (await res.json()) as { version?: string };
          if (json.version && json.version !== BUILD_VERSION) {
            const clients = await self.clients.matchAll({ type: "window" });
            for (const client of clients) client.postMessage({ type: "KICKLIVE_UPDATE_AVAILABLE", version: json.version });
          }
        } catch {
          /* offline: nothing to say */
        }
      })(),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isSameOrigin(url.href)) return;
  if (url.pathname.startsWith("/api/")) return;

  const kind = classify(request, url);
  if (kind === "navigation") {
    event.respondWith(networkFirst(request, pageCache(), "./index.html").catch(() => offlineResponse("navigation-unavailable")));
    return;
  }

  event.respondWith(
    cacheFirst(request, staticCache())
      .then((response) => {
        // Mirror the server contract inside the SW: a 404 asset stays a 404.
        if (response.status === 404) {
          return new Response("404 missing-asset: not serving the app shell for asset requests\n", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8", "X-KickLive-Reason": "missing-asset", "Cache-Control": "no-store" },
          });
        }
        return response;
      })
      .catch(() => offlineResponse("asset-unavailable")),
  );
});

function offlineResponse(reason: string): Response {
  return new Response(`504 ${reason}: offline and not cached\n`, {
    status: 504,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-KickLive-Reason": reason, "Cache-Control": "no-store" },
  });
}

export {};
