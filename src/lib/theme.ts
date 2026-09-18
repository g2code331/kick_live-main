/**
 * Applies the admin presentation settings to the document root so they take VISIBLE effect, not just
 * persist as flags. Three attributes on <html> drive CSS in src/index.css:
 *   - data-theme="light" | "dark"      → the palette variables (background, text, glass surfaces, inputs)
 *   - data-density="compact" | "cozy"   → tighter paddings/gaps across panels
 *   - data-animations="on" | "off"      → halts the decorative pulse/breathe/float loops
 *
 * `startThemeSync()` is called once at boot (src/main.tsx). It applies the current settings immediately and
 * then re-applies on every change (same tab via the custom event, other tabs via `storage`). It is safe to
 * call in any environment: it no-ops when there is no `document`.
 */
import { loadAdminSettings, onAdminSettingsChange, type AdminSettings } from './admin-settings';

export function applyTheme(settings: AdminSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme === 'light' ? 'light' : 'dark');
  root.setAttribute('data-density', settings.compactMode ? 'compact' : 'cozy');
  root.setAttribute('data-animations', settings.showScoreAnimations ? 'on' : 'off');
}

let started = false;

export function startThemeSync(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  // Apply whatever is persisted right away so the first paint already honours the saved theme.
  applyTheme(loadAdminSettings());
  if (started) return () => undefined;
  started = true;
  return onAdminSettingsChange((next) => applyTheme(next));
}
