/**
 * Phase 5 · the notification migration, read as text.
 *
 * There is no Postgres in this sandbox, so nothing here executes the SQL — the same limitation Phase 3
 * recorded, and the reason these tests exist instead of a claim that the schema works. What *is* checkable
 * without a database is the class of mistake a migration like this actually makes:
 *
 *   - the category vocabulary drifting between the places it is repeated, which fails silently (a switch the
 *     user turned on that nothing sends) rather than loudly;
 *   - a per-user inbox left behind a table-wide read policy — a privacy incident with no error message;
 *   - a "safe, additive" file that contains a destructive statement, usually one added three edits later;
 *   - idempotency that is only *described* in a comment and never created as a unique index;
 *   - a preference join that turns "no row yet" into "opted out", which silently un-notifies every account
 *     that never opened the settings screen.
 *
 * Each of those is a text property of this file or of the TypeScript that mirrors it, so each is asserted
 * here. The behavioural half — RLS actually refusing a cross-user read, `on conflict` absorbing a replay —
 * needs §18 of docs/NOTIFICATIONS_ARCHITECTURE.md to have been run against a real project, and no test in
 * this file claims otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS, PREFERENCE_DEFAULTS, preferencesDocument } from "../../src/lib/data/notifications.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const MIGRATION = path.join(REPO, "supabase/migrations/20260911120000_phase5_notifications.sql");
const src = fs.readFileSync(MIGRATION, "utf8");

/** The file without `--` comment lines: statements, not prose. */
const code = src.replace(/^\s*--.*$/gm, "");

/**
 * Whitespace collapsed. The SQL wraps lines for legibility, and a test that depends on where a line breaks is
 * a test that fails the next time someone improves the formatting — which trains people to delete tests.
 */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const has = (haystack: string, needle: string, what: string) => assert.ok(norm(haystack).includes(norm(needle)), `${what}\n    expected to find: ${norm(needle)}`);

/** The body of `create or replace function public.<name>(…)`, up to the closing `$$;`. */
function fnBody(name: string): string {
  const at = code.indexOf(`create or replace function public.${name}(`);
  assert.ok(at >= 0, `${name} is not defined in the migration`);
  const open = code.indexOf("as $$", at);
  const close = code.indexOf("$$;", open);
  assert.ok(open > 0 && close > open, `${name} has no $$ body`);
  return code.slice(open + 4, close);
}

/** The argument list of a function, as declared — found by counting parens, because one-line and wrapped
 * signatures both occur, and slicing to the next `\n)` silently grabs the body of the short ones. */
function fnArgs(name: string): string {
  const head = `create or replace function public.${name}(`;
  const at = code.indexOf(head);
  assert.ok(at >= 0, `${name} is not defined in the migration`);
  let depth = 1;
  let i = at + head.length;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") depth--;
  }
  return code.slice(at + head.length, i - 1);
}

/** The kind list inside a `check (kind in (…))`, parsed rather than string-compared. */
function kindsIn(constraint: string): string[] {
  const flat = norm(code);
  const at = flat.indexOf(`constraint ${constraint} check (kind in (`);
  assert.ok(at >= 0, `${constraint} does not gate on kind`);
  const open = at + `constraint ${constraint} check (kind in (`.length;
  return flat
    .slice(open, flat.indexOf(")", open))
    .split(",")
    .map((x) => x.trim().replace(/^'|'$/g, ""));
}

/** Every `unnest(array[…]) as k(ind)?` list, as parsed kinds. */
function inlineKindLists(): string[][] {
  return [...norm(code).matchAll(/select unnest\(array\[([^\]]+)\]\) as k(?:ind)?/g)].map((m) => m[1]!.split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
}

