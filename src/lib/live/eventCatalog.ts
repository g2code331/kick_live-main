/**
 * The controller pad, derived from the Worker's event specification — no second vocabulary.
 *
 * `workers/src/lib/matchEvents.ts` is the authority on every fact the pad needs: which of the schema's 27
 * event types a controller may submit at all (the lifecycle ones are written by a status transition, and
 * `substitution_on`/`_off` are written by the substitution itself), whether an event must name a team, and
 * whether it may carry a player, a goal type or a card reason. This file mirrors that table, and
 * `tests/unit/live-client.test.ts` re-parses the Worker's source and compares every row, so an edit on one
 * side that is not made on the other fails the build rather than surprising a referee at 19:58.
 *
 * What the browser adds on its own is presentation only: `glyph`, `groupLabel` and `confirm` (which taps
 * deserve a sheet before they fire). None of those can make an illegal event legal — the server refuses
 * that — and an unavailable control is rendered disabled with the server's reason, never hidden.
 */

import type { MatchPeriod } from "./protocol.ts";

export interface TapEvent {
  readonly type: string;
  readonly label: string;
  readonly group: "goal" | "card" | "substitution" | "review" | "play";
  readonly groupLabel: string;
  readonly glyph: string;
  readonly team: "required" | "forbidden" | "optional";
  readonly players: "none" | "one" | "one_or_two";
  readonly goalType: boolean;
  readonly cardReason: boolean;
  /** A dangerous tap gets a confirmation sheet; a routine one fires on the first tap. */
  readonly confirm: boolean;
}

export const TAP_EVENTS: readonly TapEvent[] = [
  { type: "goal", label: "Goal", group: "goal", groupLabel: "Goals", glyph: "⚽", team: "required", players: "one_or_two", goalType: true, cardReason: false, confirm: false },
  { type: "own_goal", label: "Own goal", group: "goal", groupLabel: "Goals", glyph: "⚽", team: "required", players: "one_or_two", goalType: true, cardReason: false, confirm: true },
  { type: "penalty_goal", label: "Penalty scored", group: "goal", groupLabel: "Goals", glyph: "⚽", team: "required", players: "one", goalType: true, cardReason: false, confirm: false },
  { type: "penalty_missed", label: "Penalty missed", group: "goal", groupLabel: "Goals", glyph: "⚽", team: "required", players: "one", goalType: false, cardReason: false, confirm: true },
  { type: "yellow_card", label: "Yellow", group: "card", groupLabel: "Discipline", glyph: "🟨", team: "required", players: "one", goalType: false, cardReason: true, confirm: false },
  { type: "second_yellow", label: "Second yellow", group: "card", groupLabel: "Discipline", glyph: "🟨", team: "required", players: "one", goalType: false, cardReason: true, confirm: true },
  { type: "red_card", label: "Red", group: "card", groupLabel: "Discipline", glyph: "🟨", team: "required", players: "one", goalType: false, cardReason: true, confirm: true },
  { type: "substitution", label: "Substitution", group: "substitution", groupLabel: "Changes", glyph: "🔁", team: "required", players: "one_or_two", goalType: false, cardReason: false, confirm: false },
  { type: "var_check", label: "VAR review", group: "review", groupLabel: "Review", glyph: "📺", team: "optional", players: "none", goalType: false, cardReason: false, confirm: false },
  { type: "var_overturned", label: "VAR overturned", group: "review", groupLabel: "Review", glyph: "📺", team: "optional", players: "none", goalType: false, cardReason: false, confirm: true },
  { type: "injury", label: "Injury", group: "play", groupLabel: "Open play", glyph: "📍", team: "optional", players: "one", goalType: false, cardReason: false, confirm: false },
  { type: "water_break", label: "Water break", group: "play", groupLabel: "Open play", glyph: "📍", team: "forbidden", players: "none", goalType: false, cardReason: false, confirm: false },
  { type: "corner", label: "Corner", group: "play", groupLabel: "Open play", glyph: "📍", team: "required", players: "none", goalType: false, cardReason: false, confirm: false },
  { type: "offside", label: "Offside", group: "play", groupLabel: "Open play", glyph: "📍", team: "required", players: "one", goalType: false, cardReason: false, confirm: false },
  { type: "free_kick", label: "Free kick", group: "play", groupLabel: "Open play", glyph: "📍", team: "required", players: "one", goalType: false, cardReason: false, confirm: false },
  { type: "throw_in", label: "Throw-in", group: "play", groupLabel: "Open play", glyph: "📍", team: "required", players: "none", goalType: false, cardReason: false, confirm: false },
  { type: "goal_kick", label: "Goal kick", group: "play", groupLabel: "Open play", glyph: "📍", team: "required", players: "none", goalType: false, cardReason: false, confirm: false },
  { type: "extra_time_half_time", label: "Extra-time interval", group: "play", groupLabel: "Lifecycle", glyph: "⏱", team: "forbidden", players: "none", goalType: false, cardReason: false, confirm: false },
];

export const TAP_EVENT_TYPES: readonly string[] = TAP_EVENTS.map((e) => e.type);

/** Grouped for the pad: one row per family, in the order a match actually needs them. */
export const TAP_GROUPS: readonly { group: TapEvent["group"]; label: string; events: readonly TapEvent[] }[] = (["goal", "card", "substitution", "review", "play"] as const).map((group) => ({
  group,
  label: TAP_EVENTS.find((e) => e.group === group)?.groupLabel ?? group,
  events: TAP_EVENTS.filter((e) => e.group === group),
}));

export function tapEvent(type: string): TapEvent | undefined {
  return TAP_EVENTS.find((e) => e.type === type);
}

/**
 * The goal types the pad offers, and only for an event the Worker says may carry one. The values are the
 * schema's `match_events.goal_type` CHECK list; which events accept one is the spec mirrored above, so a
 * `goal_type` cannot be attached to a corner by a UI edit alone.
 */
export const GOAL_TYPE_CHOICES: readonly { value: string; label: string }[] = [
  { value: "normal", label: "Open play" },
  { value: "header", label: "Header" },
  { value: "penalty", label: "Penalty" },
  { value: "free_kick", label: "Free kick" },
  { value: "deflection", label: "Deflection" },
];

/**
 * Minute ceilings, mirrored for the input's `max` attribute only. The server clamps, refuses and owns the
 * clock; this exists so a controller's arrow keys do not wander past 45 and get refused for it.
 */
export const MINUTE_CEILINGS: Record<MatchPeriod, number> = { pre: 0, first: 45, half_time: 45, second: 90, extra_first: 105, extra_second: 120, shootout: 120, done: 130, interrupted: 130 };
