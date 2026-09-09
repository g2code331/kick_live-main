#!/usr/bin/env node
/**
 * The branding / packaging-identity verifier (docs/RELEASE-PIPELINE.md §3.5 of the plan).
 *
 *   node scripts/branding.mjs check            # CI gate: fail on any drift
 *   node scripts/branding.mjs write            # regenerate everything this script owns
 *   node scripts/branding.mjs check --json     # machine-readable output for the gate report
 *
 * `write` only produces files that are *derived* (packaging/linux/kicklive.desktop,
 * public/site.webmanifest, packaging/icons/*.png, public/web-app-manifest-*.png when --force-icons
 * is passed). It never rewrites artwork it did not create, and never touches src/.
 *
 * Everything it asserts comes from shared/branding.ts, so "the name in the window manager" and
 * "the name in the .deb control file" cannot disagree without CI going red.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

import { BRAND, linuxIconSpecs, renderDesktopFile, renderWebManifest, hicolorPath, pwaIconSpecs } from "../shared/branding.ts";
import { REPO_ROOT, readVersionFile, walk } from "../tools/vite-shared.ts";
import { checkVersions } from "./version.mjs";
import { padToSquare, pngDimensions, encodePng, decodePng, resize } from "./lib/png.mjs";

const ICON_SIZES = BRAND.iconSizes;

class Findings {
  constructor() {
    this.items = [];
  }
  error(code, message) {
    this.items.push({ level: "error", code, message });
  }
  warn(code, message) {
    this.items.push({ level: "warn", code, message });
  }
  get errors() {
    return this.items.filter((i) => i.level === "error");
  }
  get warnings() {
    return this.items.filter((i) => i.level === "warn");
  }
}

function read(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function same(root, rel, expected) {
  const actual = read(root, rel);
  if (actual === null) return { ok: false, why: "missing file" };
  if (actual.replace(/\r\n/g, "\n") === expected) return { ok: true };
  return { ok: false, why: "content differs from the generator output" };
}

/* ---------------------------- individual checks ---------------------------- */

function checkPackageJson(root, f) {
  const raw = read(root, "package.json");
  if (raw === null) {
    f.error("package.json", "missing");
    return {};
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    f.error("package.json", `unparseable: ${err.message}`);
    return {};
  }
  if (pkg.name !== BRAND.id) f.error("package.json.name", `expected "${BRAND.id}", got "${String(pkg.name)}"`);
  if (pkg.productName !== BRAND.productName) f.error("package.json.productName", `expected "${BRAND.productName}", got "${String(pkg.productName)}"`);
  if (pkg.desktopName !== BRAND.desktopFile) f.error("package.json.desktopName", `expected "${BRAND.desktopFile}" (drives WM_CLASS + StartupWMClass), got "${String(pkg.desktopName)}"`);
  if (pkg.main !== "build/electron/main.cjs") f.error("package.json.main", `expected "build/electron/main.cjs", got "${String(pkg.main)}"`);
  if (pkg.private !== true) f.warn("package.json.private", "should stay private:true so nothing is published to npm by accident");
  for (const forbidden of BRAND.forbiddenNames) {
    if (JSON.stringify([pkg.name, pkg.productName, pkg.description, pkg.displayName]).includes(forbidden)) f.error("package.json.forbidden-name", `contains scaffold/legacy name "${forbidden}"`);
  }
  return pkg;
}

