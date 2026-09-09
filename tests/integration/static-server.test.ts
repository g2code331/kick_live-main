/**
 * Static server over a real socket (spec § static server / §7.2).
 *
 * Why raw sockets for half of this: `fetch()` and the URL parser normalise `/a/../b` before the
 * request is ever sent, so an HTTP client cannot even express the traversal attempts that matter.
 * They go out as literal bytes on the wire instead.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { startStaticServer, type RunningServer } from "../../server/static-server.ts";

let root: string;
let server: RunningServer;
const ASSET = "index-AbCdEf0123.js";
const CSS = "site-12345678.css";

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  raw: string;
}

/** Send an arbitrary request target (including ones no client would send) and read the response. */
function rawRequest(requestTarget: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const lines = [`${opts.method ?? "GET"} ${requestTarget} HTTP/1.1`];
      lines.push(`Host: ${opts.host ?? `127.0.0.1:${server.port}`}`);
      for (const [k, v] of Object.entries(opts.headers ?? {})) lines.push(`${k}: ${v}`);
      lines.push("Connection: close", "", "");
      socket.write(lines.join("\r\n"));
    });
    let buffer = "";
    socket.setTimeout(8000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("data", (chunk) => (buffer += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, body = ""] = buffer.split("\r\n\r\n");
      const [statusLine, ...headerLines] = head.split("\r\n");
      const [, status, statusText = ""] = /HTTP\/1\.[01] (\d{3})(.*)$/.exec(statusLine) ?? [];
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: Number(status), statusText: statusText.trim(), headers, body, raw: buffer });
    });
  });
}

async function get(urlPath: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${server.origin}${urlPath}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-serve-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "admin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<!doctype html><html><head><title>KickLive</title></head><body><div id="root"></div><script type="module" src="./assets/' + ASSET + '"></script></body></html>',
  );
  fs.writeFileSync(path.join(root, "assets", ASSET), "const x = 1;\nexport { x };\n");
  fs.writeFileSync(path.join(root, "assets", CSS), ":root { color: red; }");
  fs.writeFileSync(path.join(root, "sw.js"), "self.addEventListener('install', () => {});\n");
  fs.writeFileSync(path.join(root, "version.json"), JSON.stringify({ version: "1.0.0", sw: "/sw.js" }));
  fs.writeFileSync(path.join(root, "site.webmanifest"), '{"name":"KickLive"}');
  fs.writeFileSync(path.join(root, "kicklive-icon.png"), "not really a png");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  fs.writeFileSync(path.join(root, "admin/index.html"), "<html>admin</html>");
  server = await startStaticServer({ root, port: 0, host: "127.0.0.1" });
});

