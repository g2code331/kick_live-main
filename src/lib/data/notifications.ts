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

/** A device row, as the API returns it: never a token, because a settings screen has no reason to read one. */
export interface NotificationDevice {
  id: string;
  provider: "fcm" | "webpush";
  platform: "android" | "ios" | "web" | "unknown";
  app_id?: string | null;
  active: boolean;
  created_at: string;
  last_seen_at?: string | null;
  last_sent_at?: string | null;
  has_failures?: boolean;
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
