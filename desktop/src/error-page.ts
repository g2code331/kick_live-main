/**
 * The last-resort diagnostic page.
 *
 * Shown only when every load source failed (missing renderer, half-copied asar, bad
 * KICKLIVE_RENDERER_ROOT). It deliberately contains machine-readable markers so the CI smoke test
 * can assert "the fallback chain ended in a real painted DOM, not a blank window":
 * `data-kicklive="renderer-error"` plus `id="kicklive-error-page"`.
 */

import { BRAND } from "../../shared/branding.ts";

export type ErrorPageInput = {
  version: string;
  attempts: number;
  totalAttempts: number;
  lastError: string;
  rendererRoot: string;
  indexHtml: string;
  httpOrigin?: string;
  logFile: string | null;
  platform: string;
};

/**
 * This page is loaded as a `data:` URL, where the session-level CSP header does not apply, so it
 * declares its own. `default-src 'none'` plus inline styles only: the diagnostic page must not be a
 * way to execute anything, even for an attacker who can write into the app directory.
 */
export const ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderErrorPage(input: ErrorPageInput): string {
  const rows: [string, string][] = [
    ["product", `${BRAND.displayName} ${input.version}`],
    ["platform", input.platform],
    ["attempts", `${String(input.attempts)} of ${String(input.totalAttempts)}`],
    ["renderer root", input.rendererRoot],
    ["expected index", input.indexHtml],
    ["fallback server", input.httpOrigin ?? "not started"],
    ["last error", input.lastError.length > 0 ? input.lastError : "unknown"],
    ["log file", input.logFile ?? "not writable"],
  ];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${ERROR_PAGE_CSP}" />
    <title>${esc(BRAND.displayName)} | renderer failed to load</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; padding: 40px 24px; background: ${esc(BRAND.colors.bg)}; color: #fff;
             font: 400 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 760px; margin: 0 auto; }
      h1 { font-size: 22px; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 6px; }
      .accent { color: ${esc(BRAND.colors.green)}; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
      th { width: 160px; color: rgba(255,255,255,.5); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
      ul { margin: 18px 0 0; padding-left: 18px; color: rgba(255,255,255,.75); }
      .hint { margin-top: 20px; color: rgba(255,255,255,.6); font-size: 13px; }
      button { margin-top: 22px; background: ${esc(BRAND.colors.green)}; color: #000; border: 0; border-radius: 8px;
               padding: 10px 16px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; cursor: pointer; }
    </style>
  </head>
  <body>
    <main id="kicklive-error-page" data-kicklive="renderer-error" data-attempts="${String(input.attempts)}">
      <h1>Renderer <span class="accent">failed to load</span></h1>
      <p>The ${esc(BRAND.displayName)} window is alive, but it could not find its interface files. Nothing in the
         app data changed — this is a packaging or path problem, not a data problem.</p>
      <table>
        ${rows.map((row) => `<tr><th scope="row">${esc(row[0])}</th><td><code>${esc(row[1])}</code></td></tr>`).join("\n        ")}
      </table>
      <ul>
        <li>Reinstall the package (dpkg -i ${esc(BRAND.id)}_*.deb), or</li>
        <li>check that <code>renderer/dist/index.html</code> exists inside <code>${esc(BRAND.installDir)}/resources/app.asar</code>, or</li>
        <li>unset <code>KICKLIVE_RENDERER_ROOT</code> if you exported it.</li>
      </ul>
      <p class="hint">Fix the install, then reload the window with <code>Ctrl+R</code>. Nothing here needs to run JavaScript, so this page ships a CSP that forbids it.</p>
    </main>
  </body>
</html>
`;
}

/** `data:` URL form — no temp file, no privileged write, works with the sandbox on. */
export function errorPageDataUrl(input: ErrorPageInput): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderErrorPage(input))}`;
}
