/**
 * Static-file-server contract (spec § static server). This is the code the desktop shell embeds as
 * its HTTP fallback AND the thing that serves dist/web in the self-hosted container, so the
 * traversal / 404 / MIME rules are asserted here as pure functions before the socket test does it
 * for real (tests/integration/static-server.test.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cacheClassFor, cacheControlFor, checkHostHeader, etagFor, isLoopbackHost, planResponse, resolveRequestTarget } from "../../server/static-server.ts";
import { contentTypeFor, extname, hasAnyExtension, isAssetExtension } from "../../server/mime.ts";

let root: string;
let assetName: string;

const HOST = { host: "127.0.0.1:4123" };

function req(url: string, method = "GET", headers: Record<string, string> = {}) {
  return { method, url, headers: { ...HOST, ...headers } };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-root-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><title>KickLive</title><div id="root"></div>');
  assetName = "index-AbCdEf01.js";
  fs.writeFileSync(path.join(root, "assets", assetName), "export const x = 1;");
  fs.writeFileSync(path.join(root, "assets", "site-12345678.css"), ":root{}");
  fs.writeFileSync(path.join(root, "site.webmanifest"), "{}");
  fs.writeFileSync(path.join(root, "sw.js"), "// sw");
  fs.writeFileSync(path.join(root, "version.json"), '{"version":"1.0.0"}');
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "secret");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveRequestTarget: traversal refusal", () => {
  const hostile = [
    "/../etc/passwd",
    "/..%2fetc%2fpasswd",
    "/%2e%2e/etc/passwd",
    "/%2E%2E%2Fetc%2Fpasswd",
    "/..\\..\\windows\\win.ini",
    "/%2e%2e%5cwindows",
    "/..%5c..%5cetc",
    "/%252e%252e/%252e%252e/etc/passwd",
    "/%c0%ae%c0%ae/etc/passwd",
    "/%c0%afetc/passwd",
    "/....//....//etc/passwd",
    "/assets/../../../etc/passwd",
    "/assets/%2e%2e/%2e%2e/etc/passwd",
    "/%00/../etc/passwd",
    "/assets/x.js%00.png",
    "/%2fetc/passwd",
    "/%2e/git/config",
    "/%2E%2e",
  ];
  for (const target of hostile) {
    it(`refuses ${target}`, () => {
      const res = resolveRequestTarget(target, { root });
      assert.equal(res.kind, "error", `${target} must not resolve to a file (got ${JSON.stringify(res)})`);
      const error = res as { status: number; reason: string };
      assert.ok([400, 403, 404].includes(error.status), `${target} -> status ${String(error.status)}`);
      assert.ok(!JSON.stringify(res).includes("/etc/passwd"), "the refusal must not echo a host path");
    });
  }

  it("refuses absolute-form and protocol-relative request targets", () => {
    for (const target of ["http://evil.example/x.js", "//evil.example/x.js", "file:///etc/passwd"]) {
      assert.equal(resolveRequestTarget(target, { root }).kind, "error", target);
    }
  });

  it("refuses control characters and malformed escapes", () => {
    assert.equal(resolveRequestTarget("/assets/x\u0001.js", { root }).kind, "error");
    assert.equal(resolveRequestTarget("/assets/%zz.js", { root }).kind, "error");
    assert.equal(resolveRequestTarget("/assets/%e0%a4", { root }).kind, "error");
  });

  it("refuses a symlink that points outside the root", () => {
    const outside = path.join(path.dirname(root), "kicklive-outside-secret.txt");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(root, "leak.txt"));
    const res = resolveRequestTarget("/leak.txt", { root });
    assert.equal(res.kind, "error");
    assert.equal((res as { reason: string }).reason, "escapes-root");
    fs.unlinkSync(path.join(root, "leak.txt"));
    fs.rmSync(outside, { force: true });
  });

  it("does not serve dotfiles", () => {
    const res = resolveRequestTarget("/.git/config", { root });
    assert.equal(res.kind, "error");
    assert.equal((res as { reason: string }).reason, "dotfile");
  });

  it("serves ordinary files inside the root", () => {
    const res = resolveRequestTarget(`/assets/${assetName}`, { root });
    assert.equal(res.kind, "file");
    assert.ok(res.kind === "file" && res.absPath.endsWith(assetName));
  });
});

describe("resolveRequestTarget: 404 vs app shell", () => {
  it("a missing asset-looking path is a 404, never the HTML shell", () => {
    const res = resolveRequestTarget("/assets/typo-does-not-exist.js", { root });
    assert.equal(res.kind, "error");
    assert.equal(res.status, 404);
    assert.equal(res.reason, "missing-asset");
  });

  it("a missing .html page is a 404 (not the shell)", () => {
    const res = resolveRequestTarget("/missing.html", { root });
    assert.equal(res.reason, "missing-page");
  });

  it("an extensionless client-side route gets index.html", () => {
    const res = resolveRequestTarget("/admin/matches", { root });
    assert.equal(res.kind, "app-shell");
    assert.ok(res.kind === "app-shell" && res.absPath.endsWith("index.html"));
  });

  it("with spa disabled, extensionless routes 404 too", () => {
    const res = resolveRequestTarget("/admin/matches", { root, spa: false });
    assert.equal(res.kind, "error");
    assert.equal(res.reason, "not-found");
  });

  it("a directory without index.html is not listed", () => {
    fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });
    const res = resolveRequestTarget("/empty-dir", { root });
    assert.equal(res.kind, "error");
    assert.equal(res.reason, "no-index");
  });
});

describe("mime types", () => {
  it("javascript gets a JS type (ES modules are refused without one)", () => {
    for (const file of ["a.js", "a.mjs", "x/index-abc.js"]) {
      assert.match(contentTypeFor(file), /^text\/javascript/, file);
    }
    assert.match(contentTypeFor("a.css"), /^text\/css/);
    assert.match(contentTypeFor("a.json"), /^application\/json/);
    assert.match(contentTypeFor("site.webmanifest"), /^application\/manifest\+json/);
    assert.match(contentTypeFor("a.svg"), /^image\/svg\+xml/);
    assert.equal(contentTypeFor("a.wasm"), "application/wasm");
  });

  it("unknown extensions are opaque bytes, never HTML (that is what stops a download becoming a page)", () => {
    assert.match(contentTypeFor("kicklive_1.1.0_amd64.deb"), /^application\/(vnd\.debian\.binary-package|octet-stream)/);
    assert.equal(contentTypeFor("totally-unknown-xyz.bin"), "application/octet-stream");
    assert.equal(contentTypeFor("notes"), "application/octet-stream", "extensionless files are opaque: nothing on this server may be sniffed into a page");
    assert.ok(!contentTypeFor("weird.xyz").includes("text/html"), contentTypeFor("weird.xyz"));
  });

  it("asset classification agrees with the service worker's navigation rule", () => {
    assert.equal(isAssetExtension("/assets/a.js"), true);
    assert.equal(isAssetExtension("/kicklive.deb"), true);
    assert.equal(isAssetExtension("/admin/match/1"), false);
    assert.equal(hasAnyExtension("/a/b"), false);
    assert.equal(hasAnyExtension("/a/b.html"), true);
    assert.equal(extname("/a/b.min.js"), ".js");
    assert.equal(extname("/a/.hidden"), "");
  });
});

describe("cache policy + validators", () => {
  it("content-hashed assets are immutable, the shell always revalidates", () => {
    assert.equal(cacheClassFor("/assets/index-AbCdEf01.js"), "immutable");
    assert.equal(cacheClassFor("/index.html"), "revalidate");
    assert.equal(cacheClassFor("/sw.js"), "revalidate");
    assert.equal(cacheClassFor("/version.json"), "revalidate");
    assert.equal(cacheClassFor("/site.webmanifest"), "revalidate");
    assert.match(cacheControlFor("/assets/index-AbCdEf01.js"), /immutable/);
    assert.match(cacheControlFor("/assets/index-AbCdEf01.js"), /max-age=31536000/);
    assert.equal(cacheControlFor("/index.html"), "public, max-age=0, must-revalidate");
    assert.ok(!/immutable/.test(cacheControlFor("/index.html")));
  });

  it("etag derives from size+mtime and changes when the file changes", () => {
    const file = path.join(root, "version.json");
    const first = etagFor(fs.statSync(file));
    fs.writeFileSync(file, '{"version":"1.0.1"}');
    const second = etagFor(fs.statSync(file));
    assert.notEqual(first, second);
    assert.match(first, /^(W\/)?"[A-Za-z0-9_-]+"$/);
  });

  it("Host header check blocks DNS rebinding but allows loopback", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(checkHostHeader("evil.example", ["loopback"]), false);
    assert.equal(checkHostHeader("127.0.0.1:4123", ["loopback"]), true);
    assert.equal(checkHostHeader("kicklive.internal:3000", ["kicklive.internal"]), true);
    assert.equal(checkHostHeader("anything.example", ["*"]), true);
    assert.equal(checkHostHeader(undefined, ["loopback"]), false, "a missing Host header is not acceptable on HTTP/1.1");
    assert.equal(checkHostHeader("[::1]:4123", ["loopback"]), true);
    assert.equal(checkHostHeader("evil.example:4123", ["loopback"]), false);
    assert.equal(checkHostHeader("KICKLIVE.INTERNAL", ["kicklive.internal"]), true, "Host is case-insensitive");
  });
});

describe("planResponse", () => {
  it("serves JS with the JS type, nosniff and an ETag", () => {
    const res = planResponse(req(`/assets/${assetName}`), { root });
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /^text\/javascript/);
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.ok(res.headers.ETag);
    assert.match(res.headers["Cache-Control"], /immutable/);
  });

  it("marks app-shell responses so a mis-set rewrite is visible in the logs", () => {
    const res = planResponse(req("/admin/matches"), { root });
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /^text\/html/);
    assert.equal(res.headers["X-KickLive-App-Shell"], "1", "CI asserts this header for SPA fallbacks");
    assert.match(res.headers["Cache-Control"], /max-age=0, must-revalidate/, "the shell must always revalidate, but `no-cache` would be a lie for 304 handling");
  });

  it("404 carries the machine-readable reason and never HTML", () => {
    const res = planResponse(req("/assets/nope.js"), { root });
    assert.equal(res.status, 404);
    assert.equal(res.headers["X-KickLive-Reason"], "missing-asset");
    assert.match(res.headers["Content-Type"], /^text\/plain/, "an asset 404 must not look like a page");
    assert.ok(!res.body.includes("<!doctype"), "no app shell in an asset 404");
  });

  it("403/400 refusals are terse and leak no filesystem paths", () => {
    const res = planResponse(req("/../etc/passwd"), { root });
    assert.ok(res.status >= 400 && res.status < 500);
    assert.ok(!res.body.includes("/etc/passwd"), `body leaked a path: ${res.body}`);
    assert.ok(!res.body.includes(root), "body must not echo the document root");
  });

  it("HEAD returns the same headers and no body", () => {
    const get = planResponse(req(`/assets/${assetName}`), { root });
    const head = planResponse(req(`/assets/${assetName}`, "HEAD"), { root });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["Content-Length"], get.headers["Content-Length"]);
  });

  it("If-None-Match becomes a 304 with no body", () => {
    const first = planResponse(req(`/assets/${assetName}`), { root });
    const again = planResponse(req(`/assets/${assetName}`, "GET", { "if-none-match": first.headers.ETag }), { root });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
  });

  it("refuses a request with no Host header (DNS rebinding / curl --no-host guards)", () => {
    const res = { method: "GET", url: "/", headers: {} };
    const planned = planResponse(res, { root });
    assert.equal(planned.status, 403);
    assert.equal(planned.headers["X-KickLive-Reason"], "host-mismatch");
    // ...unless the operator explicitly opts out (the desktop shell serves on loopback only).
    assert.equal(planResponse(res, { root, allowedHosts: ["*"] }).status, 200);
  });

  it("CSP is on by default and can be turned off for debugging", () => {
    const withCsp = planResponse(req("/"), { root });
    assert.match(withCsp.headers["Content-Security-Policy"], /default-src 'self'/);
    const without = planResponse(req("/"), { root, csp: false });
    assert.equal(without.headers["Content-Security-Policy"], undefined);
  });

  it("redirects a bare directory path to its trailing-slash form (relative asset URLs depend on it)", () => {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub/index.html"), "<html>sub</html>");
    const res = planResponse(req("/sub"), { root });
    assert.equal(res.status, 301);
    assert.equal(res.headers.Location, "/sub/");
  });

  it("POST/PUT are refused on a static host", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = planResponse(req("/", method), { root });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.Allow, "GET, HEAD");
    }
  });
});
