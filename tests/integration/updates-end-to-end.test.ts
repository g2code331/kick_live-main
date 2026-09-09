/**
 * The updates contract, end to end over a real HTTP server and real files (spec §7.4).
 *
 * Everything here uses the SAME code paths the app uses: shared/update-client for transport,
 * shared/update-manifest for schema + policy, shared/update-controller for state, desktop/updater for
 * staging, desktop/settings-store for persistence. Only the manifest URL and the artifact host are
 * faked (loopback, with allowInsecureUrls), and `spawn` is injected so nothing is installed.
 *
 * Covered, one test each, in the order the spec lists them:
 *   manifest schema validation · semver/never-downgrade · checksum-mismatch refusal ·
 *   offline => unknown(lastSeenAt) · snooze persistence per version · one prompt per open ·
 *   header control exists with no manifest reachable · both surfaces' activation semantics.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { createUpdateController } from "../../shared/update-controller.ts";
import { parseUpdateManifest } from "../../shared/update-manifest.ts";
import type { UpdateManifest } from "../../shared/update-manifest.ts";
import { installArtifact } from "../../desktop/src/updater.ts";
import { SettingsFile, createSettingsStorage, defaultSettings } from "../../desktop/src/settings-store.ts";
import { UPDATE_LOG_PATTERNS } from "../../shared/update-client.ts";
import { viewModelFromDecision } from "../../src/lib/use-update-control.ts";

const DEB_BYTES = Buffer.from("KickLive fake .deb payload for the integration test\n".repeat(64));
const DEB_SHA = createHash("sha256").update(DEB_BYTES).digest("hex");

type Feed = {
  origin: string;
  setManifest: (m: unknown) => void;
  setArtifact: (bytes: Buffer) => void;
  requests: string[];
  close: () => Promise<void>;
};

let feed: Feed;
let work: string;

async function startFeed(): Promise<Feed> {
  const requests: string[] = [];
  let manifestJson: unknown = null;
  let artifactBytes: Buffer = DEB_BYTES;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/kicklive-update-stable.json") {
      res.writeHead(manifestJson === null ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(manifestJson));
      return;
    }
    if (req.url === "/artifacts/kicklive_1.1.0_amd64.deb") {
      res.writeHead(200, { "content-type": "application/vnd.debian.binary-package", "content-length": String(artifactBytes.length) });
      res.end(artifactBytes);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    setManifest: (m) => {
      manifestJson = m;
    },
    setArtifact: (b) => {
      artifactBytes = b;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections?.();
      }),
  };
}

function manifestFor(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "kicklive",
    channel: "stable",
    version,
    releasedAt: "2026-09-01T12:00:00.000Z",
    notes: `KickLive ${version}: feed refresh no longer thrashes the CPU.`,
    notesUrl: "https://github.com/g2code331/kick_live-main/releases/tag/v" + version,
    platforms: {
      linux_x64: {
        kind: "deb",
        fileName: "kicklive_1.1.0_amd64.deb",
        url: `${feed.origin}/artifacts/kicklive_1.1.0_amd64.deb`,
        sha256: DEB_SHA,
        size: DEB_BYTES.length,
      },
    },
    web: { version, swUrl: "/sw.js", precache: ["/", "/index.html"] },
    ...overrides,
  };
}

function makeController(opts: {
  storage: ReturnType<typeof createSettingsStorage>;
  surface?: "desktop" | "pwa";
  currentVersion?: string;
  onInstall?: (d: never) => Promise<{ ok: boolean; detail: string }>;
  log?: (l: string) => void;
}) {
  return createUpdateController({
    surface: opts.surface ?? "desktop",
    currentVersion: opts.currentVersion ?? "1.0.0",
    channel: "stable",
    platformId: "linux_x64",
    storage: opts.storage,
    manifestUrl: `${feed.origin}/kicklive-update-stable.json`,
    allowInsecureUrls: true,
    log: opts.log,
    attempts: 1,
    onInstall: opts.onInstall as never,
  });
}

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-e2e-"));
  feed = await startFeed();
});

after(async () => {
  await feed.close();
  fs.rmSync(work, { recursive: true, force: true });
});

let settingsDir: string;
beforeEach(() => {
  settingsDir = fs.mkdtempSync(path.join(work, "user-"));
  feed.setManifest(manifestFor("1.1.0"));
  feed.setArtifact(DEB_BYTES);
});

const storageFor = (dir: string): ReturnType<typeof createSettingsStorage> => createSettingsStorage(new SettingsFile(dir));

describe("updates contract: manifest schema over the wire", () => {
  it("a published manifest that does not validate is refused by the client, loudly", async () => {
    feed.setManifest({ ...manifestFor("1.1.0"), platforms: { linux_x64: { kind: "deb", fileName: "x.deb", url: "http://x/y.deb" } } });
    const logs: string[] = [];
    const controller = makeController({ storage: storageFor(settingsDir), log: (l) => logs.push(l) });
    const summary = await controller.check("manual");
    assert.equal(summary.decision.state, "error");
    assert.equal(summary.decision.reason, "manifest-invalid");
    assert.ok((summary.errors?.length ?? 0) >= 2, `expected several schema errors, got ${JSON.stringify(summary.errors)}`);
    assert.ok(
      logs.some((l) => UPDATE_LOG_PATTERNS.checked.test(l)),
      "the refusal must be visible in the log",
    );
  });

  it("the same document validated by the builder is accepted", async () => {
    const parsed = parseUpdateManifest(JSON.stringify(manifestFor("1.1.0")), { allowInsecureUrls: true });
    assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? null : parsed.errors));
  });
});

describe("updates contract: version ordering", () => {
  it("1.1.0 is offered to a 1.0.0 install", async () => {
    const controller = makeController({ storage: storageFor(settingsDir) });
    const summary = await controller.check("startup");
    assert.equal(summary.mayPrompt, true);
    assert.equal(summary.decision.candidateVersion, "1.1.0");
  });

  it("a rolled-back manifest never offers a downgrade, even after a restart", async () => {
    const storage = storageFor(settingsDir);
    const controller = makeController({ storage });
    await controller.check("startup");

    feed.setManifest(manifestFor("0.5.0"));
    const restarted = makeController({ storage });
    const summary = await restarted.check("startup");
    assert.equal(summary.decision.state, "up-to-date");
    assert.equal(summary.decision.reason, "never-downgrade");
    assert.equal(summary.mayPrompt, false);
    assert.equal(summary.decision.prompt, false);
  });

  it("the install path refuses to run apt for an older artifact", async () => {
    let spawned = 0;
    feed.setManifest(manifestFor("0.5.0"));
    const storage = storageFor(settingsDir);
    const controller = makeController({
      storage,
      onInstall: (async (decision) => {
        void decision;
        spawned += 1;
        return { ok: true, detail: "should never run" };
      }) as never,
    });
    const res = await controller.install();
    assert.equal(res.ok, false);
    assert.equal(spawned, 0);
  });
});

describe("updates contract: checksum mismatch", () => {
  it("refuses to stage an artifact whose bytes differ from the manifest, and installs nothing", async () => {
    feed.setManifest(manifestFor("1.1.0"));
    const storage = storageFor(settingsDir);
    const logs: string[] = [];
    const controller = makeController({ storage, log: (l) => logs.push(l) });
    const summary = await controller.check("manual");
    assert.equal(summary.decision.state, "available");

    // The feed goes hostile *after* the manifest was published: same declared hash, new bytes.
    feed.setArtifact(Buffer.from("ATTACKER PAYLOAD".padEnd(DEB_BYTES.length, "!")));
    let spawned = 0;
    let spawnCommand: string[] = [];
    const stagedDir = path.join(settingsDir, "updates");
    const install = await installArtifact(summary.decision, "1.0.0", {
      downloadDir: stagedDir,
      log: (l) => logs.push(l),
      applyMode: "system",
      spawn: async (command, args) => {
        spawned += 1;
        spawnCommand = [command, ...args];
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(install.ok, false);
    assert.match(install.detail, /checksum-mismatch/);
    assert.equal(spawned, 0, "a mismatch must never reach the package manager");
    assert.equal(spawnCommand.length, 0);
    assert.deepEqual(fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : [], [], "nothing may be left staged");
    assert.ok(
      logs.some((l) => UPDATE_LOG_PATTERNS.refused.test(l)),
      "the documented REFUSE_INSTALL line must be emitted",
    );
  });

  it("a genuine artifact stages, verifies, and (in manual mode) only prints the command", async () => {
    const storage = storageFor(settingsDir);
    const logs: string[] = [];
    const controller = makeController({ storage, log: (l) => logs.push(l) });
    const summary = await controller.check("manual");
    const stagedDir = path.join(settingsDir, "updates");
    let spawned = 0;
    const outcome = await installArtifact(summary.decision, "1.0.0", {
      downloadDir: stagedDir,
      log: (l) => logs.push(l),
      spawn: async () => {
        spawned += 1;
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(spawned, 0, "the default apply mode never runs a privileged command unattended");
    const file = outcome.staged!;
    assert.equal(fs.statSync(file).size, DEB_BYTES.length);
    assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), DEB_SHA);
    assert.match(outcome.command!, /^pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y /);
    assert.ok(logs.some((l) => /STAGED_FOR_USER/.test(l)));
  });
});

describe("updates contract: offline", () => {
  it("an unreachable feed is unknown(lastSeenAt), and the header still renders", async () => {
    const storage = storageFor(settingsDir);
    await makeController({ storage }).check("startup");

    await feed.close(); // hard offline: connection refused
    try {
      const logs: string[] = [];
      const restarted = makeController({ storage, log: (l) => logs.push(l) });
      const summary = await restarted.check("startup");
      assert.equal(summary.decision.state, "unknown");
      assert.equal(summary.decision.reason, "manifest-unreachable");
      assert.match(String(summary.decision.lastSeenAt), /^20\d\d-/);
      assert.equal(summary.mayPrompt, false, "being offline is not a reason to show an error dialog");
      const model = viewModelFromDecision({ decision: summary.decision, mayPrompt: false, feedConfigured: true, channel: "stable" });
      assert.equal(model.state, "unknown");
      assert.match(model.label, /unknown|last seen/i);
      assert.ok(logs.some((l) => UPDATE_LOG_PATTERNS.checked.test(l) && l.includes("state=unknown")));
    } finally {
      feed = await startFeed(); // restore for the remaining tests
      feed.setManifest(manifestFor("1.1.0"));
    }
  });

  it("a never-configured feed is also unknown, not 'up to date'", () => {
    const model = viewModelFromDecision(null, { feedConfigured: false });
    assert.equal(model.state, "unknown");
    assert.equal(model.feedConfigured, false);
  });
});

describe("updates contract: snooze persistence per version", () => {
  it("survives a restart and does not silence a newer release", async () => {
    const storage = storageFor(settingsDir);
    const controller = makeController({ storage });
    await controller.check("startup");
    const afterSnooze = await controller.snooze();
    assert.equal(afterSnooze.decision.reason, "snoozed");

    // On-disk state, not memory: a brand new SettingsFile must see it.
    const onDisk = new SettingsFile(settingsDir);
    onDisk.forgetCache();
    const persisted = onDisk.read().updates.snoozedUntil;
    assert.deepEqual(Object.keys(persisted), ["1.1.0"]);
    assert.ok(Date.parse(persisted["1.1.0"]) > Date.now());

    const sameVersion = makeController({ storage: storageFor(settingsDir) });
    assert.equal((await sameVersion.check("startup")).mayPrompt, false);

    feed.setManifest(manifestFor("1.2.0"));
    const newerVersion = makeController({ storage: storageFor(settingsDir) });
    assert.equal((await newerVersion.check("startup")).mayPrompt, true, "a new release is a new prompt");
    feed.setManifest(manifestFor("1.1.0"));
  });

  it("an expired snooze prompts again (12h window, not forever)", async () => {
    const file = new SettingsFile(settingsDir);
    file.write({
      ...defaultSettings("stable"),
      updates: { ...defaultSettings().updates, snoozedUntil: { "1.1.0": new Date(Date.now() - 60_000).toISOString() } },
    });
    const controller = makeController({ storage: createSettingsStorage(file) });
    const summary = await controller.check("startup");
    assert.equal(summary.mayPrompt, true);
  });
});

describe("updates contract: one prompt per open", () => {
  it("automatic then manual => exactly one prompt", async () => {
    const controller = makeController({ storage: storageFor(settingsDir) });
    assert.equal((await controller.check("startup")).mayPrompt, true);
    assert.equal((await controller.check("focus")).mayPrompt, false);
    assert.equal((await controller.check("manual")).mayPrompt, false, "a manual check reports state but does not re-open the dialog");
  });

  it("the latch is per app open, not persisted to disk", async () => {
    const storage = storageFor(settingsDir);
    const first = makeController({ storage });
    await first.check("startup");
    const second = makeController({ storage });
    assert.equal((await second.check("startup")).mayPrompt, true, "restarting the app may prompt again; the snooze is what silences it");
  });
});

describe("updates contract: the two surfaces", () => {
  it("desktop offers install, PWA offers reload", async () => {
    const desktop = makeController({ storage: storageFor(settingsDir), surface: "desktop" });
    const pwa = makeController({ storage: storageFor(path.join(settingsDir, "pwa")), surface: "pwa" });
    const d = (await desktop.check("startup")).decision;
    const p = (await pwa.check("startup")).decision;
    assert.equal(d.action, "install");
    assert.equal(p.action, "reload", "a browser cannot install a .deb: activation for the web surface is a service-worker swap");
    assert.equal(d.artifact?.kind, "deb");
    assert.ok(!p.artifact, "the web decision must not carry a package artifact");
  });

  it("the PWA decision carries the sw scope so the UI can call update+reload", async () => {
    const pwa = makeController({ storage: storageFor(path.join(settingsDir, "pwa2")), surface: "pwa" });
    const summary = await pwa.check("manual");
    assert.equal(summary.decision.state, "available");
    assert.match(String(summary.decision.candidateVersion), /^1\.1\.0$/);
    const model = viewModelFromDecision({ decision: summary.decision, mayPrompt: summary.mayPrompt, feedConfigured: true, channel: "stable" });
    assert.equal(model.surface, "web");
    assert.equal(model.state, "available");
  });
});

describe("updates contract: the header control exists with no manifest reachable", () => {
  // `node --test` strips types but cannot transform JSX, so the component is asserted structurally
  // here (it is mounted in the real bundle) and its *logic* is asserted through the pure view model.
  // The DOM-level proof of "the control paints" is gate 3's xvfb smoke run.
  const read = (rel: string): string => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");

  it("the app header mounts the control", () => {
    const header = read("src/components/Header.tsx");
    assert.match(header, /import UpdateControl from "\.\.\/components\/UpdateControl\.tsx"/);
    assert.match(header, /<UpdateControl \/>/);
  });

  it("the control always renders and exposes its state to the DOM", () => {
    const control = read("src/components/UpdateControl.tsx");
    assert.match(control, /data-kicklive="update-control"/);
    assert.match(control, /data-state=\{stateAttr\}/);
    assert.match(control, /data-feed-configured=\{String\(model\.feedConfigured\)\}/);
    assert.match(control, /const stateAttr = model\.state;/, "the DOM attribute mirrors the decision state verbatim");
    assert.doesNotMatch(control, /if \(!model\) return null/, "it must not disappear when there is no data");
  });

  it("the built renderer bundle carries the control (proof it survived the build)", () => {
    const assets = path.resolve(import.meta.dirname, "../..", "renderer/dist/assets");
    if (!fs.existsSync(assets)) return; // not built in this checkout: gate 2 builds it
    const js = fs
      .readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(assets, f), "utf8"))
      .join("\n");
    assert.match(js, /update-control/, "the marker attribute must exist in the shipped bundle");
    assert.match(js, /kicklive\.updates\.v1/, "the web storage key must exist in the shipped bundle");
  });

  it("with no manifest reachable the view model says unknown, never up-to-date", () => {
    const model = viewModelFromDecision(null, { feedConfigured: false });
    assert.equal(model.state, "unknown");
    assert.equal(model.reason, "manifest-unreachable");
    assert.equal(model.shouldPrompt, false);
    assert.equal(model.feedConfigured, false);
    assert.match(model.label, /unknown/i);
  });
});
