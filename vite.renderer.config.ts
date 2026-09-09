import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { KICKLIVE_BUILD_DEFAULTS, kickliveVersion } from "./tools/vite-shared.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Desktop renderer build (packed inside the Electron asar at `renderer/dist`).
 *
 * Differences from the web build, both of them load-bearing:
 *  - `base: "./"` so `file://` loads resolve their own assets (no `/assets/...` at the
 *    filesystem root, which is the #1 "white window" cause in packaged Electron apps);
 *  - no service worker: the desktop shell owns caching, and SW registration over `file://`
 *    only produces console noise.
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
      __KICKLIVE_SHELL__: JSON.stringify("desktop"),
    },
    base: "./",
    build: {
      ...KICKLIVE_BUILD_DEFAULTS,
      outDir: path.resolve(__dirname, "renderer/dist"),
      sourcemap: false,
    },
    server: { host: "127.0.0.1", port: 5199 },
  };
});
