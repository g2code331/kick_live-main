/**
 * Renderer load plan + the log lines that go with it.
 *
 * The desktop shell never "just" loads a file: it walks a ladder of attempts and only then falls
 * back. Keeping the ladder, the backoff table and the log format here means the Electron main
 * process, the CI smoke test and the unit tests all assert against the *same* strings.
 *
 * Documented log lines (see docs/RELEASE-PIPELINE.md § "load ladder"):
 *
 *   [kicklive:renderer] LOADED source=<url> attempt=<n>/<total>
 *   [kicklive:renderer] LOAD_FAILED attempt=<n>/<total> source=<url> error=<message> retryInMs=<ms>
 *   [kicklive:renderer] RETRY attempt=<n>/<total> inMs=<ms>
 *   [kicklive:renderer] FALLBACK_ACTIVE source=<url> attempt=<n>/<total>
 *   [kicklive:renderer] EXHAUSTED attempts=<total> lastError=<message>
 *   [kicklive:renderer] DIAGNOSTIC <key>=<value>
 */

export const LOG_PREFIX = "[kicklive:renderer]" as const;

export type LoadAttemptKind = "file" | "http" | "error-page";

export type LoadAttempt = {
  kind: LoadAttemptKind;
  /** file: absolute path; http: absolute URL; error-page: literal "builtin:" */
  target: string;
  /** short label used in logs */
  label: string;
  /** attempts at this source before moving on (>=1) */
  attempts: number;
  /** backoff between attempts of the same source, in ms */
  backoffMs: readonly number[];
  /** a fallback source only runs when the previous ones failed */
  isFallback?: boolean;
};

export type LoadPlan = {
  /** ordered; the first entry is the primary path */
  sources: LoadAttempt[];
  /** extra sources appended when KICKLIVE_RENDERER_ROOT points somewhere else (CI smoke) */
  brokenPath?: string;
};

export const DEFAULT_BACKOFF_MS = [250, 500, 1000] as const;
export const MAX_SOURCE_ATTEMPTS = 4 as const;

export function formatLog(message: string): string {
  return `${LOG_PREFIX} ${message}`;
}

/** The exact shapes the tests and the smoke script match on. */
export const LOAD_LOG_PATTERNS = {
  loaded: /\[kicklive:renderer\] LOADED source=(\S+) attempt=(\d+)\/(\d+)/,
  loadFailed: /\[kicklive:renderer\] LOAD_FAILED attempt=(\d+)\/(\d+) source=(\S+) error="([^"]*)" retryInMs=(\d+)/,
  retry: /\[kicklive:renderer\] RETRY attempt=(\d+)\/(\d+) inMs=(\d+)/,
  fallback: /\[kicklive:renderer\] FALLBACK_ACTIVE source=(\S+) attempt=(\d+)\/(\d+)/,
  exhausted: /\[kicklive:renderer\] EXHAUSTED attempts=(\d+) lastError="([^"]*)"/,
  diagnostic: /\[kicklive:renderer\] DIAGNOSTIC (\w+)=(\S*)/,
} as const;

export function describePlan(plan: LoadPlan): string {
  return plan.sources.map((s, i) => `${i + 1}:${s.kind}(${s.attempts})`).join(" -> ");
}

/**
 * Build the ladder.
 *  - `rendererIndexPath`  primary `file://` target inside the asar
 *  - `httpOrigin`          loopback origin served by the embedded static server (fallback)
 *  - `brokenPath`          when set (CI smoke), it becomes the *only* primary source so the
 *                          ladder is forced to fall back — proving the fallback fires.
 */
export function buildLoadPlan(opts: { rendererIndexPath: string; httpOrigin?: string; attemptsPerSource?: number; backoffMs?: readonly number[]; brokenPath?: string }): LoadPlan {
  const attempts = Math.max(1, Math.min(opts.attemptsPerSource ?? MAX_SOURCE_ATTEMPTS, 6));
  const backoff = opts.backoffMs && opts.backoffMs.length ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const sources: LoadAttempt[] = [];

  if (opts.brokenPath) {
    sources.push({
      kind: "file",
      target: `file://${opts.brokenPath}`,
      label: "broken-primary",
      attempts,
      backoffMs: backoff,
    });
  } else {
    sources.push({
      kind: "file",
      target: `file://${opts.rendererIndexPath}`,
      label: "asar-file",
      attempts,
      backoffMs: backoff,
    });
  }

  if (opts.httpOrigin) {
    sources.push({
      kind: "http",
      target: `${opts.httpOrigin.replace(/\/$/, "")}/`,
      label: "embedded-server",
      attempts: 2,
      backoffMs: backoff,
      isFallback: true,
    });
  }

  sources.push({
    kind: "error-page",
    target: "builtin:",
    label: "offline-diagnostic",
    attempts: 1,
    backoffMs: [],
    isFallback: true,
  });

  return { sources, brokenPath: opts.brokenPath };
}

