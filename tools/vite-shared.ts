import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build-time helpers shared by the two Vite configs and the packaging scripts.
 * Lives in `tools/` because it is Node-only (fs) while still typechecked by tsconfig.node.json.
 */

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const KICKLIVE_BUILD_DEFAULTS = {
  target: "es2022",
  assetsDir: "assets",
  emptyOutDir: true,
  cssCodeSplit: true,
  reportCompressedSize: false,
  modulePreload: { polyfill: false },
} as const;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readVersionFile(root: string = REPO_ROOT): string {
  const file = path.join(root, "VERSION");
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!SEMVER.test(raw)) {
    throw new Error(`VERSION file is not a semver string: ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function kickliveVersion(): string {
  return readVersionFile();
}

export type PackageJson = {
  name: string;
  version: string;
  productName?: string;
  main?: string;
  scripts?: Record<string, string>;
  [k: string]: unknown;
};

export function readPackageJson(root: string = REPO_ROOT): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}

/** Which Vite build a script is running (web/PWA bundle vs desktop renderer). */
export type BuildTarget = "web" | "renderer";

export function outDirFor(target: BuildTarget, root: string = REPO_ROOT): string {
  return target === "web" ? path.join(root, "dist/web") : path.join(root, "renderer/dist");
}

export function rel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

export function walk(dir: string, filter?: (file: string) => boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (filter ? filter(full) : true)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function writeFileEnsured(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}
