/**
 * CLI for the hardened static host.
 *
 *   node server/cli.ts --root dist/web [--port 5000] [--host 0.0.0.0] [--no-spa] [--no-csp]
 *
 * Exits non-zero (with a one-line reason) when the root is missing or has no index.html, so CI
 * can't "succeed" while serving an empty directory.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { startStaticServer } from "./static-server.ts";

type Args = {
  root: string;
  port: number;
  host: string;
  spa: boolean;
  csp: boolean;
  allowAnyHost: boolean;
  quiet: boolean;
};

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    root: "dist/web",
    port: Number(process.env.PORT ?? 5174),
    host: process.env.HOST ?? "127.0.0.1",
    spa: true,
    csp: true,
    allowAnyHost: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${String(a)}`);
      return v;
    };
    switch (a) {
      case "--root":
        args.root = next();
        break;
      case "--port":
        args.port = Number(next());
        break;
      case "--host":
        args.host = next();
        break;
      case "--no-spa":
        args.spa = false;
        break;
      case "--no-csp":
        args.csp = false;
        break;
      case "--allow-any-host":
        args.allowAnyHost = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        console.log("usage: node server/cli.ts --root <dir> [--port 0] [--host 127.0.0.1] [--no-spa] [--no-csp] [--allow-any-host] [--quiet]");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${String(a)}`);
    }
  }
  if (!Number.isFinite(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error(`invalid --port ${String(args.port)}`);
  }
  return args;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`kicklive-static: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(args.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`kicklive-static: root is not a directory: ${root} (run "npm run build:web" first)`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(path.join(root, "index.html"))) {
    console.error(`kicklive-static: root has no index.html: ${root}`);
    process.exitCode = 1;
    return;
  }

  const running = await startStaticServer({
    root,
    port: args.port,
    host: args.host,
    spa: args.spa,
    csp: args.csp,
    allowedHosts: args.allowAnyHost || args.host === "0.0.0.0" ? ["*"] : ["loopback"],
  });
  if (!args.quiet) {
    console.log(`kicklive-static: serving ${root}`);
    console.log(`kicklive-static: listening on ${running.origin} (spa=${String(args.spa)} csp=${String(args.csp)})`);
    console.log(`kicklive-static: ready`);
  }
  const shutdown = (): void => {
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("server", "cli.ts"));
if (invokedDirectly) {
  await main();
}
