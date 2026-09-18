/**
 * Admin application settings — a persisted, client-side settings store.
 *
 * There is no server-side settings table wired to the browser, so "working settings" here means a
 * store that (1) persists across reloads in localStorage, (2) exposes a typed shape the settings
 * page reads and writes, and (3) notifies subscribers so anything in the app can react to a change.
 * When a Worker-backed settings endpoint lands, only `load`/`save` need to change — the page and its
 * consumers keep working against the same shape.
 */

export type AdminSettings = {
  // Core functionality
  liveStreaming: boolean;
  predictions: boolean;
  userComments: boolean;
  notifications: boolean;
  registrationOpen: boolean;
  // Security & data
  maintenanceMode: boolean;
  dataAutoSync: boolean;
  twoFactorRequired: boolean;
  auditLogging: boolean;
  // Presentation
  theme: "dark" | "light";
  compactMode: boolean;
  showScoreAnimations: boolean;
  // Operations
  autoPublishResults: boolean;
  defaultMatchDuration: number; // minutes
  seasonLabel: string;
};

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  liveStreaming: true,
  predictions: true,
  userComments: true,
  notifications: true,
  registrationOpen: true,
  maintenanceMode: false,
  dataAutoSync: true,
  twoFactorRequired: false,
  auditLogging: true,
  theme: "dark",
  compactMode: false,
  showScoreAnimations: true,
  autoPublishResults: false,
  defaultMatchDuration: 90,
  seasonLabel: "2025/26",
};

export const ADMIN_SETTINGS_KEY = "kicklive.admin.settings.v1";

/** Read the persisted settings, merged over the defaults so a new field is never `undefined`. */
export function loadAdminSettings(): AdminSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_ADMIN_SETTINGS };
  try {
    const raw = localStorage.getItem(ADMIN_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ADMIN_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AdminSettings>;
    return { ...DEFAULT_ADMIN_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_ADMIN_SETTINGS };
  }
}

/** Persist the settings and broadcast the change to any subscriber (and other tabs). */
export function saveAdminSettings(settings: AdminSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(settings));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent<AdminSettings>("kicklive:admin-settings", { detail: settings }));
    }
  } catch {
    /* quota / private mode: the page keeps working in memory, just without persistence */
  }
}

/** Subscribe to settings changes (same tab via the custom event, other tabs via `storage`). */
export function onAdminSettingsChange(cb: (settings: AdminSettings) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const local = (e: Event): void => cb((e as CustomEvent<AdminSettings>).detail);
  const cross = (e: StorageEvent): void => {
    if (e.key === ADMIN_SETTINGS_KEY) cb(loadAdminSettings());
  };
  window.addEventListener("kicklive:admin-settings", local as EventListener);
  window.addEventListener("storage", cross);
  return () => {
    window.removeEventListener("kicklive:admin-settings", local as EventListener);
    window.removeEventListener("storage", cross);
  };
}
