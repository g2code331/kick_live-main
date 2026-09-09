import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Tiny command runner shared by every script: one place for "print what you ran". */

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function relPath(root, p) {
  return path.relative(root, p).split(path.sep).join("/");
}

export function tail(text, n = 12) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
}

/**
 * @param {string} label
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, echo?: boolean, tailLines?: number}} [opts]
 */
export function run(label, cmd, args, opts = {}) {
  const echo = opts.echo !== false;
  if (echo) console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const combined = stdout + (stderr ? `\n${stderr}` : "");
  if (echo && combined.trim()) process.stdout.write(combined.endsWith("\n") ? combined : combined + "\n");
  if (res.error) {
    return { label, code: -1, ok: false, stdout: combined, stderr: String(res.error), command: [cmd, ...args].join(" ") };
  }
  return {
    label,
    code: res.status ?? 1,
    ok: res.status === 0,
    stdout: combined,
    stderr,
    command: [cmd, ...args].join(" "),
  };
}

/** Start a long-lived process, capture its output, and hand back a kill switch. */
export function start(label, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  proc.stdout.on("data", (c) => (buffer += String(c)));
  proc.stderr.on("data", (c) => (buffer += String(c)));
  return {
    label,
    command: [cmd, ...args].join(" "),
    get output() {
      return buffer;
    },
    async wait(ms) {
      await new Promise((r) => setTimeout(r, ms));
      return buffer;
    },
    kill() {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
}

export function which(bin) {
  const res = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

export function listFiles(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && (filter ? filter(full) : true)) out.push(full);
    }
  }
  return out.sort();
}

export class Report {
  constructor(title) {
    this.title = title;
    this.rows = [];
  }
  add(name, status, detail = "") {
    this.rows.push({ name, status, detail });
    const mark = status === "PASS" ? "✅" : status === "SKIP" ? "➖" : "❌";
    console.log(`${mark} ${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
    return this;
  }
  failed() {
    return this.rows.some((r) => r.status === "FAIL");
  }
  table() {
    const w = Math.max(...this.rows.map((r) => r.name.length), 12);
    const lines = [`${this.title}`, "-".repeat(w + 34)];
    for (const r of this.rows) {
      lines.push(`${r.name.padEnd(w)}  ${r.status.padEnd(4)}  ${r.detail}`);
    }
    return lines.join("\n");
  }
}
