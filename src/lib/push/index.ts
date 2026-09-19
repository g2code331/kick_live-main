/**
 * Push opt-in — the client half of the notification chain, and the one piece the Worker cannot do for
 * itself: obtain a device registration token and hand it to `POST /notifications/devices`.
 *
 * Everything from there on already exists. A goal (or a staff reply, an announcement…) writes a
 * `notification_job`; the Worker's cron sweep materialises it and, for kinds in `PUSHABLE_KINDS`, calls
 * `workers/src/services/fcm.ts`, which posts a real FCM `messages:send` to every registered device. The
 * only missing link was a token to register — this module mints one.
 *
 * Two token paths, chosen at runtime by shell (see ./platform.ts):
 *
 *   web     — Firebase JS SDK: initializeApp(publicConfig) → getToken(messaging, { vapidKey, sw }). The
 *             service worker that receives background pushes is /firebase-messaging-sw.js, generated at
 *             build time with the same public config baked in (scripts/build-firebase-sw.mjs).
 *   android — @capacitor/push-notifications: request permission, then register(); the OS returns the FCM
 *             token via the 'registration' event. No Firebase JS SDK, no VAPID key.
 *
 * Design rules mirrored from the rest of the app:
 *   - Dynamic import()s, so `firebase` (~a lot of KB) and the Capacitor plugin never enter the boot chunk;
 *     a user who never opts in never downloads them.
 *   - Degrade, never throw at the app: an unconfigured deployment, a denied permission, or an
 *     unsupported browser returns a typed failure the settings screen renders — a score is never gated
 *     on push existing.
 */

import { registerDevice } from '../data/notifications.ts';
import { getFirebaseConfig, isPushConfigured } from './firebase-config.ts';
import { currentPlatform, isNativeShell } from './platform.ts';

export { isPushConfigured } from './firebase-config.ts';
export { currentPlatform, isNativeShell } from './platform.ts';

export type PushOptInResult =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; reason: PushFailureReason; message: string };

export type PushFailureReason =
  | 'unconfigured' // this deployment has no Firebase config (the default today)
  | 'unsupported' // the browser/shell cannot do push at all
  | 'denied' // the user (or the OS) refused the permission prompt
  | 'no-token' // permission granted but no token came back
  | 'register-failed' // the token was minted but the API rejected it
  | 'error'; // anything unexpected on the way

/** `Notification.permission` without assuming the API exists (it does not on iOS Safari < 16.4, etc.). */
export function currentPermission(): NotificationPermission | 'unsupported' {
  if (isNativeShell()) return 'default';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * The whole opt-in, end to end: acquire a token for this shell and register it. Idempotent on the
 * server (re-registering the same token just refreshes its `last_seen_at`), so calling it again after a
 * permission is already granted is a cheap way to keep the token fresh.
 */
export async function enablePush(): Promise<PushOptInResult> {
  try {
    return isNativeShell() ? await enableNativePush() : await enableWebPush();
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'Push could not be enabled.' };
  }
}

async function enableWebPush(): Promise<PushOptInResult> {
  const config = getFirebaseConfig();
  if (!config) return { ok: false, reason: 'unconfigured', message: 'Push delivery is not configured for this deployment.' };
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof Notification === 'undefined') {
    return { ok: false, reason: 'unsupported', message: 'This browser does not support web push notifications.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied', message: 'Notification permission was not granted.' };
  }

  // Loaded lazily so the SDK stays out of the boot chunk; only an opt-in ever pays for it.
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
  ]);

  if (!(await isSupported())) {
    return { ok: false, reason: 'unsupported', message: 'This browser does not support the Firebase Messaging APIs.' };
  }

  const app = getApps().length ? getApps()[0]! : initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  });

  // The dedicated messaging SW receives background pushes; it is generated at build time with the same
  // public config (scripts/build-firebase-sw.mjs). Registering it explicitly (rather than letting the SDK
  // guess) is what lets the app SW (/sw.js) and the messaging SW coexist.
  const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });

  const token = await getToken(getMessaging(app), { vapidKey: config.vapidKey, serviceWorkerRegistration: swReg });
  if (!token) return { ok: false, reason: 'no-token', message: 'The browser did not return a push token.' };

  return finishRegistration(token, 'web', 'webpush');
}

async function enableNativePush(): Promise<PushOptInResult> {
  const { PushNotifications } = await import('@capacitor/push-notifications');

  const status = await PushNotifications.checkPermissions();
  let receive = status.receive;
  if (receive === 'prompt' || receive === 'prompt-with-rationale') {
    receive = (await PushNotifications.requestPermissions()).receive;
  }
  if (receive !== 'granted') {
    return { ok: false, reason: 'denied', message: 'Notification permission was not granted.' };
  }

  // register() resolves before the token arrives — the token comes on the 'registration' event — so wrap
  // the one-shot listener in a promise with a timeout, then hand the token to the API.
  const token = await new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      void regHandle.then((h) => h.remove());
      void errHandle.then((h) => h.remove());
      resolve(value);
    };
    const regHandle = PushNotifications.addListener('registration', (t: { value: string }) => done(t.value));
    const errHandle = PushNotifications.addListener('registrationError', () => done(null));
    void PushNotifications.register();
    setTimeout(() => done(null), 15000);
  });

  if (!token) return { ok: false, reason: 'no-token', message: 'The device did not return a push token.' };
  return finishRegistration(token, currentPlatform(), 'fcm');
}

async function finishRegistration(
  token: string,
  platform: 'android' | 'ios' | 'web' | 'unknown',
  provider: 'fcm' | 'webpush',
): Promise<PushOptInResult> {
  const res = await registerDevice({ token, platform, provider, appId: 'com.kicklive.app' });
  if (!res.ok) {
    return { ok: false, reason: 'register-failed', message: res.message || 'The server rejected the device registration.' };
  }
  return { ok: true, deviceId: res.data.id, token };
}

/** True when this deployment could offer push at all: configured web, or the native shell. */
export function canOfferPush(): boolean {
  return isNativeShell() || isPushConfigured();
}
