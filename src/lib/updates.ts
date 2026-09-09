/**
 * Renderer update plumbing.
 *
 * Two wiring modes, one policy:
 *  - desktop: the main process owns the controller (so the prompt latch, snooze and the privileged
 *    installer all live in one place); the renderer only renders `UpdateView` and forwards actions;
 *  - web/PWA: the renderer owns the controller, persisting to localStorage, and "install" means
 *    "activate the waiting service worker and reload".
 */

import type { DesktopApi, UpdateView } from "../../desktop/src/api.ts";
import type { Channel } from "../../shared/update-manifest.ts";
import type { UpdateStore, UpdateStorage } from "../../shared/update-controller.ts";
import { createUpdateController } from "../../shared/update-controller.ts";
import { resolveChannel, resolveManifestUrl } from "../../shared/update-client.ts";
import { APP_VERSION, desktopApi, SHELL } from "./app-shell.ts";

export const UPDATE_STORAGE_KEY = "kicklive.updates.v1";

function localStorageStorage(): UpdateStorage {
  return {
    async load(): Promise<UpdateStore | null> {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(UPDATE_STORAGE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as UpdateStore;
        if (parsed && parsed.schemaVersion === 1) return parsed;
      } catch {
        /* corrupt store -> treat as empty */
      }
      return null;
    },
    async save(store: UpdateStore): Promise<void> {
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.setItem(UPDATE_STORAGE_KEY, JSON.stringify(store));
      } catch {
        /* private mode / quota: updates still work, just without memory */
      }
    },
  };
}

export type UpdateControllerHandle = ReturnType<typeof createUpdateController>;

let webController: UpdateControllerHandle | null = null;

export function webChannel(): Channel {
  return resolveChannel(import.meta.env as unknown as Record<string, string | undefined>);
}

export function webManifestUrl(): string {
  return resolveManifestUrl({ env: import.meta.env as unknown as Record<string, string | undefined>, channel: webChannel() });
}

export function isDesktopShell(): boolean {
  return SHELL === "desktop";
}

export function getWebController(): UpdateControllerHandle {
  if (!webController) {
    webController = createUpdateController({
      surface: "pwa",
      currentVersion: APP_VERSION,
      channel: webChannel(),
      storage: localStorageStorage(),
      manifestUrl: webManifestUrl(),
      log: (line) => console.info(line),
      onReload: async () => {
        const registration = await navigator.serviceWorker?.getRegistration?.();
        // The waiting worker only activates when it tells itself to skipWaiting (a page cannot).
        registration?.waiting?.postMessage({ type: "KICKLIVE_SKIP_WAITING" });
        window.location.reload();
      },
    });
  }
  return webController;
}

/** The desktop path: read/write through the privileged main-process controller over IPC. */
export const desktopUpdates = {
  available(api: DesktopApi | null = desktopApi()): boolean {
    return api !== null;
  },
  async view(api: DesktopApi): Promise<UpdateView> {
    return api.checkForUpdates();
  },
  async startupView(api: DesktopApi): Promise<UpdateView | null> {
    return api.startupUpdateState();
  },
  async snooze(api: DesktopApi, hours?: number): Promise<UpdateView> {
    return api.snoozeUpdate(hours);
  },
  async install(api: DesktopApi): Promise<{ ok: boolean; detail: string }> {
    return api.installUpdate();
  },
};

export type { UpdateView };
