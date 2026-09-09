/**
 * The match state machine — one table, owned by the server.
 *
 * Every one of the ten Match Control variants kept its own idea of the lifecycle in component state
 * (`setStatus('live')`, a `finished` status that the database CHECK rejects, an unlock modal behind a
 * string literal in the bundle). This module is the replacement for all of them, and it is written
 * against the statuses the schema actually allows (`KICKLIVE_FINAL_SCHEMA.sql`, `matches.status`), so
 * there is no second vocabulary to reconcile:
 *
 *   scheduled · waiting · first_half · half_time · second_half · extra_time · penalty_shootout
 *   full_time · suspended · postponed · cancelled · abandoned · completed · live
 *
 * `live` is the legacy spelling of `first_half` (older rows use it, and `MatchesPage` filters on it),
 * so the table treats the two as the same *phase* while preserving whichever spelling a row already
 * uses — normalising history would be a destructive migration for no behavioural gain.
 *
 * Rules encoded here:
 *   - a transition not in `TRANSITIONS` is rejected in the Worker **and** again in Postgres
 *     (`kicklive_transition_match`), so neither layer can be talked out of it by the other;
 *   - `requires: "admin"` marks the transitions that undo a finished match — those are corrections,
 *     not controls, and they carry a reason;
 *   - terminal-for-events statuses reject ordinary live events; corrections stay available, because
 *     a referee's mistake does not expire at full time.
 */
import { ApiError } from "./response.ts";

export type MatchStatus =
  "scheduled" | "waiting" | "first_half" | "live" | "half_time" | "second_half" | "extra_time" | "penalty_shootout" | "full_time" | "suspended" | "postponed" | "cancelled" | "abandoned" | "completed";

/** Exactly the schema's CHECK list, in schema order; a test pins this against the SQL. */
export const MATCH_STATUS_VALUES: readonly MatchStatus[] = [
  "scheduled",
  "waiting",
  "first_half",
  "half_time",
  "second_half",
  "extra_time",
  "penalty_shootout",
  "full_time",
  "suspended",
  "postponed",
  "cancelled",
  "abandoned",
  "completed",
  "live",
];

/** The phase a status belongs to. The clock, the event validators and the UI all ask for this. */
export type MatchPeriod = "pre" | "first" | "half_time" | "second" | "extra_first" | "extra_second" | "shootout" | "done" | "interrupted";

export type ClockKind = "wallclock" | "paused" | "none";

export interface Transition {
  readonly to: MatchStatus;
  /** Human-readable reason shown to the controller; also the label for the confirmation dialog. */
  readonly label: string;
  /** `admin` transitions reopen or undo something already finished. */
  readonly requires?: "admin";
  /** A reason string is mandatory — this is the audit trail for a league dispute. */
  readonly reasonRequired?: boolean;
  readonly summary: string;
}

const FORWARD: readonly Transition[] = [];

/**
 * `from → allowed moves`. Anything absent here is refused, including "backwards" moves like
 * `second_half → first_half` (use a correction event for the data, and a suspension for the clock).
 */
