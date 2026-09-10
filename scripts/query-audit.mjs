#!/usr/bin/env node
/**
 * KICKLIVE · query audit (Phase 4)
 *
 * Two jobs, because "improved caching, batching and performance" has to be a number and not a feeling:
 *
 *   1. `--static` (default) — read the frontend the way the database sees it: every PostgREST call site,
 *      which table it touches, whether it bounds its own result, whether it writes, and which component
 *      owns a timer. This is the only honest way to answer "how many queries does opening the home page
 *      actually make", because the answer is spread over `useEffect` blocks in 40 files.
 *   2. `--live` — replay the canonical public reads against a real project with `Prefer: count=estimated`
 *      and report rows + latency. Needs credentials and a network; it never writes, and it never runs
 *      without `--url`/`--key`. `--explain` prints the SQL to run in the dashboard, because PostgREST has
 *      no EXPLAIN endpoint and pretending otherwise would be a fake measurement.
 *
 * The ratchet: `--check` compares the static counts with `scripts/query-audit.baseline.json` and fails if
 * unbounded reads or timer-owned polls went UP. `--write-baseline` moves the baseline down when the tree
 * genuinely improved. A perf claim without a failing-before check is a changelog entry, not a gate.
 *
 * Usage:
 *   node scripts/query-audit.mjs                       # human-readable audit
 *   node scripts/query-audit.mjs --json                # machine-readable
 *   node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md
 *   node scripts/query-audit.mjs --check               # CI gate against the baseline
 *   node scripts/query-audit.mjs --live --url https://REF.supabase.co --key $ANON_KEY --iterations 5
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_ROOTS = ["src/pages", "src/components", "src/contexts", "src/lib", "src/hooks"];
const BASELINE_FILE = path.join(ROOT, "scripts/query-audit.baseline.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * Remove comments so a docblock that mentions `supabase.from('matches')` is not counted as a query.
 * Offsets are preserved — every removed character is replaced by a space, newlines kept — because the
 * line numbers in the report have to point at the real file.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(?<=^|\s)\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const SELECT_CHAIN = 460;

/**
 * Every `.from('table')` / `.rpc('fn')` in the app, with the modifiers that follow it on the same
 * expression. `insert/update/delete/upsert` are marked as writes; a read with no `limit`/`range`/
 * `single` is `unbounded`, which is the thing that turns into a 5 MB response when a league grows.
 */
