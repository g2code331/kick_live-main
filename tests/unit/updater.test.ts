/**
 * The privileged half of the update path. This is the code that can `apt-get install` something, so
 * the assertions are all "what must NOT happen": no spawn after a bad checksum, no install of an
 * older version, no write outside the staging directory, no shell interpolation of a manifest name.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { installArtifact, installCommandFor, stageArtifact } from "../../desktop/src/updater.ts";
import type { UpdateDecision } from "../../shared/update-manifest.ts";
import { asManifest, collectLogs, fakeFetch, manifest, sha256Of } from "../support/fixture.ts";

const BYTES = Buffer.from("PK\x03\x04 fake deb payload ".padEnd(4096, "x"));
const DIGEST = sha256Of(BYTES);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-updater-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    kind: "deb",
    fileName: "kicklive_1.1.0_amd64.deb",
    url: "http://127.0.0.1:9/artifacts/kicklive_1.1.0_amd64.deb",
    sha256: DIGEST,
    size: BYTES.length,
    ...overrides,
  };
}

/**
 * The decision carries the artifact the installer will actually fetch, so both are built from one
 * object: a test that points `decision.artifact` at example.invalid would hit the real network.
 */
function decisionFor(overrides: Record<string, unknown> = {}, artifactOverrides: Record<string, unknown> = {}): UpdateDecision {
  const a = { ...artifact(), ...artifactOverrides };
  const m = manifest({ artifact: a as never });
  return {
    state: "available",
    reason: "update-available",
    prompt: true,
    mandatory: false,
    checkedAt: new Date().toISOString(),
    candidateVersion: "1.1.0",
    artifact: asManifest(m).platforms.linux_x64,
    ...overrides,
  } as UpdateDecision;
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    "/artifacts/kicklive_1.1.0_amd64.deb": { body: BYTES },
    ...extra,
  };
}

describe("stageArtifact", () => {
  it("downloads, verifies and renames into place", async () => {
    const { fetch } = fakeFetch(routes());
    const logs = collectLogs();
    const res = await stageArtifact(artifact() as never, { downloadDir: dir, log: logs.log, fetchImpl: fetch });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.sha256, DIGEST);
    assert.equal(res.size, BYTES.length);
    assert.equal(res.file, path.join(dir, "kicklive_1.1.0_amd64.deb"));
    assert.deepEqual(fs.readFileSync(res.file), BYTES);
    assert.equal(fs.existsSync(`${res.file}.part`), false, "the .part file must be renamed away");
    assert.equal(fs.statSync(res.file).mode & 0o777, 0o600);
    assert.ok(logs.lines.some((l) => l.startsWith("[kicklive:updates] DOWNLOAD_START url=")));
    assert.ok(logs.lines.some((l) => /DOWNLOAD_VERIFIED file=kicklive_1\.1\.0_amd64\.deb sha256=[0-9a-f]{64} bytes=\d+/.test(l)));
  });

  it("refuses a checksum mismatch and leaves nothing staged", async () => {
    const { fetch } = fakeFetch(routes({ "/artifacts/kicklive_1.1.0_amd64.deb": { body: Buffer.from("ATTACKER-SWAPPED-PAYLOAD".padEnd(BYTES.length, "y")) } }));
    const logs = collectLogs();
    const res = await stageArtifact({ ...artifact({ size: BYTES.length }) } as never, { downloadDir: dir, log: logs.log, fetchImpl: fetch });
    assert.equal(res.ok, false);
    assert.equal(res.ok ? "" : res.reason, "checksum-mismatch");
    assert.deepEqual(fs.readdirSync(dir), [], "no .part, no staged file: a mismatch must not leave anything executable around");
    assert.ok(logs.lines.some((l) => /^\[kicklive:updates\] REFUSE_INSTALL reason=checksum-mismatch detail=".+/.test(l)));
  });

  it("treats a 404 artifact as a download failure, never a verification pass", async () => {
    const { fetch } = fakeFetch();
    const logs = collectLogs();
    const res = await stageArtifact({ ...artifact(), url: "http://127.0.0.1:9/nope", size: 12 } as never, { downloadDir: dir, log: logs.log, fetchImpl: fetch });
    assert.equal(res.ok, false);
    assert.equal(res.ok ? "" : res.reason, "download-failed", "a 404 is a download failure, not a verification pass");
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(logs.lines.length >= 1);
  });

  it("surfaces a transport error instead of throwing", async () => {
    const logs = collectLogs();
    const brokenFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await stageArtifact(artifact() as never, { downloadDir: dir, log: logs.log, fetchImpl: brokenFetch });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.detail, /ECONNREFUSED/);
  });

  it("sanitises a hostile fileName from the manifest (never a path, never a traversal)", async () => {
    for (const [name, expected] of [
      // basename() strips any directory part, so "../../etc/cron.d/evil" becomes a harmless file
      // name in the staging dir -- it must NOT become /etc/cron.d/evil.
      ["../../etc/cron.d/evil", "evil"],
      ["/etc/passwd", "passwd"],
      ["..\..\windows\system32\evil.exe", "kicklive-update.bin"],
      ["; rm -rf /", "kicklive-update.bin"],
      ["a b.deb", "kicklive-update.bin"],
      ["ok_name-1.0.deb", "ok_name-1.0.deb"],
    ] as [string, string][]) {
      const { fetch } = fakeFetch(routes());
      const res = await stageArtifact({ ...artifact(), fileName: name } as never, { downloadDir: dir, log: () => {}, fetchImpl: fetch });
      assert.equal(res.ok, true, name);
      if (!res.ok) continue;
      assert.equal(path.basename(res.file), expected, name);
      assert.ok(res.file.startsWith(dir + path.sep), `${res.file} escaped the staging dir`);
    }
  });

  it("times out a stalled download", async () => {
    const hangingFetch = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }) as unknown as Promise<Response>;
    const res = await stageArtifact(artifact() as never, {
      downloadDir: dir,
      log: () => {},
      fetchImpl: hangingFetch as unknown as typeof fetch,
      timeoutMs: 20,
    });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.detail, /aborted/);
  });
});

