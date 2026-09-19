// Responsibility: give a fixture test a scratch directory under the repo
// root, and the specifier that names this repository's library from inside
// it.
// Boundary: no cleanup policy beyond mkdtempSync's own contract; the caller
// still owns rmSync/t.after.
//
// Why: a bare absolute path is not a valid ESM specifier on Windows, a
// file:// URL is not a valid tsc module specifier, and a relative path is
// valid for both only when the fixture directory and src/ sit on the same
// drive -- which os.tmpdir() does not guarantee on CI.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratchRoot = join(root, ".scratch");

export function fixtureDir(prefix: string): string {
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(join(scratchRoot, prefix));
}

export function specifier(dir: string, target: string): string {
  const posix = relative(dir, target).split(sep).join("/");
  return posix.startsWith(".") ? posix : `./${posix}`;
}

export function librarySpecifier(dir: string): string {
  return specifier(dir, join(root, "src/index.ts"));
}

// node_modules/.bin/tsc is a shim (a .cmd wrapper on Windows); spawnSync
// without shell: true can't run it and fails ENOENT, and shell: true would
// change how Windows quotes the arguments and hide a real ENOENT. Running
// tsc's own entry point through node itself works the same on every
// platform.
export function tscArgs(projectRoot: string, args: string[]): [string, string[]] {
  return [process.execPath, [join(projectRoot, "node_modules/typescript/bin/tsc"), ...args]];
}

// `npm` is `npm.cmd` on Windows, which spawnSync/execFileSync can't run
// without shell: true -- and shell: true would change how Windows quotes the
// arguments and hide a real ENOENT, the same reason tscArgs above runs tsc's
// entry point through node instead of the .bin shim. npm_execpath (set when
// tests run under `npm run`/`npm test`) already names npm-cli.js; the two
// fallbacks below cover a direct `node --test` invocation on Windows and on
// POSIX installs, respectively.
export function npmArgs(args: string[]): [string, string[]] {
  const bundled = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const lib = join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  const cli = process.env.npm_execpath ?? (existsSync(bundled) ? bundled : lib);
  return [process.execPath, [cli, ...args]];
}
