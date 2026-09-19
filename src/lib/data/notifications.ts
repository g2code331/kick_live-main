/**
 * Phase 5 · the notification API client — the browser's transport half.
 *
 * The vocabulary itself (the kind list, defaults, labels, and the pure document helpers) lives in the
 * import-free `./notification-vocab.ts`, because that list is also compiled into the Cloudflare Worker
 * (`workers/src/lib/notificationPolicy.ts`) and the Workers runtime has none of the browser globals this
 * file's `api` transport depends on (`import.meta.env`, DOM `crypto`). This module re-exports the
 * vocabulary so every existing `from '.../notifications.ts'` import keeps working, and adds the functions
 * that actually talk to the API.
 */

import { api } from '../api/index.ts';
import type { ApiResult } from '../api/index.ts';

export {
  NOTIFICATION_KINDS,
  NOTIFICATION_CHANNELS,
  PREFERENCE_DEFAULTS,
  KIND_LABELS,
  preferencesDocument,
  withCategory,
} from './notification-vocab.ts';
export type {
  NotificationKind,
  NotificationChannel,
  NotificationPreferenceEntry,
  NotificationPreferences,
} from './notification-vocab.ts';

// Imported (not just re-exported) because this file's own functions reference them directly.
import { preferencesDocument } from './notification-vocab.ts';
import type { NotificationKind, NotificationPreferences } from './notification-vocab.ts';

/** Read the caller's own preference document (defaults filled in for any category never toggled). */
export async function loadNotificationPreferences(): Promise<NotificationPreferences> {
  const res: ApiResult<Partial<NotificationPreferences>> =
    await api.get<Partial<NotificationPreferences>>('/notifications/preferences');
  return preferencesDocument(res.ok ? res.data : null);
}

/**
 * Save the whole preference document. Full-document semantics: an omitted category is an off switch, so we
 * always send the complete set. Returns the server's stored document (the reconciliation path).
 */
export async function saveNotificationPreferences(
  prefs: NotificationPreferences,
): Promise<ApiResult<Partial<NotificationPreferences>>> {
  return api.put<Partial<NotificationPreferences>>('/notifications/preferences', {
    enabled: prefs.notificationsEnabled,
    categories: prefs.categories,
  });
}

export interface InboxPage {
  items: NotificationItem[];
  unread: number;
}

/** The caller's notification inbox: their own rows plus broadcasts, newest/most-important first. */
export async function loadInbox(limit = 20): Promise<InboxPage> {
  const res = await api.get<InboxPage>('/notifications/inbox', { query: { limit } });
  return res.ok ? { items: res.data.items ?? [], unread: res.data.unread ?? 0 } : { items: [], unread: 0 };
}

/** Mark one notification read. */
export function markNotificationRead(id: number): Promise<ApiResult<unknown>> {
  return api.post(`/notifications/inbox/${id}/read`, {});
}

/** Mark every notification read. */
export function markAllNotificationsRead(): Promise<ApiResult<unknown>> {
  return api.post('/notifications/inbox/read-all', {});
}

/** A device row, as the API returns it: never a token, because a settings screen has no reason to read one. */
export interface NotificationDevice {
  id: string;
  provider: 'fcm' | 'webpush';
  platform: 'android' | 'ios' | 'web' | 'unknown';
  appId: string | null;
  active: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  lastSentAt: string | null;
}

/** What the settings screen needs to render itself — including whether this deployment can push at all. */
export interface NotificationConfig {
  kinds: NotificationKind[];
  defaults: Record<string, boolean>;
  limits: { maxDevices: number; titleMaxChars: number; bodyMaxChars: number; inboxPageSizeMax: number };
  /** `mock` means no FCM project is configured; the UI must not promise a buzz it cannot deliver. */
  transport: 'fcm' | 'mock';
}

/** Public config for the notification settings screen (categories, defaults, limits, transport). */
export async function loadNotificationConfig(): Promise<NotificationConfig | null> {
  const res = await api.get<NotificationConfig>('/notifications/config');
  return res.ok ? res.data : null;
}

/** The caller's registered push devices, newest first. */
export async function listDevices(): Promise<NotificationDevice[]> {
  const res = await api.get<{ devices: NotificationDevice[] }>('/notifications/devices');
  return res.ok ? (res.data.devices ?? []) : [];
}

/** Register a push token for this browser/device. */
export function registerDevice(input: {
  token: string;
  platform: NotificationDevice['platform'];
  provider?: NotificationDevice['provider'];
  appId?: string;
}): Promise<ApiResult<{ id: string }>> {
  return api.post('/notifications/devices', input);
}

/** Revoke a registered device by id. */
export function deleteDevice(id: string): Promise<ApiResult<unknown>> {
  return api.del(`/notifications/devices/${id}`);
}

export interface NotificationItem {
  id: number;
  title: string;
  body: string;
  kind: NotificationKind;
  matchId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  priority: number;
  broadcast: boolean;
}
