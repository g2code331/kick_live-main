/**
 * Manifest schema contract (spec §7.4 "manifest schema validation").
 *
 * The validator is hand-written and shared by BOTH surfaces (the desktop main process and the PWA
 * JS), so a manifest that passes here is accepted by every client. Tests are grouped by the mistake
 * a release engineer actually makes: typo'd field, hand-edited checksum, http url, wrong product.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MANIFEST_SCHEMA_VERSION, parseUpdateManifest, validateUpdateManifest } from "../../shared/update-manifest.ts";
import { manifest, sha256Of } from "../support/fixture.ts";

function codes(input: unknown, opts = {}): string[] {
  const res = validateUpdateManifest(input, opts);
  return res.ok ? [] : res.errors.map((e) => `${e.path}[${e.code}]`);
}

describe("update manifest: happy path", () => {
  it("accepts a well-formed desktop+web manifest", () => {
    const res = validateUpdateManifest(manifest());
    assert.equal(res.ok, true, JSON.stringify((res as { errors?: unknown }).errors));
    assert.equal(res.ok && res.value.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(res.ok && res.value.platforms.linux_x64?.kind, "deb");
  });

  it("accepts an unknown top-level field only when it is namespaced with x-", () => {
    assert.deepEqual(codes(manifest({ extra: { xTracker: "ci-run-42" } })), [], "x-prefixed extension fields must be allowed forward-compat");
    assert.ok(
      codes(manifest({ extra: { "some-future-field": 1 } })).some((c) => c.includes("unknown-field")),
      "unknown fields are reported, not silently ignored",
    );
  });
});

describe("update manifest: rejections", () => {
  it("requires the product id and schema version", () => {
    assert.ok(codes(manifest({ product: "kicklive-desktop" })).some((c) => c.startsWith("product")));
    const wrongSchema = { ...manifest(), schemaVersion: 2 };
    assert.ok(codes(wrongSchema).some((c) => c.startsWith("schemaVersion")));
  });

  it("requires a semver version and a parseable releasedAt", () => {
    assert.ok(codes(manifest({ version: "v1.2.0" })).some((c) => c.startsWith("version")));
    assert.ok(codes(manifest({ version: "1.2" })).some((c) => c.startsWith("version")));
    assert.ok(codes(manifest({ releasedAt: "yesterday" })).some((c) => c.startsWith("releasedAt")));
  });

  it("rejects a malformed sha256 / wrong-length sha256 / non-positive size", () => {
    const badHash = manifest({ artifact: { sha256: "deadbeef" } });
    assert.ok(
      codes(badHash).some((c) => c.includes("sha256")),
      "sha256 must be exactly 64 hex chars",
    );
    const badSize = manifest({ artifact: { size: 0 } });
    assert.ok(codes(badSize).some((c) => c.includes("size")));
    const negSize = manifest({ artifact: { size: -5 } });
    assert.ok(codes(negSize).some((c) => c.includes("size")));
  });

  it("refuses a non-https artifact url (an update is remote code execution by design)", () => {
    const httpUrl = manifest({ artifact: { url: "http://example.invalid/kicklive.deb" } });
    assert.ok(
      codes(httpUrl).some((c) => c.includes("url")),
      "http must be refused",
    );
    // ...but the local dev feed and the contract tests are allowed to opt in explicitly.
    assert.deepEqual(
      codes({ ...httpUrl, web: undefined }, { allowInsecureUrls: true }).filter((c) => c.includes("url")),
      [],
    );
    assert.ok(codes(manifest({ artifact: { url: "ftp://example.invalid/kicklive.deb" } })).some((c) => c.includes("url")));
    assert.ok(codes(manifest({ artifact: { url: "not a url" } })).some((c) => c.includes("url")));
  });

  it("requires a known platform id and at least one artifact", () => {
    assert.ok(codes(manifest({ platformId: "linux_riscv" as never })).some((c) => c.startsWith("platforms")));
    assert.ok(
      codes(manifest({ platformId: null })).some((c) => c === "platforms[minItems]"),
      "a manifest with no platforms would prompt users into a dead end",
    );
  });

  it("rejects a floor newer than the release itself", () => {
    assert.ok(codes(manifest({ version: "1.1.0", minSupportedVersion: "2.0.0" })).some((c) => c.includes("[range]")));
    assert.ok(codes(manifest({ version: "1.1.0", mandatoryBelow: "1.2.0" })).some((c) => c.includes("[range]")));
  });

  it("rejects unknown artifact kinds", () => {
    assert.ok(codes(manifest({ artifact: { kind: "msi" as never } })).some((c) => c.includes("kind")));
  });

  it("caps the release notes so a hostile feed cannot flood the dialog", () => {
    assert.deepEqual(codes(manifest({ notes: "x".repeat(4000) })), [], "4000 chars is the documented limit and must be accepted");
    assert.ok(codes(manifest({ notes: "x".repeat(4001) })).some((c) => c.startsWith("notes")));
  });

  it("validates the optional floor/ceiling fields when present", () => {
    assert.ok(codes(manifest({ mandatoryBelow: "nope" })).some((c) => c.includes("mandatoryBelow")));
    assert.ok(codes(manifest({ minSupportedVersion: "1.2" })).some((c) => c.includes("minSupportedVersion")));
    assert.deepEqual(codes(manifest({ mandatoryBelow: "1.0.5", minSupportedVersion: "0.9.0" })), []);
  });

  it("checks the web block when present", () => {
    assert.ok(codes({ ...manifest(), web: { version: "1.2" } }).some((c) => c.startsWith("web")));
    assert.ok(codes({ ...manifest(), web: { version: "1.1.0", swUrl: "http://x/sw.js" } }).some((c) => c.startsWith("web")));
    assert.ok(
      codes({ ...manifest(), web: { version: "1.1.0", swUrl: "../sw.js" } }).some((c) => c.startsWith("web")),
      "swUrl must be an absolute path or https url",
    );
  });

  it("rejects non-objects", () => {
    for (const input of [null, undefined, 42, "1.0.0", []]) {
      assert.equal(validateUpdateManifest(input).ok, false, `${String(input)} must be rejected`);
    }
  });

  it("reports every problem at once (a release run should not need five iterations)", () => {
    const broken = { schemaVersion: 3, product: "other", version: "nope", channel: "nightly", releasedAt: "soon", platforms: {} };
    const found = codes(broken);
    assert.ok(found.length >= 5, `expected >=5 errors, got ${String(found.length)}: ${found.join(",")}`);
  });
});

describe("update manifest: parsing", () => {
  it("gives a JSON-syntax error rather than a stack trace", () => {
    const res = parseUpdateManifest("{ not json ");
    assert.equal(res.ok, false);
    assert.equal(res.ok ? "" : res.errors[0]?.code, "json");
  });

  it("parses a valid document", () => {
    const res = parseUpdateManifest(JSON.stringify(manifest()));
    assert.equal(res.ok, true);
  });
});

describe("update manifest: samples in the repo", () => {
  it("packaging/updates/*.json are valid", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../..");
    for (const file of ["manifest.sample.json", "manifest.beta.json"]) {
      const full = path.join(root, "packaging/updates", file);
      if (!fs.existsSync(full)) continue;
      const res = parseUpdateManifest(fs.readFileSync(full, "utf8"), { allowInsecureUrls: false });
      assert.equal(res.ok, true, `${file}: ${JSON.stringify(res.ok ? null : res.errors)}`);
    }
  });
});
