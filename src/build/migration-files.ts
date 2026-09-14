// Responsibility: append migration files in replay order without replacing history.
// Boundary: schema comparison and SQL generation belong to build.ts and migration.ts.
import { closeSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "./migration.ts";
import { BuildError } from "./typegen.ts";
import { announceMigrationLock } from "./machine.ts";
import type { RebuildRecord } from "./scan.ts";

// solarsql has no way to check which migration files a database has
// already applied, so every message here says that plainly instead of
// making the rename conditional on a fact the tool cannot verify.
const cannotCheckDeployment = "solarsql cannot check a database's applied-migrations state itself; know which file, if any, is already deployed before renaming one.";

export function migrationSequence(names: readonly string[]): { maximum: number; width: number } {
  const sorted = [...names].sort();
  const parsed = sorted.map((name) => {
    const match = /^(\d{4,})_[a-z0-9_]+\.sql$/.exec(name);
    return { name, sequence: match ? Number(match[1]) : NaN, width: match ? match[1]!.length : 0 };
  });
  for (const entry of parsed) {
    if (!Number.isSafeInteger(entry.sequence)) {
      const action = `Rename ${entry.name} to a unique, increasing NNNN_name.sql number.`;
      throw new BuildError(`Migration history has an invalid sequence at ${entry.name}. ${action} ${cannotCheckDeployment}`, undefined, action);
    }
  }
  let maximum = -1;
  let previous: string | null = null;
  let width = 4;
  for (const entry of parsed) {
    if (entry.sequence <= maximum) {
      const colliding = parsed.filter((p) => p.sequence === entry.sequence).map((p) => p.name);
      if (colliding.length > 1) {
        const action = `Rename all but one of ${colliding.join(", ")} to a unique, increasing NNNN_name.sql number, or write a new migration that reconciles them.`;
        throw new BuildError(`Migration history has colliding sequence numbers at ${colliding.join(", ")}. ${action} ${cannotCheckDeployment}`, undefined, action);
      }
      const action = `Rename ${entry.name} to a digit width consistent with ${previous}.`;
      throw new BuildError(`Migration history has an ambiguous replay order at ${entry.name}: its digit width does not match ${previous}, so sort order disagrees with numeric order. ${action} ${cannotCheckDeployment}`, undefined, action);
    }
    maximum = entry.sequence;
    previous = entry.name;
    width = Math.max(width, entry.width);
  }
  return { maximum, width };
}

export function nextMigrationFile(names: readonly string[], name: string, statements: readonly string[], rebuilds: readonly RebuildRecord[] = []) {
  const { maximum, width } = migrationSequence(names);
  const next = Math.max(1, maximum + 1);
  if (!Number.isSafeInteger(next)) throw new BuildError("Migration sequence exceeds the safe integer range. Review an explicit append-only migration strategy without renaming applied files.");
  const file = render(next, name, statements, rebuilds, width);
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