const TRANSITIONS: Partial<Record<MatchStatus, readonly Transition[]>> = {
  scheduled: [
    { to: "waiting", label: "Check in", summary: "Officials and teams confirmed present." },
    { to: "first_half", label: "Kick off", summary: "Start the match. The server clock starts here, not in the browser." },
    { to: "live", label: "Kick off", summary: "Start the match (legacy status spelling)." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "Called off before kick-off." },
    { to: "cancelled", label: "Cancel", requires: "admin", reasonRequired: true, summary: "Match cancelled." },
  ],
  waiting: [
    { to: "first_half", label: "Kick off", summary: "Start the match." },
    { to: "live", label: "Kick off", summary: "Start the match (legacy status spelling)." },
    { to: "scheduled", label: "Stand down", summary: "Back to the fixture list." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "Called off while waiting to start." },
    { to: "cancelled", label: "Cancel", requires: "admin", reasonRequired: true, summary: "Match cancelled." },
  ],
  first_half: [
    { to: "half_time", label: "Half time", summary: "Stop the clock and mark the interval." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "Temporary stoppage; the clock is banked, not reset." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "Match will not resume." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "Called off; any events stay recorded." },
    { to: "full_time", label: "Full time", summary: "End a match that has no interval (youth/friendly formats)." },
  ],
  live: [
    { to: "half_time", label: "Half time", summary: "Stop the clock and mark the interval." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "Temporary stoppage." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "Match will not resume." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "Called off; any events stay recorded." },
    { to: "full_time", label: "Full time", summary: "End the match." },
  ],
  half_time: [
    { to: "second_half", label: "Second half", summary: "Restart the clock for the second period." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "The teams never came back out." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "Match will not resume." },
  ],
  second_half: [
    { to: "full_time", label: "Full time", summary: "End normal time." },
    { to: "extra_time", label: "Extra time", summary: "Knockout: two more periods." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "Temporary stoppage." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "Match will not resume." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "Called off; any events stay recorded." },
  ],
  extra_time: [
    { to: "full_time", label: "Full time", summary: "End extra time." },
    { to: "penalty_shootout", label: "Shoot-out", summary: "Kick the shoot-out off; the clock stops." },
    { to: "half_time", label: "Extra-time interval", summary: "Between the two extra-time periods." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "Temporary stoppage." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "Match will not resume." },
  ],
  penalty_shootout: [
    { to: "full_time", label: "Full time", summary: "Shoot-out decided it." },
    { to: "suspended", label: "Suspend", reasonRequired: true, summary: "Rare, but it happens (light, crowd)." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "No result." },
  ],
  full_time: [
    { to: "completed", label: "Finalize", summary: "Lock the result, recompute standings, publish." },
    // Reopening is a correction, so it is admin-only and needs a reason; `is_locked` is checked again
    // by the database, which is where the real authority lives.
    { to: "second_half", label: "Reopen", requires: "admin", reasonRequired: true, summary: "Reopen for a correction to the clock or a missed period." },
    { to: "abandoned", label: "Abandon (after the fact)", requires: "admin", reasonRequired: true, summary: "Result voided." },
  ],
  completed: [{ to: "full_time", label: "Un-finalize", requires: "admin", reasonRequired: true, summary: "Withdraw the finalized result; standings recalculation must be re-run." }],
  suspended: [
    { to: "first_half", label: "Resume", summary: "Banked clock restarts in the first period." },
    { to: "live", label: "Resume", summary: "Banked clock restarts (legacy status spelling)." },
    { to: "second_half", label: "Resume", summary: "Banked clock restarts in the second period." },
    { to: "half_time", label: "Resume into interval", summary: "Continue from the interval." },
    { to: "extra_time", label: "Resume into extra time", summary: "Continue from extra time." },
    { to: "abandoned", label: "Abandon", reasonRequired: true, summary: "It is not resuming." },
    { to: "postponed", label: "Postpone", requires: "admin", reasonRequired: true, summary: "To be completed later." },
  ],
  abandoned: [{ to: "scheduled", label: "Reinstate", requires: "admin", reasonRequired: true, summary: "Admin only: put it back on the fixture list." }],
  postponed: [{ to: "scheduled", label: "Reinstate", requires: "admin", reasonRequired: true, summary: "Admin only: back on the fixture list." }],
  cancelled: [{ to: "scheduled", label: "Reinstate", requires: "admin", reasonRequired: true, summary: "Admin only: un-cancel a fixture." }],
};

void FORWARD;

/** Statuses an ordinary live event (goal, card, substitution…) may be recorded in. */
const PLAYING: readonly MatchStatus[] = ["live", "first_half", "half_time", "second_half", "extra_time", "penalty_shootout", "suspended"];

/** Nothing may be recorded in these — corrections and admin transitions excepted. */
export const CLOSED_FOR_EVENTS: readonly MatchStatus[] = ["completed", "cancelled", "postponed", "abandoned", "scheduled"];

export function isKnownStatus(value: unknown): value is MatchStatus {
  return typeof value === "string" && (MATCH_STATUS_VALUES as readonly string[]).includes(value);
}

export function transitionsFrom(status: MatchStatus): readonly Transition[] {
  return TRANSITIONS[status] ?? [];
}

