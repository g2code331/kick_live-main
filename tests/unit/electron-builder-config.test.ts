/**
 * electron-builder.yml is validated against the builder's own JSON schema.
 *
 * Why this exists: the desktop job is the slowest gate in the pipeline (it downloads the Electron
 * runtime and then fpm before it can fail), and a config typo fails it at the very end. Worse, the
 * failure message is useless — `DebOptions` sets `additionalProperties: false`, so when this file
 * said `section: web` (renamed to `packageCategory` in electron-builder 26) the builder only
 * reported the anyOf branch it knew how to print:
 *
 *     - configuration.deb should be one of these:
 *       null
 *
 * with the real cause (one unknown key) buried in the branch it did not expand. Validating the
 * file here turns that into a named key in a two-second unit test.
 *
 * The schema ships inside app-builder-lib, a transitive dependency of electron-builder, so the
 * test says so loudly instead of silently passing on a checkout where it is not installed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = path.join(REPO_ROOT, "electron-builder.yml");
const SCHEMA = path.join(REPO_ROOT, "node_modules", "app-builder-lib", "scheme.json");

/** The compiled ajv validator, or null when app-builder-lib is not installed. */
async function validator(): Promise<null | ((cfg: unknown) => string[])> {
  if (!fs.existsSync(SCHEMA)) return null;
  // ESM/CJS interop: ajv exposes its constructor as `default` to ESM importers.
  const mod: any = await import("ajv");
  const Ajv = mod.default ?? mod;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA, "utf8")));
  return (cfg: unknown) => {
    if (validate(cfg)) return [];
    return (validate.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  };
}

describe("electron-builder.yml", () => {
  it("matches the electron-builder schema for the installed version", async () => {
    assert.ok(fs.existsSync(CONFIG), "electron-builder.yml is missing");
    const validate = await validator();
    assert.ok(validate, `app-builder-lib/scheme.json not found at ${SCHEMA} — is electron-builder installed?`);
    const errors = validate!(parseYaml(fs.readFileSync(CONFIG, "utf8")));
    assert.deepEqual(errors, [], `electron-builder.yml does not match the builder's schema:\n  ${errors.join("\n  ")}`);
  });

  it("keeps the deb Section that verify-packaging's C1e asserts", () => {
    // `packageCategory` becomes fpm's --category, i.e. the deb control `Section` field. Spelling
    // the key `section` (the pre-26 name) is what broke the desktop job, so assert both halves:
    // the key the schema wants, and the value the layout test reads back out of the built .deb.
    const cfg = parseYaml(fs.readFileSync(CONFIG, "utf8")) as { deb?: Record<string, unknown> };
    assert.equal(cfg.deb?.packageCategory, "web");
    assert.equal(cfg.deb?.section, undefined, "`section` was renamed to `packageCategory` in electron-builder 26");
  });
});
