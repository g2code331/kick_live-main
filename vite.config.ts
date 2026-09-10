import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { KICKLIVE_BUILD_DEFAULTS, kickliveVersion } from "./tools/vite-shared.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Web / PWA build.
 *
 * Output is `dist/web`: a normal multi-file bundle (hashed assets under /assets/, real
 * `Content-Type` per extension). `vite-plugin-singlefile` is deliberately NOT used here — an
 * inlined single file hides exactly the class of packaging bugs this pipeline is meant to catch
 * (asset 404s masquerading as HTML, module scripts served as text/html, absolute-path assumptions).
 */
export default defineConfig(() => {
  const version = kickliveVersion();
  return {
    root: __dirname,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "shared"),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __KICKLIVE_SHELL__: JSON.stringify("web"),
    },
    base: "/",
    build: {
      ...KICKLIVE_BUILD_DEFAULTS,
      outDir: path.resolve(__dirname, "dist/web"),
      sourcemap: process.env["KICKLIVE_SOURCEMAP"] === "1",
    },
    server: {
      host: "0.0.0.0",
      port: 5000,
      allowedHosts: true as const,
      // Phase 2: `/api` in the dev server means a local build talks to a *local* Worker
      // (`npm run worker:dev`, wrangler on 8787) and can never reach production by accident.
      // Relative URLs also keep working behind the preview host, which proxies by port, not by path.
      //
      // Phase 3 turns `ws` on, because `GET /api/live/matches/:id` is a WebSocket upgrade and without it a
      // dev console would fall back to SSE/polling and nobody would notice the socket path was broken until
      // deployment. It is a proxy of the same `/api` prefix, so no second port, no CORS exception and no
      // dev-only URL appear anywhere in the app. Under `scripts/worker-local.mjs` the upgrade still cannot
      // complete (Node's plain http server has no upgrade handling) — that is expected, and the room is
      // exercised there over SSE instead.
      proxy: {
        "/api": {
          target: process.env["KICKLIVE_WORKER_ORIGIN"] ?? "http://127.0.0.1:8787",
          changeOrigin: false,
          ws: true,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 5000,
      allowedHosts: true as const,
    },
  };
});
