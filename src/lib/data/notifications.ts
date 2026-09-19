/**
 * Phase 5 · the notification vocabulary the client is allowed to know.
 *
 * This file is the browser's half of a list that exists in three places, and the reason it is a list in a
 * module rather than strings scattered through the settings screen: `notifications.kind`,
 * `notification_preferences.kind`, `notification_jobs.kind` and the Worker's policy all hold the same eleven
 * names, and a category the database calls `goal` and the UI calls `match_goal` does not produce an error
 * anywhere — it produces a switch a user turned on that nothing ever sends.
 * `tests/unit/phase5-notifications.test.ts` compares this array against the three CHECK constraints in
 * `supabase/migrations/20260911120000_phase5_notifications.sql`, and `workers/src/lib/notificationPolicy.ts`
 * against both.
 *
 * The defaults here are copied from `kicklive_preference_defaults()` in the same migration, deliberately:
 * the settings screen renders a state before the RPC answers, and an optimistic switch that disagrees with
 * the server's default is a flicker the user reads as a bug. If the two lists must ever disagree, the
 * `PUT /notifications/preferences` response replaces the document, which is the reconciliation path (§23).
 *
 * `channels` is an array for the same reason the column is: adding a medium is an element, not a migration.
 */

import { api } from '../api/index.ts';
import type { ApiResult } from '../api/index.ts';

export const NOTIFICATION_KINDS = [
  "goal",
  "red_card",
  "half_time",
  "full_time",
  "match_start",
  "match_reminder",
  "team_update",
  "competition_update",
  "news",
  "system",
  "announcement",
  "message",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ["inbox", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Mirror of `kicklive_preference_defaults()`. Anything not listed defaults off. */
export const PREFERENCE_DEFAULTS: Record<NotificationKind, boolean> = {
  goal: true,
  full_time: true,
  half_time: true,
  match_start: true,
  system: true,
  announcement: true,
  message: true,
  red_card: false,
  match_reminder: false,
  team_update: false,
  competition_update: false,
  news: false,
};

/**
 * What each switch means to a person, in the app's own register: a sentence, not a promise. Anything the
 * backend can send but this phase does not is labelled by its category rather than hidden, because a switch
 * that does nothing is worse than a switch that says it is waiting for something.
 */
export const KIND_LABELS: Record<NotificationKind, { label: string; description: string }> = {
  goal: { label: "Goals", description: "When a match you are following scores" },
  red_card: { label: "Red cards", description: "Sending-off, if you want the noise" },
  half_time: { label: "Half time", description: "The break, with the score" },
  full_time: { label: "Full time", description: "The final whistle" },
  match_start: { label: "Kick-off", description: "When a match you are watching begins" },
  match_reminder: { label: "Starting soon", description: "A nudge before kick-off" },
  team_update: { label: "Team news", description: "Announcements from the clubs" },
  competition_update: { label: "Competitions", description: "Fixtures and standings moves" },
  news: { label: "News", description: "Stories, when there are any" },
  system: { label: "Account", description: "Things about your KickLive account" },
  announcement: { label: "Announcements", description: "League-wide notices" },
  message: { label: "Messages", description: "Replies from the KickLive team" },
};

export interface NotificationPreferenceEntry {
  enabled: boolean;
  channels: NotificationChannel[];
}

export interface NotificationPreferences {
  notificationsEnabled: boolean;
  categories: Record<NotificationKind, NotificationPreferenceEntry>;
}

/** The whole document, built from a partial server response — the shape `PUT` accepts and returns. */
export function preferencesDocument(partial: Partial<NotificationPreferences> | null | undefined): NotificationPreferences {
  const categories = {} as NotificationPreferences["categories"];
  for (const kind of NOTIFICATION_KINDS) {
    const entry = partial?.categories?.[kind];
    categories[kind] = {
      enabled: entry?.enabled ?? PREFERENCE_DEFAULTS[kind],
      channels: entry?.channels?.length ? entry.channels : ["inbox", "push"],
    };
  }
  return { notificationsEnabled: partial?.notificationsEnabled ?? true, categories };
}

/** A single switch's worth of change, as the PUT document the Worker expects (full-document semantics). */
export function withCategory(current: NotificationPreferences, kind: NotificationKind, patch: Partial<NotificationPreferenceEntry>): NotificationPreferences {
  const entry = current.categories[kind];
  return preferencesDocument({ ...current, categories: { ...current.categories, [kind]: { ...entry, ...patch } } });
}

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
