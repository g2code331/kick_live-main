#!/usr/bin/env node
/**
 * Update-manifest builder / validator / promoter (docs/RELEASE-PIPELINE.md § updates).
 *
 *   node scripts/update-manifest.mjs build --version 1.2.0 --release-dir release [--channel stable]
 *   node scripts/update-manifest.mjs validate <file|->            # schema check; reads stdin with "-"
 *   node scripts/update-manifest.mjs promote --tag v1.2.0 --channel beta
 *   node scripts/update-manifest.mjs rollback --to v1.1.0
 *
 * The manifest is the *only* thing a client trusts, so:
 *  - sha256 + size are computed from the real artifact files, never hand-written;
 *  - output is validated with the same shared schema the clients use before it is written;
 *  - `rollback` re-publishes an older release's manifest instead of editing the live one, so a bad
 *    manifest can always be reverted with one command.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { BRAND } from "../shared/branding.ts";
import { REPO_ROOT, readVersionFile, sha256File } from "../tools/vite-shared.ts";
import { validateUpdateManifest } from "../shared/update-manifest.ts";
import { run, tail } from "./lib/run.mjs";

const args = process.argv.slice(2);
const mode = args[0] ?? "build";
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

export function buildManifest({ version, channel, releaseDir = "release", notes, notesUrl, releasedAt, allowInsecureUrls, baseUrl }) {
  const dir = path.resolve(releaseDir);
  const platforms = {};
  const warnings = [];
  const linuxX64Deb = artifactForPath(dir, /\.deb$/);
  const linuxX64AppImage = artifactForPath(dir, /\.AppImage$/);
  if (linuxX64Deb) {
    platforms.linux_x64 = {
      kind: "deb",
      fileName: linuxX64Deb.name,
      url: assetUrl(linuxX64Deb.name, baseUrl, allowInsecureUrls),
      sha256: linuxX64Deb.sha256,
      size: linuxX64Deb.bytes,
      minGlibc: "2.28",
    };
  } else warnings.push("no .deb found in the release dir: linux_x64 clients will see platform-missing");
  if (!linuxX64AppImage) warnings.push("no .AppImage found: users without root cannot be offered an update");

  const manifest = {
    schemaVersion: 1,
    product: "kicklive",
    channel,
    version,
    releasedAt,
    notes,
    ...(notesUrl ? { notesUrl } : {}),
    ...(has("mandatory-below") ? { mandatoryBelow: flag("mandatory-below") } : {}),
    platforms,
    web: {
      version,
      swUrl: "/sw.js",
      precache: ["/", "/index.html", "/site.webmanifest"],
    },
  };
  return { manifest, warnings, artifacts: { deb: linuxX64Deb, appimage: linuxX64AppImage } };
}

function artifactForPath(dir, re) {
  if (!fs.existsSync(dir)) return null;
  const name = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .at(-1);
  if (!name) return null;
  const file = path.join(dir, name);
  return { file, name, bytes: fs.statSync(file).size, sha256: sha256File(file) };
}

function assetUrl(name, baseUrl, allowInsecure) {
  if (typeof baseUrl === "string" && baseUrl.length > 0) {
    if (allowInsecure || baseUrl.startsWith("https://") || baseUrl.startsWith("/")) return `${baseUrl.replace(/\/$/, "")}/${name}`;
    throw new Error(`--base-url must be https:// (got ${baseUrl}); pass --allow-insecure-urls for local testing`);
  }
  const tag = flag("asset-tag", `v${readVersionFile(REPO_ROOT)}`);
  return `https://github.com/${repoSlug()}/releases/download/${tag}/${name}`;
}

function repoSlug() {
  const env = process.env.GITHUB_REPOSITORY;
  if (env && env.includes("/")) return env;
  return `${BRAND.homepage.split("/")[3] ?? "g2code331"}/${BRAND.homepage.split("/")[4] ?? "kick_live-main"}`;
}

function emit(text, out) {
  if (out && out !== "-") {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`update-manifest: wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}

export async function main() {
  if (mode === "validate") {
    const target = args[1] && !args[1].startsWith("--") ? args[1] : flag("file", "-");
    const text = target === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(target), "utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      console.error(`update-manifest: INVALID ${target} — not parseable JSON: ${err.message}`);
      return 1;
    }
    const res = validateUpdateManifest(json, { allowInsecureUrls: has("allow-insecure-urls") });
    if (res.ok) {
      console.log(`update-manifest: VALID ${target} (version=${res.value.version} channel=${res.value.channel} platforms=${Object.keys(res.value.platforms).join(",")})`);
      return 0;
    }
    console.error(`update-manifest: INVALID ${target}`);
    for (const e of res.errors) console.error(`  ${e.path || "(root)"} [${e.code}] ${e.message}`);
    return 1;
  }

  if (mode === "build") {
    const version = flag("version", readVersionFile(REPO_ROOT));
    const channel = flag("channel", "stable");
    const releasedAt = flag("released-at", new Date().toISOString());
    const notes = flag("notes", `KickLive ${version}`);
    const { manifest, warnings, artifacts } = buildManifest({
      version,
      channel,
      releaseDir: flag("release-dir", "release"),
      notes,
      notesUrl: flag("notes-url", `https://github.com/${repoSlug()}/releases/tag/v${version}`),
      releasedAt,
      baseUrl: flag("base-url", ""),
      allowInsecureUrls: has("allow-insecure-urls"),
    });
    const text = JSON.stringify(manifest, null, 2) + "\n";
    const check = validateUpdateManifest(JSON.parse(text), { allowInsecureUrls: has("allow-insecure-urls") });
    if (!check.ok) {
      console.error("update-manifest: refusing to write an invalid manifest:");
      for (const e of check.errors) console.error(`  ${e.path || "(root)"} [${e.code}] ${e.message}`);
      return 1;
    }
    const out = flag("out", `release/kicklive-update-${channel}.json`);
    emit(text, out);
    for (const [platform, a] of Object.entries(manifest.platforms)) {
      console.log(`  ${platform.padEnd(11)} ${a.fileName.padEnd(36)} ${(a.size / 1024 / 1024).toFixed(2)} MiB sha256:${a.sha256.slice(0, 12)}…`);
    }
    for (const w of warnings) console.log(`  warn: ${w}`);
    if (has("check-assets")) {
      for (const a of Object.values(artifacts)) {
        if (!a) continue;
        console.log(`  asset ${a.name}: ${a.bytes} bytes, sha256 recomputed from ${path.relative(REPO_ROOT, a.file)}`);
      }
    }
    return 0;
  }

  if (mode === "promote" || mode === "rollback") {
    const channel = flag("channel", mode === "promote" ? "beta" : "stable");
    const tag = mode === "promote" ? flag("tag", `v${readVersionFile(REPO_ROOT)}`) : flag("to", "");
    const asset = `kicklive-update-${channel}.json`;
    if (!tag) {
      console.error("update-manifest: rollback needs --to v1.2.3 (promote needs --tag v1.2.3)");
      return 2;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-manifest-"));
    const commands = [];
    if (channel === "stable") {
      // Stable clients read releases/latest/download/<asset>, so "rollback" = re-publish the
      // previous release's manifest over the one attached to the latest release. No client-side
      // cache is involved (Cache-Control: no-store on release download redirects).
      commands.push(["gh", ["release", "download", tag, "-p", asset, "-D", workDir]]);
      commands.push(["gh", ["release", "upload", flag("onto", "latest"), path.join(workDir, asset), "--clobber"]]);
    } else {
      // Beta clients follow the moving tag update-channel-beta; moving it is the whole promotion.
      commands.push(["gh", ["release", "download", tag, "-p", asset, "-D", workDir]]);
      commands.push(["git", ["tag", "-f", `update-channel-${channel}`, tag]]);
      commands.push(["git", ["push", "-f", "origin", `refs/tags/update-channel-${channel}`]]);
    }
    console.log(`update-manifest: ${mode} ${channel} -> ${tag} (asset ${asset})`);
    for (const [cmd, cmdArgs] of commands) console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
    if (has("dry-run")) return 0;
    let failed = false;
    for (const [cmd, cmdArgs] of commands) {
      const res = run(cmd, cmd, cmdArgs, { cwd: REPO_ROOT, echo: false });
      console.log(`  ${res.ok ? "ok  " : "FAIL"} ${cmd} ${cmdArgs.join(" ")}${res.ok ? "" : "\n" + tail(res.stdout + res.stderr, 4)}`);
      if (!res.ok) failed = true;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    if (failed) console.error("update-manifest: channel was NOT moved; fix the failing command and re-run");
    return failed ? 1 : 0;
  }

  console.error(`update-manifest: unknown mode "${mode}" (build|validate|promote|rollback)`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("update-manifest.mjs")) {
  process.exitCode = await main();
}