describe("phase5 · the vocabulary is one list, repeated as little as SQL allows", () => {
  it("appears identically in every CHECK constraint that needs it", () => {
    for (const constraint of ["notifications_kind_check", "notification_preferences_kind_check", "notification_jobs_kind_check"]) {
      assert.deepEqual(kindsIn(constraint), [...NOTIFICATION_KINDS], `${constraint} is a different vocabulary from the rest`);
    }
  });

  it("appears identically in the two inline lists the RPCs validate against", () => {
    const lists = inlineKindLists();
    assert.equal(lists.length, 2, "expected exactly the defaults-document and the set-preferences validator");
    for (const list of lists) {
      assert.deepEqual(list, [...NOTIFICATION_KINDS], "an inline list drifted from the schema's CHECK");
    }
  });

  it("matches the TypeScript the settings screen renders", () => {
    assert.equal(NOTIFICATION_KINDS.length, 11, "the brief's categories, no more");
    assert.deepEqual([...NOTIFICATION_KINDS], ["goal", "red_card", "half_time", "full_time", "match_start", "match_reminder", "team_update", "competition_update", "news", "system", "announcement"]);
  });

  it("drives the preference defaults on both sides", () => {
    const body = fnBody("kicklive_preference_defaults");
    assert.ok(/select '\{/.test(norm(body)) && /\}'::jsonb/.test(norm(body)), "the defaults must be a literal jsonb object, so there is nothing to compute wrongly");
    const lines = [...body.matchAll(/"(\w+)": (true|false)/g)].map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(
      lines,
      NOTIFICATION_KINDS.map((k) => `${k}=${String(PREFERENCE_DEFAULTS[k])}`),
      "a default that differs from the client's means the switch the user sees is not the switch the server set",
    );
  });

  it("keeps the noisy categories off by default and the match moments on", () => {
    // "Do not force users to enable every notification type", applied where a wrong guess costs trust.
    for (const kind of ["red_card", "match_reminder", "news", "team_update", "competition_update"] as const) {
      assert.equal(PREFERENCE_DEFAULTS[kind], false, `${kind} defaults on`);
    }
    for (const kind of ["goal", "full_time", "half_time", "match_start", "system"] as const) {
      assert.equal(PREFERENCE_DEFAULTS[kind], true, `${kind} defaults off`);
    }
  });

  it("restricts channels to what exists", () => {
    assert.deepEqual([...NOTIFICATION_CHANNELS], ["inbox", "push"]);
    has(code, "check (channels <@ array['inbox','push']::text[] and channels <> '{}')", "the channel check must reject an unknown medium rather than store it");
    // An absent entry is not "no channels": a document built from nothing must still be deliverable.
    assert.deepEqual(preferencesDocument(null).categories.goal.channels, ["inbox", "push"]);
  });
});

describe("phase5 · what the migration is forbidden to do", () => {
  it("destroys nothing that already exists", () => {
    const forbidden: Array<[RegExp, string]> = [
      [/\bdrop\s+table\b/i, "drop table"],
      [/\btruncate\b/i, "truncate"],
      [/\balter\s+table\s+public\.matches\b/i, "altering matches"],
      [/\balter\s+table\s+public\.match_events\b/i, "altering match_events"],
      [/\balter\s+table\s+public\.players\b/i, "altering players"],
      [/\bdisable\s+row\s+level\s+security\b/i, "disabling RLS"],
      [/\balter\s+default\s+privileges\b/i, "alter default privileges (it broke writes in an earlier phase)"],
      [/\bdelete\s+from\s+public\.notifications\b/i, "deleting notification history"],
      [/drop\s+policy\s+if\s+exists\s+"[^"]*(admin|public read)"\s+on\s+public\.(matches|match_events|teams|players)\b/i, "dropping a policy on a table this phase does not own"],
    ];
    for (const [re, what] of forbidden) assert.ok(!re.test(code), `the migration contains ${what}`);
  });

  it("deletes only rows this phase owns", () => {
    const deletes = [...code.matchAll(/delete from ([a-z_.]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(deletes)].sort(), ["public.match_interest", "public.notification_devices"], "a dismissed interest row and a long-dead device row, and nothing else");
  });

  it("runs inside one transaction and reloads the API catalogue", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(statements[0], "begin", "must open a transaction first");
    assert.equal(statements.at(-1), "commit", "and close it");
    assert.match(code, /notify pgrst, 'reload schema';/, "or the new RPCs 404 until a restart, which reads like a Worker bug");
  });

  it("is re-runnable", () => {
    for (const re of [/create table if not exists/, /create or replace function/, /drop policy if exists/, /create index if not exists/, /add column if not exists/]) {
      assert.match(code, re, `a re-run needs ${re}`);
    }
    // The exception worth naming: `add constraint` has no `if not exists`, so the kind check is preceded by a
    // drop by name. A migration that cannot be re-run is a migration that cannot be recovered.
    has(
      code,
      "alter table public.notifications drop constraint if exists notifications_kind_check;\nalter table public.notifications add constraint notifications_kind_check",
      "the added check must survive a re-run",
    );
  });

  it("keeps every privilege statement in the same file as the object it guards", () => {
    const grants = [...norm(code).matchAll(/grant ([a-z, ]+) on (?:table |view )?public\.([a-z_]+) to ([a-z_, ]+);/g)];
    assert.ok(grants.length >= 4, "the client grant set is smaller than the tables that exist, on purpose");
    const allowed = ["notification_devices_public", "match_interest", "notification_preferences", "notification_devices", "notifications"];
    for (const g of grants) {
      assert.ok(allowed.includes(g[2]!), `a table grant to a client role on ${g[2]} is not part of this design`);
      assert.ok(!/\btruncate|references/.test(g[1]!), `grant ${g[1]} on ${g[2]} is wider than the RPCs need`);
    }
    assert.ok(!/grant update on public\.notification_devices/.test(norm(code)), "a client that can update a device row can re-point someone else's token");
    assert.ok(!/grant (insert|update|delete) on public\.notification_jobs to (anon|authenticated)/.test(code), "no client may queue a send");
    assert.ok(!/grant (insert|update|delete) on public\.notification_deliveries to (anon|authenticated)/.test(code), "nor rewrite a delivery record");
  });
});