after(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("static server: serving", () => {
  it("index.html at the root, with a CSP and nosniff", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-kicklive-server"), "kicklive-static");
  });

  it("a module script is served with a JS MIME type (otherwise the browser refuses to run it)", async () => {
    const res = await get(`/assets/${ASSET}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(res.text, "const x = 1;\nexport { x };\n");
  });

  it("css, webmanifest, json and images all get specific types", async () => {
    assert.match((await get(`/assets/${CSS}`)).headers.get("content-type") ?? "", /^text\/css/);
    assert.match((await get("/site.webmanifest")).headers.get("content-type") ?? "", /^application\/manifest\+json/);
    assert.match((await get("/version.json")).headers.get("content-type") ?? "", /^application\/json/);
    assert.match((await get("/kicklive-icon.png")).headers.get("content-type") ?? "", /^image\/png/);
  });

  it("the service worker and version.json are never cached", async () => {
    for (const p of ["/sw.js", "/version.json", "/index.html"]) {
      const res = await get(p);
      assert.match(res.headers.get("cache-control") ?? "", /must-revalidate/, p);
      assert.ok(!/immutable/.test(res.headers.get("cache-control") ?? ""), p);
    }
  });

  it("ETag + If-None-Match => 304 with no body", async () => {
    const first = await get(`/assets/${ASSET}`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const res = await fetch(`${server.origin}/assets/${ASSET}`, { headers: { "if-none-match": etag ?? "" } });
    assert.equal(res.status, 304);
    assert.equal(await res.text(), "");
  });

  it("HEAD returns headers only", async () => {
    const res = await rawRequest(`/assets/${ASSET}`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-length"], String(fs.statSync(path.join(root, "assets", ASSET)).size));
    assert.equal(res.body, "");
  });

  it("a directory with an index.html redirects to the trailing slash so relative asset URLs keep working", async () => {
    const res = await get("/admin");
    // fetch follows redirects; assert the final content and that the redirect existed via raw.
    assert.equal(res.status, 200);
    assert.match(res.text, /admin/);
    const direct = await rawRequest("/admin");
    assert.equal(direct.status, 301);
    assert.equal(direct.headers.location, "/admin/");
  });
});

describe("static server: missing files must be 404, not the app shell", () => {
  it("a typo'd asset 404s with a machine-readable reason", async () => {
    const res = await rawRequest("/assets/typo-does-not-exist.js");
    assert.equal(res.status, 404);
    assert.equal(res.headers["x-kicklive-reason"], "missing-asset");
    assert.ok(!res.body.includes("<!doctype"), "an asset 404 must not be an HTML document");
    assert.ok(!/text\/html/.test(res.headers["content-type"] ?? ""), res.headers["content-type"]);
  });

  it("a missing .html page 404s (only extensionless routes get the shell)", async () => {
    const res = await rawRequest("/missing.html");
    assert.equal(res.status, 404);
    assert.equal(res.headers["x-kicklive-reason"], "missing-page");
  });

  it("an extensionless client-side route gets the shell, tagged so it is greppable", async () => {
    const res = await rawRequest("/admin/matches/42", { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-kicklive-app-shell"], "1");
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
  });

  it("directory listings are off", async () => {
    const res = await rawRequest("/assets/");
    assert.equal(res.status, 404);
    assert.equal(res.headers["x-kicklive-reason"], "no-index");
  });

  it("404 bodies never echo the document root", async () => {
    const res = await rawRequest("/nope-nothing-here");
    assert.ok(!res.body.includes(root), "the 404 body leaked the filesystem path");
  });
});

describe("static server: traversal refusals (raw wire form)", () => {
  const attempts = [
    "/../etc/passwd",
    "/assets/../../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..%2fetc%2fpasswd",
    "/..%5c..%5cwindows%5cwin.ini",
    "/%252e%252e/etc/passwd",
    "/%c0%ae%c0%ae/etc/passwd",
    "/etc/passwd",
    "/%2fetc/passwd",
    "/kicklive-icon.png/../../../etc/passwd",
    "/assets/%00/../../../etc/passwd",
    "/..%00",
  ];
  for (const target of attempts) {
    it(`refuses ${target} without serving a file outside the root`, async () => {
      const res = await rawRequest(target);
      // The invariant is "no file outside the root, ever". Some of these targets are
      // extensionless and therefore legitimately resolve to the SPA shell (200) — what must never
      // happen is the shell being confused with /etc/passwd, or a 200 with foreign bytes.
      assert.ok(!res.body.includes("root:"), `${target} leaked /etc/passwd`);
      assert.ok(!res.body.includes("repositoryformatversion"), `${target} leaked .git/config`);
      assert.ok(!res.body.includes("module.exports"), `${target} leaked server source`);
      if (res.status < 400) {
        assert.equal(res.headers["x-kicklive-app-shell"], "1", `${target} returned ${String(res.status)} with a body that is not the app shell`);
      } else {
        assert.ok([400, 403, 404].includes(res.status), `${target} -> ${String(res.status)}`);
      }
    });
  }

  it("refuses absolute-form request targets", async () => {
    const res = await rawRequest("http://evil.example/x.js");
    assert.equal(res.status, 400);
  });

  it("refuses a request line with a bare LF (request smuggling guard)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(server.port, "127.0.0.1", () => socket.write("GET /index.html HTTP/1.1\nHost: x\n\n"));
      let data = "";
      socket.setTimeout(4000, () => socket.destroy());
      socket.on("data", (c) => (data += c.toString()));
      socket.on("close", () => resolve(Number(/HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0)));
      socket.on("error", reject);
    });
    assert.ok(status === 400 || status === 0, `bare-LF request line got status ${String(status)}`);
  });

  it("does not serve dotfiles", async () => {
    const res = await rawRequest("/.git/config");
    assert.equal(res.status, 404);
    assert.equal(res.headers["x-kicklive-reason"], "dotfile");
  });

  it("does not serve its own source through the root", async () => {
    const res = await rawRequest("/../../server/static-server.ts");
    assert.ok(res.status >= 400);
  });
});

describe("static server: host header + methods", () => {
  it("refuses a foreign Host (DNS rebinding on a loopback-only server)", async () => {
    const res = await rawRequest("/", { host: "attacker.example" });
    assert.equal(res.status, 403);
    assert.equal(res.headers["x-kicklive-reason"], "host-mismatch");
  });

  it("accepts localhost and 127.0.0.1 with any port", async () => {
    for (const host of ["localhost", `localhost:${server.port}`, `127.0.0.1:${server.port}`]) {
      const res = await rawRequest("/", { host });
      assert.equal(res.status, 200, host);
    }
  });

  it("only GET/HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await rawRequest("/", { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "GET, HEAD");
    }
  });

  it("sends a small, stable fingerprint on every response", async () => {
    const res = await rawRequest("/");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.ok(!res.headers["server"] || res.headers["server"].includes("kicklive"), `server header was ${res.headers["server"]}`);
  });
});

describe("static server: the actual web build", () => {
  it("serves dist/web with every referenced asset resolvable", async () => {
    const distWeb = path.resolve(import.meta.dirname, "../..", "dist/web");
    if (!fs.existsSync(path.join(distWeb, "index.html"))) {
      console.log("  (skipped: dist/web is not built in this checkout — run npm run build:web)");
      return;
    }
    const built = await startStaticServer({ root: distWeb, port: 0, host: "127.0.0.1" });
    try {
      const index = await fetch(`${built.origin}/`);
      assert.equal(index.status, 200);
      const html = await index.text();
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("http") && !u.startsWith("data:") && !u.startsWith("#"));
      assert.ok(refs.length >= 2, `expected the built index.html to reference assets, found ${JSON.stringify(refs)}`);
      for (const ref of refs) {
        const clean = ref.startsWith("./") ? ref.slice(1) : ref;
        if (!clean.startsWith("/")) continue;
        const res = await fetch(`${built.origin}${clean}`);
        assert.equal(res.status, 200, `${clean} is referenced by index.html but 404s`);
        if (clean.endsWith(".js")) assert.match(res.headers.get("content-type") ?? "", /text\/javascript/, clean);
      }
      // The built service worker and manifest must be reachable and typed.
      const sw = await fetch(`${built.origin}/sw.js`);
      assert.equal(sw.status, 200);
      assert.match(sw.headers.get("content-type") ?? "", /text\/javascript/);
      const manifestRes = await fetch(`${built.origin}/site.webmanifest`);
      assert.equal(manifestRes.status, 200);
      assert.match(manifestRes.headers.get("content-type") ?? "", /application\/manifest\+json/);
      const version = JSON.parse(await (await fetch(`${built.origin}/version.json`)).text());
      assert.match(String(version.version), /^\d+\.\d+\.\d+/);
      // ...and a hashed asset that does not exist must 404, not fall back to the shell.
      const bogus = await fetch(`${built.origin}/assets/definitely-not-built-00000000.js`);
      assert.equal(bogus.status, 404);
    } finally {
      await built.close();
    }
  });
});

describe("static server: graceful behaviour under reuse", () => {
  it("keeps working when the root changes underneath it (dev hot-swap)", async () => {
    const before = await get("/version.json");
    assert.equal(JSON.parse(before.text).version, "1.0.0");
    const tmpFile = path.join(root, "version.json");
    fs.writeFileSync(tmpFile, JSON.stringify({ version: "1.0.1", sw: "/sw.js" }));
    const after = await get("/version.json");
    assert.equal(JSON.parse(after.text).version, "1.0.1", "no caching of file contents between requests");
    fs.writeFileSync(tmpFile, JSON.stringify({ version: "1.0.0", sw: "/sw.js" }));
  });

  it("survives a request with a huge path without crashing the process", async () => {
    const res = await rawRequest(`/${"a".repeat(9000)}.js`);
    assert.ok([400, 404, 414, 431].includes(res.status) || res.status === 0, `status ${String(res.status)}`);
    const alive = await get("/");
    assert.equal(alive.status, 200, "the server must still answer afterwards");
  });
});
