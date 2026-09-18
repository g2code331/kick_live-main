/**
 * Cloudflare Pages "advanced mode" Worker. This is the SPA host contract, identical to the one
 * `server/static-server.ts` enforces locally and `scripts/ci/probe-deploy.sh` asserts on the deployed host.
 *
 * Why _worker.js and NOT a functions/ directory: `wrangler pages deploy dist/web` does NOT compile a
 * nested `functions/` folder — the Cloudflare docs require `functions/` to live at the PROJECT root, not
 * inside the output dir. When it sat in `dist/web/functions/` it was uploaded as a dead static file and
 * never ran, so Pages fell back to its default `not_found_handling` (single-page-application: index.html
 * at 200) for a missing `/assets/*.js`. That is the exact PWA-pinning bug the probe caught. A `_worker.js`
 * at the deploy root, by contrast, is ALWAYS executed by Pages and takes full control of routing.
 *
 * Why not `_redirects` (`/* /index.html 200`): it is unconditional. After an update the previous
 * index.html (still cached) references `assets/index-<old-hash>.js`; that file is gone, and a blanket
 * rewrite answers it with HTML at 200. The browser refuses the module and the PWA pins a broken shell.
 *
 * The detection rule: `env.ASSETS.fetch()` already carries Pages' SPA not-found behaviour — a MISSING path
 * comes back as the index.html shell (200, text/html), not a 404. So a real file is distinguished from a
 * miss by its content type, not the status code:
 *   1. a path WITH a non-HTML extension that comes back as text/html was NOT found → a real 404;
 *   2. any other response from ASSETS is the genuine article — a real asset with its own MIME (immutable
 *      /assets/*, no-store /sw.js), index.html for "/", or the app shell for an extensionless route.
 *
 * The one dynamic route: `/updates/manifest[.json]`. The web/PWA update check must read the SAME published
 * manifest the desktop app reads, but that lives on GitHub Releases, whose asset download 302-redirects to
 * objects.githubusercontent.com (S3) with NO Access-Control-Allow-Origin header — so a browser cross-origin
 * fetch is blocked and the widget shows "Failed to fetch". A Worker is not bound by CORS, so it fetches the
 * GitHub manifest server-side here and re-serves it same-origin with permissive CORS. `?channel=beta` selects
 * the beta feed; anything else is the stable feed.
 */

const MANIFEST_FEEDS = {
  stable: "https://github.com/g2code331/kick_live-main/releases/latest/download/kicklive-update-stable.json",
  beta: "https://github.com/g2code331/kick_live-main/releases/download/update-channel-beta/kicklive-update-beta.json",
};

async function serveUpdateManifest(request) {
  const channel = new URL(request.url).searchParams.get("channel") === "beta" ? "beta" : "stable";
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "accept, content-type",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    const upstream = await fetch(MANIFEST_FEEDS[channel], {
      redirect: "follow",
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: { accept: "application/json", "user-agent": "KickLive-Updates/1" },
    });
    if (!upstream.ok) {
      // No published release yet (404) or a transient GitHub error: report it as JSON so the client's
      // "unreachable" branch has a real reason instead of an opaque CORS/network failure.
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}`, channel }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors },
      });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", ...cors },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err), channel }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors },
    });
  }
}

/**
 * Same-origin `/api/*` proxy, active ONLY when `env.API_ORIGIN` is set on the Pages project.
 *
 * On the custom domain the API and the SPA share a zone, so `kicklive.football/api/*` is routed to the
 * Worker by a zone route and the app's same-origin `/api` calls just work. The raw `<project>.pages.dev`
 * host has no such route, so `/api/observability/*` used to fall through to `env.ASSETS.fetch` and come
 * back as the index.html shell (HTML, 200) — which the client correctly rejects as an "unexpected body
 * shape" (DEPENDENCY_FAILED), painting every admin panel red. Setting `API_ORIGIN` to the deployed API
 * Worker's absolute origin (e.g. https://kicklive-api-staging.<subdomain>.workers.dev) lets this host
 * relay `/api/*` there, same-origin to the browser, with WebSocket upgrades passed straight through.
 *
 * It is a var and not hard-wired because the production custom domain does not need it (and must not
 * double-hop), and each Pages project points at its own API environment.
 */
async function proxyApi(request, env) {
  const origin = (env.API_ORIGIN || "").replace(/\/+$/, "");
  const incoming = new URL(request.url);
  const target = origin + incoming.pathname + incoming.search;

  // A WebSocket upgrade (GET /api/live/matches/:id) cannot be re-created from a plain Request clone: forward
  // the original request object so Cloudflare carries the Upgrade handshake and the returned socket through.
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return fetch(new Request(target, request));
  }

  const headers = new Headers(request.headers);
  // Let the upstream Worker see the browser-facing origin/host so CORS + absolute-URL building stay correct.
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };
  return fetch(target, init);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // Same-origin update-manifest proxy (see the header comment): the browser cannot fetch the GitHub
    // release asset directly (S3 sends no CORS header), so the Worker relays it here.
    if (path === "/updates/manifest" || path === "/updates/manifest.json") {
      return serveUpdateManifest(request);
    }

    // `/api/*` → the API Worker, but only on hosts that carry no zone route of their own (see proxyApi).
    // Without API_ORIGIN this branch is skipped and `/api` behaves as before (custom-domain zone route).
    if ((path === "/api" || path.startsWith("/api/")) && env.API_ORIGIN) {
      return proxyApi(request, env);
    }

    const hasExtension = /\.[A-Za-z0-9]+$/.test(path) && path !== "/";

    const res = await env.ASSETS.fetch(request);
    const contentType = res.headers.get("content-type") || "";
    const servedAsHtml = contentType.includes("text/html");

    // A dotted path answered with the HTML shell is the SPA fallback swallowing a missing asset. Report the
    // miss instead: 200+HTML for `index-<old-hash>.js` is what pins a broken PWA shell forever.
    if (hasExtension && servedAsHtml && !path.endsWith(".html")) {
      return new Response(`missing asset: ${path}\n`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "x-kicklive-reason": "missing-asset" },
      });
    }

    return res;
  },
};
