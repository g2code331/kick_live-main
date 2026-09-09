/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
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
