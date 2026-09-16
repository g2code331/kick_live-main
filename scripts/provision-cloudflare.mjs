#!/usr/bin/env node
/**
 * Proves — and with `--apply`, creates — the Cloudflare resources this Worker's config references.
 *
 *   node scripts/provision-cloudflare.mjs                # both environments, check only (CI default)
 *   node scripts/provision-cloudflare.mjs --env=staging
 *   node scripts/provision-cloudflare.mjs --env=staging --apply
 *   node scripts/provision-cloudflare.mjs --json
 *
 * WHY. Every deploy failure the operator hit this week was the same shape: `wrangler.toml` names a KV id, an
 * R2 bucket and two queues that did not exist yet on the account, and the deploy error appears *at upload*,
 * mid-release. A queue that does not exist is worse than a failed deploy — the producer binding resolves, the
 * send fails inside a queue-backed job, and the notification quietly never arrives. This script reads the
 * resource names out of the config (so it cannot drift from it) and asks the account, per environment, whether
 * each one is there.
 *
 * WHAT IT DOES NOT DO. It never deletes anything, and it never edits `wrangler.toml`: a newly created KV
 * namespace has an id that must be pasted into the config by a human, in a commit, where it can be reviewed.
 * `--apply` creates only the resources the config already names, and reports each one as created-or-already-
 * present, so re-running is free.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const CONFIG = "workers/wrangler.toml";
const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const APPLY = args.includes("--apply");
const ONLY_ENV = (args.find((a) => a.startsWith("--env=")) || "").split("=")[1];
const ENVS = ONLY_ENV ? [ONLY_ENV] : ["staging", "production"];

function log(...a) {
  if (!AS_JSON) console.log(...a);
}

function wrangler(argv, opts = {}) {
  const res = spawnSync("npx", ["--yes", "wrangler", ...argv], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 180_000,
    env: process.env,
    ...opts,
  });
  return { code: res.status ?? 1, out: (res.stdout || "") + (res.stderr || "") };
}

/**
 * The desired state, parsed from the config rather than restated here. Duplicated lists are how provisioning
 * and deployment end up disagreeing, which is the exact class of bug this script exists to prevent.
 */
