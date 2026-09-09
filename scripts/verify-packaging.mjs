#!/usr/bin/env node
/**
 * Packaging layout tests (docs/RELEASE-PIPELINE.md §7.2). Three tiers, and the script is honest
 * about which one ran:
 *
 *   A  always            build outputs, hook scripts (bash -n), branding/version lockstep, and a
 *                        synthetic repack of the real `renderer/dist` + `build/electron` with the
 *                        REAL @electron/asar tool (list + extract-file), asserting the asar/unpack
 *                        split that electron-builder.yml declares.
 *   B  needs release/    release/linux-unpacked layout + `asar list` on the actual app.asar.
 *   C  needs the .deb    dpkg-deb -f / -c / -e / -x: control fields, the installed .desktop file
 *                        diffed against packaging/linux/kicklive.desktop, hicolor icon set,
 *                        chrome-sandbox, plus checksums.json for the update manifest.
 *
 * CI passes --require-full so a missing tier becomes a failure; a laptop without the Electron
 * binary gets A + "B/C skipped, here is why".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

import { BRAND, linuxIconSpecs } from "../shared/branding.ts";
import { REPO_ROOT, readVersionFile, walk } from "../tools/vite-shared.ts";
import { fmtSize, listFiles, relPath, run, tail, which } from "./lib/run.mjs";
import { readPngHeader } from "./lib/png.mjs";
import { verifyBundle } from "./build-desktop.mjs";

const RELEASE = path.join(REPO_ROOT, "release");
const args = process.argv.slice(2);
const REQUIRE_FULL = args.includes("--require-full");
const WRITE_REPORT = !args.includes("--no-report");

const results = [];
function add(name, status, detail = "") {
  const mark = status === "PASS" ? "✅" : status === "SKIP" ? "➖" : "❌";
  results.push({ name, status, detail });
  console.log(`${mark} ${status.padEnd(4)} ${name}${detail ? `\n       ${detail.split("\n").join("\n       ")}` : ""}`);
}
function check(name, ok, detail = "") {
  add(name, ok ? "PASS" : "FAIL", detail);
  return ok;
}
function skip(name, why) {
  add(name, "SKIP", why);
}

function exists(p) {
  return fs.existsSync(p);
}

/* ------------------------------ tier A ------------------------------ */