describe("phase5 · the security properties, as text", () => {
  it("enables RLS on every new table in one loop — and does not force it", () => {
    has(
      code,
      "foreach t in array array['notification_preferences','notification_devices','notification_jobs','notification_deliveries','match_interest'] loop execute format('alter table public.%I enable row level security', t); execute format('revoke all on table public.%I from anon, authenticated', t); end loop",
      "one loop, so a sixth table cannot be forgotten",
    );
    // The Phase 1 (`access_requests`) and Phase 3 (`match_assignments`) lesson, still load-bearing: FORCE also
    // applies to the table owner, every RPC here runs as the owner, so forcing it would make each function
    // insert zero rows into its own table. Hardening that breaks the write path is not hardening.
    assert.ok(!/force row level security/.test(code), "FORCE would block the SECURITY DEFINER RPCs that write these tables");
    assert.match(src, /RLS is \*enabled\*, never \*forced\*/, "the reason has to be in the file, not in a commit message");
    assert.match(code, /and relrowsecurity and not relforcerowsecurity/, "the migration checks it stayed that way");
    assert.match(code, /have FORCE ROW LEVEL SECURITY/, "…and complains by name if a later edit added it");
    for (const t of ["notification_preferences", "notification_devices", "notification_jobs", "notification_deliveries", "match_interest"]) {
      assert.ok(src.includes(`'${t}'`), `${t} is not in the RLS loop`);
    }
  });

  it("replaces notifications: public read with an owner-or-broadcast read", () => {
    assert.match(code, /drop policy if exists "notifications: public read" on public\.notifications;/);
    const at = code.indexOf('create policy "notifications: owner or broadcast read"');
    assert.ok(at > code.indexOf('drop policy if exists "notifications: public read"'), "the replacement must come after the drop, or a re-run leaves both policies and the wider one wins");
    has(code.slice(at, at + 400), "for select to anon, authenticated using (user_id is null or user_id = auth.uid())", "the replacement policy is not owner-or-broadcast");
    // Read state is a user action, so it is a policy too and not only a WHERE clause in an RPC.
    {
      const at = code.indexOf('create policy "notifications: owner update read"');
      has(
        code.slice(at, at + 400),
        "for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and read_at is not null)",
        "read state is a policy as well as a WHERE clause",
      );
    }
  });

  it("keeps the device token out of every client-reachable path", () => {
    const at = code.indexOf("create or replace view public.notification_devices_public");
    const view = code.slice(at, code.indexOf("comment on", at));
    assert.ok(at > 0, "the view the settings screen reads does not exist");
    assert.ok(!/\btoken\b/.test(norm(view).replace("notification_devices", "")), "notification_devices_public must not select the token column");
    has(view, "where d.user_id = auth.uid()", "and must be scoped to the caller");
    {
      const at = code.indexOf('create policy "notification_devices: owner read"');
      has(code.slice(at, at + 300), "for select to authenticated using (false)", "no direct select on the token table; the view is the only read path");
    }
    assert.ok(!/grant (insert|update)\s+on public\.notification_devices to (anon|authenticated)/.test(code), "a client must never write a device row directly");
    assert.match(src, /No INSERT\/UPDATE policy on purpose/, "the reason there is no write policy is stated in the file, not in a commit message");
  });

  it("gives clients the self-service RPCs and nothing that touches another user", () => {
    const granted = [...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+)/g)].map((m) => ({ fn: m[1]!, roles: m[2]!.trim() }));
    const clientFns = [...new Set(granted.filter((g) => /\b(authenticated|anon)\b/.test(g.roles)).map((g) => g.fn))].sort();
    assert.deepEqual(
      clientFns,
      [
        "kicklive_mark_all_notifications_read",
        "kicklive_mark_notifications_read",
        "kicklive_notification_defaults_document",
        "kicklive_notifications_page",
        "kicklive_preference_defaults",
        "kicklive_register_notification_device",
        "kicklive_set_match_interest",
        "kicklive_set_notification_preferences",
        "kicklive_unregister_notification_device",
      ],
      "the client-callable surface is nine functions, every one of which derives the user from auth.uid()",
    );
    for (const dangerous of [
      "kicklive_notification_audience",
      "kicklive_notification_recipients",
      "kicklive_claim_notification_job",
      "kicklive_materialise_notifications",
      "kicklive_broadcast_notification",
      "kicklive_prune_notification_devices",
      "kicklive_pending_notification_jobs",
      "kicklive_notification_job_for_event",
    ]) {
      assert.ok(!clientFns.includes(dangerous), `${dangerous} must be service-role only`);
    }
  });

  it("derives identity from the session, never from the body, in every client-facing write", () => {
    for (const name of [
      "kicklive_register_notification_device",
      "kicklive_unregister_notification_device",
      "kicklive_set_notification_preferences",
      "kicklive_notifications_page",
      "kicklive_set_match_interest",
      "kicklive_mark_notifications_read",
      "kicklive_mark_all_notifications_read",
    ]) {
      assert.match(fnBody(name), /auth\.uid\(\)/, `${name} must take the user from auth.uid()`);
      assert.ok(!/p_user/.test(fnArgs(name)), `${name} accepts a user id as an argument, so a caller could choose whose row to write`);
    }
    // The one place a user id is an argument is a read helper the Worker calls for another user's document —
    // and it is granted to no role a browser can use anonymously.
    assert.match(fnArgs("kicklive_notification_defaults_document"), /p_user_id uuid/);
    assert.ok(!/kicklive_notification_defaults_document\(uuid\) to anon/.test(norm(code)), "…and it is not callable by an anonymous session");
  });

  it("pins search_path on every SECURITY DEFINER function", () => {
    // The line *after* `security definer` is where `set search_path` belongs, so the check is positional:
    // a DEFINER function whose path is not pinned is search_path hijacking waiting for an unqualified
    // reference, and it is invisible in review because the function still works on a machine with a clean path.
    const lines = code.split("\n");
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^security definer\s*$/.test(lines[i] ?? "")) continue;
      seen++;
      let j = i + 1;
      while (j < lines.length && /^(stable|immutable|volatile|strict|parallel)\b/.test(lines[j] ?? "")) j++;
      assert.match(lines[j] ?? "", /^set search_path = public, pg_temp\s*$/, `line ${String(i + 1)} is SECURITY DEFINER without a pinned search_path on the next line`);
    }
    assert.ok(seen >= 14, `only ${String(seen)} DEFINER functions found; the file changed shape or the parser is wrong`);
    // 18 of the 19 functions: every one that crosses a table a client cannot select from. The exception is
    // kicklive_preference_defaults(), which reads nothing at all and is LANGUAGE SQL.
    assert.equal(seen, 18, "the DEFINER count moved; §9.7's expected count and this number must move together");
  });

  it("never lets the token or the job payload reach a log line from SQL", () => {
    has(code, "comment on column public.notification_devices.token is", "the token column carries the rule in its comment");
    assert.match(src, /Never selected by a policy a browser can use, never returned by an endpoint, never logged/);
    // Diagnostics returns counts and an age, not rows.
    has(fnBody("kicklive_pending_notification_jobs"), "oldestPendingSeconds");
    assert.ok(!/\btoken\b/.test(norm(fnBody("kicklive_pending_notification_jobs"))), "the diagnostics read must not surface a token");
  });
});

