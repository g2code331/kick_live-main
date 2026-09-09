#!/usr/bin/env node
/**
 * Desktop smoke runner: launches the *built* binary and asserts it painted a real DOM.
 *
 *   node scripts/smoke-desktop.mjs                        # packaged layout, normal load path
 *   node scripts/smoke-desktop.mjs --broken-load-path     # primary renderer path removed: the
 *                                                         # retry ladder + fallback must fire
 *   node scripts/smoke-desktop.mjs --binary release/linux-unpacked/kicklive
 *
 * Checks, in order:
 *   1. the process exits with the code the harness documents (0 / 3 / 4 / 5);
 *   2. `[kicklive:renderer] LOADED` happened, and with --broken-load-path the ladder
 *      (LOAD_FAILED → RETRY → FALLBACK_ACTIVE) is present in the log;
 *   3. SMOKE_DOM reports a non-empty #root and the brand title;
 *   4. if the embedded HTTP fallback started, its assets really are served as text/javascript
 *      (the MIME rule that makes ES modules load at all).
 *
 * Under CI this is wrapped in xvfb-run (see scripts/ci/desktop-smoke.sh).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, readVersionFile, walk } from "../tools/vite-shared.ts";
import { LOAD_LOG_PATTERNS } from "../shared/renderer-load.ts";
import { run, tail } from "./lib/run.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

export function findBinary(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [path.join(REPO_ROOT, "release/linux-unpacked/kicklive"), path.join(REPO_ROOT, "release/KickLive.AppImage")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const appimages = existsReleasesMatching(/\.AppImage$/);
  if (appimages.length > 0) return appimages[0];
  return null;
}

function existsReleasesMatching(re) {
  const dir = path.join(REPO_ROOT, "release");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => path.join(dir, f));
}

export function assertSmokeLog(log, { brokenLoadPath, version }) {
  const problems = [];
  const lines = log.split("\n");
  const find = (re) => lines.map((l) => re.exec(l)).filter(Boolean);

  const loaded = find(LOAD_LOG_PATTERNS.loaded);
  if (loaded.length === 0) problems.push("no `[kicklive:renderer] LOADED source=…` line: the window never committed a document");
  const failed = find(LOAD_LOG_PATTERNS.loadFailed);
  const retries = find(LOAD_LOG_PATTERNS.retry);
  const fallback = find(LOAD_LOG_PATTERNS.fallback);
  const exhausted = find(LOAD_LOG_PATTERNS.exhausted);

  if (brokenLoadPath) {
    if (failed.length < 2) problems.push(`expected the retry ladder to log >=2 LOAD_FAILED lines, saw ${String(failed.length)}`);
    if (retries.length < 1) problems.push(`expected RETRY lines with a backoff delay, saw ${String(retries.length)}`);
    if (fallback.length < 1) problems.push("expected FALLBACK_ACTIVE to fire when the primary path is broken, saw nothing");
    if (exhausted.length > 0 && loaded.length === 0) problems.push("load ladder was EXHAUSTED and never recovered — the fallback did not work");
    // Delays must actually increase (250/500/1000 ladder), not be a tight retry loop.
    const delays = retries.map((m) => Number(m[3]));
    if (delays.length >= 2 && !delays.every((d, i) => i === 0 || d >= delays[i - 1])) problems.push(`retry backoff is not monotonic: ${delays.join(",")}`);
  } else if (failed.length > 0) {
    problems.push(
      `unexpected LOAD_FAILED on the happy path: ${failed
        .map((m) => m[0])
        .join(" | ")
        .slice(0, 200)}`,
    );
  }

  const dom = /SMOKE_DOM (.*)/.exec(log);
  if (!dom) problems.push("no SMOKE_DOM line: the in-app probe never ran (did the window reach ready-to-show?)");
  else {
    const title = /title="((?:[^"\\]|\\.)*)"/.exec(dom[1])?.[1] ?? "";
    const rootChildren = Number(/rootChildren=(\d+)/.exec(dom[1])?.[1] ?? "-1");
    const reported = /version=([^\s]+)/.exec(dom[1])?.[1] ?? "";
    if (!/KickLive/i.test(title)) problems.push(`document.title is ${JSON.stringify(title)} (expected it to contain the brand)`);
    if (!(rootChildren >= 1)) problems.push(`#root has ${String(rootChildren)} children: the SPA did not mount`);
    if (reported !== version) problems.push(`page-reported version ${JSON.stringify(reported)} != VERSION ${version}`);
  }
  const result = /SMOKE_RESULT (\w+)/.exec(log);
  if (!result) problems.push("no SMOKE_RESULT line");
  else if (result[1] !== "ok") problems.push(`SMOKE_RESULT ${result[1]}`);
  return { problems, summary: { loaded: loaded.length, failed: failed.length, retries: retries.length, fallback: fallback.length } };
}

export async function main() {
  const version = readVersionFile(REPO_ROOT);
  const broken = has("broken-load-path");
  const binary = findBinary(flag("binary"));
  if (!binary || !fs.existsSync(binary)) {
    console.error(
      `smoke-desktop: no built desktop binary found (looked for release/linux-unpacked/kicklive).\n` +
        `              Build it first: npm run package:linux   (CI does this on ubuntu-24.04 under xvfb)`,
    );
    return 1;
  }
  const wrapper = flag("wrapper");
  const cmd = wrapper ? wrapper.split(" ") : [];
  const env = {
    KICKLIVE_SMOKE: "1",
    KICKLIVE_VERBOSE: "1",
    KICKLIVE_LOG_FILE: "0",
    KICKLIVE_LOAD_ATTEMPTS: "4",
    ...(broken ? { KICKLIVE_SMOKE_BAD_LOAD: "1" } : {}),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  };
  const extra = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-logging=stderr", "--v=0"];
  const res = run("smoke", cmd[0] ?? binary, [...cmd.slice(1), binary, ...extra], {
    cwd: REPO_ROOT,
    env,
    echo: has("verbose"),
  });
  const log = res.stdout;
  const { problems, summary } = assertSmokeLog(log, { brokenLoadPath: broken, version });

  console.log(`smoke-desktop: binary=${path.relative(REPO_ROOT, binary)} exit=${String(res.code)} broken=${String(broken)}`);
  console.log(`  log lines: LOADED=${String(summary.loaded)} LOAD_FAILED=${String(summary.failed)} RETRY=${String(summary.retries)} FALLBACK_ACTIVE=${String(summary.fallback)}`);
  for (const line of log
    .split("\n")
    .filter((l) => /\[kicklive:(renderer|updates)\]|SMOKE_/.test(l))
    .slice(-14))
    console.log(`  | ${line}`);

  // MIME proof, only possible when the shell started its embedded server.
  const origin = /SMOKE_HTTP_ORIGIN (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1];
  if (origin) {
    const assetsDir = path.join(REPO_ROOT, "renderer/dist/assets");
    const sample = walk(assetsDir, (f) => f.endsWith(".js"))[0];
    if (sample) {
      const rel = path.relative(assetsDir, sample).split(path.sep).join("/");
      const curl = run("curl", "curl", ["-sS", "-D", "-", "-o", "/dev/null", `${origin}/assets/${rel}`], { echo: false });
      const ctype = /content-type:\s*([^\r\n]+)/i.exec(curl.stdout)?.[1] ?? "";
      const status = /HTTP\/1\.1 (\d{3})/.exec(curl.stdout)?.[1] ?? "";
      console.log(`  embedded server: GET /assets/${rel} → ${status} content-type=${ctype || "?"}`);
      if (!/text\/javascript/.test(ctype)) problems.push(`embedded server served ${rel} as ${JSON.stringify(ctype)} (ES modules require a JS MIME type)`);
      const missing = run("curl-404", "curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `${origin}/assets/definitely-not-here-abc123.js`], { echo: false });
      console.log(`  embedded server: missing asset → HTTP ${missing.stdout.trim()}`);
      if (missing.stdout.trim() !== "404") problems.push(`missing asset on the embedded server returned ${missing.stdout.trim()}, not 404`);
    }
  } else {
    console.log("  embedded server: not exercised (the file:// path won, so no HTTP fallback log line)");
  }

  if (problems.length > 0) {
    console.error("\nsmoke-desktop: FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n--- captured output (last 25 lines) ---\n${tail(log, 25)}`);
    return 1;
  }
  console.log("smoke-desktop: PASS (window painted a mounted DOM" + (broken ? ", ladder fell back as documented" : "") + ")");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("smoke-desktop.mjs")) {
  process.exitCode = await main();
}
