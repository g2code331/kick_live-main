/**
 * Registers the esbuild `load` hook for TypeScript sources, so every `node` invocation in this repository's
 * toolchain can import `.ts` files regardless of whether the running Node was built with type stripping.
 *
 * Passed to Node as `--import ./scripts/lib/ts-loader.mjs` by the `node …` entries in `package.json`, which is the
 * only place the flag can be added: the toolchain scripts import their `.ts` dependencies *statically* (a checker
 * reading `workers/src/router.ts` reads the same artifact the app ships), and by the time any code in such a
 * script runs, the module graph — including the `.ts` files — has already been loaded or failed. A guard call
 * inside the script would arrive one step too late; a flag on the command line arrives before resolution.
 *
 * NODE_OPTIONS is then extended with the same `--import`, using this file's absolute URL, so children inherit it:
 * `scripts/gates.mjs` runs `scripts/run-tests.mjs`, which spawns `node --test tests/unit/*.ts`, and each of those
 * test files imports more `.ts`. Inheriting one environment variable is what makes the whole tree work with one
 * flag at the top, and the dedup check is what keeps a deep spawn chain from growing it forever.
 */
import { register } from "node:module";

register(new URL("./ts-hooks.mjs", import.meta.url));

const flag = `--import ${import.meta.url}`;
const current = process.env.NODE_OPTIONS ?? "";
// A space in the path would be split by Node's NODE_OPTIONS parser, so the propagation is skipped rather than
// silently producing a broken child. The explicit `--import` on this process still applies.
if (!current.includes("scripts/lib/ts-loader.mjs") && !import.meta.url.includes("%20") && !import.meta.url.includes(" ")) {
  process.env.NODE_OPTIONS = current ? `${current} ${flag}` : flag;
}
