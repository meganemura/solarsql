// Responsibility: keep generated output separate from source files and their aliases.
// Boundary: callers decide which inputs and SQLite companion files must be preserved.
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BuildError } from "./typegen.ts";

function destination(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  const target = join(realpathSync(dirname(absolute)), basename(absolute));
  if (seen.has(target)) throw new BuildError("The output contains a symbolic link cycle.");
  seen.add(target);
  const entry = lstatSync(target, { throwIfNoEntry: false });
  return entry?.isSymbolicLink() ? destination(resolve(dirname(target), readlinkSync(target)), seen) : target;
}

export function protectInputs(output: string, inputs: readonly string[]): void {
  const target = destination(output);
  const outputFile = statSync(target, { throwIfNoEntry: false });
  for (const input of inputs) {
    const source = destination(input);
    const inputFile = statSync(source, { throwIfNoEntry: false });
    if (target === source || (outputFile && inputFile && outputFile.dev === inputFile.dev && outputFile.ino === inputFile.ino)) {
      throw new BuildError("The generated output must differ from every input and SQLite companion file, including file aliases.");
    }
  }
}
