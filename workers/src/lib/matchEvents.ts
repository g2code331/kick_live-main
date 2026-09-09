/**
 * The match event catalogue, derived from `match_events.event_type` — no new vocabulary.
 *
 * Three things live here and nowhere else:
 *
 *   1. **which of the schema's 27 event types a controller may submit**, versus which are written by a
 *      status transition (`kickoff`, `half_time`, `second_half_start`, `full_time`, …) so the timeline
 *      and the clock cannot disagree, and which are internal (`substitution_on`/`_off` are written by
 *      the substitution itself);
 *   2. **the scoring rule** (which types move which side's score, and how a shoot-out tally is kept
 *      out of the match score). The identical rule is re-implemented in
 *      `supabase/migrations/20260909210000_phase3_live_match_engine.sql`, because Postgres is the
 *      authority and the Durable Object only mirrors it; a test in
 *      `tests/unit/live-match-engine.test.ts` compares the two type lists so they cannot drift;
 *   3. **what makes an event impossible** (a third yellow for a player already sent off, a goal for a
 *      team not in the match, a substitution with the same player on and off).
 *
 * Corrections are deliberately NOT an event type: the schema's CHECK list has no `reversed`, and
 * inventing one would break the constraint every other client depends on. A correction is a state
 * transition on the row (`active → corrected`, with `corrected_by`, `correction_reason`,
 * `replacement_event_id`) plus an audit entry — the original stays, which is the point.
 */
import { MATCH_EVENT_TYPES, type MatchEventType } from "./validation.ts";
import { ApiError } from "./response.ts";
import type { MatchStatus } from "./matchLifecycle.ts";
import { periodOf } from "./matchLifecycle.ts";

export type EventGroup = "goal" | "card" | "substitution" | "review" | "play" | "lifecycle" | "internal";

export interface EventSpec {
  readonly type: MatchEventType;
  readonly label: string;
  readonly group: EventGroup;
  /** A controller may submit this from the console. */
  readonly recordable: boolean;
  /** Written by the state machine as a side effect of a transition; rejected if submitted directly. */
  readonly lifecycle: boolean;
  readonly team: "required" | "forbidden" | "optional";
  readonly players: "none" | "one" | "one_or_two";
  readonly goalType: boolean;
  readonly cardReason: boolean;
  /** +1 / −1 applied to the side that `team_id` names; `own_goal` is the mirror image and is handled separately. */
  readonly matchScoreForTeam: 0 | 1;
  readonly shootoutTally: boolean;
  /** May be recorded after the match is closed (the correction path uses this). */
  readonly afterClose: boolean;
  readonly summary: string;
}

const spec = (type: MatchEventType, over: Partial<EventSpec> & Pick<EventSpec, "label" | "group" | "summary">): EventSpec => ({
  type,
  label: over.label,
  group: over.group,
  recordable: over.recordable ?? true,
  lifecycle: over.lifecycle ?? false,
  team: over.team ?? "required",
  players: over.players ?? "none",
  goalType: over.goalType ?? false,
  cardReason: over.cardReason ?? false,
  matchScoreForTeam: over.matchScoreForTeam ?? 0,
  shootoutTally: over.shootoutTally ?? false,
  afterClose: over.afterClose ?? false,
  summary: over.summary,
});

