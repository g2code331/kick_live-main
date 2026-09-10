/**
 * The notification policy: what a server-side fact means to a phone.
 *
 * The brief asks for "one module that defines which events generate notifications" rather than rules scattered
 * across routes, and the scattering it is preventing is worse than duplication — it is *divergence*. A goal
 * whose copy lives in the sender and whose category lives in the settings screen is a bug that only appears on
 * someone's lock screen. So this file owns the vocabulary, the defaults, the copy, the audience selector, and
 * the priority; the settings screen imports the labels, the queue consumer imports the copy, and the SQL owns
 * the constraints that must hold even when the Worker is not the one asking.
 *
 * What it deliberately does **not** own is `match_events.event_type`. That enum belongs to the database (29
 * values, Phase 3), and this file maps a named subset of it onto the eleven categories. An unmapped event type
 * produces no notification — silence is the correct answer to "we did not decide", not a generic push.
 *
 * The same list is written again as CHECK constraints in
 * `supabase/migrations/20260911120000_phase5_notifications.sql` because Postgres must hold the rule even when
 * something writes to these tables without the Worker. `tests/unit/phase5-notifications.test.ts` compares the
 * two and fails the build if they drift.
 */
import { NOTIFICATION_KINDS, PREFERENCE_DEFAULTS } from "../../../src/lib/data/notifications.ts";

/** Categories a user can toggle. Mirrors `notification_preferences.kind`. */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_PRIORITY: Record<NotificationKind, number> = {
  goal: 80,
  red_card: 60,
  half_time: 50,
  full_time: 70,
  match_start: 55,
  match_reminder: 40,
  team_update: 30,
  competition_update: 25,
  news: 20,
  system: 45,
  announcement: 35,
};

/**
 * How long an inbox row stays visible. Push is already gone from the lock screen after a match; keeping the
 * record forever would make the badge a museum. `null` = keep until dismissed.
 */
export const NOTIFICATION_TTL_HOURS: Record<NotificationKind, number | null> = {
  goal: null,
  red_card: null,
  half_time: null,
  full_time: null,
  match_start: null,
  match_reminder: 6,
  team_update: 24 * 30,
  competition_update: 24 * 30,
  news: 24 * 14,
  system: null,
  announcement: 24 * 14,
};

/** Which kinds are allowed to reach a device at all, whatever the recipient's preference says. */
export const PUSHABLE_KINDS: readonly NotificationKind[] = ["goal", "red_card", "half_time", "full_time", "match_start", "match_reminder", "system", "announcement"];

/**
 * The event→category map. `second_yellow` is a red card by definition; a penalty and an own goal are both
 * goals, because the category a user subscribed to is "a goal happened in a match I care about", not the
 * taxonomy of the pitch — the difference lives in `metadata.eventType`, which the client renders.
 *
 * `match_abandoned` is deliberately absent (see the migration's comment). `substitution`, `corner`, `var_check`
 * and the rest of the 29 are absent because nobody asked for them on a lock screen.
 */
export const EVENT_TO_KIND: Readonly<Partial<Record<string, NotificationKind>>> = {
  goal: "goal",
  penalty_goal: "goal",
  own_goal: "goal",
  red_card: "red_card",
  second_yellow: "red_card",
  half_time: "half_time",
  extra_time_half_time: "half_time",
  full_time: "full_time",
  kickoff: "match_start",
  second_half_start: "match_start",
};

/** The kinds an admin may send. A broadcast must never be able to impersonate a match fact. */
export const BROADCAST_KINDS: readonly NotificationKind[] = ["announcement", "system", "news", "competition_update", "team_update"];

/**
 * Copy limits, enforced here and again in the schema (`kicklive_broadcast_notification`), because the two
 * writers of a notification body are the two places a too-long string must not survive.
 */
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 480;

/**
 * Where match copy is authored, and why it is not authored here.
 *
 * A goal's title and body are built by the `AFTER INSERT` trigger on `match_events` (see §8 of
 * docs/NOTIFICATIONS_ARCHITECTURE.md), in the same transaction as the event row. This module therefore does
 * *not* contain a `buildGoalNotification(...)` — the Worker's role is to decide who receives a job and what
 * happens to the send, not to write the sentence. Putting the copy here as well would have created exactly the
 * divergence this file exists to prevent: the trigger's text for events, the Worker's text for whatever path it
 * originates, and a fan seeing both.
 *
 * The one kind of content the Worker does originate is an admin broadcast, and it forwards the admin's own
 * title/body verbatim after `validateCopy` — no templates, no rephrasing, nothing invented.
 */
export function validateCopy(title: string, body: string): string | null {
  if (title.trim().length === 0) return "title must not be empty";
  if (title.length > MAX_TITLE_CHARS) return `title must be ${String(MAX_TITLE_CHARS)} characters or fewer`;
  if (body.trim().length === 0) return "body must not be empty";
  if (body.length > MAX_BODY_CHARS) return `body must be ${String(MAX_BODY_CHARS)} characters or fewer`;
  return null;
}

/** How many minutes before kick-off a reminder is worth sending. 0 disables reminders entirely. */
export const REMINDER_LEAD_MINUTES = 15;

/** Devices per FCM send. Above this a goal's fan-out becomes a burst Google will throttle. */
export const FCM_BATCH_SIZE = 500;

/** Batches in flight at once per job. See docs/NOTIFICATIONS_ARCHITECTURE.md §13. */
export const FCM_BATCH_CONCURRENCY = 5;

/** Retries before a job is left `failed` for the operator to see. */
export const JOB_MAX_ATTEMPTS = 6;

/** Strikes before a device leaves the audience without anyone dying. */
export const DEVICE_FAILURE_LIMIT = 5;

/** Rows the sweep picks up per run. The sweep must never be the heaviest thing on the minute. */
export const SWEEP_LIMIT = 25;

export function preferenceDefaults(): Record<NotificationKind, boolean> {
  return { ...PREFERENCE_DEFAULTS };
}

export function isKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export { NOTIFICATION_KINDS };
