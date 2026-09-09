/**
 * In-app smoke harness, active only when KICKLIVE_SMOKE=1 (CI runs the *built* binary with it).
 *
 * It proves the window painted a real DOM rather than a blank/errored frame, and it prints
 * machine-readable lines the CI step asserts on:
 *
 *   SMOKE_START version=<v> shell=desktop platform=<p>
 *   SMOKE_DOM title="<document.title>" rootChildren=<n> version=<v> shell=desktop
 *   SMOKE_LOAD source=<url> attempt=<n>/<total> fallback=<true|false>
 *   SMOKE_HTTP_ORIGIN http://127.0.0.1:<port>
 *   SMOKE_RESULT ok
 *
 * Exit codes: 0 = painted DOM with a mounted root, 3 = loaded but root empty, 4 = never became
 * ready (timeout), 5 = load ladder exhausted.
 */

export const SMOKE_PROBE = `(() => {
  const meta = (n) => (document.querySelector('meta[name="' + n + '"]') || {}).content || '';
  const root = document.getElementById('root');
  const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src') || '');
  return {
    title: document.title || '',
    rootChildren: root ? root.childElementCount : -1,
    rootHtmlLength: root ? (root.innerHTML || '').length : 0,
    version: meta('kicklive:version'),
    shell: meta('kicklive:shell'),
    bodyChildren: document.body ? document.body.childElementCount : -1,
    scripts,
    url: location.href,
    href: String(document.querySelector('link[rel="icon"]')?.href || ''),
    iconComplete: (() => { const i = document.querySelector('img'); return i ? (i.complete && i.naturalWidth > 0) : null; })(),
  };
})()`;

export type SmokeProbeResult = {
  title: string;
  rootChildren: number;
  rootHtmlLength: number;
  version: string;
  shell: string;
  bodyChildren: number;
  scripts: string[];
  url: string;
  href: string;
  iconComplete: boolean | null;
};

export type SmokeVerdict = { ok: boolean; exitCode: number; lines: string[]; probe?: SmokeProbeResult };

export function formatSmokeLines(parts: Record<string, string | number | boolean | undefined>): string[] {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
}

/**
 * Pure decision: probe -> verdict. Unit-tested (tests/unit/smoke-parser.test.ts) so the CI gate
 * itself cannot silently pass on a broken window.
 */
export function judgeProbe(probe: SmokeProbeResult, expected: { version: string; minRootChildren?: number }): SmokeVerdict {
  const expectedTitle = /KickLive/;
  const minChildren = expected.minRootChildren ?? 1;
  const ok = probe.rootChildren >= minChildren && probe.rootHtmlLength > 32 && expectedTitle.test(probe.title) && probe.version === expected.version;
  const detail = `SMOKE_DOM title=${JSON.stringify(probe.title)} rootChildren=${String(probe.rootChildren)} rootHtmlLength=${String(probe.rootHtmlLength)} version=${probe.version || "none"} shell=${probe.shell || "none"} scripts=${String(probe.scripts.length)} iconComplete=${String(probe.iconComplete)}`;
  if (ok) return { ok: true, exitCode: 0, lines: [detail, "SMOKE_RESULT ok"], probe };
  const reasons: string[] = [];
  if (probe.rootChildren < minChildren) reasons.push(`root has ${String(probe.rootChildren)} children`);
  if (probe.rootHtmlLength <= 32) reasons.push("root markup is empty-ish");
  if (!expectedTitle.test(probe.title)) reasons.push(`title "${probe.title}" lacks the brand`);
  if (probe.version !== expected.version) reasons.push(`version ${probe.version || "missing"} != ${expected.version}`);
  return { ok: false, exitCode: 3, lines: [detail, `SMOKE_RESULT failed reason=${reasons.join(";")}`], probe };
}

export function parseSmokeLine(line: string): { title: string; rootChildren: number; version: string; ok: boolean } | null {
  const m = /SMOKE_DOM title="((?:[^"\\]|\\.)*)" rootChildren=(\d+)/.exec(line);
  if (!m) return null;
  const version = /version=([^\s]+)/.exec(line)?.[1] ?? "";
  const result = /SMOKE_RESULT (\w+)/.exec(line)?.[1];
  return { title: JSON.parse(`"${m[1]}"`) as string, rootChildren: Number(m[2]), version, ok: result === "ok" };
}

export const SMOKE_TIMEOUT_MS = 45_000;
