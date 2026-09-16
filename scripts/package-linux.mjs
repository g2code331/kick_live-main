#!/usr/bin/env node
/**
 * Build the Linux desktop artifacts with electron-builder, then run the layout tests against the
 * real output.
 *
 *   node scripts/package-linux.mjs [--targets deb,AppImage] [--dir] [--skip-build] [--require-full]
 *
 * `--dir` stops at release/linux-unpacked (fast, no fpm/AppImage tooling needed) — useful for a
 * layout check without producing shippable artifacts.
 *
 * Requirement this script cannot satisfy offline: electron-builder downloads the Electron runtime
 * zip + fpm from GitHub release assets. If that host is unreachable the failure is printed with
 * the exact reason instead of a stack trace, because that is the #1 "CI works, my laptop doesn't"
 * complaint for this pipeline.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, readVersionFile, walk } from "../tools/vite-shared.ts";
import { fmtSize, run, tail } from "./lib/run.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

function targets() {
  if (has("dir")) return ["dir"];
  return String(flag("targets", "deb,AppImage"))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export async function main() {
  const version = readVersionFile(REPO_ROOT);
  if (!has("skip-build")) {
    const build = run("npm run build", "npm", ["run", "build"], { cwd: REPO_ROOT });
    if (!build.ok) {
      console.error("package-linux: npm run build failed");
      return build.code || 1;
    }
  }
  for (const required of ["renderer/dist/index.html", "build/electron/main.cjs", "build/electron/preload.cjs"]) {
    if (!fs.existsSync(path.join(REPO_ROOT, required))) {
      console.error(`package-linux: ${required} is missing — run "npm run build" first`);
      return 1;
    }
  }

  // Call electron-builder directly, never through `npx --no electron-builder …`.
  //
  // npx keeps parsing options as npm's OWN until it meets a non-option argument, then hands the
  // rest to the binary. So `npx --no prettier --version` prints npm's version, and this script's
  // original `npx --no electron-builder --config electron-builder.yml …` made npm eat `--config`
  // (npm reads it as an npmrc path!) and forward `electron-builder.yml` to electron-builder as a
  // stray positional — "Unknown arguments: electron-builder.yml, never". A command whose first
  // argument is a subcommand (wrangler `deploy`) escapes this by accident; one that starts with a
  // flag does not. `npx --no -- <pkg> …` also works; the local binary is more predictable.
  // electron-builder takes the target list as VALUES of the `--linux` ARRAY option
  // (`--linux deb AppImage`). Neither `--deb --AppImage` nor bare positionals are accepted —
  // both are rejected with "Unknown arguments: deb, AppImage", which this script then reported
  // as a download failure. An EMPTY list means "use linux.target from electron-builder.yml",
  // which is what `--dir` relies on (`args.dir` is promoted to DIR_TARGET internally).
  const builderArgs = ["--config", "electron-builder.yml", "--linux"];
  if (has("dir")) builderArgs.push("--dir");
  else builderArgs.push(...targets());
  // electron-builder writes `linux.desktop.entry` values into the .desktop file VERBATIM — there is
  // no macro expansion on that path (LinuxTargetHelper.computeDesktopEntry just does
  // `data += \`\n${name}=${desktopMeta[name]}\``). So the `${version}` in electron-builder.yml is a
  // placeholder, not a value: left to itself the builder ships the six characters "${version}" into
  // /usr/share/applications/kicklive.desktop, and tier C6 fails with
  // "X-KickLive-Version: expected 1.0.0 got ${version}".
  //
  // `-c.<dotted.key>=<value>` is the documented way to combine a config file with CLI overrides
  // (electron-builder#2016: `config` becomes [file, object] and the object is deep-assigned over
  // it), so the resolved version is injected here, where VERSION is already known. The macro stays
  // in electron-builder.yml because `branding check` asserts the packager declares the key.
  builderArgs.push(`-c.linux.desktop.entry.X-KickLive-Version=${version}`);
  builderArgs.push("--x64", "--publish", "never");
  const localBin = path.join(REPO_ROOT, "node_modules", ".bin", "electron-builder");
  const builder = fs.existsSync(localBin) ? localBin : "npx";
  const argv = fs.existsSync(localBin) ? builderArgs : ["--no", "--", "electron-builder", ...builderArgs];
  console.log(`package-linux: electron-builder ${targets().join(",")} @ v${version}`);
  const res = run("electron-builder", builder, argv, { cwd: REPO_ROOT, env: { ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? "" } });
  const out = res.stdout + res.stderr;
  // Persist the FULL builder transcript to release/ before deciding pass/fail. When electron-builder
  // fails, the `verify` and `smoke` steps that follow it never run, so their `if: always()` artifact
  // (release/smoke-*.log) is never written — and this sandbox cannot read GitHub's step logs at all.
  // A committed log file, matched by the workflow's smoke-log upload glob, is the only transcript that
  // survives a packaging failure and can be downloaded from the run's Artifacts.
  try {
    fs.mkdirSync(path.join(REPO_ROOT, "release"), { recursive: true });
    fs.writeFileSync(
      path.join(REPO_ROOT, "release", "package-linux.log"),
      `# electron-builder ${targets().join(",")} @ v${version}\n# invoked: ${[builder, ...argv].join(" ")}\n# exit: ${String(res.code)}\n\n${out}\n`,
    );
  } catch {
    /* best-effort: never mask the real failure with a logging error */
  }
  if (!res.ok) {
    // Classify before speaking. The old pattern included a bare `self-signed`, which matches
    // electron-builder's own help text ("create-self-signed-cert") — so a CLI usage error was
    // reported as "it could not download the Electron runtime", pointing at the network when the
    // problem was the argument list. A usage error now says so by name.
    const usage = /Unknown arguments?:|Unknown option|Invalid configuration object/i.test(out);
    const blocked = !usage && /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Could not download|download.*failed|unable to verify the first certificate|self.signed certificate/i.test(out);
    console.error(
      `\npackage-linux: electron-builder failed${usage ? " — the builder rejected its own arguments or config" : blocked ? " — it could not download the Electron runtime/fpm tooling" : ""}`,
    );
    if (usage) {
      console.error(`  electron-builder never started building: ${tail(out, 2).trim()}`);
      console.error(`  invoked as: ${[builder, ...argv].join(" ")}`);
      console.error("  Targets are values of the `--linux` array (`--linux deb AppImage`), not `--deb --AppImage` flags.");
    }
    if (blocked) {
      console.error(
        "  This step needs network access to github.com release assets. In CI it is available;\n" +
          "  locally you can pre-seed the caches:\n" +
          "    export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/\n" +
          "    mkdir -p ~/.cache/electron-builder && <place electron-v" +
          version +
          "-linux-x64.zip in ~/.cache/electron>",
      );
    }
    console.error(tail(out, 20));
    return res.code || 1;
  }

  const releaseDir = path.join(REPO_ROOT, "release");
  const artifacts = fs.existsSync(releaseDir) ? walk(releaseDir, (f) => /\.(deb|AppImage|rpm|zip|tar\.gz|blockmap|yml|json)$/.test(f) && !/packaging-report|checksums|artifacts\.json/.test(f)) : [];
  const rows = [];
  for (const file of artifacts) {
    const stat = fs.statSync(file);
    rows.push({
      name: path.basename(file),
      bytes: stat.size,
      sha256: (await hashFile(file)).slice(0, 16),
      full: await hashFile(file),
    });
  }
  const manifest = {
    product: "kicklive",
    version,
    generatedAt: new Date().toISOString(),
    targets: targets(),
    artifacts: rows.map((r) => ({ name: r.name, bytes: r.bytes, sha256: r.sha256, path: `release/${r.name}` })),
  };
  fs.writeFileSync(path.join(releaseDir, "artifacts.json"), JSON.stringify(manifest, null, 2) + "\n");
  // release/*.deb/AppImage are hashed at build time so `verify-packaging` (tier C) and the update
  // manifest builder agree on one source of truth instead of each re-reading the files.
  const checksums = Object.fromEntries(rows.map((r) => [`release/${r.name}`, r.full]));
  fs.writeFileSync(path.join(releaseDir, "checksums.json"), JSON.stringify({ version, generatedAt: manifest.generatedAt, files: checksums }, null, 2) + "\n");
  console.log("\npackage-linux: artifacts");
  for (const r of rows) console.log(`  ${r.name.padEnd(42)} ${fmtSize(r.bytes).padStart(10)}  sha256:${r.sha256}…`);

  const verify = run("verify-packaging", process.execPath, ["scripts/verify-packaging.mjs", ...(has("dir") ? [] : ["--require-full"])], { cwd: REPO_ROOT });
  // Append the artifact inventory + the FULL verify-packaging transcript to the same log the CI
  // smoke-log upload collects. electron-builder can SUCCEED and this verify step still fail (a tier
  // B/C layout mismatch), in which case the electron-builder-only log above looks clean and hides the
  // real cause. Recording both here means the downloadable artifact always explains the exit code —
  // which matters because this sandbox cannot read GitHub's step logs.
  try {
    const inventory = rows.length ? rows.map((r) => `  ${r.name}  ${fmtSize(r.bytes)}  sha256:${r.sha256}…`).join("\n") : "  (no artifacts found in release/)";
    fs.appendFileSync(
      path.join(REPO_ROOT, "release", "package-linux.log"),
      `\n\n# ── artifacts ──\n${inventory}\n\n# ── verify-packaging${has("dir") ? "" : " --require-full"} (exit ${String(verify.code)}) ──\n${verify.stdout}\n`,
    );
  } catch {
    /* best-effort */
  }
  return verify.ok ? 0 : verify.code || 1;
}

async function hashFile(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("package-linux.mjs")) {
  process.exitCode = await main();
}
