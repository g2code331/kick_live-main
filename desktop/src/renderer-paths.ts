/**
 * Where the renderer lives, in both the packed app and a plain checkout.
 *
 * Packed:   <resources>/app.asar/renderer/dist/index.html   (asar keeps index.html, the
 *           hashed assets under renderer/dist/assets are asar-unpacked on purpose — the embedded
 *           HTTP fallback server stats/streams them directly, and the layout test asserts both
 *           halves of that split).
 * Checkout: <repo>/renderer/dist/index.html, produced by `npm run build:renderer`.
 */

import fs from "node:fs";
import path from "node:path";

export type RendererRoots = {
  /** directory that holds index.html + assets/ */
  root: string;
  indexHtml: string;
  /** true when running from an asar archive */
  packed: boolean;
};

export function resolveRendererRoot(opts: { appPath: string; isPackaged: boolean; override?: string }): RendererRoots {
  // cwd is a dev-only convenience: a packaged app must never pick up an index.html from whatever
  // directory it happened to be launched from (that is how a stray checkout shadows the asar).
  const candidates = [opts.override, path.join(opts.appPath, "renderer", "dist"), path.join(opts.appPath, "..", "renderer", "dist"), opts.isPackaged ? undefined : process.cwd()].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );

  for (const root of candidates) {
    const indexHtml = path.join(root, "index.html");
    if (fs.existsSync(indexHtml)) {
      return { root, indexHtml, packed: root.includes(`app.asar${path.sep}`) || root.endsWith("app.asar") };
    }
  }
  const root = candidates[0] ?? opts.appPath;
  return { root, indexHtml: path.join(root, "index.html"), packed: false };
}

/** The path handed to the load plan; may not exist, which is exactly what the ladder must survive. */
export function rendererIndexPath(roots: RendererRoots): string {
  return roots.indexHtml;
}

export function describeRoots(roots: RendererRoots): string {
  return `root=${roots.root} index=${roots.indexHtml} packed=${String(roots.packed)}`;
}
