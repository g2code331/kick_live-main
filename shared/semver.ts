/**
 * Minimal, dependency-free semver 2.0.0 subset: parse, compare, and "never downgrade" rules.
 *
 * Deliberately small: the update contract only needs strict comparison, not range solving, so
 * that the desktop app, the PWA and the CI manifest builder all agree on one implementation.
 * Runs under plain `node` (type stripping), Vite and esbuild.
 */

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  build: readonly string[];
};

const NUM = /^(0|[1-9]\d*)$/;
const PRERELEASE = /^[0-9A-Za-z-]+$/;
const STRICT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parse(input: string): SemVer | null {
  if (typeof input !== "string") return null;
  const m = STRICT.exec(input.trim());
  if (!m) return null;
  const prerelease = m[4] ? m[4].split(".") : [];
  const build = m[5] ? m[5].split(".") : [];
  for (const p of prerelease) if (!PRERELEASE.test(p)) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    build,
  };
}

export function isValid(input: string): boolean {
  return parse(input) !== null;
}

export function format(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease.length) s += `-${v.prerelease.join(".")}`;
  if (v.build.length) s += `+${v.build.join(".")}`;
  return s;
}

function cmpNumeric(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNum = NUM.test(a);
  const bNum = NUM.test(b);
  if (aNum && bNum) return cmpNumeric(Number(a), Number(b));
  if (aNum) return -1; // numeric identifiers always have lower precedence
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: build metadata is ignored. */
export function compare(a: string | SemVer, b: string | SemVer): number {
  const va = typeof a === "string" ? parse(a) : a;
  const vb = typeof b === "string" ? parse(b) : b;
  if (!va || !vb) {
    throw new TypeError(`cannot compare non-semver values: ${String(a)} vs ${String(b)}`);
  }
  const core = cmpNumeric(va.major, vb.major) || cmpNumeric(va.minor, vb.minor) || cmpNumeric(va.patch, vb.patch);
  if (core !== 0) return core;
  // A version without prerelease outranks one with a prerelease.
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1;
  if (vb.prerelease.length === 0) return -1;
  const len = Math.min(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const c = comparePrereleaseIdentifiers(va.prerelease[i] as string, vb.prerelease[i] as string);
    if (c !== 0) return c;
  }
  return cmpNumeric(va.prerelease.length, vb.prerelease.length);
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

export function gte(a: string, b: string): boolean {
  return compare(a, b) >= 0;
}

export function eq(a: string, b: string): boolean {
  return compare(a, b) === 0;
}

/** Highest of a list, by precedence. Returns null for an empty/invalid list. */
export function maxOf(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!isValid(v)) continue;
    if (best === null || gt(v, best)) best = v;
  }
  return best;
}

/**
 * "Never downgrade" gate: an update candidate is only acceptable when it is strictly newer than
 * what is running. Rolled-back or stale manifests therefore resolve to no-op instead of
 * silently installing an older build.
 */
export function isUpgrade(candidate: string, current: string): boolean {
  try {
    return gt(candidate, current);
  } catch {
    return false;
  }
}

export function bumpVersion(current: string, kind: "major" | "minor" | "patch"): string {
  const v = parse(current);
  if (!v) throw new TypeError(`not a valid version: ${current}`);
  const next =
    kind === "major"
      ? { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: [] as string[] }
      : kind === "minor"
        ? { ...v, minor: v.minor + 1, patch: 0, prerelease: [] as string[] }
        : { ...v, patch: v.patch + 1, prerelease: [] as string[] };
  return format({ ...next, build: [] as string[] });
}
