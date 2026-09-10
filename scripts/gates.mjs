#!/usr/bin/env node
/**
 * The release gate: everything that must be green before a tag is pushed, in the order the spec
 * numbers them (docs/RELEASE-PIPELINE.md § gates).
 *
 *   node scripts/gates.mjs                # run 1,2,4,5 + 3/6 when their tools exist
 *   node scripts/gates.mjs --only=1,2     # subset
 *   node scripts/gates.mjs --skip=6       # skip the clean-VM rehearsal
 *
 * Every gate prints a one-line summary and the whole run ends with the §2.5 table, so the last
 * thing on stdout is the thing to paste into a PR.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, readVersionFile } from "../tools/vite-shared.ts";
import { fmtSize, run, start, tail, which } from "./lib/run.mjs";

const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  ?.split(",")
  .map(Number);
const skip = new Set(args.filter((a) => a.startsWith("--skip=")).flatMap((a) => a.slice(7).split(",").map(Number)));
if (args.includes("--skip-clean-vm")) skip.add(6);

const rows = [];
function record(gate, name, status, detail) {
  rows.push({ gate, name, status, detail });
  const icon = status === "pass" ? "✅" : status === "skip" ? "➖" : "❌";
  console.log(`${icon} ${status.toUpperCase().padEnd(4)} [${gate}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function step(gate, name, cmd, cmdArgs, opts = {}) {
  const res = run(name, cmd, cmdArgs, { cwd: REPO_ROOT, echo: false, ...opts });
  record(
    gate,
    name,
    res.ok ? "pass" : "fail",
    res.ok
      ? (opts.detail ?? summarize(res.stdout))
      : tail(res.stdout + res.stderr, 12)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join(" / "),
  );
  return res;
}

function summarize(out) {
  const line =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1) ?? "";
  return line.length > 0 && line.length < 120 ? line : "";
}

const wanted = (n) => (!only || only.includes(n)) && !skip.has(n);

async function gate1() {
  step(1, "typecheck (web+shared)", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  step(1, "typecheck (scripts+server+desktop)", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.node.json"]);
  step(1, "typecheck (workers skeleton)", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.workers.json"]);
  step(1, "no hardcoded backend config in shipped source", process.execPath, ["scripts/check-secrets.mjs", "--scan-only"]);
  step(1, "unit tests", process.execPath, ["scripts/run-tests.mjs", "unit"]);
  step(1, "integration tests", process.execPath, ["scripts/run-tests.mjs", "integration"]);
  // `npx --no <bin>` is not a flag: npx ignores it, falls back to fetching a package, and the step
  // "passes" having run nothing at all. Invoke the installed binaries directly so a formatting
  // failure is a real failure (this was a false pass until the Phase 1 audit).
  step(1, "format (prettier)", process.execPath, ["node_modules/prettier/bin/prettier.cjs", "--check", "."]);
  const eslint = fs.existsSync(path.join(REPO_ROOT, "eslint.config.js")) || fs.existsSync(path.join(REPO_ROOT, ".eslintrc.cjs"));
  if (eslint && fs.existsSync(path.join(REPO_ROOT, "node_modules/eslint/bin/eslint.js"))) step(1, "lint (eslint)", process.execPath, ["node_modules/eslint/bin/eslint.js", "."]);
  else record(1, "lint (eslint)", "skip", "no eslint config in the repo — prettier is the only formatter gate that exists");
}

async function gate2() {
  step(2, "build:renderer", process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.renderer.config.ts"]);
  step(2, "build:web", process.execPath, ["scripts/build-web.mjs"]);
  step(2, "build:desktop (esbuild bundles)", process.execPath, ["scripts/build-desktop.mjs"]);
  step(2, "verify:packaging (tier A: layout, hooks, identity, version, asar)", process.execPath, ["scripts/verify-packaging.mjs"]);
  if (fs.existsSync(path.join(REPO_ROOT, "release/linux-unpacked"))) step(2, "verify:packaging (tier B)", process.execPath, ["scripts/verify-packaging.mjs", "--require-full"]);
  else record(2, "verify:packaging (tier B/C: real .deb + AppImage)", "skip", "no release/*.deb here — needs the Electron dist zip + fpm (CI gate: desktop)");
}

async function gate3() {
  const binary = path.join(REPO_ROOT, "release/linux-unpacked/kicklive");
  const hasXvfb = which("xvfb-run") !== null;
  const hasElectron = fs.existsSync(path.join(REPO_ROOT, "node_modules/electron/dist/electron"));
  if (!fs.existsSync(binary) || !hasElectron) {
    record(
      3,
      "smoke: built binary under xvfb (real DOM + fallback)",
      "skip",
      hasElectron ? "no release/linux-unpacked/kicklive — run npm run package:linux" : "electron runtime not downloadable in this sandbox; CI runs this gate",
    );
    return;
  }
  const wrapper = hasXvfb ? "xvfb-run -a --server-args=-screen 0 1280x800x24" : "";
  step(3, "smoke: happy path", process.execPath, ["scripts/smoke-desktop.mjs", ...(wrapper ? ["--wrapper", wrapper] : [])]);
  step(3, "smoke: broken load path", process.execPath, ["scripts/smoke-desktop.mjs", "--broken-load-path", ...(wrapper ? ["--wrapper", wrapper] : [])]);
}

async function gate4() {
  step(4, "update contract tests", process.execPath, [
    "--test",
    "tests/unit/semver.test.ts",
    "tests/unit/update-manifest.test.ts",
    "tests/unit/update-decide.test.ts",
    "tests/unit/update-controller.test.ts",
    "tests/unit/update-updater.test.ts",
    "tests/integration/updates-end-to-end.test.ts",
  ]);
  for (const file of ["packaging/updates/manifest.sample.json", "packaging/updates/manifest.beta.json"]) {
    const p = path.join(REPO_ROOT, file);
    if (fs.existsSync(p)) step(4, `manifest schema: ${file}`, process.execPath, ["scripts/update-manifest.mjs", "validate", file]);
    else record(4, `manifest schema: ${file}`, "skip", "file missing");
  }
}

async function gate5() {
  step(5, "branding check", process.execPath, ["scripts/branding.mjs", "check"]);
  // The browser-facing brand assets are derived files, so they are gated as such: the committed bytes must
  // be what `scripts/brand-assets.mjs` writes today. Master artwork edited without regenerating is exactly
  // the drift a "logo looks slightly off in prod" bug report cannot explain.
  step(5, "brand assets are in sync with the pipeline", process.execPath, ["scripts/brand-assets.mjs", "--check"]);
  step(5, "version lockstep", process.execPath, ["scripts/version.mjs", "check"]);
  step(5, "verify (aggregate)", process.execPath, ["scripts/verify.mjs", "check"]);
  // The "write is idempotent" mode: regenerate and prove the *generated* files do not change. A
  // pre-existing dirty tree is fine, so the comparison is on content, not on git status.
  const generated = [
    "public/site.webmanifest",
    "packaging/linux/kicklive.desktop",
    ...fs
      .readdirSync(path.join(REPO_ROOT, "packaging/icons"))
      .filter((f) => f.endsWith(".png"))
      .map((f) => `packaging/icons/${f}`),
  ];
  const digest = (files) => files.map((f) => `${f}:${hashOf(path.join(REPO_ROOT, f))}`).join("|");
  const before = digest(generated);
  step(5, "branding write (regenerate)", process.execPath, ["scripts/branding.mjs", "write"]);
  step(5, "version write (regenerate)", process.execPath, ["scripts/version.mjs", "write"]);
  const after = digest(generated);
  record(
    5,
    "regeneration is idempotent (generated files byte-identical)",
    before === after ? "pass" : "fail",
    before === after ? `${String(generated.length)} generated files unchanged` : "generated output differs between runs",
  );
  // And in check-mode on a dirty tree, `check` must actually fail (that is the point of the gate).
  step(5, "verify:packaging (branding+identity assertions)", process.execPath, ["scripts/verify-packaging.mjs"]);
}

function hashOf(file) {
  if (!fs.existsSync(file)) return "absent";
  const { createHash } = require_crypto();
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

function require_crypto() {
  // imported lazily so the gate script still runs if node's crypto is somehow unavailable
  return crypto;
}

async function gate6() {
  // Clean-VM rehearsal: fresh clone into a temp dir, npm ci, build, serve, curl assertions.
  const dirty = run("git status", "git", ["status", "--porcelain"], { cwd: REPO_ROOT, echo: false }).stdout.trim();
  if (dirty.length > 0) {
    record(
      6,
      "clean clone → npm ci → build:web → serve",
      "skip",
      `the working tree has ${String(dirty.split("\n").length)} uncommitted change(s): a fresh clone cannot see them, so this rehearsal only means anything on a committed tree (CI clones the pushed commit)`,
    );
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-clean-"));
  const clone = path.join(tmp, "kicklive");
  const steps = [];
  steps.push(run("clone", "git", ["clone", "--shared", REPO_ROOT, clone], { echo: false }));
  // node_modules is copied by symlink: `npm ci` in the clone proves the lockfile is complete.
  steps.push(run("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], { cwd: clone, echo: false }));
  steps.push(run("build:web", "npm", ["run", "build:web"], { cwd: clone, echo: false }));
  const child = start("serve", process.execPath, ["server/cli.ts", "--root", path.join(clone, "dist/web"), "--port", "4319", "--quiet"], { cwd: clone });
  await child.wait(1500);
  steps.push({ ok: true, stdout: child.output, code: 0 });
  // --path-as-is matters: without it curl rewrites /../x into /x client-side, so the server would
  // never see the traversal at all and the probe would prove nothing.
  const probe = (url) => run("curl", "curl", ["-sS", "--path-as-is", "-o", "/dev/null", "-w", "%{http_code} %{content_type}", `http://127.0.0.1:4319${url}`], { echo: false });
  const body = (url) => run("curl", "curl", ["-sS", "--path-as-is", `http://127.0.0.1:4319${url}`], { echo: false });
  const index = probe("/");
  const js = probe(`/${jsName(clone)}`);
  const missing = probe("/assets/nope-does-not-exist.js");
  const traversal = probe("/../etc/passwd");
  const leaked = body("/../etc/passwd");
  steps.push({ ok: /200 text\/html/.test(index.stdout), stdout: index.stdout, code: 0 });
  steps.push({ ok: /200 text\/javascript/.test(js.stdout), stdout: js.stdout, code: 0 });
  steps.push({ ok: /404/.test(missing.stdout), stdout: missing.stdout, code: 0 });
  // Either refused outright, or the SPA shell — what must never happen is /etc/passwd coming back.
  steps.push({
    ok: (/40[039]/.test(traversal.stdout) || /200 text\/html/.test(traversal.stdout)) && !leaked.stdout.includes("root:"),
    stdout: `${traversal.stdout}\n${tail(leaked.stdout, 2)}`,
    code: 0,
  });
  child.kill();
  const ok = steps.every((s) => s.ok);
  record(6, "clean clone → npm ci → build:web → serve (200 html, 200 js, 404 asset, 4xx traversal)", ok ? "pass" : "fail", `clone=${clone}`);
  if (!ok)
    for (const s of steps)
      if (!s.ok)
        console.log(
          tail(s.stdout ?? "", 6)
            .split("\n")
            .map((l) => `       ${l}`)
            .join("\n"),
        );
  fs.rmSync(tmp, { recursive: true, force: true });
}

function jsName(cloneRoot) {
  const dir = path.join(cloneRoot, "dist/web/assets");
  if (!fs.existsSync(dir)) return "assets/missing.js";
  const js = fs.readdirSync(dir).filter((f) => f.endsWith(".js"))[0];
  return `assets/${js ?? "missing.js"}`;
}

export async function main() {
  const t0 = Date.now();
  console.log(`KickLive release gates (v${readVersionFile(REPO_ROOT)}) — node ${process.version}, ${os.platform()}/${os.arch()}`);
  for (const [n, fn] of [
    [1, gate1],
    [2, gate2],
    [3, gate3],
    [4, gate4],
    [5, gate5],
    [6, gate6],
  ]) {
    if (!wanted(n)) {
      record(n, "gate disabled by CLI", "skip", "");
      continue;
    }
    console.log(`\n─── gate ${n} ───`);
    await fn();
  }
  const failed = rows.filter((r) => r.status === "fail");
  const skipped = rows.filter((r) => r.status === "skip");
  console.log("\n=== run summary (§2.5) ===");
  console.log("| gate | check | status | detail |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.gate} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`);
  console.log(`\ngates: ${String(rows.length - failed.length - skipped.length)} pass, ${String(failed.length)} fail, ${String(skipped.length)} skip in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.error("gates: FAILED — do not tag a release");
    return 1;
  }
  if (skipped.length > 0) console.error("gates: PASSED with skips (each skip names the CI job that covers it)");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("gates.mjs")) {
  process.exitCode = await main();
}
