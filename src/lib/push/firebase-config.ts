/**
 * The browser's PUBLIC Firebase config — the values a web app needs to obtain an FCM registration
 * token. Every field here is public by design, exactly like the Supabase anon key: it identifies the
 * project to Google's SDK, and authorisation to actually *send* a push still lives entirely in the
 * Worker's service-account secret (`FCM_SERVICE_ACCOUNT`), which the browser never sees.
 *
 * Why env-gated rather than committed constants: the repo's whole configuration philosophy (see
 * `src/lib/env.ts`) is that a bundle carries no hardcoded project. When these vars are unset — the
 * default today — push simply reports itself unconfigured and the app degrades to the in-app inbox
 * (the bell). Nothing throws; a football score should never be gated on a Firebase key existing.
 *
 * Supply them by adding `VITE_FIREBASE_*` to `workers/wrangler.toml`'s `[env.<env>.vars]` and running
 * `npm run web:env` (the generator passes them through), or by exporting them for a one-off build.
 * All five values come from Firebase console → Project settings → your web app; the VAPID key is under
 * Cloud Messaging → Web configuration → "Web Push certificates".
 */

function read(name: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  /** Web Push certificate public key. Required by getToken(); without it a web token cannot be minted. */
  vapidKey: string;
}

/**
 * The four fields `initializeApp` needs plus the VAPID key `getToken` needs. `authDomain` is derived
 * from the project id when omitted (the console default is `<projectId>.firebaseapp.com`), so an
 * operator only has to paste the values Firebase highlights.
 */
export function getFirebaseConfig(): FirebaseWebConfig | null {
  const apiKey = read('VITE_FIREBASE_API_KEY');
  const projectId = read('VITE_FIREBASE_PROJECT_ID');
  const messagingSenderId = read('VITE_FIREBASE_MESSAGING_SENDER_ID');
  const appId = read('VITE_FIREBASE_APP_ID');
  const vapidKey = read('VITE_FIREBASE_VAPID_KEY');
  if (!apiKey || !projectId || !messagingSenderId || !appId || !vapidKey) return null;
  const authDomain = read('VITE_FIREBASE_AUTH_DOMAIN') || `${projectId}.firebaseapp.com`;
  return { apiKey, authDomain, projectId, messagingSenderId, appId, vapidKey };
}

/**
 * Cheap, throw-free "is web push even wired for this deployment?" check. Used by the settings screen to
 * decide between offering an opt-in button and explaining that push is not configured. Deliberately
 * mirrors `isSupabaseConfigured()` — a boolean, no decoding, no side effects.
 */
export function isPushConfigured(): boolean {
  return getFirebaseConfig() !== null;
}
