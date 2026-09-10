/**
 * KICKLIVE · every public read in the app, in one file (Phase 4)
 *
 * This is the answer to finding F-02: the same question ("the matches a fan should see right now") used to be
 * asked at 34 call sites in three shapes, so no two screens could reuse each other's answer. A spec here is
 * the question, the columns that answer it, the bound, the cache key, the invalidation tags and the freshness
 * class — all four in one place, because a page that picks its own `ttlMs` is how you get six of those too
 * (F-09).
 *
 * Two rules, both load-bearing:
 *  - **reads only.** No spec writes. The 90 write sites stay where they are until their Worker route exists
 *    (Phase 2's per-route migration), and a caching phase that quietly moves authorisation around is not a
 *    caching phase;
 *  - **not the live match.** Score, minute and status for a match in play come from the room
 *    (`src/lib/live/useMatchRoom.ts`). The lists here exist so a fan sees the right *set* of matches, and the
 *    one row they may show from cache is a fixture's identity, never its running score.
 */
import { defineQuery, one, rows } from "./context.ts";
import { FRESHNESS, LIVE_STATUSES, DONE_STATUSES, UPCOMING_STATUSES } from "./freshness.ts";
import { computeStandings, type StandingRow, type StandingsMatch, type StandingTeam } from "./standings.ts";

/** Anything a list page shows about a match: the union of what the home strip and the fixture list render. */
export const MATCH_CARD_COLUMNS =
  "id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, competition_id, is_locked, homeTeam:teams!home_team_id(id, name, short_name, primary_color, secondary_color), awayTeam:teams!away_team_id(id, name, short_name, primary_color, secondary_color), competitions(id, name)";

export const PLAYER_CARD_COLUMNS = "id, name, number, position, goals, assists, nationality, team_id, teams(id, name, short_name, primary_color)";

/**
 * A row from PostgREST, loosely typed on purpose.
 *
 * The screens these feeds replace were written against `useState<any[]>`, and a caching refactor is not the
 * moment to retype every JSX expression — that is a UI-side change with its own risk. What the layer *does*
 * promise is the narrow shapes below (`MatchCard`, `StandingRow`): the fields a page may not do without.
 * Everything else stays an open row so a column can be added in SQL without touching the frontend.
 */
export type Row = Record<string, any>;

export type MatchCard = Row & {
  id: number;
  status: string;
  minute: number | null;
  home_score: number | null;
  away_score: number | null;
  start_time: string | null;
  is_locked?: boolean | null;
};

export type MatchFilter = "all" | "live" | "scheduled" | "finished";

export interface PageArgs {
  filter?: MatchFilter;
  page?: number;
  pageSize?: number;
}

/** The fixture list, in one page. `pageSize` is a parameter so the ceiling lives here, not in a page. */
export const matchList = defineQuery<{ rows: MatchCard[]; page: number; pageSize: number; more: boolean }, PageArgs>({
  key: (a) => `matches|f=${a.filter ?? "all"}|p=${a.page ?? 0}|n=${a.pageSize ?? 20}`,
  tags: () => ["matches"],
  ttlMs: FRESHNESS.fast,
  pollMs: FRESHNESS.fast,
  minIntervalMs: 2000,
  fetch: async (ctx, a, signal) => {
    const pageSize = Math.min(Math.max(a.pageSize ?? 20, 1), 100);
    const page = Math.max(a.page ?? 0, 0);
    let builder = ctx.db.from("matches").select(MATCH_CARD_COLUMNS).order("start_time", { ascending: false });
    if (a.filter === "live") builder = builder.in("status", LIVE_STATUSES);
    else if (a.filter === "scheduled") builder = builder.in("status", UPCOMING_STATUSES);
    else if (a.filter === "finished") builder = builder.in("status", DONE_STATUSES);
    const data = await rows<MatchCard[]>(builder.range(page * pageSize, page * pageSize + pageSize - 1));
    return { rows: data, page, pageSize, more: data.length === pageSize };
  },
});

/** The strip on the home page: what is in play, right now. Polling this is the only polling a fan needs. */
export const liveMatches = defineQuery<MatchCard[], { limit?: number }>({
  key: (a) => `matches|live|n=${a.limit ?? 10}`,
  tags: () => ["matches"],
  ttlMs: FRESHNESS.fast,
  pollMs: FRESHNESS.fast,
  minIntervalMs: 2000,
  fetch: async (ctx, a) =>
    await rows<MatchCard[]>(
      ctx.db
        .from("matches")
        .select(MATCH_CARD_COLUMNS)
        .in("status", LIVE_STATUSES)
        .order("start_time", { ascending: false })
        .limit(Math.min(a.limit ?? 10, 30)),
    ),
});

