import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The TypeScript loader in `scripts/lib/`.
 *
 * It exists because a repackaged Node build can be compiled without type stripping, and the symptom of that on a
 * perfectly good checkout is 23 identical `ERR_UNKNOWN_FILE_EXTENSION` failures — indistinguishable from a broken
 * repository to whoever hits it first. These tests are therefore not about the transpiler being clever: they are
 * about (a) the loader actually loading something Node's stripper refuses, and (b) no npm script being able to
 * forget it.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const LOADER = "./scripts/lib/ts-loader.mjs";
const patcher = read("scripts/install-ts-loader.mjs");

describe("phase 10 · the toolchain does not depend on Node's TypeScript stripping", () => {
  it("every node script runs through the loader", () => {
    const missing = Object.entries(pkg.scripts)
      .filter(([, command]) => command.startsWith("node ") && !command.includes(LOADER))
      .map(([name]) => name);
    assert.deepEqual(missing, [], `${missing.join(", ")} imports a .ts source and has no loader — run:  node scripts/install-ts-loader.mjs --write`);
  });

  it("the loader registers hooks and hands them to children without doubling the flag", () => {
    const loader = read("scripts/lib/ts-loader.mjs");
    assert.match(loader, /register\(new URL\("\.\/ts-hooks\.mjs", import\.meta\.url\)\)/, "the hooks module is registered from the loader, not from each script");
    assert.match(loader, /process\.env\.NODE_OPTIONS/, "children inherit it, which is how `node --test` gets the same treatment");
    assert.match(loader, /includes\("scripts\/lib\/ts-loader\.mjs"\)/, "and the env var is only ever set once per chain");
    assert.match(loader, /import\.meta\.url/, "with an absolute URL, so a child that changed cwd still resolves it");
  });

  it("the hook leaves alone anything that is not a TypeScript source", () => {
    const hooks = read("scripts/lib/ts-hooks.mjs");
    assert.match(hooks, /url\.endsWith\("\.d\.ts"\)/, "declaration files have no runtime module to produce");
    assert.match(hooks, /TS_LIKE\.test\(url\)/, "and non-TS specifiers go straight back to nextLoad");
    assert.match(hooks, /return nextLoad\(url, context\)/, "the pass-through is a return, not a fallthrough after work");
    assert.match(hooks, /transpileModule/, "transpile-only: no type checking, which is tsc's job in the same breath");
  });

  it("transpiles what Node's own stripper cannot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kicklive-ts-loader-"));
    const file = path.join(dir, "probe.ts");
    // `enum` is the canonical unsupported-by-erasure construct: type stripping removes annotations, it does not
    // generate the object an enum compiles to. If the loader answers 1 here, it is genuinely owning the load — a
    // test that only proved "the file imported" would pass with the hook broken and Node doing the work.
    // The reverse lookup is the point: only a compiled `enum` answers `E[1] === "A"`, so a run that merely
    // erased annotations could not satisfy this expression.
    writeFileSync(file, 'export enum E { A = 1 }\nexport const value: number = E.A + (E[1] === "A" ? 1 : 0);\n', "utf8");
    const withLoader = spawnSync(process.execPath, [`--import`, path.join(REPO, LOADER), "-e", `import(${JSON.stringify("file://" + file)}).then((m) => console.log(String(m.value)))`], {
      encoding: "utf8",
      cwd: REPO,
      // The parent's inherited NODE_OPTIONS would make this child of a test run re-enter the loader machinery; the
      // point of the assertion is that *this* invocation resolves through the hook, so it is set explicitly.
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(withLoader.status, 0, `loader run failed: ${withLoader.stderr.slice(0, 400)}`);
    assert.equal(withLoader.stdout.trim(), "2", "the enum object was emitted by the loader, not erased");

    const bare = spawnSync(process.execPath, ["-e", `import(${JSON.stringify("file://" + file)}).then(() => console.log("ok"))`], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    assert.notEqual(bare.status, 0, "and this file is a thing a bare Node (with or without stripping) must refuse, or the test proves nothing");
  });

  it("is installable, idempotent, and refuses to touch itself", () => {
    assert.match(patcher, /command\.startsWith\("node "\)/, "the rule is one the reader can verify by eye: node scripts get the flag");
    assert.match(patcher, /name !== "ci:install-loader"/, "and the patcher's own entry is excluded, or --write would patch itself into an infinite loop");
    assert.match(patcher, /if \(needs\.length === 0\)/, "a second run is a report, not a re-write");
    assert.match(patcher, /process\.exit\(1\)/, "while a report run exits non-zero, so CI can demand the patch has landed");
    assert.match(patcher, /JSON\.stringify\(pkg, null, 2\)/, "and it re-writes two-space JSON, the shape prettier enforces here");
  });

  it("fails with an instruction rather than a stack when the compiler is absent", () => {
    const hooks = read("scripts/lib/ts-hooks.mjs");
    assert.match(hooks, /npm ci/, "the message names the fix");
    assert.match(hooks, /loadCompiler/, "and the import is behind a guard, not at module top level");
  });
});
