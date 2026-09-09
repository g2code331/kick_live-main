/**
 * Renderer-side runtime detection + the privileged desktop bridge.
 *
 * `__KICKLIVE_SHELL__` is baked in at build time (web vs desktop), and `window.kicklive` only
 * exists when the preload script ran. Everything here must be safe to import in the web build.
 */

import type { DesktopApi } from "../../desktop/src/api.ts";

export type Shell = "web" | "desktop";

export const SHELL: Shell = typeof __KICKLIVE_SHELL__ === "undefined" ? "web" : __KICKLIVE_SHELL__;
export const APP_VERSION: string = typeof __APP_VERSION__ === "undefined" ? "0.0.0-dev" : __APP_VERSION__;

export function isDesktop(): boolean {
  return SHELL === "desktop" && desktopApi() !== null;
}

export function desktopApi(): DesktopApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { kicklive?: DesktopApi }).kicklive;
  return api && typeof api.getVersion === "function" ? api : null;
}

/**
 * Asset URLs must work from `file://…/renderer/dist/index.html` (desktop) and from `/` (web).
 * Vite's `base` is `./` for the renderer build, so `import.meta.env.BASE_URL` + a path relative to
 * the document is the only form that is correct in both. Absolute `/foo.png` silently becomes
 * `file:///foo.png` on desktop.
 */
export function assetUrl(name: string): string {
  const clean = name.replace(/^\.?\//, "");
  if (typeof document === "undefined") return `./${clean}`;
  const base = document.baseURI || window.location.href;
  try {
    return new URL(`./${clean}`, base).toString();
  } catch {
    return `./${clean}`;
  }
}

/** Where the renderer is being served from; used in the desktop header tooltip and smoke output. */
export function loadSource(): string {
  if (typeof window === "undefined") return "node";
  return window.location.protocol === "file:" ? "asar-file" : `http:${new URL(window.location.href).host}`;
}
