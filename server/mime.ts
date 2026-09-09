/**
 * Content types for the static host.
 *
 * Two invariants that the packaging/e2e gates assert directly:
 *  - JS must be served as a JavaScript MIME type or browsers refuse to run it as a module;
 *  - anything unknown is `application/octet-stream`, never `text/html` (an HTML answer to a
 *    `.js` request is exactly how "works locally, white screen in the desktop build" happens).
 */

export const EXTENSION_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonld": "application/ld+json",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".svgz": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".br": "application/brotli",
  ".deb": "application/vnd.debian.binary-package",
  ".appimage": "application/x-executable",
  ".desktop": "text/plain; charset=utf-8",
  ".appcache": "text/cache-manifest",
};

export function extname(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function contentTypeFor(filePath: string): string {
  return EXTENSION_TYPES[extname(filePath)] ?? "application/octet-stream";
}

/** `.js`, `.css`, images, fonts… i.e. "the browser asked for a file, not a route". */
const NAVIGATION_SAFE_EXTENSIONS = new Set([".html", ".htm"]);

export function isAssetExtension(filePath: string): boolean {
  const ext = extname(filePath);
  if (!ext) return false;
  return !NAVIGATION_SAFE_EXTENSIONS.has(ext);
}

export function hasAnyExtension(filePath: string): boolean {
  return extname(filePath) !== "";
}