export function delayFor(attempt: number, backoff: readonly number[]): number {
  if (backoff.length === 0) return 0;
  const idx = Math.max(0, Math.min(attempt - 1, backoff.length));
  return backoff[Math.min(idx, backoff.length - 1)] ?? 0;
}

export type LoadDeps = {
  /** perform the actual navigation; resolves when the page is committed */
  load: (attempt: LoadAttempt) => Promise<void>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /**
   * Optional: turn a source's *plan* target into the target that will actually be navigated, so the
   * logs and the LoadResult report the real URL rather than a lazy placeholder. The embedded HTTP
   * fallback is planned as the sentinel `embedded://renderer/` because its loopback port is only
   * chosen when the server starts; this hook starts it and returns `http://127.0.0.1:<port>/`, which
   * is what FALLBACK_ACTIVE / LOADED / the smoke harness expect to see. Defaults to identity.
   */
  resolve?: (attempt: LoadAttempt) => Promise<string> | string;
};

export type LoadResult = {
  ok: boolean;
  source?: string;
  label?: string;
  attemptNumber: number;
  totalAttempts: number;
  failures: number;
  lastError?: string;
  /** true when the winning source was not the primary one */
  usedFallback: boolean;
};

/**
 * Walk the ladder. Every failure emits LOAD_FAILED (with the retry delay) and every transition to
 * a fallback source emits FALLBACK_ACTIVE; running out of sources emits EXHAUSTED.
 */
export async function runLoadPlan(plan: LoadPlan, deps: LoadDeps): Promise<LoadResult> {
  const total = plan.sources.reduce((n, s) => n + s.attempts, 0);
  let attemptNumber = 0;
  let failures = 0;
  let lastError = "";
  let usedFallback = false;

  for (const [i, source] of plan.sources.entries()) {
    // Resolve the *plan* target (which may be a lazy sentinel like `embedded://renderer/`) into the
    // target that will really be navigated (`http://127.0.0.1:<port>/`), so every log line and the
    // LoadResult carry the concrete URL. Do it BEFORE FALLBACK_ACTIVE so that line names the real
    // origin. If resolving fails (e.g. the embedded server cannot start), treat it as a load failure
    // for this source and fall through to the next one rather than crashing the ladder.
    let resolvedTarget = source.target;
    let resolveError: string | null = null;
    if (deps.resolve) {
      try {
        resolvedTarget = await deps.resolve(source);
      } catch (err) {
        resolveError = err instanceof Error ? err.message : String(err);
      }
    }
    const resolvedSource: LoadAttempt = { ...source, target: resolvedTarget };
    if (i > 0 && source.isFallback) {
      usedFallback = true;
      deps.log(formatLog(`FALLBACK_ACTIVE source=${resolvedTarget} attempt=${attemptNumber + 1}/${total}`));
    }
    for (let n = 1; n <= source.attempts; n++) {
      attemptNumber += 1;
      try {
        if (resolveError) throw new Error(resolveError);
        await deps.load(resolvedSource);
        deps.log(formatLog(`LOADED source=${resolvedTarget} attempt=${attemptNumber}/${total}`));
        return {
          ok: true,
          source: resolvedTarget,
          label: source.label,
          attemptNumber,
          totalAttempts: total,
          failures,
          lastError: failures > 0 ? lastError : undefined,
          usedFallback,
        };
      } catch (err) {
        failures += 1;
        lastError = err instanceof Error ? err.message : String(err);
        const isLastAttemptOfSource = n === source.attempts;
        const nextDelay = isLastAttemptOfSource ? 0 : delayFor(n, source.backoffMs);
        deps.log(formatLog(`LOAD_FAILED attempt=${attemptNumber}/${total} source=${resolvedTarget} error="${lastError}" retryInMs=${nextDelay}`));
        if (!isLastAttemptOfSource) {
          deps.log(formatLog(`RETRY attempt=${attemptNumber + 1}/${total} inMs=${nextDelay}`));
          await deps.sleep(nextDelay);
        }
      }
    }
    // Keep DIAGNOSTIC lines tied to the source that just gave up.
    deps.log(formatLog(`DIAGNOSTIC source=${source.label} exhausted=true`));
  }

  deps.log(formatLog(`EXHAUSTED attempts=${total} lastError="${lastError}"`));
  return {
    ok: false,
    attemptNumber,
    totalAttempts: total,
    failures,
    lastError,
    usedFallback,
  };
}

/** Small helper so tests and the main process share the sleep semantics. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