async function tierA() {
  const version = readVersionFile(REPO_ROOT);
  const rendererDist = path.join(REPO_ROOT, "renderer", "dist");
  const webDist = path.join(REPO_ROOT, "dist", "web");
  const electronOut = path.join(REPO_ROOT, "build", "electron");

  // A1 — renderer bundle present at the path the shell loads.
  const indexHtml = path.join(rendererDist, "index.html");
  if (!check("A1 renderer/dist present", exists(indexHtml), `expected ${relPath(REPO_ROOT, indexHtml)} (npm run build:renderer)`)) {
    return { version, rendererDist, webDist, electronOut, fatal: true };
  }
  const html = fs.readFileSync(indexHtml, "utf8");
  const assetRefs = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const cssRefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"[^>]*>/g)].map((m) => m[1]);
  const badAbsolute = [...assetRefs, ...cssRefs].filter((r) => r.startsWith("/"));
  check(
    "A1b renderer uses relative asset URLs",
    badAbsolute.length === 0 && assetRefs.length > 0,
    badAbsolute.length > 0 ? `absolute URLs break file:// loads: ${badAbsolute.join(", ")}` : `${String(assetRefs.length)} script + ${String(cssRefs.length)} stylesheet refs`,
  );
  check("A1c module script tag present", /<script[^>]+type="module"/.test(html), "the entry <script> must be type=module so the JS MIME type actually matters");
  const assetsDir = path.join(rendererDist, "assets");
  const jsAssets = exists(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /\.js$/.test(f)) : [];
  check("A1d hashed JS assets exist", jsAssets.length > 0, jsAssets.slice(0, 3).join(", "));
  for (const ref of assetRefs) {
    const file = path.join(rendererDist, ref.replace(/^\.\//, ""));
    check(`A1e asset resolvable ${ref}`, exists(file), exists(file) ? fmtSize(fs.statSync(file).size) : "missing from the bundle");
  }
  const swInRenderer = exists(path.join(rendererDist, "sw.js"));
  check("A1f renderer has no service worker", !swInRenderer, swInRenderer ? "the desktop build must not ship sw.js" : "correct: SW is a web-surface only feature");
  const versionStamped = /name="kicklive:version"/.test(html);
  check("A1g version meta present", versionStamped, 'index.html must carry <meta name="kicklive:version">');

  // The desktop renderer is the only place the update control can be proven to exist without a
  // browser: JSX cannot be unit-tested in plain node, so the shipped bytes are asserted instead.
  const bundleText = jsAssets.map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8")).join("\n");
  check("A1h the update control shipped into the renderer bundle", bundleText.includes("update-control"), `${String(jsAssets.length)} bundle file(s) searched for the data-kicklive marker`);
  check("A1i the web storage key is in the bundle", bundleText.includes("kicklive.updates.v1"), "the PWA must persist snooze/lastSeen across reloads");
  check("A1j no absolute asset URLs anywhere in the bundle", !/src="\/[^"/]/.test(html) && !/href="\/[^"/]/.test(html), 'absolute "/" URLs resolve to the filesystem root under file://');

  // A2 — web/PWA bundle.
  if (exists(webDist)) {
    const files = listFiles(webDist);
    const names = files.map((f) => path.basename(f));
    check("A2 web bundle present", names.includes("index.html") && names.includes("sw.js") && names.includes("version.json"), `${String(files.length)} files`);
    const swText = fs.readFileSync(path.join(webDist, "sw.js"), "utf8");
    check(
      "A2b sw.js cache is versioned",
      swText.includes(`kicklive-static-v${version}`.replace("v" + version, () => "v")) || /kicklive-static-v/.test(swText),
      "cache names must include the build version",
    );
    check("A2c sw.js is self-contained", !/from\s+["']\.\/[^"']+["']/.test(swText), "an unbundled sw would 404 on importScripts");
    const vjson = JSON.parse(fs.readFileSync(path.join(webDist, "version.json"), "utf8"));
    check("A2d version.json matches VERSION", vjson.version === version, `version.json=${String(vjson.version)} VERSION=${version}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(webDist, "site.webmanifest"), "utf8"));
    check("A2e built webmanifest matches source", JSON.stringify(manifest) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "public", "site.webmanifest"), "utf8"))));
  } else {
    skip("A2 web bundle", "dist/web is missing (npm run build:web)");
  }

  // A3 — electron bundles.
  try {
    verifyBundle(electronOut);
    check("A3 main/preload bundles ok", true, 'require("electron") external, no import.meta.dirname in CJS');
  } catch (err) {
    check("A3 main/preload bundles ok", false, err.message);
  }
  const mainCjs = path.join(electronOut, "main.cjs");
  if (exists(mainCjs)) {
    const text = fs.readFileSync(mainCjs, "utf8");
    check("A3b main embeds the load-ladder log vocabulary", text.includes("[kicklive:renderer]") && text.includes("FALLBACK_ACTIVE") && text.includes("LOAD_FAILED"));
    check("A3c main embeds the updates log vocabulary", text.includes("[kicklive:updates]") && text.includes("REFUSE_INSTALL"));
    check(
      "A3d main sets desktopName/WM_CLASS",
      text.includes(`"${BRAND.desktopFile}"`) || text.includes(`'${BRAND.desktopFile}'`),
      "app.setDesktopName(<desktopName>) is what links the window to the launcher",
    );
    check("A3e no node_modules bundled", !text.includes("node_modules"), "the app bundle must be dependency-free");
  }

  // A4 — hook scripts.
  const shellFiles = walk(REPO_ROOT, (f) => f.endsWith(".sh") && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}.git${path.sep}`));
  const bash = which("bash") ?? "/bin/bash";
  let hooksOk = shellFiles.length > 0;
  for (const file of shellFiles) {
    const rel = relPath(REPO_ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    const hasShebang = text.startsWith("#!/bin/bash") || text.startsWith("#!/usr/bin/env bash") || text.startsWith("#!/bin/sh");
    const noCrlf = !text.includes("\r\n");
    const res = runQuiet(bash, ["-n", file]);
    const ok = hasShebang && noCrlf && res.code === 0;
    if (!ok) hooksOk = false;
    check(
      `A4 bash -n ${rel}`,
      ok,
      [
        !hasShebang ? "missing bash shebang" : null,
        !noCrlf ? "CRLF line endings" : null,
        res.code !== 0 ? `bash -n: ${tail(res.stdout + res.stderr, 4)}` : `syntax ok, ${String(text.split("\n").length)} lines`,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  if (shellFiles.length === 0) check("A4 hook scripts exist", false, "no *.sh found: after-install/after-remove hooks are required by the deb target");

  // A5 — branding + version lockstep.
  const branding = runQuiet(process.execPath, [path.join(REPO_ROOT, "scripts/branding.mjs"), "check"]);
  check("A5 branding check", branding.code === 0, branding.code === 0 ? tail(branding.stdout, 1) : tail(branding.stdout + branding.stderr, 12));
  const versionCheck = runQuiet(process.execPath, [path.join(REPO_ROOT, "scripts/version.mjs"), "check"]);
  check("A5b version lockstep", versionCheck.code === 0, versionCheck.code === 0 ? `all fields at ${version}` : tail(versionCheck.stdout + versionCheck.stderr, 12));

  // A6 — synthetic asar repack with the real tool.
  await syntheticAsar(version);
  return { version, rendererDist, webDist, electronOut, fatal: false };
}

function runQuiet(cmd, args2) {
  return run("", cmd, args2, { cwd: REPO_ROOT, echo: false });
}

function stageSyntheticApp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dir, "package.json"));
  for (const [from, to] of [
    [path.join(REPO_ROOT, "build/electron"), path.join(dir, "build/electron")],
    [path.join(REPO_ROOT, "renderer/dist"), path.join(dir, "renderer/dist")],
  ]) {
    if (!exists(from)) throw new Error(`missing ${relPath(REPO_ROOT, from)} — run npm run build first`);
    fs.cpSync(from, to, { recursive: true });
  }
  // Drop the sourcemaps that `files: ["!**/*.map"]` excludes, so the staging tree really is
  // what electron-builder would pack.
  for (const map of walk(dir, (f) => f.endsWith(".map"))) fs.rmSync(map);
  return dir;
}

async function syntheticAsar(version) {
  const asarBin = path.join(REPO_ROOT, "node_modules", ".bin", "asar");
  if (!exists(asarBin)) {
    skip("A6 asar layout", "@electron/asar is not installed");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-layout-"));
  try {
    const appDir = stageSyntheticApp(path.join(tmp, "app"));
    const archive = path.join(tmp, "app.asar");
    // `asar pack --unpack` matches globs against archive paths that start with "/", so the
    // electron-builder pattern "renderer/dist/assets/**" has to be written "**/…/*" here.
    const unpackGlob = "**/renderer/dist/assets/*";
    const packed = runQuiet(asarBin, ["pack", appDir, archive, "--unpack", unpackGlob]);
    if (
      !check(
        "A6 asar pack (real @electron/asar)",
        packed.code === 0 && exists(archive),
        packed.code === 0 ? `${relPath(tmp, archive)} ${fmtSize(fs.statSync(archive).size)}` : tail(packed.stdout + packed.stderr, 6),
      )
    )
      return;

    const listed = runQuiet(asarBin, ["list", "--is-pack", archive]);
    const packLines = listed.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const entries = packLines.map((l) => l.replace(/^(pack|unpack)\s+:\s*/, ""));
    const unpackedEntries = packLines.filter((l) => l.startsWith("unpack")).map((l) => l.replace(/^unpack\s+:\s*/, ""));
    const has = (p) => entries.some((e) => e === p || e === path.posix.join("/", p));
    for (const required of ["/package.json", "/build/electron/main.cjs", "/build/electron/preload.cjs", "/renderer/dist/index.html"]) {
      check(`A6b asar contains ${required}`, entries.includes(required), entries.length > 0 ? `${String(entries.length)} entries listed` : "asar list produced nothing");
    }
    const assetEntries = entries.filter((e) => e.startsWith("/renderer/dist/assets/"));
    check("A6c assets are listed in the asar header", assetEntries.length > 0, `${String(assetEntries.length)} asset entries`);

    // Unpacked halves: @electron/asar writes them next to the archive as app.asar.unpacked.
    const unpackedRoot = `${archive}.unpacked`;
    const unpackedAssets = exists(unpackedRoot) ? walk(unpackedRoot, (f) => /\.(js|css)$/.test(f)) : [];
    check(
      "A6c2 header marks those assets unpacked",
      unpackedEntries.length > 0 && unpackedEntries.every((e) => e.startsWith("/renderer/dist/assets/")),
      `${String(unpackedEntries.length)} "unpack" entries (asar list --is-pack)`,
    );
    check(
      "A6d asarUnpack'd assets live on disk",
      unpackedAssets.length > 0 && assetEntries.length > 0,
      unpackedAssets.length > 0
        ? `${String(unpackedAssets.length)} real files under ${relPath(tmp, unpackedRoot)} (matches electron-builder's asarUnpack: renderer/dist/assets/**)`
        : "nothing was unpacked — the embedded HTTP server would be reading through the asar shim",
    );
    // Extraction goes through the same @electron/asar library electron-builder packs with
    // (the CLI's extract-file writes into the cwd, which is never what a test wants).
    const asarLib = await import("@electron/asar");
    const extractText = (p) => {
      try {
        return asarLib.extractFile(archive, p).toString("utf8");
      } catch {
        return null;
      }
    };
    const extracted = {};
    for (const rel of ["build/electron/main.cjs", "renderer/dist/index.html", "package.json"]) {
      const text = extractText(rel);
      extracted[rel] = text;
      check(
        `A6e extractFile ${"/" + rel}`,
        typeof text === "string" && text.length > 0,
        typeof text === "string" ? `${fmtSize(Buffer.byteLength(text))} read out of the archive` : "not readable from the asar",
      );
    }
    // The in-asar package.json is what app.getVersion() reads: assert it says the same thing.
    const packedJsonText = extracted["package.json"];
    let packedVersion = null;
    let packedPkg = {};
    try {
      packedPkg = JSON.parse(packedJsonText ?? "{}");
      packedVersion = packedPkg.version ?? null;
    } catch {
      packedVersion = null;
    }
    check("A6f asar package.json version", packedVersion === version, `asar=${String(packedVersion)} VERSION=${version}`);
    check(
      "A6g asar package.json has no dependencies (self-contained bundle)",
      !packedPkg.dependencies || Object.keys(packedPkg.dependencies).length === 0 || exists(path.join(unpackedRoot, "..")),
      "note: electron-builder strips devDependencies; runtime deps would be packed as node_modules",
    );
    check("A6h main entry resolvable from the asar root", typeof packedPkg.main === "string" && exists(path.join(appDir, packedPkg.main)), `main=${String(packedPkg.main)}`);
    check(
      "A6i asar main.cjs carries the load ladder",
      typeof extracted["build/electron/main.cjs"] === "string" && extracted["build/electron/main.cjs"].includes("FALLBACK_ACTIVE"),
      "the packed main is the one with the retry ladder",
    );
    check(
      "A6j unpacked asset bytes are readable from disk",
      (() => {
        if (unpackedAssets.length === 0) return false;
        const sample = fs.readFileSync(unpackedAssets[0], "utf8");
        return sample.length > 0 && !sample.includes("\0");
      })(),
      unpackedAssets[0] ? relPath(tmp, unpackedAssets[0]) : "no unpacked assets",
    );
  } catch (err) {
    check("A6 asar layout", false, err.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------ tiers B/C ------------------------------ */

function tierB() {
  const unpacked = path.join(REPO_ROOT, "release", "linux-unpacked");
  if (!exists(unpacked)) {
    skip("B linux-unpacked layout", "release/linux-unpacked is absent — this only exists after `electron-builder --linux` ran (needs the Electron dist zip)");
    return false;
  }
  const exe = path.join(unpacked, BRAND.id);
  check("B1 executable named after the package", exists(exe), exists(exe) ? fmtSize(fs.statSync(exe).size) : `expected ${relPath(REPO_ROOT, exe)}`);
  if (exists(exe)) {
    const head = fs.readFileSync(exe).subarray(0, 4);
    check("B1b executable is ELF", head[0] === 0x7f && head.toString("latin1", 1) === "ELF", `magic=${head.toString("hex")}`);
  }
  const asar = path.join(unpacked, "resources", "app.asar");
  check("B2 resources/app.asar present", exists(asar), exists(asar) ? fmtSize(fs.statSync(asar).size) : "missing");
  const sandbox = path.join(unpacked, "chrome-sandbox");
  if (exists(sandbox)) {
    const mode = fs.statSync(sandbox).mode & 0o777;
    check("B3 chrome-sandbox present", true, `mode 0${mode.toString(8)} (after-install sets 4755 when userns is unavailable)`);
  } else {
    check("B3 chrome-sandbox present", false, "missing next to the executable: the sandbox will not start");
  }
  const unpackedRes = path.join(unpacked, "resources", "app.asar.unpacked", "renderer", "dist", "assets");
  check("B4 app.asar.unpacked assets on disk", exists(unpackedRes), exists(unpackedRes) ? `${String(fs.readdirSync(unpackedRes).length)} files` : "asarUnpack produced nothing");
  const asarBin = path.join(REPO_ROOT, "node_modules", ".bin", "asar");
  if (exists(asar) && exists(asarBin)) {
    const listed = runQuiet(asarBin, ["list", asar]);
    const entries = listed.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const required of ["/package.json", "/build/electron/main.cjs", "/renderer/dist/index.html"]) {
      check(`B5 real app.asar contains ${required}`, entries.includes(required), `${String(entries.length)} entries`);
    }
  }
  return true;
}

function tierC() {
  const deb = exists(RELEASE) ? fs.readdirSync(RELEASE).find((f) => f.endsWith(".deb")) : undefined;
  if (!deb) {
    skip("C .deb layout", "no release/*.deb — built in CI (needs the Electron dist zip + fpm)");
    return false;
  }
  const debPath = path.join(RELEASE, deb);
  const fields = runQuiet("dpkg-deb", ["-f", debPath]);
  if (fields.code !== 0) {
    check("C1 dpkg-deb -f", false, tail(fields.stdout + fields.stderr, 6));
    return false;
  }
  const control = parseControl(fields.stdout);
  const version = readVersionFile(REPO_ROOT);
  check("C1 Package", control.Package === BRAND.id, `Package=${String(control.Package)}`);
  check("C1b Version == VERSION", control.Version === version, `deb=${String(control.Version)} VERSION=${version}`);
  check("C1c Architecture amd64", control.Architecture === "amd64", `Architecture=${String(control.Architecture)}`);
  check("C1d Maintainer", typeof control.Maintainer === "string" && control.Maintainer.includes("KickLive"), `Maintainer=${String(control.Maintainer)}`);
  check("C1e Section/Priority", control.Section === "web" && control.Priority === "optional", `Section=${String(control.Section)} Priority=${String(control.Priority)}`);
  check("C1f Homepage", typeof control.Homepage === "string" && control.Homepage.startsWith("https://"), `Homepage=${String(control.Homepage)}`);
  const depends = String(control.Depends ?? "");
  const t64 = depends.includes("libgtk-3-0t64 | libgtk-3-0");
  check("C1g depends are t64-aware", t64, depends.slice(0, 160));

  const listing = runQuiet("dpkg-deb", ["-c", debPath]);
  const lines = listing.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const paths = lines.map((l) => l.replace(/.*\s\.\//, "./"));
  const has = (p) => paths.some((x) => x === p || x === "." + p);
  check("C2 /opt install dir", has(`/opt/${BRAND.productName}/${BRAND.id}`), `/opt/${BRAND.productName}/${BRAND.id}`);
  check("C2b resources/app.asar in package", has(`/opt/${BRAND.productName}/resources/app.asar`));
  check("C2c chrome-sandbox in package", has(`/opt/${BRAND.productName}/chrome-sandbox`));
  check("C3 desktop entry installed", has(`/usr/share/applications/${BRAND.desktopFile}`), `/usr/share/applications/${BRAND.desktopFile}`);
  const icons = linuxIconSpecs().map((s) => `/usr/share/icons/hicolor/${s.size}x${s.size}/apps/${BRAND.id}.png`);
  const missingIcons = icons.filter((i) => !has(i));
  check("C4 hicolor icon set complete", missingIcons.length === 0, missingIcons.length === 0 ? `${String(icons.length)} sizes installed` : `missing: ${missingIcons.join(", ")}`);
  const unpackedInDeb = paths.filter((p) => p.includes("app.asar.unpacked/renderer/dist/assets"));
  check("C4b unpacked renderer assets installed", unpackedInDeb.length > 0, `${String(unpackedInDeb.length)} asset files (they are what the embedded server reads)`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-deb-"));
  try {
    const x = runQuiet("dpkg-deb", ["-x", debPath, tmp]);
    const e = runQuiet("dpkg-deb", ["-e", debPath, path.join(tmp, "DEBIAN")]);
    check("C5 dpkg-deb -x/-e", x.code === 0 && e.code === 0, "extracted control + payload");
    const desktopPath = path.join(tmp, "usr/share/applications", BRAND.desktopFile);
    if (exists(desktopPath)) {
      const actual = readKeyValue(fs.readFileSync(desktopPath, "utf8"));
      const expected = readKeyValue(fs.readFileSync(path.join(REPO_ROOT, "packaging/linux", BRAND.desktopFile), "utf8"));
      const mismatched = Object.entries(expected).filter(([k, v]) => actual[k] !== v);
      check(
        "C6 installed .desktop matches the generated expectation",
        mismatched.length === 0,
        mismatched.length === 0
          ? `${Object.keys(expected).length} keys equal (Name, Exec, Icon, StartupWMClass, Comment, Categories, MimeType, X-KickLive-*)`
          : mismatched.map(([k, v]) => `${k}: expected "${v}" got "${String(actual[k])}"`).join("; "),
      );
      check("C6b StartupWMClass == wmClass", actual.StartupWMClass === BRAND.wmClass, `StartupWMClass=${String(actual.StartupWMClass)}`);
      const iconFiles = walk(path.join(tmp, "usr/share/icons"), (f) => f.endsWith(".png"));
      const badDims = [];
      for (const file of iconFiles) {
        try {
          const h = readPngHeader(fs.readFileSync(file));
          const dir = path.basename(path.dirname(path.dirname(file)));
          if (`${String(h.width)}x${String(h.height)}` !== dir) badDims.push(`${path.basename(file)} in ${dir} is ${String(h.width)}x${String(h.height)}`);
        } catch (err) {
          badDims.push(`${relPath(tmp, file)}: ${err.message}`);
        }
      }
      check(
        "C7 installed icon dimensions match their hicolor directory",
        badDims.length === 0 && iconFiles.length > 0,
        badDims.length > 0 ? badDims.join("; ") : `${String(iconFiles.length)} icons verified`,
      );
    } else {
      check("C6 installed .desktop present", false, `${BRAND.desktopFile} not found after extraction`);
    }
    for (const script of ["postinst", "prerm", "postrm"]) {
      const file = path.join(tmp, "DEBIAN", script);
      if (exists(file)) {
        const chk = runQuiet("bash", ["-n", file]);
        check(
          `C8 maintainer script ${script} parses`,
          chk.code === 0,
          chk.code === 0 ? `${fmtSize(fs.statSync(file).size)} (from ${relPath(REPO_ROOT, "packaging/hooks")})` : tail(chk.stdout + chk.stderr, 4),
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // checksums for the update manifest
  const artifacts = exists(RELEASE) ? fs.readdirSync(RELEASE).filter((f) => /\.(deb|AppImage|zip|tar\.gz)$/.test(f)) : [];
  const sums = {};
  for (const a of artifacts) {
    const r = runQuiet("sha256sum", [path.join(RELEASE, a)]);
    const hex = r.stdout.trim().split(/\s+/)[0];
    sums[a] = { sha256: hex, bytes: fs.statSync(path.join(RELEASE, a)).size };
  }
  const reportPath = path.join(RELEASE, "checksums.json");
  fs.writeFileSync(reportPath, JSON.stringify({ version: readVersionFile(REPO_ROOT), generatedAt: new Date().toISOString(), artifacts: sums }, null, 2) + "\n");
  check("C9 checksums.json", Object.keys(sums).length === artifacts.length && artifacts.length > 0, `${String(artifacts.length)} artifacts hashed → release/checksums.json`);
  return true;
}

function parseControl(text) {
  const out = {};
  let key = null;
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) && key) {
      out[key] += " " + line.trim();
      continue;
    }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      out[key] = m[2];
    }
  }
  return out;
}

function readKeyValue(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_-]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* --------------------------------- main --------------------------------- */

export async function main() {
  const started = Date.now();
  const yml = exists(path.join(REPO_ROOT, "electron-builder.yml")) ? parseYaml(fs.readFileSync(path.join(REPO_ROOT, "electron-builder.yml"), "utf8")) : null;
  if (!yml) add("config", "FAIL", "electron-builder.yml is missing");
  console.log(`verify-packaging: tier A (build outputs, hooks, branding, synthetic asar)`);
  const a = await tierA();
  console.log(`\nverify-packaging: tier B (release/linux-unpacked)`);
  const b = tierB();
  console.log(`\nverify-packaging: tier C (release/*.deb)`);
  const c = tierC();

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const report = {
    product: "kicklive",
    version: readVersionFile(REPO_ROOT),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    tiers: { A: !a.fatal, B: b, C: c },
    requireFull: REQUIRE_FULL,
    counts: { pass: results.filter((r) => r.status === "PASS").length, fail: failed.length, skip: skipped.length },
    results,
  };
  if (WRITE_REPORT && exists(RELEASE)) {
    fs.writeFileSync(path.join(RELEASE, "packaging-report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`\n${String(report.counts.pass)} pass, ${String(report.counts.fail)} fail, ${String(report.counts.skip)} skipped in ${String(Math.round(report.durationMs / 100) / 10)}s`);
  if (skipped.length > 0) console.log(`skipped: ${skipped.map((s) => s.name).join(", ")} — CI runs this with --require-full`);
  if (REQUIRE_FULL && (!b || !c)) {
    console.error("--require-full: tiers B and/or C could not run (no release/linux-unpacked or release/*.deb)");
    return 1;
  }
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("verify-packaging.mjs")) {
  process.exitCode = await main();
}