export const EVENT_SPECS: Record<MatchEventType, EventSpec> = {
  goal: spec("goal", { label: "Goal", group: "goal", players: "one_or_two", goalType: true, matchScoreForTeam: 1, summary: "A goal for `team_id`; assist and goal type are optional metadata." }),
  own_goal: spec("own_goal", { label: "Own goal", group: "goal", players: "one_or_two", goalType: true, summary: "+1 to the opposing side; `team_id` is the side that scored it." }),
  penalty_goal: spec("penalty_goal", {
    label: "Penalty scored",
    group: "goal",
    players: "one",
    goalType: true,
    matchScoreForTeam: 1,
    shootoutTally: true,
    summary: "A converted penalty. During a shoot-out it counts toward the shoot-out tally, not the score.",
  }),
  penalty_missed: spec("penalty_missed", {
    label: "Penalty missed",
    group: "goal",
    players: "one",
    shootoutTally: true,
    summary: "Saved/missed spot kick; never changes the score, but is a real event for the timeline.",
  }),
  yellow_card: spec("yellow_card", { label: "Yellow", group: "card", players: "one", cardReason: true, summary: "A caution for one player." }),
  second_yellow: spec("second_yellow", {
    label: "Second yellow",
    group: "card",
    players: "one",
    cardReason: true,
    summary: "A sending-off that came from a second caution. Requires a prior yellow for that player.",
  }),
  red_card: spec("red_card", { label: "Red", group: "card", players: "one", cardReason: true, summary: "A sending-off. The player may not appear in any later live event." }),
  substitution: spec("substitution", {
    label: "Substitution",
    group: "substitution",
    players: "one_or_two",
    summary: "`player_id` comes on, `assist_player_id` goes off — the convention the existing variants already write.",
  }),
  substitution_on: spec("substitution_on", {
    label: "Substitution on",
    group: "internal",
    recordable: false,
    summary: "Written by `substitution`; not offered as a separate button, so the pair can never diverge.",
  }),
  substitution_off: spec("substitution_off", { label: "Substitution off", group: "internal", recordable: false, summary: "Written by `substitution`." }),
  var_check: spec("var_check", { label: "VAR review", group: "review", players: "none", team: "optional", summary: "Opens a review on the latest reviewable event." }),
  var_overturned: spec("var_overturned", {
    label: "VAR overturned",
    group: "review",
    players: "none",
    team: "optional",
    summary: "Ends a review with a change; the changed event itself is corrected, not deleted.",
  }),
  injury: spec("injury", { label: "Injury", group: "play", players: "one", team: "optional", summary: "A stoppage note; drives stoppage-time expectations, not the score." }),
  water_break: spec("water_break", { label: "Water break", group: "play", team: "forbidden", summary: "A cooling break." }),
  corner: spec("corner", { label: "Corner", group: "play", players: "none", summary: "Statistical event; safe to record fast, no participants required." }),
  offside: spec("offside", { label: "Offside", group: "play", players: "one", summary: "Statistical event." }),
  free_kick: spec("free_kick", { label: "Free kick", group: "play", players: "one", summary: "Statistical event." }),
  throw_in: spec("throw_in", { label: "Throw-in", group: "play", players: "none", summary: "Statistical event." }),
  goal_kick: spec("goal_kick", { label: "Goal kick", group: "play", players: "none", summary: "Statistical event." }),
  kickoff: spec("kickoff", { label: "Kick-off", group: "lifecycle", lifecycle: true, team: "forbidden", recordable: false, summary: "Written by the `scheduled|waiting → live` transition." }),
  half_time: spec("half_time", { label: "Half time", group: "lifecycle", lifecycle: true, team: "forbidden", recordable: false, summary: "Written by the `→ half_time` transition." }),
  second_half_start: spec("second_half_start", {
    label: "Second half",
    group: "lifecycle",
    lifecycle: true,
    team: "forbidden",
    recordable: false,
    summary: "Written by the `half_time → second_half` transition.",
  }),
  extra_time_start: spec("extra_time_start", { label: "Extra time", group: "lifecycle", lifecycle: true, team: "forbidden", recordable: false, summary: "Written by the `→ extra_time` transition." }),
  extra_time_half_time: spec("extra_time_half_time", {
    label: "Extra-time interval",
    group: "lifecycle",
    // The one lifecycle-shaped event a controller taps by hand: `matches.status` has no value for the
    // break between the two extra-time halves (inventing a 15th would split every "what's live" query),
    // so the clock is stopped with a suspension and this row marks the moment in the timeline.
    lifecycle: false,
    team: "forbidden",
    recordable: true,
    summary: "Tapped at the interval between the extra-time periods; the clock itself is banked by suspending and restarted on resume.",
  }),
  penalty_shootout_start: spec("penalty_shootout_start", {
    label: "Shoot-off",
    group: "lifecycle",
    lifecycle: true,
    team: "forbidden",
    recordable: false,
    summary: "Written by the `→ penalty_shootout` transition.",
  }),
  full_time: spec("full_time", { label: "Full time", group: "lifecycle", lifecycle: true, team: "forbidden", recordable: false, summary: "Written by the `→ full_time` transition." }),
  match_abandoned: spec("match_abandoned", {
    label: "Abandoned",
    group: "lifecycle",
    lifecycle: true,
    team: "forbidden",
    recordable: false,
    afterClose: true,
    summary: "Written by the `→ abandoned` transition, with a reason.",
  }),
} as Record<MatchEventType, EventSpec>;

