/**
 * Phase 5 · the notification vocabulary — the pure, dependency-free half.
 *
 * This module holds the list every layer agrees on (`notifications.kind`, `notification_preferences.kind`,
 * `notification_jobs.kind`, the Worker's policy) plus the small pure helpers that shape a preference
 * document. It imports NOTHING — deliberately: it is compiled into both the browser bundle AND the
 * Cloudflare Worker (via `workers/src/lib/notificationPolicy.ts`), and the Workers runtime has no
 * `import.meta.env`, no DOM `crypto`, and none of the API-client transport that `./notifications.ts`
 * pulls in. Keeping the vocabulary import-free is what lets both sides share one source of truth without
 * dragging browser globals into the Worker's typecheck.
 *
 * `tests/unit/phase5-notifications.test.ts` compares `NOTIFICATION_KINDS` against the three CHECK
 * constraints in the migrations, and `workers/src/lib/notificationPolicy.ts` against both. The defaults
 * here mirror `kicklive_preference_defaults()` so an optimistic switch never disagrees with the server's
 * first answer (the flicker a user reads as a bug); the `PUT /notifications/preferences` response is the
 * reconciliation path if they ever drift.
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
