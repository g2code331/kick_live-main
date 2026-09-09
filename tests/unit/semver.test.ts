/**
 * semver: the ordering primitive every never-downgrade rule rests on, so it gets tested directly
 * rather than only through the manifest policy.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bumpVersion, compare, eq, format, gt, gte, isUpgrade, isValid, lt, maxOf, parse } from "../../shared/semver.ts";

describe("semver.parse", () => {
  it("accepts the shapes a release tag can produce", () => {
    for (const input of ["1.0.0", "0.0.1", "10.20.30", "1.2.3-beta.1", "1.2.3+build.5", "1.2.3-rc.1+build.7"]) {
      assert.ok(isValid(input), `${input} should be valid`);
      const p = parse(input);
      assert.ok(p, `${input} should parse`);
      assert.equal(format(p!), input, `${input} round-trips through parse/format`);
    }
  });

  it("rejects non-semver without throwing", () => {
    for (const input of ["", "1", "1.2", "v1.2.3", "1.2.3.4", "1.2.x", "latest", "1.2.3-", "1.2.3+"]) {
      assert.equal(isValid(input), false, `${JSON.stringify(input)} must be rejected`);
    }
    assert.equal(parse("nope"), null);
  });
});

describe("semver.compare", () => {
  it("orders numerically, not lexically", () => {
    assert.equal(compare("1.10.0", "1.9.0"), 1);
    assert.equal(compare("1.2.100", "1.2.99"), 1);
    assert.equal(compare("2.0.0", "10.0.0"), -1);
    assert.equal(compare("1.0.0", "1.0.0"), 0);
  });

  it("a pre-release sorts below its release", () => {
    assert.equal(compare("1.2.3-beta", "1.2.3"), -1);
    assert.equal(compare("1.2.3-beta.2", "1.2.3-beta.10"), -1);
    assert.equal(gt("1.2.3-beta.10", "1.2.3-beta.2"), true);
  });

  it("ignores build metadata for precedence", () => {
    assert.equal(compare("1.2.3+build.1", "1.2.3+build.2"), 0);
    assert.equal(eq("1.2.3+a", "1.2.3+b"), true);
  });

  it("gte/lt behave at the boundary (this is the never-downgrade edge)", () => {
    assert.equal(gte("1.1.0", "1.1.0"), true);
    assert.equal(lt("1.1.0", "1.1.0"), false);
    assert.equal(isUpgrade("1.1.0", "1.1.0"), false, "equal versions are not an upgrade");
    assert.equal(isUpgrade("1.0.9", "1.1.0"), false, "older is never an upgrade");
    assert.equal(isUpgrade("1.1.1", "1.1.0"), true);
  });

  it("throws on garbage instead of silently comparing", () => {
    assert.throws(() => compare("garbage", "1.0.0"));
  });
});

describe("semver.maxOf / bumpVersion", () => {
  it("picks the highest, tolerating empties", () => {
    assert.equal(maxOf([]), null);
    assert.equal(maxOf(["1.0.0", "1.0.1", "0.9.9"]), "1.0.1");
    assert.equal(maxOf(["garbage", "1.4.2"]), "1.4.2", "invalid entries must not win");
  });

  it("bumps for the version script", () => {
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    assert.equal(bumpVersion("1.2.3-beta.1", "minor"), "1.3.0", "bumping clears the pre-release tag");
  });
});
