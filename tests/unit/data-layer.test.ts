/**
 * Phase 4 · the shared data layer.
 *
 * The layer exists to answer a claim — "opening the home page fires 6 reads, now it fires 1" — so the tests
 * run the *real* query specs against a `db` that counts what it is asked for. That is why `DataCtx` is
 * injected (see `src/lib/data/context.ts`): with a fake in place of Supabase, deduplication, TTL behaviour,
 * tag targeting and query count are ordinary unit tests rather than something a reviewer has to watch a
 * network tab for.
 *
 * What is deliberately not tested here: the transport to the Worker (it does not exist yet in this unit) and
 * anything requiring React — the hook's logic is thin, and it is the same three primitives (subscribe,
 * read once, arm) exercised below through `queryCache` directly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { QueryCache } from "../../src/lib/data/cache.ts";
import { createPerf } from "../../src/lib/data/perf.ts";
import { createTicker } from "../../src/lib/data/ticker.ts";
import { runQuery, setCtx, type DataCtx, type QueryBuilder } from "../../src/lib/data/context.ts";
import { computeStandings, rankStandings, recentForm } from "../../src/lib/data/standings.ts";
import { FRESHNESS } from "../../src/lib/data/freshness.ts";
import { liveMatches, matchList, newsPage, scorers, standings, teamsIndex } from "../../src/lib/data/queries.ts";
import * as queriesModule from "../../src/lib/data/queries.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const sread = (...parts: string[]): string => fs.readFileSync(path.join(REPO, ...parts), "utf8");

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A fake PostgREST: every `.from(t)` returns a chain that records its steps and resolves to canned rows.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface FakeCall {
  table: string;
  select: string | null;
  steps: [string, unknown[]][];
  bounded: boolean;
}

function fakeDb(options: { rows?: Record<string, unknown>; failWith?: string } = {}): { ctx: DataCtx; calls: FakeCall[]; rpcs: { fn: string; args: Record<string, unknown> }[] } {
  const calls: FakeCall[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];

  const makeChain = (table: string, steps: [string, unknown[]][]): QueryBuilder => {
    const api: Record<string, (...args: unknown[]) => QueryBuilder> = {};
    for (const method of ["select", "eq", "neq", "in", "gte", "lte", "ilike", "or", "filter", "order", "limit", "range", "single", "maybeSingle"]) {
      api[method] = (...args: unknown[]) => makeChain(table, [...steps, [method, args]]);
    }
    const thenable = {
      ...api,
      then(onFulfilled?: (v: unknown) => unknown) {
        const select = steps.find(([m]) => m === "select")?.[1][0] as string | undefined;
        calls.push({
          table,
          select: select ?? null,
          steps,
          bounded: steps.some(([m]) => m === "limit" || m === "range" || m === "single" || m === "maybeSingle"),
        });
        const data = options.rows?.[table];
        if (options.failWith) return Promise.reject(new Error(options.failWith)).then(onFulfilled);
        const value = data === undefined ? [] : typeof data === "function" ? (data as (c: FakeCall) => unknown)({ table, select: select ?? null, steps, bounded: Boolean(select) }) : data;
        return Promise.resolve({ data: value, error: null, count: Array.isArray(value) ? value.length : 1 }).then(onFulfilled);
      },
    };
    return thenable as unknown as QueryBuilder;
  };

  return {
    calls,
    rpcs,
    ctx: {
      db: {
        from: (table: string) => makeChain(table, []),
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          rpcs.push({ fn, args: args ?? {} });
          const rowsForRpc = options.rows?.[`rpc:${fn}`];
          if (rowsForRpc === "missing") {
            return { data: null, error: { message: `PGRST202: Could not find the function public.${fn}`, code: "PGRST202" } };
          }
          return { data: rowsForRpc ?? null, error: null };
        },
      },
      // No api client: these specs must work with the Worker absent (docs §4.7's fallback, without a Worker).
    },
  };
}

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as unknown as Storage;
}

const fixtureRows = [
  { id: 1, status: "first_half", minute: 12, home_score: 1, away_score: 0, start_time: "2026-09-10T15:00:00Z" },
  { id: 2, status: "second_half", minute: 55, home_score: 2, away_score: 2, start_time: "2026-09-10T17:30:00Z" },
];

// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("query specs", () => {
  it("ask one question per screen, bounded, with the columns the page renders", async () => {
    const fake = fakeDb({ rows: { matches: fixtureRows, players: [{ id: 9, name: "A", goals: 4 }] } });
    const cache = new QueryCache({ now: clock().now, storage: null });

    const list = await runQuery(matchList, { filter: "live", page: 1, pageSize: 20 }, { cache, ctx: fake.ctx });
    assert.equal(list.data?.rows.length, 2);
    assert.equal(fake.calls.length, 1, "the fixture list is one read, not a read per filter");
    const call = fake.calls[0];
    assert.equal(call.table, "matches");
    assert.ok(call.bounded, "no spec issues an unbounded read (F-06)");
    assert.ok(
      call.steps.some(([m, a]) => m === "range" && a[0] === 20 && a[1] === 39),
      "page 1 of 20 is range(20,39)",
    );
    assert.match(call.select ?? "", /is_locked/, "the read carries the lock flag, which nothing used to select (F-07)");

    const home = await runQuery(liveMatches, { limit: 10 }, { cache, ctx: fake.ctx });
    assert.equal(home.data?.length, 2);
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls[1].bounded);

    const gold = await runQuery(scorers, { limit: 10 }, { cache, ctx: fake.ctx });
    assert.equal(gold.data?.[0].name, "A");
    // A page size a UI cannot inflate: the spec clamps, so `/matches?pageSize=100000` is not a thing.
    const greedy = await runQuery(newsPage, { pageSize: 5000, page: 0 }, { cache: new QueryCache({ now: clock().now, storage: null }), ctx: fake.ctx });
    assert.ok(greedy.data);
    assert.equal(fake.calls.at(-1)?.steps.find(([m]) => m === "range")?.[1]?.[1], 49, "news pages are capped at 50 rows");
  });

  it("keys are the question, so two screens that want the same rows share one entry", async () => {
    assert.equal(matchList.key({ filter: "live", page: 0, pageSize: 20 }), matchList.key({ pageSize: 20, page: 0, filter: "live" }));
    assert.notEqual(matchList.key({ filter: "live", page: 0 }), matchList.key({ filter: "all", page: 0 }));
    assert.equal(teamsIndex.key({}), "teams|active|n=100");
  });
});

describe("cache behaviour", () => {
  it("serves a fresh entry without going to the network, and refetches once the TTL passes", async () => {
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null });
    let fetches = 0;
    const read = () =>
      cache.read({
        key: "k",
        ttlMs: FRESHNESS.fast,
        fetch: () => {
          fetches += 1;
          return Promise.resolve({ n: fetches });
        },
      });

    assert.equal((await read()).source, "fresh");
    assert.equal((await read()).source, "hit");
    assert.equal((await read()).data?.n, 1, "three renders, one request");
    t.advance(FRESHNESS.fast + 1);
    const after = await read();
    assert.equal(after.source, "stale", "expired data is served *while* it is re-fetched, never instead of it");
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2);
    assert.equal(cache.peek<{ n: number }>("k")?.data?.n, 2);
  });

  it("coalesces two callers of the same cold key into one fetch", async () => {
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null });
    let fetches = 0;
    const options = { key: "same", ttlMs: 0, fetch: () => (fetches++, new Promise<number>((r) => setTimeout(() => r(fetches), 5))) };
    const sink = createPerf(t.now);
    const joined = new QueryCache({ now: t.now, storage: null, perfSink: sink });
    let joinedFetches = 0;
    const shared = { key: "same", ttlMs: 0, fetch: () => (joinedFetches++, new Promise<number>((r) => setTimeout(() => r(joinedFetches), 5))) };
    const [a, b] = await Promise.all([joined.read(shared), joined.read(shared)]);
    assert.equal(joinedFetches, 1, "F-02's overlapping readers, counted");
    assert.equal(a.source, "fresh");
    assert.equal(b.source, "fresh", "the waiter receives the owner's result, not a second request");
    assert.equal(b.data, 1);
    assert.equal(sink.summary().coalesced, 1);
    void fetches;
    void cache;
    void options;
  });

  it("keeps the last good value when a refresh fails, and says so", async () => {
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null });
    let shouldFail = false;
    const read = () =>
      cache.read({
        key: "k",
        ttlMs: 1,
        minIntervalMs: 0,
        fetch: () => (shouldFail ? Promise.reject(new Error("PGRST: down")) : Promise.resolve("ok")),
      });
    assert.equal(await read().then((r) => r.data), "ok");
    t.advance(5);
    shouldFail = true;
    const served = await read();
    assert.equal(served.source, "stale", "a refresh in flight serves what we have, it does not hang the page");
    await new Promise((r) => setImmediate(r));
    const failed = cache.peek<string>("k");
    assert.equal(failed?.error, "PGRST: down");
    assert.equal(failed?.data, "ok", "a failed refresh must not blank a page that had data");
    assert.ok(failed?.stale);
  });

  it("invalidates by tag, and only by tag", async () => {
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null });
    for (const [key, tags] of [
      ["squad|teams=12", ["players", "squad:12"]],
      ["media|preview|n=6", ["media", "news"]],
      ["standings|comp=7", ["standings", "standings:7"]],
      ["standings|comp=8", ["standings", "standings:8"]],
    ] as [string, string[]][]) {
      await cache.read({ key, tags, ttlMs: FRESHNESS.slow, fetch: () => Promise.resolve([1]) });
    }
    assert.equal(cache.invalidate("squad:12"), 1, "editing a squad clears that squad");
    assert.equal(cache.invalidate("standings:7"), 1);
    assert.ok(cache.peek("media|preview|n=6"), "and leaves the news cache alone (§4.2)");
    assert.ok(cache.peek("standings|comp=8"));
    assert.equal(cache.invalidate("standings"), 1, "the parent tag clears the rest of the family");
    assert.equal(cache.invalidate("*").valueOf() >= 1, true);
  });

  it("mirrors persisted keys into storage and revalidates them on a cold boot", async () => {
    const store = memoryStore();
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: store });
    let fetches = 0;
    await cache.read({ key: "teams|active|n=100", tags: ["teams"], ttlMs: FRESHNESS.slow, persist: true, fetch: () => (fetches++, Promise.resolve([{ id: 1 }])) });
    assert.ok(store.key(0)?.startsWith("kicklive:cache:v1:"), "the mirror is namespaced");

    const reloaded = new QueryCache({ now: t.now, storage: store });
    const warm = reloaded.peek("teams|active|n=100");
    assert.deepEqual(warm?.data, [{ id: 1 }], "a reload starts warm instead of re-reading (§4.3)");
    assert.equal(warm?.stale, false);
    t.advance(FRESHNESS.slow * 2);
    assert.equal(reloaded.peek("teams|active|n=100")?.stale, true, "warm is not the same as fresh");
    void fetches;
  });

  it("drops everything when the signed-in identity changes", async () => {
    const store = memoryStore();
    const cache = new QueryCache({ now: clock().now, storage: store });
    cache.setIdentity("user-a");
    await cache.read({ key: "teams|active|n=100", tags: ["teams"], ttlMs: FRESHNESS.slow, persist: true, fetch: () => Promise.resolve([{ id: 1 }]) });
    assert.ok(store.length > 0);
    cache.setIdentity("user-b");
    assert.equal(cache.peek("teams|active|n=100"), null, "an RLS answer belongs to the user who earned it");
    assert.equal(store.length, 0, "and its mirror goes with it");
    cache.setIdentity(null);
    assert.equal(cache.boundIdentity, null);
  });

  it("counts what it did, so the improvement is a number and not an adjective", async () => {
    const sink = createPerf(clock().now);
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null, perfSink: sink });
    const read = () => cache.read({ key: "k", ttlMs: 1000, fetch: () => Promise.resolve(1) });
    await read();
    await read();
    await read();
    t.advance(2000);
    await read();
    const summary = sink.summary();
    assert.equal(summary.reads, 2);
    assert.equal(summary.hits, 2);
    assert.equal(summary.slowestMs, 0, "the fake resolves synchronously; a real number needs a real fetch");
    assert.ok(summary.perKey.k);
  });
});

describe("the one ticker", () => {
  it("sweeps armed keys at their cadence, and not while the tab is hidden", async () => {
    const t = clock();
    const cache = new QueryCache({ now: t.now, storage: null });
    let fetches = 0;
    await cache.read({ key: "poll", ttlMs: FRESHNESS.fast, fetch: () => (fetches++, Promise.resolve(fetches)) });
    const unregister = cache.registerRefetcher("poll", async () => {
      await cache.read({ key: "poll", ttlMs: FRESHNESS.fast, minIntervalMs: 0, fetch: () => (fetches++, Promise.resolve(fetches)) });
    });
    cache.arm("poll", FRESHNESS.fast);

    let hidden = false;
    const doc = {
      get visibilityState() {
        return hidden ? "hidden" : "visible";
      },
    };
    let fired: (() => void) | null = null;
    const ticker = createTicker(
      cache,
      {
        document: doc as unknown as { visibilityState: string },
        setInterval: ((fn: () => void) => {
          fired = fn;
          return 1 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
      },
      1000,
    );
    ticker.start();
    assert.ok(fired, "start() installs exactly one timer for the whole app");

    hidden = true;
    t.advance(FRESHNESS.fast * 3);
    fired?.();
    assert.equal(fetches, 1, "a backgrounded tab asks for nothing (F-04)");

    hidden = false;
    fired?.();
    await cache.sweep(t.now());
    assert.equal(fetches, 2, "coming back catches up once");
    await cache.sweep(t.now());
    await cache.sweep(t.now() + 1);
    assert.equal(fetches, 2, "and a second sweep in the same interval does not double-fire");

    cache.arm("other|nothing", 1000);
    await cache.sweep(t.now() + 60_000);
    assert.equal(fetches, 2, "a key nobody registered a refetcher for is skipped, not spun on");
    unregister();
    cache.clear();
  });
});

describe("standings", () => {
  const matches = [
    { home_team_id: 1, away_team_id: 2, home_score: 2, away_score: 0, status: "full_time", start_time: "2026-01-01" },
    { home_team_id: 2, away_team_id: 3, home_score: 1, away_score: 1, status: "completed", start_time: "2026-01-08" },
    { home_team_id: 3, away_team_id: 1, home_score: 0, away_score: 3, status: "scheduled", start_time: "2026-01-15" },
    { home_team_id: 1, away_team_id: 3, home_score: 1, away_score: 0, status: "finished", start_time: "2026-01-20" },
  ];
  const teams = [
    { id: 1, name: "Ashanti Gold", short_name: "AG", primary_color: "#111", secondary_color: "#222" },
    { id: 2, name: "Bechem United", short_name: "BU", primary_color: null, secondary_color: null },
    { id: 3, name: "Cape Coast", short_name: null, primary_color: null, secondary_color: null },
  ];

  it("is one rule, applied in one place", () => {
    const table = computeStandings(matches as never, teams);
    assert.deepEqual(
      table.map((r) => [r.name, r.points, r.played, r.gd]),
      [
        ["Ashanti Gold", 6, 2, 3],
        ["Cape Coast", 1, 2, -1],
        ["Bechem United", 1, 2, -2],
      ],
      "points, then goal difference, then goals for, then name — and the scheduled match is not played",
    );
    assert.equal(table[0].gf, 3);
    assert.deepEqual(recentForm(table[0]), ["W", "W"]);
    assert.equal(table[2].played, 2, "the legacy `finished` row counts against Cape Coast; the scheduled one does not");
    assert.equal(table[2].gd, -2, "Bechem's two conceded in the opener decide the order");
    // Level on points, goal difference and goals for, the name is the last resort — deterministic, not Map order.
    const tie = computeStandings([{ home_team_id: 5, away_team_id: 4, home_score: 1, away_score: 1, status: "full_time" }], [
      { id: 5, name: "Zanaco" },
      { id: 4, name: "AFC/Leo" },
    ] as never);
    assert.deepEqual(
      tie.map((r) => r.name),
      ["AFC/Leo", "Zanaco"],
    );
  });

  it("names the teams, which is what TeamProfile's copy could not do (F-05)", () => {
    const table = rankStandings(computeStandings(matches as never, []));
    assert.deepEqual(table, [], "a team with no row in the teams index is not invented");
    const withNames = computeStandings(matches as never, teams);
    assert.ok(withNames.every((r) => typeof r.name === "string" && r.name.length > 0));
  });

  it("prefers the SQL aggregate and falls back to the browser rule when it is not deployed", async () => {
    const fake = fakeDb({
      rows: {
        "rpc:kicklive_competition_standings": "missing" as never,
        matches: matches as never,
        teams: teams as never,
      },
    });
    const cache = new QueryCache({ now: clock().now, storage: null });
    const result = await runQuery(standings, { competitionId: 7 }, { cache, ctx: fake.ctx });
    assert.equal(fake.rpcs.length, 1, "asked the database first");
    assert.equal(fake.calls.length, 2, "then fetched matches and teams once each, instead of once per competition");
    assert.ok(result.data && result.data.length === 3);
    assert.equal(result.data?.[0].name, "Ashanti Gold");
  });

  it("does not fall back when the function exists but says no", async () => {
    const fake = fakeDb({});
    fake.ctx.db.rpc = async () => ({ data: null, error: { message: "42501: permission denied for matches", code: "42501" } });
    const result = await runQuery(standings, { competitionId: 7 }, { cache: new QueryCache({ now: clock().now, storage: null }), ctx: fake.ctx });
    // The cache turns a refused read into `error` + the value it still has; it never throws at a render.
    assert.equal(result.error, "42501: permission denied for matches");
    assert.equal(result.data, null);
    assert.equal(fake.calls.length, 0, "a permission error is not a reason to go fetch the whole table instead");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The ratchet: what the pages are allowed to look like now, and what the layer is never allowed to contain.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the migrated screens", () => {
  const read = (...parts: string[]): string => sread(...parts);
  const codeOf = (file: string): string => {
    const src = read(file);
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  };

  const READ_ONLY_PAGES = [
    "src/pages/HomePage.tsx",
    "src/pages/MatchesPage.tsx",
    "src/pages/StandingsPage.tsx",
    "src/pages/NewsPage.tsx",
    "src/pages/TeamsPage.tsx",
    "src/pages/TeamProfile.tsx",
    "src/pages/PlayerProfile.tsx",
    "src/pages/MatchDetails.tsx",
    "src/components/Header.tsx",
  ];

  for (const file of READ_ONLY_PAGES) {
    it(`${file} reads through the layer, not through a client`, () => {
      const body = codeOf(file);
      // Quote-agnostic and depth-agnostic: prettier reflows this tree, and the assertion is about whether
      // the page imports the layer, not about which quote character a formatter happened to choose.
      assert.match(body, /from\s+["'][.\/]+lib\/data["']/, `${file} must import the data layer`);
      assert.ok(!/supabase/.test(body), `${file} must not hold a Supabase client any more`);
    });
  }

  it("the pages that used to poll do not own a timer that refetches", () => {
    for (const file of ["src/pages/HomePage.tsx", "src/pages/MatchesPage.tsx", "src/pages/portals/FanPortal.tsx", "src/pages/StandingsPage.tsx"]) {
      const body = codeOf(file);
      for (const match of body.matchAll(/setInterval\([\s\S]{0,400}/g)) {
        const window = match[0];
        assert.ok(!/\.from\(|supabase|refetch\(\)/.test(window), `${file} still has a fetch inside a timer`);
      }
    }
  });

  it("the app boots the layer and no longer warms a cache nobody reads (F-01)", () => {
    const app = codeOf("src/App.tsx");
    assert.ok(!/dataLoader\s*\.\s*\w+\(/.test(app), "the startup loadAll() and its five-minute refresh are gone");
    assert.ok(!app.includes('from "./lib/DataLoader"'), "and nothing imports the loader any more");
    assert.ok(app.includes("initDataLayer()"), "and one call starts the shared ticker instead");
    assert.ok(fs.existsSync(path.join(REPO, "src/lib/DataLoader.ts")), "the class itself is kept: a cache with no readers is deleted by a decision, not by a refactor");
    assert.ok(read("src/lib/DataLoader.ts").includes("F-01"), "and it says why nothing calls it");
  });

  it("the cache is bound to the signed-in identity", () => {
    const auth = codeOf("src/contexts/AuthContext.tsx");
    assert.ok(auth.includes("noteAuthIdentity(user?.id ?? null)"), "an RLS answer must not outlive the user who earned it");
    assert.ok(auth.includes('invalidate("*")'), "and signing out drops what the previous token read");
    assert.ok(auth.includes("useMemo<AuthContextType>"), "F-10: the provider value is memoised");
  });

  it("the live console dirties the lists it makes wrong", () => {
    const consoleSrc = codeOf("src/pages/portals/admin/MatchControlCenter.tsx");
    assert.match(consoleSrc, /invalidate\(`match:\$\{matchId\}`, "matches"\)/, "a sequence move invalidates the tags, not the world");
    assert.ok(!consoleSrc.includes("lib/supabase"), "and it holds no client of its own");
  });

  it("every spec is bounded, tagged and TTL'd — checked by running them, not by reading them", async () => {
    const strictDb = () => {
      const chain = (table: string, steps: [string, unknown[]][]): QueryBuilder => {
        const api: Record<string, (...args: unknown[]) => QueryBuilder> = {};
        for (const m of ["select", "eq", "neq", "in", "gte", "lte", "ilike", "or", "filter", "order", "limit", "range", "single", "maybeSingle"])
          api[m] = (...args: unknown[]) => chain(table, [...steps, [m, args]]);
        return {
          ...api,
          then(onFulfilled?: (v: unknown) => unknown) {
            const bounded = steps.some(([m]) => ["limit", "range", "single", "maybeSingle"].includes(m));
            if (!bounded) throw new Error(`unbounded read against ${table}`);
            return Promise.resolve({ data: [], error: null, count: 0 }).then(onFulfilled);
          },
        } as unknown as QueryBuilder;
      };
      return {
        db: {
          from: (table: string) => chain(table, []),
          rpc: async () => ({ data: [], error: { message: "PGRST202: Could not find the function", code: "PGRST202" } }),
        },
      } as unknown as DataCtx;
    };

    // Sample arguments for every exported spec. A new read that is not listed here fails this test on
    // purpose: it means somebody added a query without anyone deciding what its bounds are.
    const sampleArgs: Record<string, unknown> = {
      matchList: { filter: "live", page: 0, pageSize: 20 },
      liveMatches: { limit: 10 },
      fanMatches: { limit: 50 },
      recentResults: { hours: 24, limit: 8 },
      globalSearch: { query: "gold" },
      scorers: { limit: 10 },
      newsPreview: { limit: 6 },
      newsPage: { category: "News", query: "x", page: 0, pageSize: 12 },
      newsArticle: { id: 3 },
      teamsIndex: {},
      squadSizes: {},
      competitionsIndex: {},
      standings: { competitionId: 7 },
      teamProfile: { teamId: 4 },
      squadFor: { teamIds: [4, 5] },
      teamFixtures: { teamId: 4, limit: 20 },
      teamRecords: { teamId: 4 },
      teamCompetitions: { teamId: 4 },
      playerProfile: { playerId: 9 },
      matchFixture: { matchId: 2 },
      matchSupplements: { matchId: 2, teamIds: [4, 5] },
      competitionFixtures: { competitionId: 7 },
      teamNews: { limit: 10 },
    };

    const specs = Object.entries(queriesModule).filter(([, value]) => value && typeof value === "object" && typeof (value as any).key === "function" && typeof (value as any).fetch === "function");
    assert.ok(specs.length >= Object.keys(sampleArgs).length - 1, `the layer exports ${specs.length} specs`);
    for (const [name, spec] of specs) {
      const args = sampleArgs[name];
      assert.notEqual(args, undefined, `no sample args for the ${name} spec — add bounds to the test, not just to the query`);
      const typed = spec as unknown as { ttlMs: number; tags: (a: never) => string[]; fetch: (ctx: DataCtx, a: never) => Promise<unknown> };
      assert.ok(typed.ttlMs > 0, `${name} must declare a freshness class (§4.3) — no read joins this layer uncached and untimed`);
      assert.ok(typed.tags(args as never).length > 0, `${name} must name the tags a mutation invalidates it by (§4.2)`);
      await typed.fetch(strictDb(), args as never);
    }
  });
});
