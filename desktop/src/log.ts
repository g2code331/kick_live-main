/**
 * Main-process logging.
 *
 * Two sinks, same bytes: stderr (what `xvfb-run` captures in CI) and a rotating-enough file under
 * userData/logs (what a user pastes into a bug report). The renderer-load / updates lines are
 * emitted verbatim so the CI smoke test can assert on them without parsing a log framework.
 */

import fs from "node:fs";
import path from "node:path";

export type Logger = {
  line: (text: string) => void;
  error: (text: string) => void;
  logFile: string | null;
  /** no-op: lines are appended synchronously so they survive an abrupt app.exit() in CI */
  flushSync: () => void;
};

export type LoggerOptions = {
  userDataDir?: string;
  /** CI asserts on stderr content; tests silence it */
  quiet?: boolean;
  echo?: (text: string) => void;
  filePrefix?: string;
};

export function createLogger(opts: LoggerOptions = {}): Logger {
  let logFile: string | null = null;

  if (opts.userDataDir) {
    try {
      const dir = path.join(opts.userDataDir, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      logFile = path.join(dir, `${opts.filePrefix ?? "main"}-${stamp}.log`);
      fs.appendFileSync(logFile, "");
    } catch {
      logFile = null;
    }
  }

  const echo = opts.echo ?? ((text: string) => process.stderr.write(text + "\n"));

  return {
    logFile,
    line(text: string) {
      const stamped = `${new Date().toISOString()} ${text}`;
      if (!opts.quiet) echo(stamped);
      if (logFile) {
        try {
          fs.appendFileSync(logFile, stamped + "\n");
        } catch {
          /* a full disk must never take the app down */
        }
      }
    },
    error(text: string) {
      this.line(text);
    },
    flushSync() {
      /* synchronous appends: nothing to flush */
    },
  };
}