export function desiredState(root = REPO) {
  const text = fs.readFileSync(path.join(root, CONFIG), "utf8");
  const lines = text.split("\n");
  const state = {};
  let env = null; // null → the top-level block, which `wrangler dev` and any env-less deploy read
  const ensure = (e) => (state[e] ??= { kv: [], r2: [], queues: [], queueBindings: new Map(), crons: [] });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\/\/|^#/.test(line)) continue;
    let m = /^\[env\.([a-z0-9_-]+)\.vars\]$/.exec(line);
    if (m) {
      env = m[1];
      ensure(env);
      continue;
    }
    m = /^\[env\.([a-z0-9_-]+)\.([a-z_.]+)\]$/.exec(line);
    if (m) {
      env = m[1];
      ensure(env);
      continue;
    }
    if (/^\[[a-z_.]+\]$/.test(line)) {
      if (line === "[vars]" || line === "[triggers]" || line === "[durable_objects]" || line === "[migrations]") {
        env = null;
        ensure(null);
      } else if (/^\[env\./.test(line)) {
        // [env.staging] / [env.staging.triggers] handled above; anything else keeps the current env
      } else if (line !== "[vars]") env = env; // unrelated table (dev, observability…): leave context alone
      continue;
    }
    m = /^\[\[env\.([a-z0-9_-]+)\.(kv_namespaces|r2_buckets|queues\.producers|queues\.consumers|durable_objects\.bindings|migrations)\]\]$/.exec(line);
    if (m) {
      env = m[1];
      ensure(env);
      const kind = m[2];
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (/^\[\[?/.test(l)) break;
        if (l && !/^#/.test(l)) body.push(l);
      }
      const get = (k) =>
        body
          .find((b) => b.startsWith(k))
          ?.split("=")
          .slice(1)
          .join("=")
          .trim()
          .replace(/^"|"$/g, "") ?? null;
      if (kind === "kv_namespaces") state[env].kv.push({ binding: get("binding"), id: get("id") });
      if (kind === "r2_buckets") state[env].r2.push({ binding: get("binding"), bucket_name: get("bucket_name") });
      if (kind === "queues.producers") {
        const q = get("queue");
        state[env].queues.push(q);
        state[env].queueBindings.set(q, get("binding"));
        // a consumer may live in another block; DLQ names come from the consumer, so collect from both
        const dlq = get("dead_letter_queue");
        if (dlq) state[env].queues.push(dlq);
      }
      if (kind === "queues.consumers") {
        const q = get("queue");
        if (!state[env].queues.includes(q)) state[env].queues.push(q);
        const dlq = get("dead_letter_queue");
        if (dlq && !state[env].queues.includes(dlq)) state[env].queues.push(dlq);
      }
      i = j_placeholder(lines, i);
      continue;
    }
    if (/^\[\[(kv_namespaces|r2_buckets|queues\.producers|queues\.consumers)\]\]$/.test(line)) {
      env = null;
      ensure(null);
      const kind = line.replace("[[", "").replace("]]", "");
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (/^\[\[?/.test(l)) break;
        if (l && !/^#/.test(l)) body.push(l);
      }
      const get = (k) =>
        body
          .find((b) => b.startsWith(k))
          ?.split("=")
          .slice(1)
          .join("=")
          .trim()
          .replace(/^"|"$/g, "") ?? null;
      if (kind === "kv_namespaces") state[null].kv.push({ binding: get("binding"), id: get("id") });
      if (kind === "r2_buckets") state[null].r2.push({ binding: get("binding"), bucket_name: get("bucket_name") });
      if (kind === "queues.producers") state[null].queues.push(get("queue"));
      i = j_placeholder(lines, i);
    }
    if (/^crons\s*=/.test(line) && env !== undefined) {
      const e = env;
      ensure(e);
      for (const c of line.match(/"([^"]+)"/g) || []) state[e].crons.push(c.replace(/"/g, ""));
    }
  }
  for (const e of Object.keys(state)) state[e].queues = [...new Set(state[e].queues.filter(Boolean))];
  return state;
}

/** Skip to the end of the current table so a single pass does not re-read the body lines as top-level state. */
function j_placeholder(lines, i) {
  let j = i + 1;
  while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
  return j - 1;
}

// GitHub Actions annotations ARE retrievable from outside the runner (the job log blob is not), so a
// MISSING result prints the raw wrangler exit code + output here. That is the only channel that tells us
// whether a resource is genuinely absent, the token lacks list scope, or the token/account mismatch.
function annotateError(title, r) {
  if (!process.env.GITHUB_ACTIONS) return;
  const body = `${title} — wrangler exit ${r.code}. Output: ${(r.out || "(no output)").trim()}`;
  const encoded = body.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::error::${encoded}\n`);
}

const existsCache = new Map();
async function exists(kind, name) {
  const key = `${kind}:${name}`;
  if (existsCache.has(key)) return existsCache.get(key);
  // Wrangler v4 command surface (this repo pins wrangler@4). The old code used
  // `r2 bucket info` and `kv:namespace info`, which reported EXISTING R2 buckets and KV namespaces as
  // MISSING: `kv:namespace` colon syntax was removed in v4 and there is no `kv namespace info` at all
  // (KV is checked separately by kvNamespaceExists via `kv namespace list`), and R2's `info` was
  // flaky. Only queues (`queues info`) worked, which is exactly what the failing run showed.
  let ok;
  let r;
  if (kind === "queue") {
    // `queues info <name>` is valid in v4 and already worked here — leave it.
    r = wrangler(["queues", "info", name]);
    ok = r.code === 0 && !/not found|does not exist|Could not find|Resource not found/i.test(r.out);
  } else {
    // R2: `r2 bucket info <name>` exists in v4 but was reporting existing buckets as MISSING; list +
    // match is immune to per-bucket info output/permission quirks and needs only *list* token scope.
    r = wrangler(["r2", "bucket", "list"]);
    ok = r.code === 0 && new RegExp(`(^|[\\s"'|])${escapeRe(name)}([\\s"'|]|$)`, "m").test(r.out);
  }
  if (!ok) annotateError(`${kind} ${name} not confirmed`, r);
  existsCache.set(key, ok);
  return ok;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// KV namespaces are identified by id, not name, and there is no `kv namespace info` in wrangler v4,
// so existence is proven by listing the account's namespaces once and checking the id is present.
let kvListResult;
function kvNamespaceExists(id) {
  if (kvListResult === undefined) kvListResult = wrangler(["kv", "namespace", "list"]);
  const ok = kvListResult.code === 0 && kvListResult.out.includes(id);
  if (!ok) annotateError(`kv namespace ${id} not confirmed`, kvListResult);
  return ok;
}

async function main() {
  const state = desiredState();
  const problems = [];
  const notes = [];
  const actions = [];

  for (const env of ENVS) {
    const want = state[env] ?? { kv: [], r2: [], queues: [], crons: [] };
    const label = env ?? "dev (top level)";
    if (!state[env] && env) {
      problems.push(`workers/wrangler.toml: no [env.${env}] block, so there is nothing to provision for it`);
      continue;
    }
    log(`\n${label}`);
    for (const ns of want.kv) {
      if (!ns.id) {
        problems.push(`${label}: kv binding ${ns.binding} has no id in the config — create it, then paste the id into ${CONFIG}`);
        continue;
      }
      const ok = kvNamespaceExists(ns.id);
      log(`  ${ok ? "ok  " : "MISSING"} kv ${ns.binding} (${ns.id})`);
      if (!ok) {
        problems.push(
          `${label}: KV namespace ${ns.id} for binding ${ns.binding} is not in this account's \`wrangler kv namespace list\` (deleted, wrong account, or the token lacks Workers KV Storage read)`,
        );
        if (APPLY) actions.push({ kind: "kv", env, name: `${label}:${ns.binding}`, cmd: `kv namespace create ${ns.binding}` });
      }
    }
    for (const b of want.r2) {
      const ok = await exists("r2", b.bucket_name);
      log(`  ${ok ? "ok  " : "MISSING"} r2 ${b.bucket_name}`);
      if (!ok) {
        if (APPLY) {
          const r = wrangler(["r2", "bucket", "create", b.bucket_name]);
          const done = r.code === 0;
          actions.push({ kind: "r2", env, name: b.bucket_name, created: done });
          log(`       ${done ? "created" : `create FAILED: ${r.out.trim().split("\n").slice(-1)[0]}`}`);
          if (!done) problems.push(`${label}: could not create R2 bucket ${b.bucket_name}`);
        } else problems.push(`${label}: R2 bucket ${b.bucket_name} does not exist — npx wrangler r2 bucket create ${b.bucket_name}`);
      }
    }
    for (const q of want.queues) {
      const ok = await exists("queue", q);
      log(`  ${ok ? "ok  " : "MISSING"} queue ${q}`);
      if (!ok) {
        if (APPLY) {
          const r = wrangler(["queues", "create", q]);
          const done = r.code === 0;
          actions.push({ kind: "queue", env, name: q, created: done });
          log(`       ${done ? "created" : `create FAILED: ${r.out.trim().split("\n").slice(-1)[0]}`}`);
          if (!done) problems.push(`${label}: could not create queue ${q}`);
        } else problems.push(`${label}: queue ${q} does not exist — npx wrangler queues create ${q}`);
      }
    }
    if (!want.crons.length) notes.push(`${label}: no [triggers].crons — the notification sweep and the media sweep will not run`);
  }

  if (AS_JSON) console.log(JSON.stringify({ ok: problems.length === 0, apply: APPLY, problems, notes, actions }, null, 2));
  else {
    for (const n of notes) log(`  note: ${n}`);
    if (problems.length === 0) log(`\nprovision: every resource named by ${CONFIG} exists on the account ✔`);
    else {
      console.error(`\nprovision: ${String(problems.length)} problem(s)`);
      for (const p of problems) console.error(`  ${p}`);
      if (!APPLY) console.error("  rerun with --apply to create the queues and buckets (a new KV needs a human to paste its id into the config)");
    }
  }
  return problems.length;
}

const DIRECT = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (DIRECT) main().then((n) => process.exit(n ? 1 : 0));
