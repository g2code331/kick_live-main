#!/usr/bin/env node
/**
 * Run the Worker's real `fetch` handler on a local Node HTTP server — no `wrangler`, no Cloudflare.
 *
 *   npm run worker:local            # http://127.0.0.1:8787
 *   KICKLIVE_WORKER_PORT=4000 npm run worker:local
 *
 * Why this exists: `workers/src/index.ts` is a plain `(Request, Env, ExecutionContext) => Response`
 * function, and everything the API tier does *decides* — routing, JWT verification, the capability
 * matrix, validation, the envelope, CORS, cache and rate headers — runs on that signature. A Node
 * adapter therefore exercises the real handler, which is what `npm run dev` proxies `/api` to.
 *
 * What it is not: a Cloudflare runtime. There are no isolates, no `cfx` properties, no KV namespace and
 * no edge cache in front of it, so the rate limiter falls back to a per-process counter (and says so in
 * `x-ratelimit-store: memory`). Anything that depends on those bindings must be checked with
 * `wrangler dev`, and a deploy is still the only proof of the `routes`/custom-domain config.
 *
 * Config comes from `workers/.dev.vars` when present (git-ignored), otherwise the safe defaults below —
 * enough for `GET /api/health`, the 401/403 paths and the CORS preflight with no credentials at all.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.KICKLIVE_WORKER_PORT ?? 8787);

function devVars() {
  const file = path.join(REPO, "workers/.dev.vars");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = String(m[2])
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value.length > 0) out[m[1]] = value;
  }
  return out;
}

const env = {
  APP_ENV: "development",
  // A syntactically valid local endpoint, not a project. Real reads need `workers/.dev.vars`.
  SUPABASE_URL: "http://localhost:54321",
  ALLOWED_ORIGINS: "http://localhost:5000,http://127.0.0.1:5000",
  ...devVars(),
};

const worker = (await import(path.join(REPO, "workers/src/index.ts"))).default;

const executionContext = {
  waitUntil: (p) => {
    p.catch((err) => console.error("waitUntil rejected:", err));
  },
  passThroughOnException: () => undefined,
};

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      // Node hands `set-cookie` up as an array and everything else as a string; `append` keeps both faithful.
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.append(key, value);
    }
    // The connecting IP, from the socket rather than a header a client can forge.
    headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "unknown");

    let response;
    try {
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        body: BODYLESS.has(req.method ?? "GET") ? undefined : Buffer.concat(chunks),
      });
      response = await worker.fetch(request, env, executionContext);
    } catch (err) {
      console.error("worker-local: handler escaped an error:", err);
      response = new Response(JSON.stringify({ success: false, error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = Buffer.from(await response.arrayBuffer());
    const out = {};
    for (const [key, value] of response.headers) {
      if (out[key] === undefined) out[key] = value;
      else out[key] = `${out[key]}, ${value}`;
    }
    res.writeHead(response.status, out);
    res.end(body.length > 0 ? body : null);
  });
});

const missing = ["SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !env[k]);

server.listen(port, "0.0.0.0", () => {
  console.log(`worker-local: kick-live-api (Node adapter) on http://127.0.0.1:${String(port)}`);
  console.log(`  APP_ENV=${env.APP_ENV}  SUPABASE_URL=${env.SUPABASE_URL}  origins=${env.ALLOWED_ORIGINS}`);
  if (missing.length > 0) {
    console.log(`  unconfigured: ${missing.join(", ")} — signed-in routes will answer 500/401 until workers/.dev.vars exists`);
    console.log(`  (GET /api/health, the 401/403 paths and the CORS preflight work without them)`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
