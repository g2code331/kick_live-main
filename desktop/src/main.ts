/**
 * KickLive desktop shell.
 *
 * Responsibilities, and nothing else:
 *  1. own the window + the load ladder (file:// inside the asar, then the embedded loopback HTTP
 *     server, then a diagnostic page) and log every step with the documented lines;
 *  2. own the privileged update flow (download, sha256 verify, hand-off to the package manager);
 *  3. expose a tiny, allow-listed IPC surface to the renderer (see ./api.ts).
 *
 * The renderer decides *what to show*; this process decides *what is allowed to happen*.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND } from "../../shared/branding.ts";
import { buildLoadPlan, formatLog, runLoadPlan, sleep, type LoadAttempt, type LoadPlan, type LoadResult } from "../../shared/renderer-load.ts";
import { resolveChannel, resolveManifestUrl } from "../../shared/update-client.ts";
import { createUpdateController } from "../../shared/update-controller.ts";
import { platformIdFor } from "../../shared/platform.ts";
import { errorPageDataUrl } from "./error-page.ts";
import { createLogger, type Logger } from "./log.ts";
import { describeRoots, rendererIndexPath, resolveRendererRoot, type RendererRoots } from "./renderer-paths.ts";
import { createSettingsStorage, SettingsFile, type Settings } from "./settings-store.ts";
import { installArtifact } from "./updater.ts";
import { IPC, type DesktopInfo, type InstallResult, type UpdateView } from "./api.ts";
import { judgeProbe, SMOKE_PROBE, SMOKE_TIMEOUT_MS, type SmokeProbeResult } from "./smoke.ts";
import { startStaticServer, type RunningServer } from "../../server/static-server.ts";

const APP_VERSION: string = app.getVersion();
const ENV = process.env;
const SMOKE = ENV["KICKLIVE_SMOKE"] === "1";
const LOG_FILE = ENV["KICKLIVE_LOG_FILE"] !== "0";
const EMBEDDED_SENTINEL = "embedded://renderer";
const PLATFORM_ID = platformIdFor(process.platform, process.arch);

let logger: Logger = createLogger({ quiet: true });
let mainWindow: BrowserWindow | null = null;
let settings: SettingsFile | null = null;
let updateController: ReturnType<typeof createUpdateController> | null = null;
let httpServer: RunningServer | null = null;
let lastLoad: LoadResult | null = null;
let rendererRoots: RendererRoots | null = null;
let smokeDone = false;

function brandPath(...parts: string[]): string {
  return path.join(app.getPath("userData"), ...parts);
}

/** WM_CLASS on Linux is derived from the app name; the .desktop file must agree exactly. */
function applyBrandIdentity(): void {
  app.setName(BRAND.productName);
  try {
    app.setAppUserModelId(BRAND.appUserModelId);
  } catch {
    /* windows-only */
  }
  try {
    app.setDesktopName(BRAND.desktopFile);
  } catch {
    /* linux-only */
  }
}

function envChannel() {
  return resolveChannel(ENV as unknown as Record<string, string | undefined>);
}

function manifestUrl(): string {
  return resolveManifestUrl({ env: ENV as unknown as Record<string, string | undefined>, channel: envChannel() });
}

async function ensureHttpFallback(): Promise<string> {
  if (httpServer) return httpServer.origin;
  const roots = rendererRoots;
  if (!roots) throw new Error("renderer roots not resolved");
  httpServer = await startStaticServer({
    root: roots.root,
    host: "127.0.0.1",
    port: Number(ENV["KICKLIVE_HTTP_PORT"] ?? 0),
    spa: true,
    csp: true,
    allowedHosts: ["loopback"],
  });
  logger.line(formatLog(`DIAGNOSTIC httpOrigin=${httpServer.origin}`));
  return httpServer.origin;
}