export function scanQuerySites(root = ROOT) {
  const files = SCAN_ROOTS.flatMap((d) => walk(path.join(root, d)));
  const sites = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const raw = fs.readFileSync(file, "utf8");
    const src = codeOnly(raw);
    for (const m of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + SELECT_CHAIN);
      const writeMatch = tail.match(/^\s*\.\s*(insert|update|delete|upsert)\s*\(/);
      const select = tail.match(/^\s*\.select\(\s*(['"`])((?:[^\\]|\\.)*?)\1/s);
      const modifiers = [...tail.matchAll(/\.(eq|neq|in|gte|lte|gt|lt|is|like|ilike|or|not|filter|order|limit|range|single|maybeSingle|match)\s*\(/g)].map((x) => x[1]);
      const embeds = /\(\s*[a-z_]+\s*[,:|]/i.test(select?.[2] ?? "") && /:(\w+)\s*!/.test(select?.[2] ?? "");
      sites.push({
        file: rel,
        line: src.slice(0, m.index).split("\n").length,
        table: m[1],
        kind: writeMatch ? "write" : "read",
        write: Boolean(writeMatch),
        op: writeMatch ? writeMatch[1] : "select",
        // `select('*')` on a table with 40 columns costs the transfer; a named list costs what the page shows.
        star: Boolean(select) && /(^|,)\s*\*\s*(,|$)/.test(select[2]) ? true : !select && !writeMatch,
        columns: select ? select[2].replace(/\s+/g, " ").trim() : null,
        bounded: modifiers.some((x) => ["limit", "range", "single", "maybeSingle"].includes(x)),
        embeds: embeds || /:[a-z_]+\s*!/.test(select?.[2] ?? ""),
        modifiers: [...new Set(modifiers)],
      });
    }
    for (const m of src.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)) {
      sites.push({
        file: rel,
        line: src.slice(0, m.index).split("\n").length,
        table: `rpc:${m[1]}`,
        kind: "rpc",
        write: !/^kicklive_(record_media_view)$/.test(m[1]) ? true : true,
        op: "rpc",
        star: false,
        columns: null,
        bounded: true,
        embeds: false,
        modifiers: ["rpc"],
      });
    }
  }
  return sites;
}

/**
 * `setInterval` sites. The engine's own intervals (`src/lib/live/**`) are the heartbeat/resume ladder
 * and are excluded: they are documented in docs/PRODUCTION_ARCHITECTURE.md §17, not page polling.
 * A poll is `direct` when the interval body holds the `.from()` itself and `indirect` when it calls a
 * loader in the same file; both count as polling for the ratchet.
 */
export function scanPollers(root = ROOT) {
  const files = SCAN_ROOTS.flatMap((d) => walk(path.join(root, d)));
  const pollers = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = codeOnly(raw);
    const lines = raw.split("\n");
    for (const m of src.matchAll(/setInterval\(/g)) {
      // Read forward to the call's closing paren so the interval body is captured whole, whatever
      // its size, and then take the delay as the last number in it.
      let depth = 0;
      let i = src.indexOf("(", m.index);
      let end = -1;
      for (; i < src.length && i < m.index + 4000; i++) {
        const ch = src[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = (end > 0 ? src.slice(m.index, end + 1) : src.slice(m.index, m.index + 400)).replace(/\s+/g, " ");
      // The delay is the last argument; it is sometimes written as `5 * 60 * 1000`, so a product of
      // integers is folded too rather than reporting an unknown interval.
      const delayArg = body.match(/,(?:\s*(?:Math\.max\(|\()?)\s*([\d*\s]+)\s*\)?\s*\)?\s*$/)?.[1] ?? "";
      const everyMs = /\d/.test(delayArg)
        ? delayArg
            .trim()
            .split("*")
            .map((x) => Number(x.trim()) || 0)
            .reduce((a, b) => a * b, 1)
        : 0;
      const line = src.slice(0, m.index).split("\n").length;
      const direct = /\.from\(|fetch\(|api\.(get|post)/.test(body);
      const loader = /load|refresh|refetch|fetchData|tick\(\)/.test(body);
      if (!direct && !loader) continue;
      pollers.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        line,
        everyMs,
        mode: direct ? "direct" : "indirect",
        text: (lines[line - 1] ?? "").trim().slice(0, 110),
      });
    }
  }
  return pollers;
}

const ENGINE = /^src\/lib\/live\//;

export function summarise() {
  const sites = scanQuerySites();
  const pollers = scanPollers();
  const tables = new Map();
  const files = new Map();
  for (const s of sites) {
    const t = tables.get(s.table) ?? { reads: 0, writes: 0, star: 0, unbounded: 0 };
    if (s.write) t.writes++;
    else t.reads++;
    if (s.star) t.star++;
    if (!s.bounded && !s.write) t.unbounded++;
    tables.set(s.table, t);

    const f = files.get(s.file) ?? { reads: 0, writes: 0, star: 0, unbounded: 0, tables: new Set() };
    if (s.write) f.writes++;
    else f.reads++;
    if (s.star) f.star++;
    if (!s.bounded && !s.write) f.unbounded++;
    f.tables.add(s.table);
    files.set(s.file, f);
  }
  const unbounded = sites.filter((s) => !s.bounded && !s.write);
  const appPollers = pollers.filter((p) => !ENGINE.test(p.file));
  return {
    generatedBy: "scripts/query-audit.mjs --static",
    totals: {
      querySites: sites.length,
      reads: sites.filter((s) => !s.write).length,
      writes: sites.filter((s) => s.write).length,
      rpc: sites.filter((s) => s.kind === "rpc").length,
      starSelects: sites.filter((s) => s.star && !s.write).length,
      unboundedReads: unbounded.length,
      files: files.size,
      tables: tables.size,
      pollers: appPollers.length,
      pollsThatRefetch: appPollers.filter((p) => p.mode === "direct").length,
    },
    tables: [...tables.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.reads + b.writes - (a.reads + a.writes)),
    files: [...files.entries()].map(([name, v]) => ({ name, ...v, tables: [...v.tables].sort() })).sort((a, b) => b.reads + b.writes - (a.reads + a.writes)),
    pollers: appPollers,
    unbounded: unbounded.map((s) => ({ file: s.file, line: s.line, table: s.table, columns: s.columns })),
  };
}

function renderDoc(report) {
  const L = [];
  L.push("# Phase 4 · query inventory (generated)");
  L.push("");
  L.push("Regenerate: `node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md`.");
  L.push("");
  L.push("Machine-extracted from the tree, comments stripped, so a docblock that mentions a query is not");
  L.push("counted. `unbounded` = a read with no `limit`/`range`/`single`; `star` = `select('*')` or an");
  L.push("embedded join of whole rows. Both are only problems at scale, which is why they are counted and");
  L.push("not simply banned: `select('*').eq('id', auth.uid()).single()` is fine, `select('*')` over");
  L.push("`players` is not.");
  L.push("");
  L.push(`| total sites | reads | writes | rpc | \`select('*')\` | unbounded | files | tables | pollers |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  const t = report.totals;
  L.push(`| ${t.querySites} | ${t.reads} | ${t.writes} | ${t.rpc} | ${t.starSelects} | ${t.unboundedReads} | ${t.files} | ${t.tables} | ${t.pollers} |`);
  L.push("");
  L.push("## By table");
  L.push("");
  L.push("| table | reads | writes | unbounded reads | whole-row selects |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const row of report.tables) L.push(`| \`${row.name}\` | ${row.reads} | ${row.writes} | ${row.unbounded} | ${row.star} |`);
  L.push("");
  L.push("## By file");
  L.push("");
  L.push("| file | reads | writes | unbounded | whole-row | tables |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of report.files) L.push(`| \`${row.name}\` | ${row.reads} | ${row.writes} | ${row.unbounded} | ${row.star} | ${row.tables.map((x) => `\`${x}\``).join(" ")} |`);
  L.push("");
  L.push("## Components that own their own polling");
  L.push("");
  L.push("| file | ln | every | how it refetches |");
  L.push("| --- | --- | --- | --- |");
  for (const p of report.pollers)
    L.push(
      `| \`${p.file}\` | ${p.line} | ${p.everyMs ? (p.everyMs >= 1000 ? `${(p.everyMs / 1000).toFixed(0)} s` : `${p.everyMs} ms`) : "?"} | ${p.mode === "direct" ? "the interval body calls `.from()`" : "the interval calls a loader in the same file"} |`,
    );
  L.push("");
  L.push("`src/lib/live/**` is excluded: its intervals are the live engine's heartbeat/resume ladder,");
  L.push("documented in `docs/PRODUCTION_ARCHITECTURE.md` §17, not page polling.");
  L.push("");
  L.push("## Unbounded reads");
  L.push("");
  for (const u of report.unbounded) L.push(`- \`${u.file}:${u.line}\` — \`${u.table}\`${u.columns ? ` — ${u.columns.slice(0, 90)}` : ""}`);
  L.push("");
  return `${L.join("\n")}\n`;
}

/** The canonical public reads, for `--live` and for `--explain`. */
export const CANONICAL_QUERIES = [
  {
    name: "home: live matches",
    from: "matches",
    select: "id,home_score,away_score,status,minute,homeTeam:teams!home_team_id(name,short_name),awayTeam:teams!away_team_id(name,short_name),competitions(name)",
    query: "status=in.(first_half,second_half,extra_time,half_time,live)&order=start_time.desc&limit=10",
    index: "matches_status_start_time_idx",
  },
  {
    name: "matches: page 1 (all filter)",
    from: "matches",
    select: "id,home_score,away_score,status,minute,start_time,competition_id,homeTeam:teams!home_team_id(name,short_name),awayTeam:teams!away_team_id(name,short_name),competitions(name)",
    query: "order=start_time.desc&limit=50",
    index: "matches_start_time_idx",
  },
  {
    name: "standings: every match of one competition",
    from: "matches",
    select: "home_team_id,away_team_id,home_score,away_score,status",
    query: "competition_id=eq.1",
    index: "matches_competition_id_start_time_idx",
  },
  {
    name: "top scorers",
    from: "players",
    select: "id,name,goals,nationality,teams(name)",
    query: "order=goals.desc&limit=10",
    index: "players_goals_idx",
  },
  {
    name: "teams index",
    from: "teams",
    select: "id,name,short_name,city,coach,primary_color,secondary_color,status",
    query: "status=in.(active,null)&order=name.asc",
    index: "teams_status_name_idx",
  },
  {
    name: "news page 1",
    from: "media",
    select: "id,title,excerpt,category,image_url,created_at",
    query: "order=created_at.desc&limit=9&offset=0",
    index: "media_created_at_idx",
  },
];

async function runLive({ iterations }) {
  const url = value("url");
  const key = value("key");
  if (!url || !key) {
    console.error("--live needs --url https://<ref>.supabase.co and --key <anon key>");
    process.exitCode = 2;
    return;
  }
  console.log(`Replaying ${CANONICAL_QUERIES.length} canonical reads against ${url.replace(/https:\/\/([a-z0-9-]+)\./, "https://$1.")} × ${iterations}\n`);
  console.log("| query | rows | median ms | min | max |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const q of CANONICAL_QUERIES) {
    const times = [];
    let rows = "?";
    for (let i = 0; i < iterations; i++) {
      const started = process.hrtime.bigint();
      const res = await fetch(`${url}/rest/v1/${q.from}?${q.query}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=estimated" },
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      times.push(ms);
      if (!res.ok) {
        rows = `HTTP ${res.status}`;
        break;
      }
      const cr = res.headers.get("content-range");
      if (cr) rows = cr.split("/")[1] ?? cr;
      await res.arrayBuffer();
    }
    times.sort((a, b) => a - b);
    const mid = times.length ? times[Math.floor(times.length / 2)] : 0;
    console.log(`| ${q.name} | ${rows} | ${mid.toFixed(1)} | ${(times[0] ?? 0).toFixed(1)} | ${(times.at(-1) ?? 0).toFixed(1)} |`);
  }
}

function explainSql() {
  const lines = [];
  lines.push("-- Run in the Supabase SQL editor, one at a time, against a production-shaped database.");
  lines.push("-- EXPLAIN (ANALYZE) actually executes the read: these are all SELECTs, so that is safe.");
  lines.push("-- `SET LOCAL` keeps it inside a transaction that rolls back, in case a future entry writes.");
  for (const q of CANONICAL_QUERIES) {
    lines.push("");
    lines.push(`-- ${q.name}`);
    lines.push("begin;");
    lines.push(`explain (analyze, buffers, settings) select ${q.columns ?? "*"} from ${q.from}`);
    if (q.query) {
      const where = q.query
        .split("&")
        .filter((kv) => !["order", "limit", "offset"].includes(kv.split("=")[0]))
        .map((kv) => {
          const [col, rest] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
          const [op, ...vals] = rest.split(".");
          const v = vals.join(".");
          if (op === "in")
            return `${col} in (${v
              .split(",")
              .map((x) => (x === "null" ? "null" : `'${x}'`))
              .join(",")})`;
          if (op === "eq") return `${col} = ${/^\d+$/.test(v) ? v : `'${v}'`}`;
          return `${col} ${op} ${v}`;
        });
      if (where.length) lines.push(`where ${where.join(" and ")}`);
    }
    const order = q.query?.match(/order=([^.]+)\.(asc|desc)/);
    if (order) lines.push(`order by ${decodeURIComponent(order[1])} ${order[2].toUpperCase()}`);
    const limit = q.query?.match(/limit=(\d+)/);
    if (limit) lines.push(`limit ${limit[1]}`);
    lines.push("rollback;");
    lines.push(`-- candidate index: ${q.index}`);
  }
  return `${lines.join("\n")}\n`;
}

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return null;
  }
}

const report = summarise();

if (flag("explain")) {
  process.stdout.write(explainSql());
} else if (flag("live")) {
  await runLive({ iterations: Number(value("iterations") ?? 5) });
} else if (flag("write-baseline")) {
  const baseline = { totals: report.totals, generatedBy: report.generatedBy };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`query-audit: baseline written to ${path.relative(ROOT, BASELINE_FILE)}`);
} else if (flag("write")) {
  const out = value("write");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderDoc(report));
  console.log(`query-audit: wrote ${path.relative(ROOT, out)} (${report.totals.querySites} sites)`);
} else if (flag("check")) {
  const base = readBaseline();
  if (!base) {
    console.error("query-audit: no baseline at scripts/query-audit.baseline.json (run --write-baseline)");
    process.exitCode = 1;
  } else {
    const problems = [];
    for (const key of ["unboundedReads", "pollers", "starSelects"]) {
      const before = base.totals[key];
      const now = report.totals[key];
      if (now > before) problems.push(`${key} went up: baseline ${before} → now ${now}`);
    }
    if (problems.length) {
      console.error(`query-audit: FAILED\n  ${problems.join("\n  ")}`);
      console.error("  Either bound the query / replace the poll with a shared cache, or move the baseline");
      console.error("  down on purpose with `node scripts/query-audit.mjs --write-baseline` and say why.");
      process.exitCode = 1;
    } else {
      console.log(
        `query-audit: ok — unbounded ${report.totals.unboundedReads}/${base.totals.unboundedReads}, pollers ${report.totals.pollers}/${base.totals.pollers}, whole-row ${report.totals.starSelects}/${base.totals.starSelects}`,
      );
    }
  }
} else if (flag("json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(renderDoc(report).split("\n").slice(0, 46).join("\n"));
  console.log(`\n… full inventory: node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md`);
}
