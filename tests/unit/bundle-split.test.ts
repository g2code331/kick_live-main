/**
 * Phase 4 · the route split and the chunk grouping, pinned at source level so they fail here rather than in
 * a browser.
 *
 * `scripts/bundle-budget.mjs` measures the built bytes, but it can only run after a build, and the two
 * failures it exists to catch have causes that are visible without one: a portal re-imported statically (the
 * bundler then merges 185 KiB back into the boot chunk and the total still builds), and a `manualChunks`
 * regex that splits React from itself (which builds fine and throws "Invalid hook call" at runtime). Both are
 * config/text facts, so both are asserted against the files. The build-time check stays where it is:
 * `npm run build:web` runs the budget after every web build.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { kickliveManualChunks } from "../../tools/vite-shared.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

const app = read("src/App.tsx");
const shared = read("tools/vite-shared.ts");
const budget = JSON.parse(read("scripts/bundle-budget.json")) as {
  bootBytesMax: number;
  bootGzippedBytesMax: number;
  bootCssBytesMax: number;
  mustBeOwnChunk: string[];
  note: string;
};

describe("bundle split · the route table", () => {
  const lazyRoutes = [...app.matchAll(/const (\w+) = lazy\(\(\) => import\("(\.\/[^"]+)"\)\)/g)].map((m) => ({ name: m[1], file: m[2] }));
  const lazyNames = new Set(lazyRoutes.map((r) => r.name));

  it("keeps every portal and every secondary screen behind a dynamic import", () => {
    for (const name of ["AdminPortal", "TeamOwnerPortal", "TeamPortal", "MediaPortal", "MatchDetails", "StandingsPage", "TeamsPage", "MatchesPage", "NewsPage", "LoginPage", "SignupPage"]) {
      assert.ok(lazyNames.has(name), `${name} is not lazy — its chunk belongs in the admin's or visitor's path, not every visitor's boot`);
      assert.ok(!new RegExp(`^import ${name} from`, "m").test(app), `${name} is imported statically as well as lazily, which merges it back into the entry chunk`);
    }
  });

  it("keeps HomePage static, because it is what the first paint renders", () => {
    assert.match(app, /^import HomePage from "\.\/pages\/HomePage"/m, "HomePage must not be lazy: the fan's landing view would otherwise wait on a second round trip");
  });

  it("wraps the routes in Suspense with the brand fallback, above the route table only", () => {
    assert.match(app, /<Suspense fallback=\{<RouteFallback \/>\}>/, "the split needs a fallback or a slow route is a blank screen");
    // Position in the file is the cheap proxy for nesting here: `<Suspense>` appears inside `AppContent`, which
    // the providers wrap, and after the `<AppBackground />` it must not hide.
    const suspenseAt = app.indexOf("<Suspense");
    assert.ok(suspenseAt > app.indexOf("function AppContent"), "Suspense must sit below the providers, or a chunk that fails to load blanks the shell including its auth state");
    assert.ok(suspenseAt > app.indexOf("<AppBackground />"), "AppBackground renders immediately; the fallback only replaces the route, not the page");
    const fallback = read("src/components/RouteFallback.tsx");
    assert.match(fallback, /role="status"/, "a loader that screen readers never announce is a loader nobody knows the reason for");
    assert.match(fallback, /motion-reduce:/, "the app's existing reduced-motion rule applies to a new animation too");
    assert.match(fallback, /brand\/icon-192\.png/, "the fallback reuses the mark the header already downloaded instead of adding bytes to the wait");
  });

  it("does not lazify FanPortal, which has never had a route", () => {
    // Comments are stripped first, and deliberately: App.tsx *explains* why FanPortal is not imported, and a
    // pin that matched the explanation would be measuring prose rather than imports.
    const appCode = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/FanPortal/.test(appCode), "FanPortal.tsx is unrouted; a dynamic import of an unrouted screen emits an orphan chunk and hides the fact that nothing links to it");
    assert.ok(fs.existsSync(path.join(REPO, "src/pages/portals/FanPortal.tsx")), "the screen stays in the tree for the route it will get in a later phase");
  });
});

describe("bundle split · the vendor grouping", () => {
  // `kickliveManualChunks` is imported rather than re-typed: the point of the test is the config the two Vite
  // builds actually spread, and `tools/vite-shared.ts` is Node-only (fs/crypto), so importing it is safe.

  it("puts the whole React family in one chunk", () => {
    for (const id of [
      "node_modules/react/index.js",
      "node_modules/react-dom/client.js",
      "node_modules/react/cjs/react-jsx-runtime.production.js",
      "node_modules/scheduler/index.js",
      "node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/index.js",
    ]) {
      assert.equal(kickliveManualChunks(id), "vendor-react", `${id} must share React's chunk; a second copy of React fails at runtime, not at build time`);
    }
  });

  it("does not swallow everything with react in its name", () => {
    assert.notEqual(kickliveManualChunks("node_modules/react-router-dom/dist/index.js"), "vendor-react", "the router in React's chunk couples the router's release to React's cache key");
    assert.equal(kickliveManualChunks("node_modules/react-router-dom/dist/index.js"), undefined);
  });

  it("groups the Supabase client, which is the largest thing a fan downloads", () => {
    assert.equal(kickliveManualChunks("node_modules/@supabase/supabase-js/dist/module/index.js"), "vendor-supabase");
    assert.equal(kickliveManualChunks("node_modules/@supabase/postgrest-js/dist/cjs/index.js"), "vendor-supabase");
  });

  it("leaves app code alone", () => {
    assert.equal(kickliveManualChunks(path.join(REPO, "src/pages/HomePage.tsx")), undefined);
    assert.equal(kickliveManualChunks("node_modules/vite/dist/node/index.js"), undefined, "only the three families named here are grouped; everything else keeps the bundler's own graph");
  });
});

describe("bundle split · the budget file", () => {
  it("is a ceiling above the current build and states what it is for", () => {
    assert.ok(budget.bootBytesMax > 400 * 1024, "a ceiling under the current build would fail every build and be switched off within a day");
    assert.ok(budget.bootBytesMax < 900 * 1024, "a ceiling above the pre-split 917 KiB measures nothing");
    assert.ok(budget.bootGzippedBytesMax < 300 * 1024);
    assert.ok(budget.bootCssBytesMax > 100 * 1024 && budget.bootCssBytesMax < 256 * 1024);
    assert.match(budget.note, /headroom/);
    assert.deepEqual(budget.mustBeOwnChunk, ["AdminPortal", "TeamOwnerPortal", "MediaPortal", "TeamPortal", "MatchDetails", "StandingsPage"]);
  });

  it("names the scripts that own the numbers", () => {
    const script = read("scripts/bundle-budget.mjs");
    assert.match(script, /FAN_BOOT_CHUNKS/);
    assert.match(script, /react\.element/, "the React-copy count is what makes the vendor split safe to gate on");
    assert.match(read("scripts/build-web.mjs"), /bundle-budget\.json/, "and the gate runs from the build itself");
  });
});
