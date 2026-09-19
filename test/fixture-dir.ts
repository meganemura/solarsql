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
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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
