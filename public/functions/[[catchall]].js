/**
 * Cloudflare Pages Functions: the SPA fallback, with the same rule `server/static-server.ts` enforces
 * locally and `scripts/ci/probe-deploy.sh` asserts against the deployed host.
 *
 * Why a function and not `_redirects`: a `/* /index.html 200` rule is unconditional — after an update,
 * the *previous* index.html (still in someone's cache) references `assets/index-<old-hash>.js`, that file
 * is gone, and a blanket rewrite answers it with HTML at 200. The browser refuses to parse it as a module
 * and the PWA pins a broken shell forever. So: dotted paths that missed are a real 404 (and `/assets/*`
 * never enters this function at all, per `_routes.json` — an existing asset is served straight from static
 * storage); extensionless paths — actual client-side routes — get the app shell.
 */

/** Same shape as the reference server's reason header, so log lines mean the same thing on both hosts. */
const HEADERS = { "content-type": "text/plain; charset=utf-8" };

export function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  // A path with an extension that static storage did not have: report the miss, never the shell.
  // (index.html itself and /sw.js have extensions too, but they exist, so this function is not called.)
  if (/\.[A-Za-z0-9]+$/.test(path) && path !== "/") {
    return new Response(`missing asset: ${path}\n`, { status: 404, headers: { ...HEADERS, "x-kicklive-reason": "missing-asset" } });
  }
  return context.env.ASSETS.fetch(new URL("/index.html", context.request.url)).then((shell) => {
    if (shell.status !== 200) return shell;
    return new Response(shell.body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The shell must never be cached long: it is the only pointer to the hashed bundle.
        "cache-control": "no-cache",
        "x-kicklive-app-shell": "1",
      },
    });
  });
}