async function navigate(win: BrowserWindow, source: LoadAttempt): Promise<void> {
  if (source.kind === "file") {
    const filePath = source.target.startsWith("file://") ? fileURLToPath(source.target) : source.target;
    if (!fs.existsSync(filePath)) throw new Error("ENOENT renderer index missing");
    await win.loadFile(filePath);
    return;
  }
  if (source.kind === "http") {
    const origin = source.target.startsWith(EMBEDDED_SENTINEL) ? await ensureHttpFallback() : new URL(source.target).origin;
    await win.loadURL(`${origin}/`);
    return;
  }
  if (!rendererRoots) throw new Error("renderer roots not resolved");
  const html = errorPageDataUrl({
    version: APP_VERSION,
    attempts: lastLoad?.attemptNumber ?? 0,
    totalAttempts: lastLoad?.totalAttempts ?? 1,
    lastError: lastLoad?.lastError ?? "unknown",
    rendererRoot: rendererRoots.root,
    indexHtml: rendererRoots.indexHtml,
    httpOrigin: httpServer?.origin,
    logFile: logger.logFile,
    platform: `${process.platform}-${process.arch}`,
  });
  await win.loadURL(html);
}

function buildPlan(): LoadPlan {
  const roots = rendererRoots;
  if (!roots) throw new Error("renderer roots not resolved");
  const broken = ENV["KICKLIVE_SMOKE_BAD_LOAD"] === "1" ? brandPath("definitely-not-here", "index.html") : undefined;
  const allowHttp = ENV["KICKLIVE_NO_HTTP_FALLBACK"] !== "1";
  const plan = buildLoadPlan({
    rendererIndexPath: broken ?? rendererIndexPath(roots),
    httpOrigin: allowHttp ? `${EMBEDDED_SENTINEL}/` : undefined,
    attemptsPerSource: Number(ENV["KICKLIVE_LOAD_ATTEMPTS"] ?? 4),
    brokenPath: undefined,
  });
  if (broken) {
    // Keep the real renderer reachable as the ladder's second source, so "broken load path"
    // exercises the ladder *and* ends in a painted window.
    plan.sources.splice(1, 0, {
      kind: "file",
      target: `file://${rendererIndexPath(roots)}`,
      label: "secondary-file",
      attempts: 2,
      backoffMs: [100],
      isFallback: true,
    });
  }
  return plan;
}

async function loadRenderer(win: BrowserWindow): Promise<LoadResult> {
  const plan = buildPlan();
  logger.line(formatLog(`DIAGNOSTIC ${describeRoots(rendererRoots ?? { root: "?", indexHtml: "?", packed: false })}`));
  logger.line(formatLog(`DIAGNOSTIC plan=${plan.sources.map((s) => s.label).join("+")}`));
  const result = await runLoadPlan(plan, {
    log: (line) => logger.line(line),
    sleep: (ms) => (SMOKE ? sleep(Math.min(ms, 25)) : sleep(ms)),
    load: (source) => navigate(win, source),
  });
  lastLoad = result;
  if (!result.ok) {
    logger.line(formatLog(`DIAGNOSTIC windowState=diagnostic-page`));
  } else if (result.usedFallback) {
    logger.line(formatLog(`DIAGNOSTIC windowState=fallback source=${String(result.source)}`));
  }
  return result;
}

function view(): UpdateView | null {
  const state = updateController?.state();
  if (!state) return null;
  return {
    decision: state.decision,
    mayPrompt: state.mayPrompt,
    feedConfigured: manifestUrl().length > 0,
    channel: envChannel(),
  };
}

function broadcast(): void {
  const v = view();
  if (v && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updatesChanged, v);
}

