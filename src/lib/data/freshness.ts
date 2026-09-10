/**
 * KICKLIVE · the freshness classes (Phase 4 §4.3)
 *
 * Before this, "how old is too old" had six answers in six components (10 s, 30 s, 5 min, "on mount",
 * "on filter change", "never"). They are not free-form: a team's name and a match's minute are different
 * problems, and the only reason a football app polls at all is the second one.
 *
 * A TTL here is a **floor on the age of what may be served**, not a schedule. Nothing wakes up to refresh a
 * `slow` key because ten minutes passed in a closed tab; polling is opt-in per screen (`usePolledQuery`), and
 * a key nobody is looking at is not polled at all.
 */

export const SECOND = 1000;

export const FRESHNESS = {
  /** A number that is moving. Kept warm only while a screen is open, and never the source for a live
   *  match's score — that is the room's job (`src/lib/live/useMatchRoom.ts`). */
  live: 5 * SECOND,
  /** The default for a football list a fan watches: one refresh per half-minute per open screen, shared. */
  fast: 30 * SECOND,
  /** A page the user asked for: fresh on mount, reused on Back, revalidated when a mutation touches it. */
  page: 2 * 60 * SECOND,
  /** Nearly-static vocabulary: clubs, competitions, seasons. Persisted, and revalidated, not polled. */
  slow: 10 * 60 * SECOND,
  /** As long as a session: `profiles` for the signed-in user, invalidated by an auth change. */
  session: 6 * 60 * 60 * SECOND,
} as const;

export type FreshnessClass = keyof typeof FRESHNESS;

/** `?updated=3 min ago` labels and the "why is this grey" rule in the architecture doc §4.4. */
export function describeAge(ageMs: number): string {
  if (ageMs < 15 * SECOND) return "just now";
  if (ageMs < 60 * SECOND) return `${Math.floor(ageMs / SECOND)} s ago`;
  if (ageMs < 60 * 60 * SECOND) return `${Math.floor(ageMs / (60 * SECOND))} min ago`;
  return `${Math.floor(ageMs / (60 * 60 * SECOND))} h ago`;
}

export function isPastBudget(ageMs: number, budgetMs: number): boolean {
  return ageMs > budgetMs;
}

/**
 * Statuses, from `matches.status`'s CHECK list in `KICKLIVE_FINAL_SCHEMA.sql` — the vocabulary the live
 * engine shares (`workers/src/lib/matchLifecycle.ts`), not a browser-side invention.
 *
 * `finished` is in `LEGACY_DONE` and nowhere else, because the superseded `MatchControlComplete` used to
 * write it: a read that asks for it can only ever be tolerating rows the CHECK constraint refuses, and a
 * read that *omits* it would make a legacy row vanish from a fan's screen. So the tolerance is one named
 * constant, in the reads, and never in a write.
 */
export const STATUS = {
  upcoming: ["scheduled", "waiting"],
  live: ["live", "first_half", "half_time", "second_half", "extra_time", "penalty_shootout"],
  paused: ["suspended"],
  done: ["full_time", "completed"],
  stopped: ["postponed", "abandoned", "cancelled"],
} as const;

export const LEGACY_DONE: readonly string[] = ["finished"];

export const DONE_STATUSES: readonly string[] = [...STATUS.done, ...LEGACY_DONE];
export const LIVE_STATUSES: readonly string[] = [...STATUS.live];
export const UPCOMING_STATUSES: readonly string[] = [...STATUS.upcoming];

export function isLiveStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && LIVE_STATUSES.includes(status);
}

export function isDoneStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && DONE_STATUSES.includes(status);
}