function checkIndexHtml(root, f) {
  const html = read(root, "index.html");
  if (html === null) {
    f.error("index.html", "missing");
    return;
  }
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  if (!title.startsWith(BRAND.displayName)) f.error("index.html.title", `title must start with "${BRAND.displayName}", got "${title}"`);
  if (/<meta name="theme-color" content="([^"]+)"/i.test(html) === false) f.error("index.html.theme-color", "missing theme-color meta");
  else {
    const theme = /<meta name="theme-color" content="([^"]+)"/i.exec(html)[1];
    if (theme.toLowerCase() !== BRAND.colors.bg.toLowerCase()) f.error("index.html.theme-color", `expected ${BRAND.colors.bg}, got ${theme}`);
  }
  for (const meta of ["kicklive:version", "kicklive:shell"]) {
    if (!new RegExp(`<meta name="${meta}"`).test(html)) f.error("index.html.meta", `missing <meta name="${meta}">`);
  }
  if (!/rel="manifest"/.test(html)) f.error("index.html.manifest", "no <link rel=manifest> — the PWA is not installable");
  // Absolute asset URLs break under file:// (the desktop shell's primary load path).
  const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  if (absolute.length > 0) {
    const bad = absolute.filter((u) => !u.startsWith("/src/"));
    if (bad.length > 0) f.error("index.html.absolute-asset", `absolute asset URLs break the desktop file:// load: ${bad.join(", ")}`);
  }
  for (const forbidden of BRAND.forbiddenNames) {
    if (html.includes(forbidden)) f.error("index.html.forbidden-name", `contains "${forbidden}"`);
  }
}

function checkSourceRefs(root, f) {
  const offenders = [];
  for (const file of walk(path.join(root, "src"), (p) => /\.(tsx?|css)$/.test(p))) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    const absolute = [...text.matchAll(/(?:src|href)="(\/[^"]+\.(?:png|jpe?g|svg|webp|gif|ico|woff2?))"/g)].map((m) => m[1]);
    if (absolute.length > 0) offenders.push(`${rel}: ${absolute.join(", ")}`);
    for (const forbidden of BRAND.forbiddenNames) {
      if (text.includes(forbidden)) f.error("src.forbidden-name", `${rel} contains "${forbidden}"`);
    }
  }
  if (offenders.length > 0) f.error("src.absolute-asset", `absolute asset URLs resolve to the filesystem root under file://; use assetUrl("name") — ${offenders.join(" | ")}`);
}

function readPngSize(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return pngDimensions(abs, fs);
}