function info(): DesktopInfo {
  const platformId = PLATFORM_ID;
  return {
    appVersion: APP_VERSION,
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    platformId: platformId ?? "unsupported",
    channel: envChannel(),
    shell: "desktop",
    loadSource: lastLoad?.source ?? "unknown",
    usedFallback: lastLoad?.usedFallback ?? false,
    attempts: lastLoad?.attemptNumber ?? 0,
    updateFeedConfigured: manifestUrl().length > 0,
    updateFeedUrl: manifestUrl(),
    userDataDir: app.getPath("userData"),
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.getVersion, async () => APP_VERSION);
  ipcMain.handle(IPC.getInfo, async () => info());
  ipcMain.handle(IPC.startupUpdateState, async () => view());
  ipcMain.handle(IPC.checkForUpdates, async () => {
    const summary = await (updateController?.check("manual") ?? Promise.resolve(null));
    const v = view();
    broadcast();
    void summary;
    return v;
  });
  ipcMain.handle(IPC.snooze, async (_e, hours?: number) => {
    await updateController?.snooze(hours);
    const v = view();
    broadcast();
    return v;
  });
  ipcMain.handle(IPC.install, async (): Promise<InstallResult> => {
    const state = updateController?.state();
    if (!state || !state.decision.artifact) return { ok: false, detail: "no verified update to install" };
    return installArtifact(state.decision, APP_VERSION, {
      downloadDir: brandPath("updates"),
      log: (line) => logger.line(line),
      applyMode: ENV["KICKLIVE_UPDATE_APPLY"] === "system" ? "system" : "manual",
    });
  });
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error("only http(s) links may be opened externally");
    await shell.openExternal(String(url));
  });
  ipcMain.handle(IPC.restart, async () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.getSettings, async () => {
    const s = settings?.read() as Settings | undefined;
    return {
      snoozedUntil: s?.updates.snoozedUntil ?? {},
      autoCheck: s?.autoCheck ?? true,
      channel: s?.channel ?? envChannel(),
    };
  });
  ipcMain.handle(IPC.setSnooze, async (_e, version: string, untilIso: string | null) => {
    if (!settings) throw new Error("settings unavailable");
    const next = settings.update((current) => {
      const snoozedUntil = { ...current.updates.snoozedUntil };
      if (untilIso) snoozedUntil[String(version)] = String(untilIso);
      else delete snoozedUntil[String(version)];
      return { ...current, updates: { ...current.updates, snoozedUntil } };
    });
    void next;
    broadcast();
    return {
      snoozedUntil: next.updates.snoozedUntil,
      autoCheck: next.autoCheck,
      channel: next.channel,
    };
  });
}

function applySessionHardening(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.line(formatLog(`DIAGNOSTIC permission-denied=${permission}`));
    callback(false);
  });
  // The embedded server already sends CSP; this covers the file:// document and any redirect.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
    const isOurs = details.url.startsWith("file://") || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(details.url);
    if (isOurs) {
      const cspKey = Object.keys(headers).find((k) => k.toLowerCase() === "content-security-policy");
      if (!cspKey) headers["Content-Security-Policy"] = [brandCsp()];
    }
    callback({ responseHeaders: headers });
  });
}

function brandCsp(): string {
  // Same policy the static host serves, minus the network sources the desktop does not need.
  return [
    "default-src 'self' file:",
    "script-src 'self' file:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' file: data: https://fonts.gstatic.com",
    "img-src 'self' file: data: blob: https:",
    "connect-src 'self' file: https: wss:",
    "manifest-src 'self' file:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => {
            void (async () => {
              await updateController?.check("manual");
              broadcast();
              const v = view();
              const d = v?.decision;
              const message =
                d?.state === "available"
                  ? `KickLive ${d.candidateVersion} is available.`
                  : d?.state === "up-to-date"
                    ? "You are on the newest version."
                    : `Update status unknown (${d?.reason ?? "not checked yet"}).`;
              if (mainWindow) await dialog.showMessageBox(mainWindow, { type: "info", message: title(), detail: message, buttons: ["OK"] });
            })();
          },
        },
        {
          label: `About ${BRAND.displayName}`,
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              message: title(),
              detail: `${BRAND.tagline}\nversion ${APP_VERSION} · channel ${envChannel()}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n${BRAND.homepage}`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function title(): string {
  return `${BRAND.displayName} ${APP_VERSION}`;
}

async function runSmoke(win: BrowserWindow): Promise<void> {
  if (!SMOKE || smokeDone) return;
  smokeDone = true;
  logger.line(`SMOKE_START version=${APP_VERSION} shell=desktop platform=${process.platform}-${process.arch} title=${JSON.stringify(title())}`);
  try {
    const probe = (await Promise.race([
      win.webContents.executeJavaScript(SMOKE_PROBE, true) as Promise<SmokeProbeResult>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SMOKE_TIMEOUT_MS)),
    ])) as SmokeProbeResult | null;
    if (!probe) {
      logger.line("SMOKE_RESULT failed reason=probe-timeout");
      app.exit(4);
      return;
    }
    const verdict = judgeProbe(probe, { version: APP_VERSION });
    for (const line of verdict.lines) logger.line(line);
    logger.line(`SMOKE_LOAD source=${String(lastLoad?.source)} attempt=${String(lastLoad?.attemptNumber)}/${String(lastLoad?.totalAttempts)} fallback=${String(lastLoad?.usedFallback)}`);
    if (httpServer) logger.line(`SMOKE_HTTP_ORIGIN ${httpServer.origin}`);
    // The point of the broken-path run is this line: the primary file:// target was gone and the app
    // still painted. CI greps for exactly this string (see scripts/ci/desktop-smoke.sh).
    if (lastLoad?.usedFallback) logger.line(`SMOKE_FALLBACK_OK source=${String(lastLoad.source)} attempt=${String(lastLoad.attemptNumber)}/${String(lastLoad.totalAttempts)}`);
    if (!verdict.ok) app.exit(verdict.exitCode);
    else app.exit(0);
  } catch (err) {
    logger.line(`SMOKE_RESULT failed reason=${(err as Error).message}`);
    app.exit(3);
  }
}