/** Recently finished, for the header's notification bell. Not polled: opening the panel is the refresh. */
export const recentResults = defineQuery<MatchCard[], { hours?: number; limit?: number }>({
  key: (a) => `matches|recent-results|h=${a.hours ?? 24}|n=${a.limit ?? 8}`,
  tags: () => ["matches"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) => {
    const since = new Date(Date.now() - (a.hours ?? 24) * 3600 * 1000).toISOString();
    return await rows<MatchCard[]>(
      ctx.db
        .from("matches")
        .select("id, home_score, away_score, status, start_time, homeTeam:teams!home_team_id(name, short_name), awayTeam:teams!away_team_id(name, short_name)")
        .in("status", DONE_STATUSES)
        .gte("start_time", since)
        .order("start_time", { ascending: false })
        .limit(Math.min(a.limit ?? 8, 20)),
    );
  },
});

/** The one search box in the header. Both halves are cheap and always asked together, so they are one key. */
export const globalSearch = defineQuery<{ teams: Row[]; matches: MatchCard[] }, { query: string }>({
  key: (a) => `search|q=${a.query.trim().toLowerCase()}`,
  tags: () => ["search", "teams", "matches"],
  ttlMs: FRESHNESS.page,
  minIntervalMs: 400,
  fetch: async (ctx, a) => {
    const q = a.query.trim();
    if (!q) return { teams: [], matches: [] };
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    const [teams, matches] = await Promise.all([
      rows<Row[]>(ctx.db.from("teams").select("id, name, short_name, primary_color").ilike("name", like).limit(5)),
      rows<MatchCard[]>(
        ctx.db
          .from("matches")
          .select("id, home_score, away_score, status, minute, homeTeam:teams!home_team_id(name), awayTeam:teams!away_team_id(name)")
          .in("status", [...LIVE_STATUSES, ...DONE_STATUSES])
          .order("start_time", { ascending: false })
          .limit(8),
      ),
    ]);
    // The names come back from the join, so the old client-side `includes(q)` filter is now the *only*
    // filter on the match side — but it runs on 8 rows, not on a whole-table scan.
    return {
      teams,
      matches: matches.filter((m) => {
        const name = (v: unknown) => String((v as { name?: string })?.name ?? "").toLowerCase();
        return name(m.homeTeam).includes(q.toLowerCase()) || name(m.awayTeam).includes(q.toLowerCase());
      }),
    };
  },
});