describe("phase5 · idempotency and durability", () => {
  it("builds the job's key from the server-assigned sequence, not from the event's content", () => {
    const body = fnBody("kicklive_notification_job_for_event");
    has(body, "format('match:%s|seq:%s|kind:%s', new.match_id, coalesce(new.sequence, -new.id), v_kind)", "the dedupe key is match + sequence + kind");
    has(body, "on conflict (dedupe_key) do nothing", "a replayed event inserts nothing");
    has(body, "coalesce(new.sequence, -new.id)", "a pre-Phase-3 row with no sequence still gets a key that is stable and cannot collide with a real seq:7");
  });

  it("has the three unique constraints the design promises", () => {
    assert.match(code, /dedupe_key\s+text\s+not null unique/, "jobs: one row per key");
    has(code, "constraint notification_deliveries_job_device_unique unique (job_id, device_id)", "deliveries: a queue redelivery cannot send twice");
    has(
      code,
      "create unique index if not exists notifications_user_dedupe_key on public.notifications (user_id, dedupe_key) where dedupe_key is not null and user_id is not null",
      "inbox: partial, so pre-Phase-5 rows cannot collide with each other",
    );
    has(fnBody("kicklive_materialise_notifications"), "on conflict (user_id, dedupe_key) where dedupe_key is not null and user_id is not null do nothing", "materialising twice is a no-op");
  });

  it("claims a job with a status predicate, so two consumers cannot both send it", () => {
    const body = fnBody("kicklive_claim_notification_job");
    has(body, "status in ('pending','retry') and next_attempt_at <= now() and attempts < max_attempts", "the claim is the lock");
    assert.match(body, /returning \*/);
    assert.match(body, /NOT_CLAIMABLE/, "and losing the race is an ordinary answer, not an error");
  });

  it("keeps the retry schedule on the row", () => {
    const jobTable = code.slice(code.indexOf("create table if not exists public.notification_jobs"), code.indexOf("create index if not exists notification_jobs_claimable_idx"));
    has(jobTable, "attempts integer not null default 0", "attempts");
    has(jobTable, "max_attempts integer not null default 6 check (max_attempts between 1 and 25)", "a retry budget that is data, not a constant in one consumer");
    has(jobTable, "next_attempt_at timestamptz not null default now()", "so a consumer that dies mid-batch cannot lose a retry");
    has(
      code,
      "create index if not exists notification_jobs_claimable_idx on public.notification_jobs (next_attempt_at) where status in ('pending','retry')",
      "the sweep needs this to be a cheap index scan",
    );
  });

  it("records delivery separately from the notification, so history survives a failed send", () => {
    const d = code.slice(code.indexOf("create table if not exists public.notification_deliveries"), code.indexOf("comment on table public.notification_deliveries"));
    has(d, "status text not null check (status in ('sent','failed','skipped_invalid_token'))", "the outcomes are a closed set, so a report cannot invent one");
    has(d, "notification_id integer references public.notifications(id) on delete set null", "a delivery points at the inbox row it belongs to, and survives that row being dismissed");
    assert.ok(/insert into public\.notifications/.test(code), "the inbox row is written by materialise");
    has(fnBody("kicklive_record_notification_results"), "on conflict (job_id, device_id) do update", "a redelivered job updates the record it already made instead of adding a second");
  });

  it("deactivates a token FCM said is dead, and stops hammering one that keeps failing", () => {
    has(code, "failure_count integer not null default 0", "a device accumulates evidence");
    has(code, "last_error_code text", "the reason is stored as a code, never as a message from FCM");
    has(fnBody("kicklive_register_notification_device"), "failure_count = 0", "a fresh registration clears the strikes: the user just proved they own the device");
    has(fnBody("kicklive_notification_recipients"), "coalesce(d.failure_count, 0) < 5", "a device that keeps failing leaves the audience");
    has(fnBody("kicklive_notification_recipients"), "d.active", "and an inactive one never re-enters it");
  });
});

