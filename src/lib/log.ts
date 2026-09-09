/**
 * Console output that respects the build mode.
 *
 * Before Phase 1 the data layer logged the rows it fetched and a heartbeat on every background
 * refresh (`[DataLoader] Data refreshed: {teams: 50, …}`), and the auth layer printed database
 * errors verbatim. Nothing in the app logged a token — that is worth stating, because it is the
 * failure mode this module exists to prevent, not one it inherits.
 *
 * A production console is still a leak: the desktop shell writes stdout to a log file, and any
 * visitor can open devtools. So `debug`/`info`/`warn` are dev-and-preview only.
 *
 * - `debug` / `info` / `warn` → dev and preview builds only.
 * - `error` → always kept, but pass a message, not a raw object with PII.
 *
 * Legacy `console.*` calls remain in 33 page/component files; they print error strings, not rows,
 * so they are noise rather than exposure. Sweeping them onto this module is a Phase 2 chore
 * (docs/SECURITY_AUDIT_PHASE1.md F-12).
 */

const VERBOSE = import.meta.env.DEV || import.meta.env.MODE === "preview";

type Sink = (msg: string, ...args: unknown[]) => void;

function prefix(args: unknown[]): string {
  const [first, ...rest] = args as [unknown, ...unknown[]];
  const head = typeof first === "string" ? first : safe(first);
  return rest.length ? `${head} ${rest.map(safe).join(" ")}` : head;
}

/** Never let an unexpected object (or a circular one) turn logging into a crash or a leak. */
function safe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, redactingReplacer);
  } catch {
    return String(value);
  }
}

const SENSITIVE_KEYS = /^(access_token|refresh_token|session|password|api_key|apikey|authorization|token|jwt)$/i;

function redactingReplacer(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.test(key)) return "[redacted]";
  return value;
}

function noop(): Sink {
  return () => {};
}

const onlyWhen = (on: boolean, sink: Sink): Sink => (on ? sink : noop());

export const log = {
  debug: onlyWhen(VERBOSE, (msg, ...a) => console.log(msg, ...a)),
  info: onlyWhen(VERBOSE, (msg, ...a) => console.info(msg, ...a)),
  warn: onlyWhen(VERBOSE, (msg, ...a) => console.warn(msg, ...a)),
  /** Survives into production on purpose — silent failure is how the polling loops went unnoticed. */
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`${msg} ${prefix(args)}`.trimEnd());
  },
};