function checkPublicAssets(root, f) {
  for (const file of walk(path.join(root, "public"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const base = path.basename(rel);
    if (/\.(png|jpe?g|gif|webp|svg)\.(png|jpe?g|gif|webp|svg)$/i.test(base)) f.error("public.double-extension", `${rel} — mis-named asset; nothing should ship "foo.png.png"`);
    const bytes = fs.statSync(file).size;
    if (bytes > 1024 * 1024) f.warn("public.heavy-asset", `${rel} is ${(bytes / 1024 / 1024).toFixed(2)} MiB and is served on first paint`);
  }
  const icon = readPngSize(root, BRAND.masterIcon);
  if (!icon) f.error("branding.master-icon", `${BRAND.masterIcon} is missing`);
  else if (!icon.ok) f.error("branding.master-icon", `${BRAND.masterIcon}: ${icon.error}`);
  else if (icon.width !== icon.height) f.error("branding.master-icon", `${BRAND.masterIcon} must be square (got ${String(icon.width)}x${String(icon.height)})`);
  else if (icon.width < 512) f.error("branding.master-icon", `${BRAND.masterIcon} must be >= 512px square (got ${String(icon.width)})`);
}

function checkWebManifest(root, f, version) {
  const raw = read(root, "public/site.webmanifest");
  if (raw === null) {
    f.error("site.webmanifest", "missing (npm run branding:write)");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    f.error("site.webmanifest", `unparseable: ${err.message}`);
    return;
  }
  const expect = JSON.parse(renderWebManifest(version));
  for (const key of ["name", "short_name", "start_url", "scope", "display", "theme_color", "background_color", "id"]) {
    if (manifest[key] !== expect[key]) f.error(`site.webmanifest.${key}`, `expected ${JSON.stringify(expect[key])}, got ${JSON.stringify(manifest[key])}`);
  }
  if (manifest.version !== version) f.error("site.webmanifest.version", `expected ${version}, got ${JSON.stringify(manifest.version)}`);
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (icons.length === 0) f.error("site.webmanifest.icons", "no icons");
  const sizes = new Set();
  for (const icon of icons) {
    const rel = `public${icon.src.startsWith("/") ? icon.src : "/" + icon.src}`.replace(/\/\//g, "/");
    const dim = readPngSize(root, path.relative(root, path.join(root, rel)));
    if (!dim) {
      f.error("site.webmanifest.icon-missing", `${icon.src} does not exist in public/`);
      continue;
    }
    if (!dim.ok) {
      f.error("site.webmanifest.icon-unreadable", `${icon.src}: ${dim.error}`);
      continue;
    }
    const declared = String(icon.sizes ?? "");
    const m = /^(\d+)x(\d+)$/.exec(declared);
    if (!m) {
      f.error("site.webmanifest.icon-sizes", `${icon.src} has a non-numeric sizes field "${declared}"`);
      continue;
    }
    if (Number(m[1]) !== dim.width || Number(m[2]) !== dim.height)
      f.error("site.webmanifest.icon-dims", `${icon.src} declares ${declared} but is ${String(dim.width)}x${String(dim.height)} (a wrong sizes field makes Android skip the icon)`);
    if (icon.type && icon.type !== "image/png") f.warn("site.webmanifest.icon-type", `${icon.src} declares ${icon.type}`);
    sizes.add(`${declared}/${String(icon.purpose ?? "any")}`);
  }
  for (const required of ["192x192/any", "512x512/any", "192x192/maskable", "512x512/maskable"]) {
    if (!sizes.has(required)) f.error("site.webmanifest.icon-coverage", `missing ${required} (installability criteria want 192+512, any+maskable)`);
  }
  const spec = pwaIconSpecs();
  if (spec.length === 0) f.warn("branding.pwa-icons", "pwaIconSpecs() is empty");
}

function checkDesktopFile(root, f, version) {
  const rel = "packaging/linux/kicklive.desktop";
  const expected = renderDesktopFile(version);
  const res = same(root, rel, expected);
  if (!res.ok) f.error("desktop-file", `${rel} ${res.why}; run "npm run branding:write". Got:\n${(read(root, rel) ?? "").trim()}`);
  const text = read(root, rel) ?? "";
  for (const [key, value] of [
    ["Name", BRAND.desktopEntryName],
    ["StartupWMClass", BRAND.wmClass],
    ["Icon", BRAND.id],
    ["Terminal", "false"],
    ["Type", "Application"],
  ]) {
    const line = new RegExp(`^${key}=(.*)$`, "m").exec(text);
    if (!line) f.error(`desktop-file.${key}`, "missing key");
    else if (line[1] !== value) f.error(`desktop-file.${key}`, `expected "${value}", got "${line[1]}"`);
  }
  if (!text.includes(`Exec=${BRAND.installDir}/${BRAND.id} %U`)) f.error("desktop-file.Exec", `Exec must be "${BRAND.installDir}/${BRAND.id} %U" (electron-builder writes the absolute install path)`);
}

function checkElectronBuilder(root, f) {
  const raw = read(root, "electron-builder.yml");
  if (raw === null) {
    f.error("electron-builder.yml", "missing");
    return;
  }
  let config;
  try {
    config = parseYaml(raw);
  } catch (err) {
    f.error("electron-builder.yml", `unparseable YAML: ${err.message}`);
    return;
  }
  const linux = config.linux ?? {};
  const deb = config.deb ?? {};
  if (config.productName !== BRAND.productName) f.error("builder.productName", `expected ${BRAND.productName}`);
  if (config.appId !== BRAND.appUserModelId) f.error("builder.appId", `expected ${BRAND.appUserModelId}, got ${String(config.appId)}`);
  if (linux.executableName !== BRAND.id) f.error("builder.linux.executableName", `expected ${BRAND.id}, got ${String(linux.executableName)}`);
  if (linux.category !== BRAND.linuxCategory) f.error("builder.linux.category", `expected "${BRAND.linuxCategory}", got ${String(linux.category)}`);
  if (linux.description !== BRAND.linuxDescription) f.error("builder.linux.description", "must equal BRAND.linuxDescription (it becomes the .desktop Comment=)");
  if (linux.syncDesktopName !== true) f.error("builder.linux.syncDesktopName", "must be true so the installed launcher matches desktopName");
  if (deb.packageName !== BRAND.id) f.error("builder.deb.packageName", `expected ${BRAND.id}, got ${String(deb.packageName)}`);
  if (config.asar !== true) f.error("builder.asar", "asar must be true");
  const unpack = config.asarUnpack ?? [];
  if (!unpack.includes("renderer/dist/assets/**")) f.error("builder.asarUnpack", "renderer/dist/assets/** must be unpacked (the embedded HTTP server stats/streams those files from disk)");
  const files = (config.files ?? []).map(String);
  if (!files.some((f2) => f2.startsWith("renderer/dist"))) f.error("builder.files", "renderer/dist/** must be in `files` (that is the path main loads)");
  if (!files.includes("package.json")) f.warn("builder.files", "package.json normally ships in the asar (app.getVersion() reads it)");
  const entry = linux.desktop?.entry ?? {};
  for (const key of ["StartupNotify", "X-KickLive-Version", "X-KickLive-Feed"]) {
    if (!(key in entry)) f.error(`builder.desktop.entry.${key}`, "the .desktop expectation declares this key, so the packager must emit it");
  }
  if (entry["X-KickLive-Version"] !== "${version}") f.error("builder.desktop.entry.X-KickLive-Version", `expected the "${"${version}"}" macro`);
  // depends must be t64-aware, or the deb is uninstallable on Ubuntu 24.04.
  const depends = (deb.depends ?? []).join(" ");
  for (const pkg of ["libgtk-3-0t64 | libgtk-3-0", "libasound2t64 | libasound2", "libnotify4", "libnss3", "xdg-utils"]) {
    if (!depends.includes(pkg)) f.error("builder.deb.depends", `missing "${pkg}" — the deb would be uninstallable on some supported distros`);
  }
  if (/(^|[^0-9a-z])libappindicator3-1/.test(depends)) f.warn("builder.deb.depends", "libappindicator3-1 is gone from recent Debian/Ubuntu");
  const iconDir = String(linux.icon ?? "");
  if (!iconDir) f.error("builder.linux.icon", "must point at the generated icon dir");
  else {
    const abs = path.join(root, iconDir);
    for (const spec of linuxIconSpecs()) {
      const file = path.join(abs, spec.file);
      if (!fs.existsSync(file)) {
        f.error("icons.missing", `${iconDir}/${spec.file} is missing; run "npm run branding:write"`);
        continue;
      }
      const dim = pngDimensions(file, fs);
      if (!dim.ok) f.error("icons.unreadable", `${spec.file}: ${dim.error}`);
      else if (dim.width !== spec.size || dim.height !== spec.size)
        f.error("icons.size", `${iconDir}/${spec.file} is ${String(dim.width)}x${String(dim.height)}, expected ${String(spec.size)}x${String(spec.size)}`);
    }
    if (Array.isArray(config.extraResources)) {
      for (const r of config.extraResources) f.warn("builder.extraResources", `extra resource ${JSON.stringify(r)} duplicates what the deb layout already provides`);
    }
  }
  const sizes = linuxIconSpecs().map((s) => s.size);
  if (!sizes.includes(512)) f.error("branding.iconSizes", "512x512 is required by the Play Store-like installers and hicolor");
  for (const size of sizes) {
    const p = hicolorPath(size);
    if (!p.includes(`${String(size)}x${String(size)}`)) f.error("branding.hicolorPath", `unexpected path ${p}`);
  }
}

/* ------------------------------- write mode ------------------------------- */

function generateIcons(root, { force }) {
  const written = [];
  const skipped = [];
  const masterAbs = path.join(root, BRAND.masterIcon);
  let decoded = null;
  try {
    decoded = decodePng(fs.readFileSync(masterAbs));
  } catch (err) {
    return { written, skipped: [{ file: BRAND.masterIcon, why: `cannot decode master (${err.message})` }] };
  }

  const iconDir = path.join(root, "packaging/icons");
  fs.mkdirSync(iconDir, { recursive: true });
  for (const spec of linuxIconSpecs()) {
    const target = path.join(iconDir, spec.file);
    const img = resize(decoded, spec.size, spec.size);
    fs.writeFileSync(target, encodePng(img));
    written.push(path.relative(root, target).split(path.sep).join("/"));
  }

  const pwaTargets = [
    { file: "web-app-manifest-192x192.png", size: 192, maskable: false },
    { file: "web-app-manifest-512x512.png", size: 512, maskable: false },
    { file: "web-app-manifest-192x192-any.png", size: 192, maskable: true },
    { file: "web-app-manifest-512x512-any.png", size: 512, maskable: true },
    { file: "favicon-96x96.png", size: 96, maskable: false },
    { file: "apple-touch-icon.png", size: 180, maskable: false },
  ];
  for (const t of pwaTargets) {
    const abs = path.join(root, "public", t.file);
    const exists = fs.existsSync(abs);
    if (exists && !force) {
      skipped.push({ file: `public/${t.file}`, why: "exists (pass --force-icons to regenerate from the master)" });
      continue;
    }
    const bg = [11, 14, 19];
    const img = t.maskable ? padToSquare(decoded, t.size, bg) : resize(decoded, t.size, t.size);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, encodePng(img));
    written.push(`public/${t.file}`);
  }
  return { written, skipped };
}

function generateTextSurfaces(root, version) {
  const files = {
    "public/site.webmanifest": renderWebManifest(version),
    "packaging/linux/kicklive.desktop": renderDesktopFile(version),
  };
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return Object.keys(files);
}

/* ---------------------------------- main ---------------------------------- */

export async function main(argv = process.argv.slice(2)) {
  const root = REPO_ROOT;
  const mode = argv[0] === "write" ? "write" : "check";
  const asJson = argv.includes("--json");
  const force = argv.includes("--force-icons");
  const version = readVersionFile(root);
  const f = new Findings();

  if (mode === "write") {
    const textFiles = generateTextSurfaces(root, version);
    const icons = generateIcons(root, { force });
    console.log(`branding: write (VERSION=${version}, master=${BRAND.masterIcon})`);
    for (const file of textFiles) console.log(`  wrote ${file}`);
    for (const file of icons.written) console.log(`  wrote ${file}`);
    for (const s of icons.skipped) console.log(`  kept  ${s.file} — ${s.why}`);
    // Re-check immediately: write mode must leave the tree in a state that passes check mode.
    const after = runChecks(root, version);
    if (after.errors.length > 0) {
      console.error("branding: write finished but check still fails:");
      for (const item of after.errors) console.error(`  ERROR ${item.code}: ${item.message}`);
      return 1;
    }
    console.log(`branding: write OK (check now passes; ${String(after.warnings.length)} warning(s))`);
    return 0;
  }

  const findings = runChecks(root, version);
  if (asJson) {
    console.log(JSON.stringify({ ok: findings.errors.length === 0, version, items: findings.items }, null, 2));
  } else {
    console.log(`branding: check (VERSION=${version}, product=${BRAND.productName})`);
    for (const item of findings.items) console.log(`  ${item.level === "error" ? "ERROR" : "WARN "} ${item.code}: ${item.message}`);
    if (findings.errors.length === 0) console.log(`  all ${String(CHECK_COUNT)} branding assertions passed${findings.warnings.length ? ` (${String(findings.warnings.length)} warning(s))` : ""}`);
    else console.log(`  ${String(findings.errors.length)} error(s), ${String(findings.warnings.length)} warning(s)`);
  }
  return findings.errors.length === 0 ? 0 : 1;
}

const CHECK_COUNT = 7;

function runChecks(root, version) {
  const f = new Findings();
  checkPackageJson(root, f);
  checkIndexHtml(root, f);
  checkSourceRefs(root, f);
  checkPublicAssets(root, f);
  checkWebManifest(root, f, version);
  checkDesktopFile(root, f, version);
  checkElectronBuilder(root, f);
  for (const p of checkVersions(root).problems) f.error(`version.${p.code}`, p.message);
  return f;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("branding.mjs")) {
  process.exitCode = await main();
}