describe("phase5 · the trigger that connects Phase 3 to a phone", () => {
  it("fires on the event table, not on the browser or the RPC", () => {
    has(code, "create trigger kicklive_notification_job after insert on public.match_events for each row execute function public.kicklive_notification_job_for_event()");
    assert.ok(!/create trigger[\s\S]{0,120}(before|instead of)/i.test(code), "a BEFORE trigger could veto a referee's write");
  });

  it("never discards an event, whatever the notification decides", () => {
    const body = fnBody("kicklive_notification_job_for_event");
    assert.ok(!/return null/i.test(body), "a NULL return from a row trigger skips the insert; here it would drop a goal");
    assert.ok((body.match(/return new;/g) ?? []).length >= 6, "every early exit must return NEW");
  });

  it("stays silent for corrections and corrected rows", () => {
    const body = fnBody("kicklive_notification_job_for_event");
    has(body, "if new.corrects_event_id is not null then return new;", "a correction must not double-notify");
    has(body, "new.event_status is not null and new.event_status <> 'active'", "a void row must not notify either");
  });

  it("maps the authoritative event types onto the vocabulary, and nothing else", () => {
    const body = fnBody("kicklive_notification_job_for_event");
    const cases = [...body.matchAll(/when '([a-z_]+)'\s+then '([a-z_]+)'/g)].map((m) => [m[1]!, m[2]!]);
    assert.deepEqual(cases, [
      ["goal", "goal"],
      ["penalty_goal", "goal"],
      ["own_goal", "goal"],
      ["red_card", "red_card"],
      ["second_yellow", "red_card"],
      ["half_time", "half_time"],
      ["extra_time_half_time", "half_time"],
      ["full_time", "full_time"],
      ["kickoff", "match_start"],
      ["second_half_start", "match_start"],
    ]);
    assert.ok(!/when 'match_abandoned'/.test(body), "the brief's event list is the contract; an abandoned match is not a notification category yet");
    // The rationale is prose, so it is read from the file with comments in it; the absence above is read from
    // the file with them stripped. A test that only reads prose would pass on a comment and no code.
    assert.match(src, /`match_abandoned` is deliberately absent/);
    has(body, "else null end;", "an unmapped event type produces no job rather than a generic one");
    for (const [, kind] of cases) {
      assert.ok(NOTIFICATION_KINDS.includes(kind as (typeof NOTIFICATION_KINDS)[number]), `${kind} is not in the vocabulary`);
    }
  });

  it("words each moment separately, because the category is not the sentence", () => {
    const body = fnBody("kicklive_notification_job_for_event");
    assert.match(body, /v_title := case new\.event_type/, "a penalty goal and an own goal are the same category with different words");
    has(body, "when 'second_half_start'     then 'Second half'".replace(/\s+/g, " "));
    assert.match(body, /select name into v_home from public\.teams/, "one column into one variable: `name, short_name into v_home, v_home` compiles and quietly overwrites itself");
    assert.match(body, /jsonb_build_object\(\s*'matchId'/, "metadata is structured, so the client never parses a sentence back out of a push body");
  });

  it("does not exist in a second copy for matches status", () => {
    // Lifecycle moments arrive as match_events rows already (kicklive_lifecycle_event_for), so a trigger on
    // `matches` would notify them twice.
    const triggers = [...code.matchAll(/create trigger (\w+)/g)].map((m) => m[1]!);
    assert.deepEqual(triggers, ["kicklive_notification_job"], "one trigger, on the event table");
  });
});

describe("phase5 · the audience rule lives in one function", () => {
  const audience = fnBody("kicklive_notification_audience");

  it("treats a missing preference row as the default, not as an opt-out", () => {
    assert.match(audience, /left join public\.notification_preferences/, "an inner join here silently un-notifies every account that never opened the settings screen");
    has(audience, "coalesce(p.enabled, (public.kicklive_preference_defaults() ->> p_kind)::boolean)", "the default comes from the same function the API hands to the client");
    has(audience, "coalesce(p.channels, array['inbox','push']::text[])");
    has(audience, "pr.notifications_enabled", "the global switch is checked in SQL, not only in the UI");
  });

  it("is scoped by match for match-scoped kinds only", () => {
    has(audience, "p_match_id is null or p_kind in ('announcement','system','news') or exists ( select 1 from public.match_interest mi where mi.match_id = p_match_id and mi.user_id = pr.id )");
  });

  it("is read by all three callers, so the cap cannot disagree with the send", () => {
    const callers = ["kicklive_notification_recipients", "kicklive_materialise_notifications", "kicklive_broadcast_notification"].map((n) =>
      norm(fnBody(n)).includes("kicklive_notification_audience("),
    );
    assert.deepEqual(callers, [true, true, true], "the audience function is not used by every caller");
    assert.ok(!/select count\(distinct d\.user_id\) from public\.notification_devices/.test(norm(code)), "the broadcast must not estimate an audience from a device table");
  });

  it("writes the inbox from the audience, not from the device list", () => {
    const body = fnBody("kicklive_materialise_notifications");
    has(body, "and 'inbox' = any (a.channels)", "a user with push off still gets history");
    assert.ok(!/kicklive_notification_recipients/.test(body), "deriving history from the device query would tie the record to someone's phone");
    assert.ok(!/for .* in .* loop/i.test(body), "one set-based statement: step 28 is about not looping over recipients");
  });

  it("filters the medium in the device query, and never stores a token in a delivery row", () => {
    const r = fnBody("kicklive_notification_recipients");
    has(r, "and 'push' = any (a.channels)");
    has(r, "d.provider = 'fcm'", "FCM is the only transport this phase delivers to");
    has(r, "not exists ( select 1 from public.notification_deliveries dd where dd.job_id = j.id and dd.device_id = d.id )", "the replay guard runs before anything is sent");
    const d = code.slice(code.indexOf("create table if not exists public.notification_deliveries"), code.indexOf("comment on table public.notification_deliveries"));
    assert.ok(!/^\s+token\s+text/m.test(d), "a delivery row names a device id, never a token");
    has(d, "device_id uuid not null references public.notification_devices(id) on delete cascade");
  });

  it("answers the badge and the list from one call", () => {
    const page = fnBody("kicklive_notifications_page");
    has(page, "user_id = auth.uid() or user_id is null", "your own rows plus broadcasts");
    has(page, "expires_at is null or expires_at > now()", "an expired row is invisible without deleting anything");
    has(page, "limit greatest(1, least(coalesce(p_limit, 20), 100))", "the page size is bounded in SQL, so a client cannot ask for everything");
    assert.match(page, /'unread'/);
  });

  it("marks read with the owner in the statement, and caps read-all", () => {
    has(fnBody("kicklive_mark_notifications_read"), "where id = p_id and user_id = auth.uid() and read_at is null", "the owner is in the statement, not only in the policy");
    const all = fnBody("kicklive_mark_all_notifications_read");
    has(all, "limit 500", "read-all is bounded, because a user with 40k rows should not lock the table");
    has(all, "'capped', v_rows >= 500", "and a capped read-all says so");
  });
});

describe("phase5 · device registration rules", () => {
  const body = fnBody("kicklive_register_notification_device");

  it("moves a token that changed owner instead of duplicating it", () => {
    has(code, "constraint notification_devices_token_unique unique (provider, token)", "one token, one owner, one row");
    has(body, "on conflict (provider, token) do update set user_id = excluded.user_id", "a token that walks in elsewhere moves");
    has(body, "active = true");
  });

  it("caps active devices per account, but never locks out a re-registration", () => {
    has(body, "v_max integer := 10", "ten active devices per account is the bound");
    assert.match(body, /'DEVICE_LIMIT'/);
    has(
      body,
      "and not exists ( select 1 from public.notification_devices where provider = p_provider and token = p_token and user_id = v_user )",
      "the same phone refreshing its token must not hit the cap",
    );
  });

  it("bounds the token's shape and validates the enums in SQL too", () => {
    has(body, "length(p_token) < 20 or length(p_token) > 4096", "so a 10 MB body cannot be stored as a token");
    has(body, "p_provider not in ('fcm','webpush')");
    has(body, "p_platform not in ('android','ios','web','unknown')");
  });

  it("never returns the token to the caller", () => {
    has(body, "return jsonb_build_object('ok', true, 'id', v_id, 'active', true, 'devices'", "the response is the row's identity and a count");
    const tail = body.slice(body.lastIndexOf("return jsonb_build_object('ok', true"));
    assert.ok(!/p_token/.test(tail), "the success path must not echo the token back");
  });

  it("refuses an anonymous registration by name", () => {
    has(body, "if v_user is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED'", "signed out is a state, not a 500");
  });

  it("deactivates rather than deletes on sign-out", () => {
    const off = fnBody("kicklive_unregister_notification_device");
    has(off, "delete from public.notification_devices where id = p_id and user_id = v_user", "the row a user asked to remove, and only theirs");
  });
});

describe("phase5 · the admin surface", () => {
  const body = fnBody("kicklive_broadcast_notification");

  it("checks is_admin inside the function, not only in the route", () => {
    has(body, "if not public.is_admin() then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'", "a direct SQL caller must be refused too");
  });

  it("counts the audience before writing anything, and refuses over the cap rather than truncating", () => {
    const countAt = norm(body).indexOf("kicklive_notification_audience(p_kind");
    assert.ok(countAt > 0, "the audience is not counted from the shared rule");
    assert.ok(countAt < norm(body).indexOf("insert into public.notification_jobs"), "the cap must be checked before the job exists, or refusing is cosmetic");
    assert.match(body, /'AUDIENCE_TOO_LARGE'/);
    assert.match(fnArgs("kicklive_broadcast_notification"), /p_max_audience integer default 50000/);
    assert.match(fnArgs("kicklive_broadcast_notification"), /p_confirm boolean/, "confirmation is a required argument, not an optional one a client can omit");
  });

  it("requires confirmation as a parameter, above a threshold", () => {
    has(body, "v_audience > 1000 and not coalesce(p_confirm, false)", "a blast at the whole user base needs an explicit flag, not a click in a UI we cannot audit");
    assert.match(body, /'CONFIRMATION_REQUIRED'/);
  });

  it("will not let an announcement impersonate a match event", () => {
    has(body, "p_kind not in ('announcement','system','news','competition_update','team_update')", "a fake 'goal' from an admin would poison the dedupe keys of real ones");
  });

  it("attributes the send to whoever made it", () => {
    assert.match(fnArgs("kicklive_broadcast_notification"), /p_created_by uuid default null/);
    has(body, "returning id into v_job");
    assert.match(code, /created_by\s+uuid\s+references public\.profiles\(id\)/);
  });

  it("keeps retention a policy in the database", () => {
    const prune = fnBody("kicklive_prune_notification_devices");
    has(fnArgs("kicklive_prune_notification_devices"), "p_window interval default interval '30 days'");
    has(prune, "where not active and updated_at < now() - p_window");
    has(prune, "if not public.is_admin() then", "pruning is an admin call, and the sweep calls it as the owner");
  });
});

describe("phase5 · the verification block is the part that runs in CI-adjacent reality", () => {
  it("checks the things a reviewer would otherwise trust", () => {
    const verify = code.slice(code.indexOf("do $verify$") > 0 ? code.indexOf("$$verify$$") : code.lastIndexOf("begin\n  -- 9.1"));
    for (const needle of [
      "the match_events trigger is not attached",
      "notification_devices_public exposes `token`",
      "search_path hijacking",
      "notifications gained",
      "profiles.notifications_enabled is missing",
    ]) {
      assert.ok(verify.includes(needle) || src.includes(needle), `the verification block does not check ${needle}`);
    }
  });

  it("counts the functions it actually creates, so the two numbers cannot drift", () => {
    const created = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]!);
    const expected = Number(norm(code).match(/expected (\d+) notification functions/)![1]);
    assert.equal(created.length, expected, `the file defines ${String(created.length)} but §9.7 expects ${String(expected)}`);
    assert.equal(created.length, 19, "the surface this phase promises");
    assert.equal(new Set(created).size, created.length, "a function defined twice in one file is a copy-paste bug");
  });

  it("names every function it revokes, with arguments", () => {
    const revoked = [...code.matchAll(/\('([a-z_]+)', '([a-z_,]*)'\)/g)].map((m) => `${m[1]}(${m[2]})`);
    assert.ok(revoked.length >= 15, `the revoke list has ${String(revoked.length)} entries`);
    for (const name of ["kicklive_notification_audience", "kicklive_notification_recipients", "kicklive_broadcast_notification"]) {
      assert.ok(
        revoked.some((r) => r.startsWith(`${name}(`)),
        `${name} is not revoked from client roles`,
      );
    }
  });
});

