/**
 * Phase 18 · the client push opt-in surface — the last link in the notification chain.
 *
 * The Worker already sends real FCM messages (workers/src/services/fcm.ts); what was missing was a client
 * that obtains a registration token and hands it to POST /notifications/devices. These tests pin the two
 * pieces that are testable without a browser:
 *
 *   1. The config gate degrades, never throws. With no VITE_FIREBASE_* (node has no import.meta.env — the
 *      "deploy lost its env vars" shape, same as phase1-security relies on) push reports itself
 *      unconfigured and the app falls back to the in-app inbox. A score is never gated on a Firebase key.
 *   2. The background-push service worker generator is faithful: it bakes the PUBLIC config in when
 *      present, writes nothing when absent, and removes any stale worker — so an unconfigured build never
 *      ships a dead push worker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { isPushConfigured, getFirebaseConfig } from "../../src/lib/push/firebase-config.ts";
import { buildFirebaseSw, firebaseConfigForMode } from "../../scripts/build-firebase-sw.mjs";

const FIREBASE_ENV = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_VAPID_KEY",
];

/** Run `fn` with the given VITE_FIREBASE_* set, restoring the exact prior state (delete vs value) after. */
async function withFirebaseEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const name of FIREBASE_ENV) prior.set(name, process.env[name]);
  // Start from a clean slate so a leftover value cannot bleed in, then apply the requested pairs.
  for (const name of FIREBASE_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) process.env[name] = value;
  try {
    await fn();
  } finally {
    for (const name of FIREBASE_ENV) {
      const was = prior.get(name);
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  }
}

const FULL_CONFIG = {
  VITE_FIREBASE_API_KEY: "AIzaTEST",
  VITE_FIREBASE_PROJECT_ID: "kicklive-test",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "9001",
  VITE_FIREBASE_APP_ID: "1:9001:web:deadbeef",
};

describe("phase18 push · the config gate degrades instead of throwing", () => {
  it("reports unconfigured with no VITE_FIREBASE_* present", () => {
    // In node there is no import.meta.env — exactly the shape of a deploy that never set the vars.
    assert.equal(isPushConfigured(), false);
    assert.equal(getFirebaseConfig(), null);
  });
});

describe("phase18 push · the background-push service worker generator", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicklive-fbsw-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("derives a complete config from a project id and its neighbours, filling the console defaults", async () => {
    await withFirebaseEnv(FULL_CONFIG, async () => {
      const config = await firebaseConfigForMode(undefined);
      assert.ok(config, "a full set of required vars must yield a config");
      assert.equal(config.projectId, "kicklive-test");
      assert.equal(config.authDomain, "kicklive-test.firebaseapp.com", "authDomain defaults to <projectId>.firebaseapp.com");
      assert.equal(config.storageBucket, "kicklive-test.appspot.com", "storageBucket defaults to <projectId>.appspot.com");
    });
  });

  it("writes a worker that initialises Firebase and handles background messages when configured", async () => {
    await withFirebaseEnv(FULL_CONFIG, async () => {
      const res = await buildFirebaseSw({ outDir: tmp, mode: undefined, log: () => {} });
      assert.equal(res.written, true);
      const sw = fs.readFileSync(path.join(tmp, "firebase-messaging-sw.js"), "utf8");
      assert.match(sw, /firebase-messaging-compat\.js/, "pulls the messaging SDK");
      assert.match(sw, /"projectId": "kicklive-test"/, "bakes the public project id in");
      assert.match(sw, /onBackgroundMessage/, "handles a push that arrives with the tab closed");
      assert.match(sw, /notificationclick/, "a click routes to the deep link");
      // The public config is fine to ship; a service-account private key is not — assert it never leaks in.
      assert.doesNotMatch(sw, /private_key|BEGIN [A-Z ]*PRIVATE KEY|FCM_SERVICE_ACCOUNT/, "no server credential may enter a browser file");
    });
  });

  it("writes nothing and removes a stale worker when unconfigured", async () => {
    await withFirebaseEnv({}, async () => {
      const stale = path.join(tmp, "firebase-messaging-sw.js");
      fs.writeFileSync(stale, "// left over from a previous configured build");
      const res = await buildFirebaseSw({ outDir: tmp, mode: undefined, log: () => {} });
      assert.equal(res.written, false, "an unconfigured build writes no push worker");
      assert.equal(fs.existsSync(stale), false, "and it removes any stale worker so no dead push worker ships");
    });
  });
});
