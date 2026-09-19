/**
 * Which shell is asking for push, and therefore which token-acquisition path applies.
 *
 *   - `web`     — a browser (or the installed PWA). Token via the Firebase JS SDK + a service worker.
 *   - `android` — the Capacitor native shell on Android. Token via @capacitor/push-notifications, which
 *                 delegates to the OS/Google Play services; no Firebase JS SDK, no VAPID key.
 *   - `ios`     — the Capacitor native shell on iOS (APNs under FCM).
 *
 * The web PWA and the Capacitor app ship the SAME bundle (see capacitor.config.ts), so this cannot be a
 * build-time constant: it is decided at runtime from Capacitor's own platform report, with a plain-web
 * fallback when the native bridge is absent.
 */

import type { NotificationDevice } from '../data/notifications.ts';

export type PushPlatform = NotificationDevice['platform'];

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
  };
}

/** The native bridge, if this bundle is running inside the Capacitor shell; otherwise null. */
function capacitor(): NonNullable<CapacitorGlobal['Capacitor']> | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as CapacitorGlobal).Capacitor;
  return cap && typeof cap.getPlatform === 'function' ? cap : null;
}

/** True when running inside the native Android/iOS shell (as opposed to a browser or the PWA). */
export function isNativeShell(): boolean {
  const cap = capacitor();
  return cap?.isNativePlatform?.() === true;
}

/** The device platform to record against a registration, from the runtime shell. */
export function currentPlatform(): PushPlatform {
  const cap = capacitor();
  const p = cap?.getPlatform?.();
  if (p === 'android') return 'android';
  if (p === 'ios') return 'ios';
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) return 'web';
  return 'unknown';
}
