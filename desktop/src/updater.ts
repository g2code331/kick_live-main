/**
 * The privileged half of desktop updates: download → verify → hand off to the system package
 * manager. Nothing in this file imports electron, so the whole flow runs under `node --test`
 * against a local HTTP fixture (tests/integration/updater.test.ts).
 *
 * Design rules, all of them tested:
 *  - the manifest's sha256/size are verified on the *downloaded bytes* before anything executes;
 *  - on any mismatch the file is deleted and the install is refused (documented log line);
 *  - the running version is re-checked immediately before hand-off (never downgrade);
 *  - we never `exec` as root ourselves: a .deb goes through pkexec so the user sees the prompt.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { PlatformArtifact, UpdateDecision } from "../../shared/update-manifest.ts";
import { compare, isValid } from "../../shared/semver.ts";
import { verifyDownloadedArtifact } from "../../shared/update-manifest.ts";

export type SpawnResult = { code: number; stderr: string };
export type SpawnFn = (command: string, args: string[]) => Promise<SpawnResult>;

export type UpdaterDeps = {
  downloadDir: string;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  spawn?: SpawnFn;
  /** "system" runs pkexec/apt; "manual" (default) only stages the file and reports the command */
  applyMode?: "manual" | "system";
  timeoutMs?: number;
};

export type StageResult = { ok: true; file: string; sha256: string; size: number; detail: string } | { ok: false; reason: string; detail: string; file?: string };

export type InstallOutcome = { ok: boolean; detail: string; staged?: string; command?: string };

const defaultSpawn: SpawnFn = (command, args) =>
  new Promise<SpawnResult>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: 127, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });

function sanitizeName(fileName: string): string {
  const base = path.basename(fileName);
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(base) && !base.includes("..") ? base : "kicklive-update.bin";
}

async function sha256OfFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const buf = fs.readFileSync(file);
  hash.update(buf);
  return { sha256: hash.digest("hex"), size: buf.length };
}

/** Download + verify only. Safe to call from a test with a local server. */
export async function stageArtifact(artifact: PlatformArtifact, deps: UpdaterDeps): Promise<StageResult> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const name = sanitizeName(artifact.fileName);
  const finalPath = path.join(deps.downloadDir, name);
  const partPath = `${finalPath}.part`;
  fs.mkdirSync(deps.downloadDir, { recursive: true });

  deps.log(`[kicklive:updates] DOWNLOAD_START url=${artifact.url} file=${name} expectedBytes=${String(artifact.size)}`);
  let body: ArrayBuffer;
  try {
    if (typeof doFetch !== "function") throw new Error("fetch unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);
    try {
      const res = await doFetch(artifact.url, { signal: controller.signal, cache: "no-store" } as RequestInit);
      if (!res.ok) {
        return { ok: false, reason: "download-failed", detail: `HTTP ${String(res.status)} fetching artifact` };
      }
      body = await res.arrayBuffer();
    } finally {
      // Without this the 120s timer outlives a failed download and keeps the process alive, which
      // showed up as a two-minute hang on exit in the updater unit tests.
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, reason: "download-failed", detail: (err as Error).message };
  }

  const bytes = Buffer.from(body);
  fs.writeFileSync(partPath, bytes, { mode: 0o600 });
  const actual = await sha256OfFile(partPath);
  const verdict = verifyDownloadedArtifact({
    declared: { sha256: artifact.sha256, size: artifact.size },
    actual: { sha256: actual.sha256, size: actual.size },
  });
  if (!verdict.ok) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    deps.log(`[kicklive:updates] REFUSE_INSTALL reason=${verdict.reason} detail="${verdict.detail ?? ""}"`);
    return { ok: false, reason: verdict.reason, detail: verdict.detail ?? "verification failed" };
  }
  fs.renameSync(partPath, finalPath);
  deps.log(`[kicklive:updates] DOWNLOAD_VERIFIED file=${name} sha256=${actual.sha256} bytes=${String(actual.size)}`);
  return {
    ok: true,
    file: finalPath,
    sha256: actual.sha256,
    size: actual.size,
    detail: `staged ${name} (${String(Math.round(actual.size / 1024))} KiB, sha256 verified)`,
  };
}

export function installCommandFor(kind: PlatformArtifact["kind"], file: string): { command: string; args: string[] } {
  switch (kind) {
    case "deb":
      return { command: "pkexec", args: ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", file] };
    case "appimage":
    case "tar.gz":
      return { command: "/bin/sh", args: ["-c", `chmod +x '${file}' && '${file}' --updated >/dev/null 2>&1 &`] };
    default:
      return { command: "xdg-open", args: [file] };
  }
}

/**
 * Full hand-off: stage, re-check the version against what is running, then either print the
 * command (manual) or run it (system). Returns a structured result for the header control.
 */
export async function installArtifact(decision: UpdateDecision, runningVersion: string, deps: UpdaterDeps): Promise<InstallOutcome> {
  const artifact = decision.artifact;
  const candidate = decision.candidateVersion;
  if (!artifact || !candidate) {
    return { ok: false, detail: "refused: no artifact in this decision" };
  }
  if (isValid(runningVersion) && compare(candidate, runningVersion) <= 0) {
    deps.log(`[kicklive:updates] REFUSE_INSTALL reason=never-downgrade detail="candidate=${candidate} running=${runningVersion}"`);
    return { ok: false, detail: `refused: ${candidate} is not newer than ${runningVersion}` };
  }

  const staged = await stageArtifact(artifact, deps);
  if (!staged.ok) return { ok: false, detail: `refused: ${staged.reason} — ${staged.detail}`, staged: staged.file };

  const { command, args } = installCommandFor(artifact.kind, staged.file);
  const quoted = [command, ...args].join(" ");
  if ((deps.applyMode ?? "manual") !== "system") {
    deps.log(`[kicklive:updates] STAGED_FOR_USER command="${quoted}"`);
    return {
      ok: true,
      detail: `verified and staged; run: ${quoted}`,
      staged: staged.file,
      command: quoted,
    };
  }
  deps.log(`[kicklive:updates] INSTALL_HANDOFF kind=${artifact.kind} command="${quoted}"`);
  const result = await (deps.spawn ?? defaultSpawn)(command, args);
  if (result.code !== 0) {
    deps.log(`[kicklive:updates] INSTALL_FAILED code=${String(result.code)} detail="${result.stderr.slice(0, 400).replace(/\s+/g, " ")}"`);
    return { ok: false, detail: `installer exited ${String(result.code)}: ${result.stderr.slice(0, 200)}`, staged: staged.file, command: quoted };
  }
  deps.log(`[kicklive:updates] INSTALL_OK version=${candidate}`);
  return { ok: true, detail: `installed ${candidate}; restart to finish`, staged: staged.file, command: quoted };
}