export function eventSpec(type: unknown): EventSpec {
  if (typeof type !== "string" || !(MATCH_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new ApiError("VALIDATION_FAILED", 400, "event_type is not one the database accepts.", {
      fields: [{ field: "event_type", message: `must be one of: ${MATCH_EVENT_TYPES.join(", ")}` }],
    });
  }
  const found = EVENT_SPECS[type as MatchEventType];
  if (!found) throw new ApiError("INTERNAL_ERROR", 500, `Event type ${type} has no server-side specification.`);
  return found;
}

/** The button set, in the order the console renders it. Nothing here is "advanced". */
export const PRIMARY_TAPS: readonly MatchEventType[] = [
  "goal",
  "penalty_goal",
  "penalty_missed",
  "own_goal",
  "yellow_card",
  "second_yellow",
  "red_card",
  "substitution",
  "var_check",
  "var_overturned",
];

export const STAT_TAPS: readonly MatchEventType[] = ["corner", "offside", "free_kick", "throw_in", "goal_kick", "injury", "water_break"];

export interface EventLike {
  event_type: string;
  team_id: number | null;
  player_id: number | null;
  assist_player_id?: number | null;
  minute: number;
  period?: string | null;
  event_status?: string | null;
  sequence?: number | null;
  goal_type?: string | null;
}

/**
 * The score, as a pure fold over the event log. `corrected`/`reversed` rows are skipped, which is what
 * makes a correction recalculate rather than require a second manual edit.
 */
export function scoreFromEvents(events: readonly EventLike[], homeTeamId: number, awayTeamId: number): { home: number; away: number; shootout: { home: number; away: number } } {
  let home = 0;
  let away = 0;
  let shootHome = 0;
  let shootAway = 0;
  for (const event of events) {
    if (event.event_status && event.event_status !== "active") continue;
    const side = event.team_id === homeTeamId ? "home" : event.team_id === awayTeamId ? "away" : null;
    if (!side) continue;
    const inShootout = event.period === "shootout";
    switch (event.event_type) {
      case "goal":
      case "penalty_goal":
        if (inShootout) {
          if (side === "home") shootHome += 1;
          else shootAway += 1;
        } else if (side === "home") home += 1;
        else away += 1;
        break;
      case "own_goal":
        // The row names the side that put it in their own net; the point goes to the other side.
        if (side === "home") away += 1;
        else home += 1;
        break;
      default:
        break;
    }
  }
  return { home, away, shootout: { home: shootHome, away: shootAway } };
}

/** The event types whose only effect is on the score — used by the tests and the dispute report. */
export const SCORING_TYPES: readonly MatchEventType[] = (Object.keys(EVENT_SPECS) as MatchEventType[]).filter((k) => EVENT_SPECS[k].matchScoreForTeam === 1 || k === "own_goal");

export function isCard(type: string): boolean {
  return type === "yellow_card" || type === "second_yellow" || type === "red_card";
}

export type EventProblem = { field: string; message: string };

/**
 * Everything that makes an event *impossible* rather than merely invalid, given the state of the match.
 * Returns a list so a controller sees all of it at once instead of discovering them one round trip at a
 * time while a crowd is shouting.
 */
export function inspectEvent(incoming: EventLike, context: { existing: readonly EventLike[]; homeTeamId: number; awayTeamId: number; status: MatchStatus; isAdmin: boolean }): EventProblem[] {
  const problems: EventProblem[] = [];
  const { existing, homeTeamId, awayTeamId, status } = context;
  const active = existing.filter((e) => !e.event_status || e.event_status === "active");
  const specOf = safeSpec(incoming.event_type);

  if (incoming.team_id !== null && incoming.team_id !== homeTeamId && incoming.team_id !== awayTeamId) {
    problems.push({ field: "team_id", message: "that team is not playing in this match" });
  }
  if (specOf?.team === "required" && incoming.team_id === null) problems.push({ field: "team_id", message: "is required for " + incoming.event_type });

  const involved = [incoming.player_id, incoming.assist_player_id].filter((id): id is number => typeof id === "number");
  if (involved.length !== new Set(involved).size) problems.push({ field: "player_id", message: "a player cannot appear twice on one event (substitution on/off must differ)" });

  if (specOf?.group === "substitution" && involved.length < 2) {
    problems.push({ field: "assist_player_id", message: "a substitution needs the player coming off as well as the one coming on" });
  }

  if (isCard(incoming.event_type) && incoming.player_id !== null) {
    const yellows = active.filter((e) => e.player_id === incoming.player_id && (e.event_type === "yellow_card" || e.event_type === "second_yellow")).length;
    const sentOff = active.some((e) => e.player_id === incoming.player_id && (e.event_type === "red_card" || e.event_type === "second_yellow"));
    if (sentOff) problems.push({ field: "player_id", message: "that player has already been sent off" });
    if (incoming.event_type === "second_yellow" && yellows < 1) problems.push({ field: "event_type", message: "a second yellow needs a first one on record" });
    if (incoming.event_type === "yellow_card" && yellows >= 2) problems.push({ field: "event_type", message: "that player already has two cautions; record a send-off instead" });
  }

  if (!isCard(incoming.event_type) && incoming.player_id !== null) {
    const sentOff = active.some((e) => e.player_id === incoming.player_id && (e.event_type === "red_card" || e.event_type === "second_yellow"));
    const subbedOff = active.some((e) => e.event_type === "substitution" && e.assist_player_id === incoming.player_id && (e.sequence ?? 0) < (incoming.sequence ?? Number.MAX_SAFE_INTEGER));
    if (sentOff) problems.push({ field: "player_id", message: "that player was sent off and cannot take part in a later event" });
    else if (subbedOff) problems.push({ field: "player_id", message: "that player was substituted off; a goal after they left is a correction, not an event" });
  }

  if (incoming.event_type === "penalty_missed" && incoming.goal_type != null && incoming.goal_type !== "") problems.push({ field: "goal_type", message: "cannot be set on a missed penalty" });

  const period = periodOf(status);
  if (incoming.event_type === "penalty_goal" && period === "shootout" && incoming.minute > 120) {
    problems.push({ field: "minute", message: "a shoot-out is not measured in minutes past full time" });
  }

  return problems;
}

function safeSpec(type: string): EventSpec | null {
  return (EVENT_SPECS as Record<string, EventSpec | undefined>)[type] ?? null;
}

export function assertRecordable(type: unknown): EventSpec {
  const found = eventSpec(type);
  if (found.lifecycle || !found.recordable) {
    throw new ApiError("VALIDATION_FAILED", 400, `${found.type} is written by the match state machine, not by a controller. Change the match status instead.`, {
      fields: [{ field: "event_type", message: `${found.type} is a lifecycle event` }],
    });
  }
  return found;
}
