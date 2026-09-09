#!/usr/bin/env node
/**
 * "Does the release that is live right now actually look like an update to the version we are
 * building?" — used by the nightly job and runnable by a human:
 *
 *   node scripts/check-update-live.mjs --manifest /tmp/live.json --current "$(cat VERSION)"
 *
 * It drives the same decideUpdate() the app uses, so a manifest that would confuse a client (an
 * older version, a missing platform, an http url) is reported here instead of in someone's app.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { decideUpdate, validateUpdateManifest } from "../shared/update-manifest.ts";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const file = flag("manifest", "");
const current = flag("current", "0.0.0");
const platform = flag("platform", "linux_x64");
if (!file || !fs.existsSync(file)) {
  console.error("check-update-live: --manifest <file> is required (fetch it with curl -fsSL)");
  process.exit(2);
}
const json = JSON.parse(fs.readFileSync(file, "utf8"));
const check = validateUpdateManifest(json);
if (!check.ok) {
  console.error(`check-update-live: the LIVE manifest does not validate (${String(check.errors.length)} error(s)):`);
  for (const e of check.errors.slice(0, 12)) console.error(`  ${e.path || "(root)"} [${e.code}] ${e.message}`);
  process.exit(1);
}
const decision = decideUpdate({
  surface: "desktop",
  currentVersion: current,
  channel: check.value.channel,
  platformId: platform,
  outcome: { ok: true, manifest: check.value },
});
console.log(
  `check-update-live: manifest v${check.value.version} vs installed v${current} -> state=${decision.state} reason=${decision.reason} candidate=${decision.candidateVersion ?? "-"} prompt=${String(decision.prompt)} mandatory=${String(decision.mandatory)}`,
);
if (decision.artifact) console.log(`  artifact: ${decision.artifact.fileName} (${String(Math.round(decision.artifact.size / 1024))} KiB, ${decision.artifact.kind})`);
// Any of these is fine for a nightly: the point is that the client's policy function agrees with
// "nothing newer published" and that the manifest is structurally publishable.
if (decision.state === "error") {
  console.error("check-update-live: a client would see an ERROR state from this feed: " + (decision.detail ?? decision.reason));
  process.exit(1);
}
if (decision.state === "unknown") {
  console.error("check-update-live: a client would see 'unknown' — the feed is not usable");
  process.exit(1);
}
console.log("check-update-live: PASS");
process.exit(0);