function createWindow(): BrowserWindow {
  rendererRoots = resolveRendererRoot({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    override: ENV["KICKLIVE_RENDERER_ROOT"],
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: title(),
    backgroundColor: BRAND.colors.bg,
    autoHideMenuBar: false,
    icon: appIconPath(),
    webPreferences: {
      // Shipped next to main.cjs by scripts/build-desktop.mjs; `app.getAppPath()` is the asar
      // root when packaged and the repo root in a checkout, so one expression covers both.
      preload: path.join(app.getAppPath(), "build", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || ENV["KICKLIVE_DEVTOOLS"] === "1",
      additionalArguments: [`--kicklive-version=${APP_VERSION}`, `--kicklive-channel=${envChannel()}`],
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => {
    win.show();
    void runSmoke(win);
  });
  win.webContents.on("did-fail-load", (_e, code, description, url) => {
    logger.line(formatLog(`DIAGNOSTIC did-fail-load code=${String(code)} description=${JSON.stringify(description)} url=${url}`));
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    logger.line(formatLog(`DIAGNOSTIC render-process-gone reason=${details.reason} exitCode=${String(details.exitCode)}`));
    if (details.reason === "crashed" && !win.isDestroyed()) win.webContents.reload();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    const same = (() => {
      try {
        return new URL(url).origin === new URL(current).origin;
      } catch {
        return false;
      }
    })();
    if (!same && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    mainWindow = null;
  });

  void loadRenderer(win);
  return win;
}

function appIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "build", "icons", "512x512.png"),
    path.join(app.getAppPath(), "renderer", "dist", "kicklive-icon.png"),
    path.join(process.cwd(), "packaging", "icons", "512x512.png"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined;
}

/* ------------------------------------------------------------------ */

applyBrandIdentity();

if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    logger = createLogger({
      userDataDir: LOG_FILE ? app.getPath("userData") : undefined,
      quiet: !SMOKE && ENV["KICKLIVE_VERBOSE"] !== "1",
    });
    logger.line(formatLog(`DIAGNOSTIC boot version=${APP_VERSION} packaged=${String(app.isPackaged)} platform=${process.platform}-${process.arch}`));

    settings = new SettingsFile(app.getPath("userData"));
    const channel = ENV["KICKLIVE_UPDATE_CHANNEL"] || ENV["VITE_UPDATE_CHANNEL"] ? envChannel() : settings.read().channel;
    updateController = createUpdateController({
      surface: "desktop",
      currentVersion: APP_VERSION,
      channel,
      platformId: PLATFORM_ID ?? undefined,
      storage: createSettingsStorage(settings),
      manifestUrl: manifestUrl(),
      log: (line) => logger.line(line),
      onInstall: (decision) =>
        installArtifact(decision, APP_VERSION, {
          downloadDir: brandPath("updates"),
          log: (line) => logger.line(line),
          applyMode: ENV["KICKLIVE_UPDATE_APPLY"] === "system" ? "system" : "manual",
        }),
    });

    applySessionHardening();
    registerIpc();
    buildMenu();
    createWindow();

    // Startup check: never blocks the window, always logs its conclusion.
    if (settings.read().autoCheck) {
      void updateController
        .check("startup")
        .then(() => broadcast())
        .catch((err: unknown) => logger.line(formatLog(`DIAGNOSTIC update-check-threw=${String(err)}`)));
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    logger.flushSync();
    void httpServer?.close();
  });
}

/** Exported for tests: the ladder and log vocabulary are the contract, not the window. */
export const __testable = { buildPlan, formatLog, SMOKE_PROBE, buildMenu };
