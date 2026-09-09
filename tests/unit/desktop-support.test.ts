/**
 * The desktop support modules: settings persistence, logging, renderer path resolution, the
 * diagnostic page and the smoke probe's judgement function. These are the parts of main.ts that can
 * be tested without an Electron runtime — which matters because the sandbox that develops this
 * pipeline has no display server.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SettingsFile, createMemoryStorage, createSettingsStorage, defaultSettings } from "../../desktop/src/settings-store.ts";
import { createLogger } from "../../desktop/src/log.ts";
import { describeRoots, rendererIndexPath, resolveRendererRoot } from "../../desktop/src/renderer-paths.ts";
import { ERROR_PAGE_CSP, errorPageDataUrl, renderErrorPage } from "../../desktop/src/error-page.ts";
import { SMOKE_PROBE, formatSmokeLines, judgeProbe, parseSmokeLine } from "../../desktop/src/smoke.ts";
import { BRAND, renderDesktopFile } from "../../shared/branding.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-desktop-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const todaysLog = (userDataDir: string): string => path.join(userDataDir, "logs", `main-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);

describe("SettingsFile", () => {
  it("starts from defaults when the file is absent", () => {
    const file = new SettingsFile(dir);
    assert.deepEqual(file.read(), defaultSettings("stable"));
    assert.equal(file.read().updates.schemaVersion, 1);
  });

  it("writes atomically with 0600", () => {
    const file = new SettingsFile(dir);
    file.write({ ...defaultSettings("beta"), autoCheck: false });
    assert.equal(fs.statSync(file.file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${file.file}.tmp`), false, "the temp file must be renamed away");
    assert.equal(JSON.parse(fs.readFileSync(file.file, "utf8")).channel, "beta");
  });

  it("a corrupt file is preserved for inspection and defaults take over", () => {
    const file = new SettingsFile(dir);
    fs.writeFileSync(file.file, "{ this is not json");
    assert.deepEqual(file.read(), defaultSettings("stable"), "the app must still start");
    const kept = fs.readdirSync(dir).filter((f) => f.includes("corrupt-"));
    assert.equal(kept.length, 1, "the evidence is renamed, not deleted");
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "{ this is not json");
  });

  it("bad enum values are normalised; a corrupt snooze table is reset", () => {
    const file = new SettingsFile(dir);
    fs.writeFileSync(file.file, JSON.stringify({ channel: "nightly", autoCheck: "yes", schemaVersion: 99, updates: { snoozedUntil: "not-a-map" } }));
    const s = file.read();
    assert.equal(s.channel, "stable");
    assert.equal(s.autoCheck, true, "only an explicit false disables auto-check");
    assert.equal(s.schemaVersion, 1, "the file is never trusted with its own schema version");
    assert.deepEqual(s.updates.snoozedUntil, {}, "spreading a string would have produced {0:'n',1:'o',...}");
  });

  it("drops snooze entries that are not timestamps", () => {
    const file = new SettingsFile(dir);
    fs.writeFileSync(file.file, JSON.stringify({ updates: { snoozedUntil: { "1.1.0": "tomorrow", "1.2.0": "2026-12-31T00:00:00Z", "1.3.0": 42 } } }));
    assert.deepEqual(file.read().updates.snoozedUntil, { "1.2.0": "2026-12-31T00:00:00.000Z" });
  });

  it("refuses an unsafe file name (it is joined onto a directory)", () => {
    assert.throws(() => new SettingsFile(dir, "../escape.json"), /unsafe settings file name/);
    assert.throws(() => new SettingsFile(dir, "a/b.json"), /unsafe settings file name/);
  });

  it("round-trips the update store through the UpdateStorage adapter", async () => {
    const storage = createSettingsStorage(new SettingsFile(dir));
    assert.deepEqual((await storage.load())?.snoozedUntil, {});
    await storage.save({ ...defaultSettings().updates, snoozedUntil: { "1.1.0": "2026-09-09T12:00:00.000Z" }, lastSeen: { version: "1.1.0", at: "x", channel: "beta" } });
    const reread = await createSettingsStorage(new SettingsFile(dir)).load();
    assert.deepEqual(reread?.snoozedUntil, { "1.1.0": "2026-09-09T12:00:00.000Z" });
    assert.equal(reread?.lastSeen?.channel, "beta");
  });

  it("memory storage copies the snooze table on save (no aliasing surprises)", async () => {
    const storage = createMemoryStorage();
    const store = (await storage.load())!;
    store.snoozedUntil["1.2.0"] = "2026-01-01T00:00:00.000Z";
    await storage.save(store);
    assert.deepEqual(storage.current().snoozedUntil, { "1.2.0": "2026-01-01T00:00:00.000Z" });
  });
});

describe("logger", () => {
  it("stamps each line and writes it next to userData", () => {
    const logger = createLogger({ userDataDir: dir, quiet: true });
    logger.line("[kicklive:renderer] LOADED source=file:///x attempt=1/7");
    const written = fs.readFileSync(todaysLog(dir), "utf8");
    assert.match(written, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[kicklive:renderer\] LOADED source=file:\/\/\/x attempt=1\/7\n$/);
    assert.equal(logger.logFile, todaysLog(dir));
  });

  it("appends across instances (a restart must not truncate the diagnosis)", () => {
    createLogger({ userDataDir: dir, quiet: true }).line("first");
    createLogger({ userDataDir: dir, quiet: true }).line("second");
    const lines = fs
      .readFileSync(todaysLog(dir), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.replace(/^\S+ /, ""));
    assert.deepEqual(lines, ["first", "second"]);
  });

  it("echoes to stderr by default (that is what xvfb-run captures in CI)", () => {
    const echoed: string[] = [];
    createLogger({ quiet: false, echo: (t) => echoed.push(t) }).line("[kicklive:updates] CHECKED reason=startup");
    assert.equal(echoed.length, 1);
    assert.match(echoed[0], /\[kicklive:updates\] CHECKED reason=startup$/);
  });

  it("an unwritable log dir degrades to no-op instead of killing the app", () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const logger = createLogger({ userDataDir: blocked, quiet: true });
    assert.equal(logger.logFile, null);
    assert.doesNotThrow(() => logger.line("still alive"));
    assert.doesNotThrow(() => logger.flushSync());
  });

  it("no userDataDir means stderr only (what KICKLIVE_LOG_FILE=0 selects)", () => {
    const logger = createLogger({ quiet: true });
    assert.equal(logger.logFile, null);
    logger.line("nothing");
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe("renderer path resolution", () => {
  it("packaged layout resolves inside the asar and says so", () => {
    const appDir = path.join(dir, "resources", "app.asar", "renderer", "dist");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<html></html>");
    const roots = resolveRendererRoot({ appPath: path.join(dir, "resources", "app.asar"), isPackaged: true });
    assert.equal(roots.root, appDir);
    assert.equal(rendererIndexPath(roots), path.join(appDir, "index.html"));
    assert.equal(roots.packed, true, "the fallback server needs to know it is reading through an asar");
    assert.match(describeRoots(roots), /root=.* index=.* packed=true/);
  });

  it("dev layout finds the checkout's renderer/dist", () => {
    const appDir = path.join(dir, "checkout", "renderer", "dist");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<html></html>");
    const roots = resolveRendererRoot({ appPath: path.join(dir, "checkout"), isPackaged: false });
    assert.equal(roots.root, appDir);
    assert.equal(roots.packed, false);
  });

  it("an override wins when it actually contains index.html", () => {
    const override = path.join(dir, "elsewhere");
    fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(path.join(override, "index.html"), "<html></html>");
    const roots = resolveRendererRoot({ appPath: path.join(dir, "missing"), isPackaged: true, override });
    assert.equal(roots.root, override);
  });

  it("a packaged install with a missing renderer still returns the expected path (that is what the ladder must survive)", () => {
    const asar = path.join(dir, "resources", "app.asar");
    const roots = resolveRendererRoot({ appPath: asar, isPackaged: true });
    assert.match(roots.indexHtml, /app\.asar\/renderer\/dist\/index\.html$/);
    assert.equal(fs.existsSync(roots.indexHtml), false, "the file is genuinely absent: loadFile() will fail and the plan must fall back");
  });

  it("an override that does not exist is ignored rather than trusted", () => {
    const appPath = path.join(dir, "app");
    const expected = path.join(appPath, "renderer", "dist");
    fs.mkdirSync(expected, { recursive: true });
    fs.writeFileSync(path.join(expected, "index.html"), "<html></html>");
    const roots = resolveRendererRoot({ appPath, isPackaged: true, override: path.join(dir, "does-not-exist") });
    assert.equal(roots.root, expected, "falls through to the next candidate instead of loading a void");
  });

  it("a packaged app never picks its UI up from the launch directory", () => {
    // cwd is the classic confusion: launching the .deb from a checkout would otherwise render the
    // checkout instead of the installed asar.
    const roots = resolveRendererRoot({ appPath: path.join(dir, "empty-app"), isPackaged: true });
    assert.ok(!roots.root.startsWith(process.cwd()), `packaged resolution must not use cwd, got ${roots.root}`);
  });
});

describe("diagnostic error page", () => {
  const input = {
    version: "1.0.0",
    attempts: 4,
    totalAttempts: 7,
    lastError: 'ERR_FILE_NOT_FOUND "renderer/dist/index.html"',
    rendererRoot: "/opt/KickLive/resources/app.asar/renderer/dist",
    indexHtml: "/opt/KickLive/resources/app.asar/renderer/dist/index.html",
    httpOrigin: "http://127.0.0.1:4123",
    logFile: "/home/u/.config/kicklive/logs/main-20260909.log",
    platform: "linux x64",
  };

  it("shows the attempts, the roots and how to fix it", () => {
    const html = renderErrorPage(input);
    assert.match(html, /Renderer <span class="accent">failed to load<\/span>/);
    assert.match(html, /4 of 7/);
    assert.match(html, /ERR_FILE_NOT_FOUND/);
    assert.match(html, /127\.0\.0\.1:4123/);
    assert.match(html, /main-20260909\.log/);
    assert.match(html, /KICKLIVE_RENDERER_ROOT/, "the escape hatch belongs on the page itself");
    assert.match(html, new RegExp(`data-kicklive="renderer-error" data-attempts="4"`));
  });

  it("declares its own CSP and contains no script at all", () => {
    const html = renderErrorPage(input);
    assert.match(html, new RegExp(`<meta http-equiv="Content-Security-Policy" content="${ERROR_PAGE_CSP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" />`));
    assert.match(ERROR_PAGE_CSP, /default-src 'none'/);
    assert.ok(!html.toLowerCase().includes("<script"), "the diagnostic page must never execute code");
    assert.ok(!html.includes("onclick"), "no inline handlers: they would be blocked by the CSP anyway");
  });

  it("escapes hostile manifest/feed text", () => {
    const html = renderErrorPage({ ...input, lastError: '<img src=x onerror="alert(1)">' });
    assert.ok(!html.includes('<img src=x onerror="alert(1)">'), "raw markup must be escaped");
    assert.match(html, /&lt;img src=x onerror=/);
  });

  it("is delivered as a data: url (no temp file, no privileged write)", () => {
    const url = errorPageDataUrl(input);
    assert.match(url, /^data:text\/html;charset=utf-8,/);
    assert.ok(url.length < 200_000);
    assert.ok(decodeURIComponent(url).includes("renderer-error"));
  });
});

describe("smoke probe", () => {
  it("the injected probe reads title, #root children and the stamped version", () => {
    assert.match(SMOKE_PROBE, /document\.title/);
    assert.match(SMOKE_PROBE, /getElementById\(["']root["']\)/);
    assert.match(SMOKE_PROBE, /kicklive:version/);
    assert.match(SMOKE_PROBE, /childElementCount/);
  });

  it("formatSmokeLines emits key=value pairs, skipping undefined", () => {
    assert.deepEqual(formatSmokeLines({ event: "SMOKE_DOM", title: "KickLive", rootChildren: 3, missing: undefined }), ['event="SMOKE_DOM"', 'title="KickLive"', "rootChildren=3"]);
  });

  const probe = (over: Partial<{ title: string; rootChildren: number; rootHtmlLength: number; version: string }> = {}) => ({
    title: "KickLive — live KickLive scores",
    rootChildren: 2,
    rootHtmlLength: 4096,
    version: "1.0.0",
    shell: "desktop",
    bodyChildren: 2,
    scripts: ["./assets/index-abc.js"],
    url: "file:///opt/KickLive/resources/app.asar/renderer/dist/index.html",
    href: "file:///opt/KickLive/resources/app.asar/renderer/dist/icons/favicon.svg",
    iconComplete: true,
    ...over,
  });

  it("a mounted DOM passes", () => {
    const verdict = judgeProbe(probe(), { version: "1.0.0" });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.lines[0], /SMOKE_DOM title="KickLive — live KickLive scores" rootChildren=2 rootHtmlLength=4096 version=1\.0\.0/);
    assert.deepEqual(verdict.lines[1], "SMOKE_RESULT ok");
  });

  it("an empty #root fails with a reason (the window can commit a blank document)", () => {
    const verdict = judgeProbe(probe({ rootChildren: 0, rootHtmlLength: 0 }), { version: "1.0.0" });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.exitCode, 3);
    assert.match(verdict.lines.at(-1)!, /SMOKE_RESULT failed reason=.*root has 0 children/);
  });

  it("a stale bundle (old version meta) fails: that is how we catch a half-updated install", () => {
    const verdict = judgeProbe(probe({ version: "0.9.0" }), { version: "1.0.0" });
    assert.equal(verdict.ok, false);
    assert.match(verdict.lines.at(-1)!, /version 0\.9\.0 != 1\.0\.0/);
  });

  it("a title without the brand fails (a captive-portal-ish page must not pass)", () => {
    assert.equal(judgeProbe(probe({ title: "Sign in" }), { version: "1.0.0" }).ok, false);
  });

  it("minRootChildren is configurable for pages that legitimately mount one node", () => {
    assert.equal(judgeProbe(probe({ rootChildren: 1, rootHtmlLength: 4096 }), { version: "1.0.0", minRootChildren: 1 }).ok, true);
    assert.equal(judgeProbe(probe({ rootChildren: 1, rootHtmlLength: 4096 }), { version: "1.0.0", minRootChildren: 2 }).ok, false);
  });

  it("parseSmokeLine round-trips the log format the CI gate greps", () => {
    const verdict = judgeProbe(probe(), { version: "1.0.0" });
    const parsed = parseSmokeLine(`[kicklive:smoke] ${verdict.lines[0]} ${verdict.lines[1]}`);
    assert.deepEqual(parsed, { title: "KickLive — live KickLive scores", rootChildren: 2, version: "1.0.0", ok: true });
    assert.equal(parseSmokeLine("nothing here"), null);
  });
});

describe("brand identity used by the window manager", () => {
  it("the .desktop file carries the WM_CLASS the shell matches on", () => {
    const text = renderDesktopFile("1.0.0");
    assert.ok(text.split("\n").includes(`StartupWMClass=${BRAND.wmClass}`));
    assert.ok(text.split("\n").includes(`Name=${BRAND.desktopEntryName}`));
    assert.ok(text.split("\n").includes(`X-KickLive-Version=1.0.0`));
    assert.ok(text.split("\n").includes(`MimeType=x-scheme-handler/${BRAND.id};`), "the kicklive:// protocol handler is registered from here");
    assert.equal(BRAND.desktopFile, `${BRAND.wmClass}.desktop`);
    assert.ok(!text.includes("Actions="), "an empty Actions key makes gnome-shell warn");
  });
});