export function allowedNextStatuses(status: MatchStatus, isAdmin: boolean): MatchStatus[] {
  return transitionsFrom(status)
    .filter((t) => isAdmin || t.requires === undefined)
    .map((t) => t.to);
}

export function findTransition(from: MatchStatus, to: MatchStatus): Transition | null {
  return transitionsFrom(from).find((t) => t.to === to) ?? null;
}

/**
 * The gate every status change passes through. The message names the legal moves, because a referee at
 * 90'+4' with a bad connection needs to know what to press, not just that they were wrong.
 */
export function assertTransition(from: MatchStatus, to: MatchStatus, isAdmin: boolean): Transition {
  if (from === to) throw new ApiError("CONFLICT", 409, `The match is already ${describe(to)}.`);
  const transition = findTransition(from, to);
  if (!transition) {
    const legal = allowedNextStatuses(from, isAdmin);
    throw new ApiError("CONFLICT", 409, `Cannot go from ${describe(from)} to ${describe(to)}. From here: ${legal.length > 0 ? legal.join(", ") : "nothing — this match is closed."}`, {
      detail: `illegal transition ${from} → ${to}`,
    });
  }
  if (transition.requires === "admin" && !isAdmin) {
    throw new ApiError("FORBIDDEN", 403, "That change undoes a finished match and is restricted to platform admins.");
  }
  if (transition.reasonRequired) {
    // The caller must supply one; `routes/live.ts` validates it. Flagged here so the requirement is
    // discoverable from the table rather than from a comment.
    return transition;
  }
  return transition;
}

export function canRecordEvents(status: MatchStatus): boolean {
  return PLAYING.includes(status);
}

/** A shoot-out has no running clock; a suspension banks the elapsed time instead of resetting it. */
export function clockKind(status: MatchStatus): ClockKind {
  if (status === "live" || status === "first_half" || status === "second_half" || status === "extra_time") return "wallclock";
  if (status === "half_time" || status === "suspended") return "paused";
  return "none";
}

export function periodOf(status: MatchStatus): MatchPeriod {
  switch (status) {
    case "scheduled":
    case "waiting":
      return "pre";
    case "live":
    case "first_half":
      return "first";
    case "half_time":
      return "half_time";
    case "second_half":
      return "second";
    case "extra_time":
      return "extra_first";
    case "penalty_shootout":
      return "shootout";
    case "suspended":
      return "interrupted";
    case "postponed":
    case "cancelled":
    case "abandoned":
      return "interrupted";
    default:
      return "done";
  }
}

/**
 * Upper bound for a legitimate `minute` in a period, used by the event validator. Stoppage time and
 * a delayed restart are real, so these are generous ceilings, not the rulebook's numbers: the point is
 * to catch a `minute: 900` typo or a clock that ran while the tab was asleep, not to argue about 94'.
 */
export function minuteCeiling(status: MatchStatus): number {
  switch (periodOf(status)) {
    case "pre":
      return 0;
    case "first":
    case "half_time":
    case "second":
      return 57;
    case "extra_first":
    case "extra_second":
      return 75;
    case "shootout":
      return 120;
    case "interrupted":
      return 130;
    default:
      return 130;
  }
}

/** Display text used in error messages; a status name alone reads like a stack trace to a volunteer. */
export function describe(status: MatchStatus): string {
  switch (status) {
    case "live":
    case "first_half":
      return "live";
    case "half_time":
      return "half time";
    case "second_half":
      return "the second half";
    case "extra_time":
      return "extra time";
    case "penalty_shootout":
      return "a shoot-out";
    case "full_time":
      return "full time";
    case "waiting":
      return "check-in";
    case "scheduled":
      return "scheduled";
    case "suspended":
      return "suspended";
    case "postponed":
      return "postponed";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    default:
      return "completed";
  }
}

/**
 * `live` and `first_half` mean the same thing on the field; anywhere a *set* of statuses is compared
 * (fans filtering "what's on now"), both spellings must be included or half the matches disappear.
 */
export function equivalentPlayingStatuses(status: MatchStatus): MatchStatus[] {
  if (status === "live") return ["live", "first_half"];
  if (status === "first_half") return ["first_half", "live"];
  return [status];
}