/** Top scorers — the same columns for the home page and the fan portal, which is why there is one of them. */
export const scorers = defineQuery<Row[], { limit?: number }>({
  key: (a) => `players|scorers|n=${a.limit ?? 10}`,
  tags: () => ["players", "scorers"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await rows<Row[]>(
      ctx.db.from("players").select(PLAYER_CARD_COLUMNS).order("goals", { ascending: false }).limit(Math.min(a.limit ?? 10, 30)),
    ),
});

/** The published articles, newest first — the home page's news rail. */
export const newsPreview = defineQuery<Row[], { limit?: number }>({
  key: (a) => `media|preview|n=${a.limit ?? 6}`,
  tags: () => ["media", "news"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await rows<Row[]>(
      ctx.db.from("media").select("id, title, category, image_url, created_at, excerpt").order("created_at", { ascending: false }).limit(Math.min(a.limit ?? 6, 20)),
    ),
});

export interface NewsPageArgs {
  category?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}

export const newsPage = defineQuery<{ rows: Row[]; page: number; more: boolean }, NewsPageArgs>({
  key: (a) => `media|cat=${a.category && a.category !== "All" ? a.category : "-"}|q=${(a.query ?? "").trim().toLowerCase()}|p=${a.page ?? 0}|n=${a.pageSize ?? 12}`,
  tags: () => ["media", "news"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a, signal) => {
    const pageSize = Math.min(Math.max(a.pageSize ?? 12, 1), 50);
    const page = Math.max(a.page ?? 0, 0);
    let builder = ctx.db.from("media").select("id, title, excerpt, content, category, image_url, created_at");
    if (a.category && a.category !== "All") builder = builder.eq("category", a.category);
    const q = (a.query ?? "").trim();
    if (q) builder = builder.ilike("title", `%${q.replace(/[%_]/g, "\\$&")}%`);
    const data = await rows<Row[]>(builder.order("created_at", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1));
    void signal;
    return { rows: data, page, more: data.length === pageSize };
  },
});

export const newsArticle = defineQuery<Row | null, { id: number }>({
  key: (a) => `media|id=${a.id}`,
  tags: (a) => [`media:${a.id}`, "media"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await one<Record<string, unknown>>(
      ctx.db.from("media").select("id, title, excerpt, content, category, image_url, created_at, views").eq("id", a.id).maybeSingle(),
    ),
});

/** The club index. Bounded, persisted, and the one read three screens share. */
export const teamsIndex = defineQuery<StandingTeam[] & Row[], { limit?: number }>({
  key: (a) => `teams|active|n=${a.limit ?? 100}`,
  tags: () => ["teams"],
  ttlMs: FRESHNESS.slow,
  persist: true,
  fetch: async (ctx, a) =>
    await rows<StandingTeam[] & Row[]>(
      ctx.db.from("teams").select("id, name, short_name, city, coach, venue, primary_color, secondary_color, status").in("status", ["active", null]).order("name").limit(Math.min(a.limit ?? 100, 200)),
    ),
});

export const competitionsIndex = defineQuery<{ id: number; name: string; type: string | null; season: string | null }[], { limit?: number }>({
  key: (a) => `competitions|recent|n=${a.limit ?? 20}`,
  tags: () => ["competitions"],
  ttlMs: FRESHNESS.slow,
  persist: true,
  fetch: async (ctx, a) =>
    await rows<{ id: number; name: string; type: string | null; season: string | null }[]>(
      ctx.db.from("competitions").select("id, name, type, season, status, start_date").order("created_at", { ascending: false }).limit(Math.min(a.limit ?? 20, 50)),
    ),
});

export interface StandingsArgs {
  competitionId: number;
  /** Only used by the fallback path, where the browser still has to aggregate. */
  matchLimit?: number;
}

/**
 * One competition's table.
 *
 * The read is `kicklive_competition_standings(competition_id)` — the aggregate Postgres can do in one index
 * scan and send back as ~20 rows — and the fallback is the old browser computation, bounded to 300 matches,
 * which is what `/tables` did with no limit at all. Falling back is not hiding a problem: `soft` counts it in
 * the diagnostics, and the RPC is what the migration in this phase installs.
 */
export const standings = defineQuery<StandingRow[], StandingsArgs>({
  key: (a) => `standings|comp=${a.competitionId}`,
  tags: (a) => ["standings", `standings:${a.competitionId}`],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a, signal) => {
    const { isMissingOnServer } = await import("./context.ts");
    try {
      const res = await ctx.db.rpc("kicklive_competition_standings", { p_competition_id: a.competitionId });
      if (!res.error && Array.isArray(res.data)) return (res.data as Row[]).map(fromSqlRow);
      if (!isMissingOnServer(res.error)) throw new Error(res.error?.message ?? "standings rpc failed");
    } catch (err) {
      if (!isMissingOnServer(err)) throw err;
    }
    void signal;
    const matches = await rows<StandingsMatch[]>(
      ctx.db
        .from("matches")
        .select("home_team_id, away_team_id, home_score, away_score, status, start_time")
        .eq("competition_id", a.competitionId)
        .in("status", DONE_STATUSES)
        .order("start_time", { ascending: true })
        .limit(Math.min(a.matchLimit ?? 300, 500)),
    );
    const ids = [...new Set(matches.flatMap((m) => [m.home_team_id, m.away_team_id]))];
    const teams = ids.length
      ? await rows<StandingTeam[]>(
          ctx.db.from("teams").select("id, name, short_name, primary_color, secondary_color").in("id", ids).in("status", ["active", null]).limit(200),
        )
      : [];
    return computeStandings(matches, teams);
  },
});

function fromSqlRow(row: Record<string, unknown>): StandingRow {
  return {
    teamId: Number(row.team_id),
    name: String(row.name ?? ""),
    shortName: (row.short_name as string | null) ?? null,
    primaryColor: (row.primary_color as string | null) ?? null,
    secondaryColor: (row.secondary_color as string | null) ?? null,
    played: Number(row.played ?? 0),
    won: Number(row.won ?? 0),
    drawn: Number(row.drawn ?? 0),
    lost: Number(row.lost ?? 0),
    gf: Number(row.gf ?? 0),
    ga: Number(row.ga ?? 0),
    gd: Number(row.gd ?? 0),
    points: Number(row.points ?? 0),
    form: Array.isArray(row.form) ? (row.form as ("W" | "D" | "L")[]) : [],
  };
}

/** A club's own page: the row, the squad, the fixtures, and the record per competition in one read each. */
export const teamProfile = defineQuery<Row | null, { teamId: number }>({
  key: (a) => `team|id=${a.teamId}`,
  tags: (a) => [`team:${a.teamId}`, "teams"],
  ttlMs: FRESHNESS.slow,
  fetch: async (ctx, a) => await one<Record<string, unknown>>(ctx.db.from("teams").select("*").eq("id", a.teamId).single()),
});

export const squadFor = defineQuery<Row[], { teamIds: number[]; limit?: number }>({
  key: (a) => `squad|teams=${[...a.teamIds].sort((x, y) => x - y).join(",")}`,
  tags: (a) => ["players", ...a.teamIds.map((id) => `squad:${id}`)],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) => {
    if (!a.teamIds.length) return [];
    return await rows<Row[]>(
      ctx.db
        .from("players")
        .select("id, name, number, position, nationality, goals, assists, photo_url, team_id")
        .in("team_id", a.teamIds)
        .order("number", { ascending: true })
        .limit(Math.min(a.limit ?? 60, 120)),
    );
  },
});

export const teamFixtures = defineQuery<MatchCard[], { teamId: number; limit?: number }>({
  key: (a) => `matches|team=${a.teamId}|n=${a.limit ?? 20}`,
  tags: (a) => ["matches", `team:${a.teamId}`],
  ttlMs: FRESHNESS.fast,
  fetch: async (ctx, a) =>
    await rows<MatchCard[]>(
      ctx.db
        .from("matches")
        .select(MATCH_CARD_COLUMNS)
        .or(`home_team_id.eq.${a.teamId},away_team_id.eq.${a.teamId}`)
        .order("start_time", { ascending: false })
        .limit(Math.min(a.limit ?? 20, 50)),
    ),
});

/**
 * Every finished match a club played, for the record shown on its page. One bounded read in place of the
 * per-competition loop `TeamProfile` used to run (`select` all matches of competition X, for each X).
 */
export const teamRecords = defineQuery<(StandingsMatch & { competition_id: number })[], { teamId: number; limit?: number }>({
  key: (a) => `matches|team=${a.teamId}|finished|n=${a.limit ?? 100}`,
  tags: (a) => ["matches", "standings", `team:${a.teamId}`],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await rows<(StandingsMatch & { competition_id: number })[]>(
      ctx.db
        .from("matches")
        .select("competition_id, home_team_id, away_team_id, home_score, away_score, status, start_time")
        .or(`home_team_id.eq.${a.teamId},away_team_id.eq.${a.teamId}`)
        .in("status", DONE_STATUSES)
        .order("start_time", { ascending: true })
        .limit(Math.min(a.limit ?? 100, 300)),
    ),
});

/** The competitions a club appears in — bounded, where the old query had no limit and joined every match. */
export const teamCompetitions = defineQuery<{ id: number; name: string; season: string | null }[], { teamId: number }>({
  key: (a) => `competitions|team=${a.teamId}`,
  tags: (a) => ["competitions", `team:${a.teamId}`],
  ttlMs: FRESHNESS.slow,
  fetch: async (ctx, a) =>
    await rows<{ id: number; name: string; season: string | null }[]>(
      ctx.db
        .from("competitions")
        .select("id, name, type, season")
        .or(`matches.home_team_id.eq.${a.teamId},matches.away_team_id.eq.${a.teamId}`, { referencedTable: "matches" })
        .limit(20),
    ),
});

export const playerProfile = defineQuery<Row | null, { playerId: number }>({
  key: (a) => `player|id=${a.playerId}`,
  tags: (a) => [`player:${a.playerId}`, "players"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await one<Record<string, unknown>>(
      ctx.db.from("players").select("*, teams(id, name, short_name, primary_color, secondary_color, city, coach)").eq("id", a.playerId).single(),
    ),
});


/**
 * How many players each club has, for the team index.
 *
 * `TeamsPage` used to read `select('team_id')` over **every player row** and count them in a Map — one row
 * per squad member, forever. The SQL answer is one grouped read that returns a row per club; until the
 * function is deployed the fallback stays the scan, bounded, so the page cannot silently render "0" for a
 * league it has only partially read.
 */
export const squadSizes = defineQuery<Map<number, number>, { fallbackLimit?: number }>({
  key: () => "teams|squad-sizes",
  tags: () => ["teams", "players", "squad"],
  ttlMs: FRESHNESS.slow,
  fetch: async (ctx) => {
    const { isMissingOnServer } = await import("./context.ts");
    try {
      const res = await ctx.db.rpc("kicklive_squad_sizes");
      if (!res.error && Array.isArray(res.data)) {
        return new Map((res.data as { team_id: number; count: number }[]).map((r) => [Number(r.team_id), Number(r.count)]));
      }
      if (!isMissingOnServer(res.error)) throw new Error(res.error?.message ?? "kicklive_squad_sizes failed");
    } catch (err) {
      if (!isMissingOnServer(err)) throw err;
    }
    const rowsData = await rows<{ team_id: number }[]>(ctx.db.from("players").select("team_id").limit(2000).range(0, 1999));
    const counts = new Map<number, number>();
    for (const row of rowsData) {
      if (row?.team_id == null) continue;
      counts.set(row.team_id, (counts.get(row.team_id) ?? 0) + 1);
    }
    return counts;
  },
});


/** A competition's fixture list, for the admin screens. The team names ride the same join. */
export const competitionFixtures = defineQuery<MatchCard[], { competitionId: number; limit?: number }>({
  key: (a) => `matches|comp=${a.competitionId}|fixtures|n=${a.limit ?? 100}`,
  tags: (a) => ["matches", `competition:${a.competitionId}`],
  ttlMs: FRESHNESS.fast,
  fetch: async (ctx, a) =>
    await rows<MatchCard[]>(
      ctx.db
        .from("matches")
        .select(MATCH_CARD_COLUMNS)
        .eq("competition_id", a.competitionId)
        .order("start_time", { ascending: true })
        .limit(Math.min(a.limit ?? 100, 200)),
    ),
});

/** A single fixture's identity. Everything about the *state* of a live match comes from the room instead. */
export const matchFixture = defineQuery<Row | null, { matchId: number }>({
  key: (a) => `match|id=${a.matchId}|fixture`,
  tags: (a) => [`match:${a.matchId}`, "matches"],
  ttlMs: FRESHNESS.slow,
  fetch: async (ctx, a) =>
    await one<Record<string, unknown>>(
      ctx.db
        .from("matches")
        .select(
          "id, status, venue, start_time, match_start_time, home_team_id, away_team_id, home_score, away_score, minute, is_locked, confirmed_at, homeTeam:teams!home_team_id(id, name, short_name, primary_color, secondary_color), awayTeam:teams!away_team_id(id, name, short_name, primary_color, secondary_color), competitions(name)",
        )
        .eq("id", a.matchId)
        .single(),
    ),
});

/**
 * The parts of a match page the ledger does not answer: commentary, the statistics the events do not
 * produce, and both squads. `MatchDetails` re-reads this when the room's sequence moves and never on a
 * timer, which is the Phase 3 rule; the cache's job here is Back/Forward and the second visitor.
 */
export const matchSupplements = defineQuery<{ commentary: Row[]; statistics: Row | null; players: Row[] }, { matchId: number; teamIds: number[] }>({
  key: (a) => `match|id=${a.matchId}|supplements`,
  tags: (a) => [`match:${a.matchId}`, "matches"],
  ttlMs: FRESHNESS.fast,
  fetch: async (ctx, a) => {
    const [commentary, statistics, players] = await Promise.all([
      rows<Row[]>(ctx.db.from("match_commentary").select("id, minute, content, author, created_at, home_score, away_score").eq("match_id", a.matchId).order("minute", { ascending: true }).limit(200)),
      one<Record<string, unknown>>(ctx.db.from("match_statistics").select("*").eq("match_id", a.matchId).maybeSingle()),
      a.teamIds.length ? rows<Row[]>(ctx.db.from("players").select("id, name, number, position, team_id").in("team_id", a.teamIds).limit(60)) : Promise.resolve([]),
    ]);
    return { commentary, statistics, players };
  },
});

/** The fan portal's news feed of club posts, which no other screen asks for. */
export const teamNews = defineQuery<Row[], { limit?: number }>({
  key: (a) => `team-news|n=${a.limit ?? 10}`,
  tags: () => ["team_news"],
  ttlMs: FRESHNESS.page,
  fetch: async (ctx, a) =>
    await rows<Row[]>(
      ctx.db.from("team_news").select("id, title, body, created_at, author_name, team_id, teams(name, primary_color)").order("created_at", { ascending: false }).limit(Math.min(a.limit ?? 10, 50)),
    ),
});

/** Everything the fan portal used to fetch in one 4-query burst, now four independently-fresh keys. */
export const fanMatches = defineQuery<MatchCard[], { limit?: number }>({
  key: (a) => `matches|recent|n=${a.limit ?? 50}`,
  tags: () => ["matches"],
  ttlMs: FRESHNESS.fast,
  pollMs: FRESHNESS.fast,
  fetch: async (ctx, a) =>
    await rows<MatchCard[]>(
      ctx.db.from("matches").select(MATCH_CARD_COLUMNS).order("start_time", { ascending: false }).limit(Math.min(a.limit ?? 50, 60)),
    ),
});
