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
 */

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
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
