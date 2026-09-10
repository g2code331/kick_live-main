/**
 * A module `load` hook that transpiles TypeScript with the repository's own `typescript` package, so the
 * toolchain can import `.ts` sources on a Node build that has no built-in type stripping.
 *
 * Why a loader rather than a sentence in the README: `process.features.typescript` is `"strip"` on the Node
 * versions this repository was developed against (≥ 22.18, ≥ 23.6), but stripping is a *build-time* feature, and
 * repackaged Node builds — Debian/Ubuntu `nodejs`, some distro images, a few version-manager installs — ship
 * without it. The symptom is not an error about the code; it is
 * `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` on all 23 test files at once, which looks exactly
 * like a broken repository. It is not broken: the checkers read TypeScript sources on purpose
 * (`workers/src/router.ts`, `shared/branding.ts`, `tools/vite-shared.ts`), because the alternative is a duplicated
 * manifest that drifts — a failure mode this repository has been built to prevent since Phase 1.
 *
 * `typescript` is chosen over `esbuild` for one reason: it is already required to exist, because
 * `npm run typecheck` is `tsc`. A transpile-only call into the same compiler also means the loader cannot accept
 * syntax the project's own type checker would reject, and it spawns no binary — relevant inside a module hook,
 * which runs on its own thread.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TS_LIKE = /\.(ts|tsx|mts|cts)$/;
let compiler = null;

async function loadCompiler() {
  if (compiler) return compiler;
  try {
    compiler = (await import("typescript")).default;
  } catch {
    throw new Error(
      'scripts/lib/ts-hooks.mjs could not import "typescript". Run `npm ci`; if you do not need the .ts ' +
        "toolchain, unset NODE_OPTIONS (this loader is only registered when Node cannot strip types itself).",
    );
  }
  return compiler;
}

export async function load(url, context, nextLoad) {
  if (!TS_LIKE.test(url) || url.endsWith(".d.ts")) return nextLoad(url, context);
  const ts = await loadCompiler();
  const filename = fileURLToPath(url);
  const source = await readFile(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext2022 ?? ts.ScriptTarget.ES2022,
      // The repo writes `import type` where a type-only import matters, and stripping rather than elision is what
      // keeps this fast and faithful: nothing here may rewrite code, only remove type syntax.
      isolatedModules: true,
      verbatimModuleSyntax: true,
      jsx: url.endsWith(".tsx") ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });
  return { format: "module", shortCircuit: true, source: output.outputText };
}
