/**
 * KICKLIVE · the standings rule, as one function (Phase 4, finding F-05)
 *
 * The table used to be computed in three places — `StandingsPage`, `TeamProfile`, and again in
 * `MatchAutomation` at finalization — with three column lists and three ideas about what "finished" means.
 * Two of them sorted on points, goal difference and goals for; only `MatchAutomation` counted a walkover
 * rule, and `TeamProfile`'s rows had no `name`, which is why the "Team" column on that page renders blank.
 *
 * This is the browser's copy of the rule, used as a fallback when the SQL aggregate is not deployed. The
 * Postgres function (`kicklive_competition_standings`) is the authority when it exists; both are checked
 * against the same table of cases in `tests/unit/data-layer.test.ts`, which is the point of keeping the
 * arithmetic here rather than inline in a `.map`.
 */
import { DONE_STATUSES, isDoneStatus } from "./freshness.ts";

export interface StandingsMatch {
  home_team_id: number;
  away_team_id: number;
  home_score: number | null;
  away_score: number | null;
  status: string;
  start_time?: string | null;
}

export interface StandingTeam {
  id: number;
  name: string;
  short_name?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
}

export interface StandingRow {
  teamId: number;
  name: string;
  shortName: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  form: ("W" | "D" | "L")[];
}

/** Points for a win is not a constant to invent: the schema's competitions table has no rule column, so 3/1/0 it is. */
export const POINTS = { win: 3, draw: 1, loss: 0 } as const;

export function computeStandings(matches: readonly StandingsMatch[], teams: readonly StandingTeam[]): StandingRow[] {
  const byId = new Map<number, StandingRow>();
  for (const team of teams) {
    byId.set(team.id, {
      teamId: team.id,
      name: team.name,
      shortName: team.short_name ?? null,
      primaryColor: team.primary_color ?? null,
      secondaryColor: team.secondary_color ?? null,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      gf: 0,
      ga: 0,
      gd: 0,
      points: 0,
      form: [],
    });
  }

  // Oldest first: `form` is read left-to-right as the recent end on the right.
  const ordered = [...matches]
    .filter((m) => isDoneStatus(m.status))
    .sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));

  for (const match of ordered) {
    const home = byId.get(match.home_team_id);
    const away = byId.get(match.away_team_id);
    if (!home || !away) continue;
    const homeGoals = match.home_score ?? 0;
    const awayGoals = match.away_score ?? 0;
    home.played++;
    away.played++;
    home.gf += homeGoals;
    home.ga += awayGoals;
    away.gf += awayGoals;
    away.ga += homeGoals;
    if (homeGoals > awayGoals) {
      home.won++;
      away.lost++;
      home.points += POINTS.win;
      away.points += POINTS.loss;
      home.form.push("W");
      away.form.push("L");
    } else if (homeGoals < awayGoals) {
      away.won++;
      home.lost++;
      away.points += POINTS.win;
      home.points += POINTS.loss;
      away.form.push("W");
      home.form.push("L");
    } else {
      home.drawn++;
      away.drawn++;
      home.points += POINTS.draw;
      away.points += POINTS.draw;
      home.form.push("D");
      away.form.push("D");
    }
    home.gd = home.gf - home.ga;
    away.gd = away.gf - away.ga;
  }

  return rankStandings([...byId.values()]);
}

/** The tie-break ladder, exported separately because the SQL function must be checked against it. */
export function rankStandings(rows: readonly StandingRow[]): StandingRow[] {
  return [...rows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return a.name.localeCompare(b.name);
  });
}

/** Last five, newest first, for the `form` chips the pages already render. */
export function recentForm(row: StandingRow, n = 5): ("W" | "D" | "L")[] {
  return row.form.slice(-n).reverse();
}

export { DONE_STATUSES };
