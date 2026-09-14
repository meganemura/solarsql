// Responsibility: append migration files in replay order without replacing history.
// Boundary: schema comparison and SQL generation belong to build.ts and migration.ts.
import { closeSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "./migration.ts";
import { BuildError } from "./typegen.ts";
import { announceMigrationLock } from "./machine.ts";

export function migrationSequence(names: readonly string[]): { maximum: number; width: number } {
  let maximum = -1;
  let width = 4;
  for (const name of [...names].sort()) {
    const match = /^(\d{4,})_[a-z0-9_]+\.sql$/.exec(name);
    const sequence = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(sequence) || sequence <= maximum) {
      throw new BuildError(`Migration history has an invalid or ambiguous sequence at ${name}. Restore applied filenames; use unique, increasing NNNN_name.sql names for new files.`);
    }
    maximum = sequence;
    width = Math.max(width, match![1]!.length);
  }
  return { maximum, width };
}

export function nextMigrationFile(names: readonly string[], name: string, statements: readonly string[]) {
  const { maximum, width } = migrationSequence(names);
  const next = Math.max(1, maximum + 1);
  if (!Number.isSafeInteger(next)) throw new BuildError("Migration sequence exceeds the safe integer range. Review an explicit append-only migration strategy without renaming applied files.");
  const file = render(next, name, statements, width);
  if (names.some(previous => previous >= file.filename)) {
    throw new BuildError(`Migration ${file.filename} would replay before existing history. Review an explicit append-only migration strategy without renaming applied files.`);
  }
  return file;
}

// A timeout can stop a worker mid-write. Writing the full content to a
// temporary file first, then linking it into place only after that write
// returns, means a killed process leaves no file at the final name: the
// two steps run in order, so the final name only ever exists once the
// content behind it is complete. A hard link, not a rename, keeps the
// EEXIST failure when a migration of that name already exists; some
// filesystems without hard-link support (for example exFAT) cannot run
// this path, which a rename-based write would not have required.
export function writeNewMigration(dir: string, file: { filename: string; sql: string }): void {
  const target = join(dir, file.filename);
  const temporary = join(dir, `.${file.filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, file.sql, { flag: "wx" });
  try {
    linkSync(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BuildError(`Migration ${file.filename} already exists. Preserve it and rerun generation against the current history.`);
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

export async function withMigrationLock<T>(dir: string, action: () => T | Promise<T>): Promise<T> {
  const path = join(dir, ".solarsql-generation.lock");
  await announceMigrationLock(path);
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BuildError(`Migration generation is locked at ${path}. Retry after the other generator finishes. If it exited, inspect and remove its stale lock.`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return await action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
