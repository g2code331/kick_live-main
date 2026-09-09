/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** API Worker origin; "" (default) means same-origin `/api`. See src/lib/env.ts. */
  readonly VITE_API_BASE_URL?: string;
  /** Must be "1" for a dev build to point at a non-local API. */
  readonly VITE_API_ALLOW_REMOTE?: string;
  readonly VITE_UPDATE_MANIFEST_URL?: string;
  readonly VITE_UPDATE_CHANNEL?: string;
  readonly BASE_URL: string;
  readonly PROD: boolean;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Stamped by the Vite configs (see vite.config.ts / vite.renderer.config.ts). */
declare const __APP_VERSION__: string;
declare const __KICKLIVE_SHELL__: "web" | "desktop";

/** What `window.kicklive` looks like when running inside the desktop shell (see desktop/src/preload.ts). */
interface Window {
  kicklive?: import("../desktop/src/api.ts").DesktopApi;
}
