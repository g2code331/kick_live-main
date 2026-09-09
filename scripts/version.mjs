#!/usr/bin/env node
/**
 * Version lockstep. `VERSION` at the repo root is the single source of truth; every other version
 * field in the tree is derived from it. `check` is a CI gate, `write` regenerates the dependents.
 *
 *   node scripts/version.mjs check [--soft]
 *   node scripts/version.mjs write            # re-sync dependents from VERSION
 *   node scripts/version.mjs bump patch       # VERSION -> 1.0.1, then re-sync
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { bumpVersion, isValid } from "../shared/semver.ts";
import { renderDesktopFile, renderWebManifest } from "../shared/branding.ts";
import { REPO_ROOT, readVersionFile } from "../tools/vite-shared.ts";
import { Report } from "./lib/run.mjs";

export function versionSiblings() {
  return [
    { name: "VERSION", file: "VERSION", kind: "raw" },
    { name: "package.json", file: "package.json", kind: "json", path: "version" },
    { name: "public/site.webmanifest", file: "public/site.webmanifest", kind: "json", path: "version" },
    { name: "packaging/linux/kicklive.desktop", file: "packaging/linux/kicklive.desktop", kind: "desktop", key: "X-KickLive-Version" },
  ];
}

function readField(root, entry) {
  const abs = path.join(root, entry.file);
  if (!fs.existsSync(abs)) return { missing: true };
  const text = fs.readFileSync(abs, "utf8");
  if (entry.kind === "raw") return { value: text.trim() };
  if (entry.kind === "json") {
    try {
      const json = JSON.parse(text);
      return { value: json[entry.path] };
    } catch (err) {
      return { error: `unparseable JSON: ${err.message}` };
    }
  }
  const m = new RegExp(`^${entry.key}=(.*)$`, "m").exec(text);
  return m ? { value: m[1] } : { value: undefined };
}

function writeField(root, entry, value) {
  const abs = path.join(root, entry.file);
  if (entry.kind === "raw") {
    fs.writeFileSync(abs, value + "\n");
    return;
  }
  const text = fs.readFileSync(abs, "utf8");
  if (entry.kind === "json") {
    const json = JSON.parse(text);
    json[entry.path] = value;
    const next = entry.file === "package.json" ? JSON.stringify(json, null, 2) + "\n" : JSON.stringify(json, null, 2) + "\n";
    fs.writeFileSync(abs, next);
    return;
  }
  const re = new RegExp(`^${entry.key}=.*$`, "m");
  fs.writeFileSync(abs, re.test(text) ? text.replace(re, `${entry.key}=${value}`) : text.replace(/\n*$/, `\n`) + `${entry.key}=${value}\n`);
}

export function generatedDependents(version) {
  return [
    { file: "public/site.webmanifest", contents: renderWebManifest(version) },
    { file: "packaging/linux/kicklive.desktop", contents: renderDesktopFile(version) },
  ];
}

export function applyGenerated(root = REPO_ROOT, version = readVersionFile(root)) {
  for (const d of generatedDependents(version)) {
    const abs = path.join(root, d.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, d.contents);
  }
  return version;
}

export function checkVersions(root = REPO_ROOT) {
  const problems = [];
  const canonical = readVersionFile(root);
  if (!isValid(canonical)) problems.push({ level: "error", code: "VERSION", message: `VERSION is not valid semver: ${canonical}` });
  for (const entry of versionSiblings().slice(1)) {
    const got = readField(root, entry);
    if (got.missing) {
      problems.push({ level: "error", code: entry.name, message: "file is missing (run: node scripts/version.mjs write)" });
      continue;
    }
    if (got.error) {
      problems.push({ level: "error", code: entry.name, message: got.error });
      continue;
    }
    if (got.value !== canonical) {
      problems.push({ level: "error", code: entry.name, message: `expected ${canonical}, found ${String(got.value)}` });
    }
  }
  // Also fail if a generated file drifted from what the generator would produce right now.
  for (const d of generatedDependents(canonical)) {
    const abs = path.join(root, d.file);
    if (!fs.existsSync(abs)) {
      problems.push({ level: "error", code: d.file, message: "generated file is missing (run: npm run branding:write)" });
      continue;
    }
    const actual = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    if (actual !== d.contents) {
      problems.push({ level: "error", code: d.file, message: "content drifted from the generator (run: npm run branding:write)" });
    }
  }
  return { canonical, problems };
}

function main(argv) {
  const mode = argv[0] ?? "check";
  if (mode === "check") {
    const soft = argv.includes("--soft");
    const { canonical, problems } = checkVersions();
    const report = new Report(`version lockstep (canonical VERSION=${canonical})`);
    for (const p of problems) report.add(p.code, p.level === "error" ? "FAIL" : "WARN", p.message);
    if (problems.length === 0) {
      console.log(`version.mjs: all version fields are in lockstep at ${canonical}`);
      return 0;
    }
    console.log(report.table());
    if (soft) {
      console.log("version.mjs: --soft, not failing");
      return 0;
    }
    console.log(`version.mjs: ${String(problems.length)} field(s) out of lockstep; fix with "node scripts/version.mjs write"`);
    return 1;
  }
  if (mode === "write") {
    const version = readVersionFile();
    applyGenerated(REPO_ROOT, version);
    console.log(`version.mjs: regenerated dependents from VERSION=${version}`);
    return 0;
  }
  if (mode === "bump") {
    const kind = argv[1];
    if (!["major", "minor", "patch"].includes(kind)) {
      console.error("usage: node scripts/version.mjs bump major|minor|patch");
      return 2;
    }
    const current = readVersionFile();
    const next = bumpVersion(current, kind);
    fs.writeFileSync(path.join(REPO_ROOT, "VERSION"), next + "\n");
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = next;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    for (const entry of versionSiblings()) {
      if (entry.kind === "json" && entry.file !== "package.json") writeField(REPO_ROOT, entry, next);
    }
    applyGenerated(REPO_ROOT, next);
    console.log(`version.mjs: bumped ${current} -> ${next} (VERSION, package.json, webmanifest, desktop entry)`);
    return 0;
  }
  console.error(`unknown mode ${mode} (expected check|write|bump)`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("version.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
