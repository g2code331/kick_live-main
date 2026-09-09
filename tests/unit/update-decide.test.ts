/**
 * decideUpdate: the whole update policy as a pure function, so "never downgrade", "offline is
 * unknown, not error" and "mandatory beats snooze" are provable without an app window.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideUpdate, summariseDecision, verifyDownloadedArtifact } from "../../shared/update-manifest.ts";
import { asManifest, manifest, sha256Of } from "../support/fixture.ts";

const NOW = "2026-09-09T00:00:00.000Z";

function decide(overrides: Record<string, unknown> = {}) {
  const input = {
    surface: "desktop",
    currentVersion: "1.0.0",
    channel: "stable",
    platformId: "linux_x64",
    outcome: { ok: true, manifest: asManifest(manifest()) },
    now: NOW,
    ...overrides,
  } as never;
  return decideUpdate(input);
}

describe("decideUpdate: version policy", () => {
  it("offers an update when the manifest is newer", () => {
    const d = decide();
    assert.equal(d.state, "available");
    assert.equal(d.reason, "update-available");
    assert.equal(d.candidateVersion, "1.1.0");
    assert.equal(d.prompt, true);
    assert.equal(d.action, "install");
    assert.ok(d.artifact, "the artifact must be carried through: the UI never re-reads the manifest");
  });

  it("treats equal and older as up-to-date (never downgrade)", () => {
    for (const version of ["1.0.0", "0.9.9", "1.0.0-beta.1"]) {
      const d = decide({ outcome: { ok: true, manifest: asManifest(manifest({ version })) } });
      assert.equal(d.state, "up-to-date", `${version} must not be offered to a 1.0.0 install`);
      assert.equal(d.prompt, false);
      assert.ok(["current-is-newest", "never-downgrade"].includes(d.reason), `reason was ${d.reason}`);
    }
  });

  it("never-downgrade survives a rolled-back manifest on a channel we already saw", () => {
    const d = decide({
      outcome: { ok: true, manifest: asManifest(manifest({ version: "0.5.0" })) },
      lastSeen: { version: "1.1.0", at: "2026-09-01T00:00:00.000Z" },
    });
    assert.equal(d.state, "up-to-date");
    assert.equal(d.prompt, false);
  });

  it("honours minSupportedVersion by refusing to run an unsupported client quietly", () => {
    const d = decide({ outcome: { ok: true, manifest: asManifest(manifest({ minSupportedVersion: "1.5.0" })) } });
    assert.equal(d.state, "available");
    assert.equal(d.mandatory, true, "below the supported floor the prompt is forced");
  });
});

describe("decideUpdate: channels and platforms", () => {
  it("reports channel-mismatch instead of installing the other channel", () => {
    const d = decide({ outcome: { ok: true, manifest: asManifest(manifest({ channel: "beta" })) } });
    assert.equal(d.reason, "channel-mismatch");
    assert.equal(d.prompt, false);
  });

  it("beta clients accept the beta manifest", () => {
    const d = decide({ channel: "beta", outcome: { ok: true, manifest: asManifest(manifest({ channel: "beta" })) } });
    assert.equal(d.state, "available");
  });

  it("missing platform entry is platform-missing, not a crash", () => {
    const d = decide({ outcome: { ok: true, manifest: asManifest(manifest({ platformId: "linux_arm64" })) } });
    assert.equal(d.reason, "platform-missing");
    assert.equal(d.state, "error");
    assert.match(String(d.detail), /linux_x64/);
  });
});

describe("decideUpdate: failures degrade, they do not nag", () => {
  it("an unreachable feed is `unknown` and keeps lastSeen visible", () => {
    const d = decide({
      outcome: { ok: false, kind: "unreachable", detail: "ECONNREFUSED" },
      lastSeen: { version: "1.1.0", at: "2026-09-08T10:00:00.000Z" },
    });
    assert.equal(d.state, "unknown");
    assert.equal(d.reason, "manifest-unreachable");
    assert.equal(d.prompt, false);
    assert.equal(d.lastSeenVersion, "1.1.0");
    assert.equal(d.lastSeenAt, "2026-09-08T10:00:00.000Z", "the header has to be able to say when we last knew");
  });

  it("an invalid manifest is `error` with the validation errors attached", () => {
    const errors = [{ path: "version", code: "format", message: "not semver" }];
    const d = decide({ outcome: { ok: false, kind: "invalid", detail: "schema", errors } });
    assert.equal(d.state, "error");
    assert.equal(d.reason, "manifest-invalid");
    assert.equal(d.prompt, false);
    assert.deepEqual(d.errors, errors);
  });

  it("summariseDecision stays single-line (it goes into a log file)", () => {
    const line = summariseDecision(decide());
    assert.ok(!line.includes("\n"));
    assert.match(line, /state=available reason=update-available candidate=1\.1\.0/);
  });
});

describe("decideUpdate: user interaction", () => {
  it("a live snooze suppresses the prompt but not the state", () => {
    const d = decide({ snoozedUntil: { "1.1.0": "2026-12-31T00:00:00.000Z" } });
    assert.equal(d.reason, "snoozed");
    assert.equal(d.prompt, false);
    assert.equal(d.state, "available", "the header still shows an update is waiting");
  });

  it("an expired snooze prompts again", () => {
    const d = decide({ snoozedUntil: { "1.1.0": "2020-01-01T00:00:00.000Z" } });
    assert.equal(d.prompt, true);
    assert.equal(d.reason, "update-available");
  });

  it("snoozing does NOT apply to a mandatory update", () => {
    const d = decide({
      currentVersion: "0.9.0",
      snoozedUntil: { "1.1.0": "2026-12-31T00:00:00.000Z" },
      outcome: { ok: true, manifest: asManifest(manifest({ mandatoryBelow: "1.0.0" })) },
    });
    assert.equal(d.mandatory, true);
    assert.equal(d.prompt, true, "a security floor cannot be dismissed for 12 hours");
  });

  it("prompts at most once per app open", () => {
    assert.equal(decide().prompt, true);
    assert.equal(decide({ alreadyPromptedThisSession: true }).prompt, false, "second check in the same open must stay quiet");
  });
});

describe("decideUpdate: the PWA surface", () => {
  it("activates by reloading, and snooze does not apply to a bundle swap", () => {
    const d = decide({ surface: "pwa", snoozedUntil: { "1.1.0": "2026-12-31T00:00:00.000Z" } });
    assert.equal(d.action, "reload");
    assert.equal(d.reason, "update-available", "pwa ignores the desktop snooze table");
    assert.equal(d.prompt, true);
  });

  it("without a web bundle block the PWA says so instead of offering an install", () => {
    const d = decide({ surface: "pwa", outcome: { ok: true, manifest: asManifest(manifest({ web: false })) } });
    assert.equal(d.reason, "no-web-bundle");
    assert.equal(d.prompt, false);
  });
});

describe("verifyDownloadedArtifact: the last gate before the package manager", () => {
  const bytes = Buffer.from("real deb bytes");
  const digest = sha256Of(bytes);
  const declared = { sha256: digest, size: bytes.length };

  it("accepts a matching download", () => {
    assert.equal(verifyDownloadedArtifact({ declared, actual: { sha256: digest, size: bytes.length } }).ok, true);
  });

  it("refuses on checksum mismatch (a truncated or swapped file must never reach apt)", () => {
    const res = verifyDownloadedArtifact({ declared, actual: { sha256: "f".repeat(64), size: bytes.length } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "checksum-mismatch");
  });

  it("refuses on size mismatch", () => {
    const res = verifyDownloadedArtifact({ declared, actual: { sha256: digest, size: bytes.length - 1 } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "size-mismatch");
  });
});
