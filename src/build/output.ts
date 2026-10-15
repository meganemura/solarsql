// Responsibility: keep generated output separate from source files and their aliases.
// Boundary: callers decide which inputs and SQLite companion files must be preserved.
import { lstatSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BuildError } from "./build-error.ts";

function destination(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  const target = join(realpathSync(dirname(absolute)), basename(absolute));
  if (seen.has(target)) throw new BuildError("The output contains a symbolic link cycle.");
  seen.add(target);
  const entry = lstatSync(target, { throwIfNoEntry: false });
  return entry?.isSymbolicLink() ? destination(resolve(dirname(target), readlinkSync(target)), seen) : target;
}

// Write beside the resolved destination, then replace it. A timeout can stop a
// worker between syscalls, but it cannot expose a partly written generated file.
export function writeGeneratedFile(path: string, text: string): void {
  const target = destination(path);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// BigInt stats, because a Number cannot hold every 64-bit file id. On NTFS
// the id is the MFT record's sequence number above bit 48 and its index
// below it, so once a reused record's sequence number reaches 32, adjacent
// records round to the same Number and two distinct files compare equal.
export function protectInputs(output: string, inputs: readonly string[]): void {
  const target = destination(output);
  const outputFile = statSync(target, { throwIfNoEntry: false, bigint: true });
  for (const input of inputs) {
    const source = destination(input);
    const inputFile = statSync(source, { throwIfNoEntry: false, bigint: true });
    if (target === source || (outputFile && inputFile && outputFile.dev === inputFile.dev && outputFile.ino === inputFile.ino)) {
      throw new BuildError("The generated output must differ from every input and SQLite companion file, including file aliases.");
    }
  }
}