describe("phase5 · the outcome write path", () => {
  const results = fnBody("kicklive_record_notification_results");
  const finish = fnBody("kicklive_finish_notification_job");

  it("takes a batch, not one device at a time", () => {
    assert.match(fnArgs("kicklive_record_notification_results"), /p_results jsonb/);
    assert.match(results, /jsonb_typeof\(p_results\) <> 'array'/, "a malformed job payload is refused, not half-applied");
    assert.match(
      results,
      /jsonb_array_elements\(p_results\) as r[\s\S]*join public\.notification_devices d on d\.id = \(r->>'deviceId'\)::uuid/,
      "a result naming a deleted device is dropped, not fatal",
    );
    has(results, "and r->>'status' in ('sent','failed','skipped_invalid_token')", "the outcome set is the table's CHECK, in the same words");
  });

  it("writes the delivery record idempotently", () => {
    has(results, "on conflict (job_id, device_id) do update set status = excluded.status");
    has(
      results,
      "provider_message_id = coalesce(excluded.provider_message_id, public.notification_deliveries.provider_message_id)",
      "a later failure must not erase the message id from an earlier success",
    );
  });

  it("stores a code, never a token or a response body", () => {
    has(results, "left(coalesce(nullif(r->>'errorCode', ''), 'UNKNOWN'), 64)", "bounded, so a caller cannot smuggle a whole HTTP body into the audit trail");
    assert.ok(!/p_token|d\.token/.test(results), "the outcome path must not read or write a token");
    assert.match(src, /never the response body, never the token/);
  });

  it("retires a dead token, strikes a failing one, forgives a working one", () => {
    const retired = norm(results).match(/set active\s+= false[\s\S]*?and r->>'status' = 'skipped_invalid_token'/);
    assert.ok(retired, "an UNREGISTERED token must be deactivated in the same statement that records it");
    has(results, "and r->>'status' = 'failed'");
    has(results, "and r->>'status' = 'sent'");
    const forgiven = norm(results).slice(norm(results).lastIndexOf("update public.notification_devices d"));
    has(forgiven, "set failure_count = 0, last_error_code = null, last_seen_at = now(), last_sent_at = now()", "a success clears the strike count, or one bad network day retires a good token");
    has(forgiven, "and r->>'status' = 'sent'");
  });

  it("recomputes the job's counts from the evidence, not the caller's claim", () => {
    has(finish, "from public.notification_deliveries where job_id = p_job_id");
    has(finish, "recipient_count = coalesce(j.recipient_count, v_sent + v_bad)");
    assert.match(finish, /p_status not in \('sent','partial','failed','retry'\)/);
  });

  it("cannot overwrite a newer attempt or resurrect an exhausted job", () => {
    has(finish, "and j.status = 'running'", "the claim is the lock; a late finish is refused by name");
    has(finish, "get diagnostics v_rows = row_count", "the refusal counts the rows it touched rather than trusting a returned id");
    has(finish, "and not (p_status = 'retry' and j.attempts >= j.max_attempts)", "no infinite retry, enforced where the retry is written");
    assert.match(finish, /NOT_RUNNING/);
  });

  it("increments attempts at claim time and never at finish time", () => {
    assert.match(fnBody("kicklive_claim_notification_job"), /attempts = attempts \+ 1/);
    assert.ok(!/attempts\s*=\s*attempts \+ 1/.test(finish), "counting twice halves the retry budget's meaning");
  });
});