describe("installCommandFor", () => {
  it("uses the package manager for a .deb (dependency resolution, not dpkg -i)", () => {
    const cmd = installCommandFor("deb", "/home/u/.config/kicklive/updates/kicklive_1.1.0_amd64.deb");
    assert.equal(cmd.command, "pkexec");
    assert.deepEqual(cmd.args, ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "/home/u/.config/kicklive/updates/kicklive_1.1.0_amd64.deb"]);
  });

  it("makes an AppImage executable and hands it over", () => {
    const cmd = installCommandFor("appimage", "/tmp/KickLive-1.1.0-x86_64.AppImage");
    assert.equal(cmd.command, "/bin/sh");
    assert.match(cmd.args[1], /^chmod \+x /);
    assert.match(cmd.args[1], /--updated/);
  });

  it("falls back to opening the file for anything else", () => {
    assert.deepEqual(installCommandFor("zip", "/tmp/x.zip"), { command: "xdg-open", args: ["/tmp/x.zip"] });
  });
});

describe("installArtifact", () => {
  it("manual mode (the default) stages and prints the command, and never spawns", async () => {
    let spawned: string[][] = [];
    const { fetch } = fakeFetch(routes());
    const logs = collectLogs();
    const res = await installArtifact(decisionFor(), "1.0.0", {
      downloadDir: dir,
      log: logs.log,
      fetchImpl: fetch,
      spawn: async (command, args) => {
        spawned.push([command, ...args]);
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(spawned.length, 0, "an unattended root install is not the default behaviour");
    assert.match(res.command!, /^pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y /);
    assert.ok(logs.lines.some((l) => /STAGED_FOR_USER command="pkexec/.test(l)));
    assert.equal(fs.existsSync(res.staged ?? ""), true);
  });

  it("system mode runs exactly the staged, verified file", async () => {
    let spawnArgs: string[] = [];
    const { fetch } = fakeFetch(routes());
    const logs = collectLogs();
    const res = await installArtifact(decisionFor(), "1.0.0", {
      downloadDir: dir,
      log: logs.log,
      fetchImpl: fetch,
      applyMode: "system",
      spawn: async (command, args) => {
        spawnArgs = [command, ...args];
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(spawnArgs[0], "pkexec");
    assert.match(spawnArgs.at(-1)!, /kicklive_1\.1\.0_amd64\.deb$/);
    assert.ok(logs.lines.some((l) => /INSTALL_HANDOFF kind=deb/.test(l)));
    assert.ok(logs.lines.some((l) => /INSTALL_OK version=1\.1\.0/.test(l)));
  });

  it("reports the installer's exit status verbatim", async () => {
    const { fetch } = fakeFetch(routes());
    const logs = collectLogs();
    const res = await installArtifact(decisionFor(), "1.0.0", {
      downloadDir: dir,
      log: logs.log,
      fetchImpl: fetch,
      applyMode: "system",
      spawn: async () => ({ code: 100, stderr: "apt-get: E: dpkg was interrupted" }),
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /exited 100/);
    assert.match(res.detail, /dpkg was interrupted/);
    assert.ok(logs.lines.some((l) => /INSTALL_FAILED code=100/.test(l)));
  });

  it("never downloads at all when the candidate is not newer", async () => {
    let hits: Record<string, number> = {};
    const { fetch, hits: h } = fakeFetch(routes());
    hits = h;
    const logs = collectLogs();
    const res = await installArtifact(decisionFor({ candidateVersion: "1.0.0" }), "1.0.0", { downloadDir: dir, log: logs.log, fetchImpl: fetch });
    assert.equal(res.ok, false);
    assert.match(res.detail, /not newer/);
    assert.deepEqual(hits, {}, "the refusal happens before any network access");
    assert.ok(logs.lines.some((l) => /REFUSE_INSTALL reason=never-downgrade detail="candidate=1\.0\.0 running=1\.0\.0"/.test(l)));
  });

  it("refuses a decision with no artifact", async () => {
    const res = await installArtifact(decisionFor({ artifact: undefined, candidateVersion: undefined }), "1.0.0", { downloadDir: dir, log: () => {}, fetchImpl: fakeFetch(routes()).fetch });
    assert.equal(res.ok, false);
    assert.match(res.detail, /no artifact/);
  });

  it("does not spawn when verification failed", async () => {
    let spawned = 0;
    const { fetch } = fakeFetch(routes({ "/artifacts/kicklive_1.1.0_amd64.deb": { body: Buffer.from("swapped") } }));
    const res = await installArtifact(decisionFor(), "1.0.0", {
      downloadDir: dir,
      log: () => {},
      fetchImpl: fetch,
      applyMode: "system",
      spawn: async () => {
        spawned += 1;
        return { code: 0, stderr: "" };
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /checksum-mismatch/);
    assert.equal(spawned, 0, "this is the assertion that matters most in this file");
  });
});
