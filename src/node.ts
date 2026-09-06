// Responsibility: run queries, commands, and migrations on node:sqlite, so
// the tests and scripts of a module run in-process with no Cloudflare
// runtime (ADR 0032). A DatabaseSync gets the shape of a Durable Object's
// storage, and the Durable Object adapter does the rest: node:sqlite
// reports the same constraint messages, and the guard trigger raises the
// same way.
// Boundary: the shim only. Nothing here composes SQL, and nothing here is
// for a Worker; this file imports node:sqlite.
import type { DatabaseSync } from "node:sqlite";
import type { AdapterOptions, Database } from "./index.ts";
import { durable, migrate as migrateStorage, type MigrationFile, type StorageLike } from "./durable.ts";
import { namedParams } from "./build/scan.ts";

export function node(db: DatabaseSync, options: AdapterOptions = {}): Database {
  return durable(storageOf(db), options);
}

// Apply the migration files this database has not applied yet, in name
// order. Returns the names applied now.
export function migrate(db: DatabaseSync, files: readonly MigrationFile[]): string[] {
  return migrateStorage(storageOf(db), files);
}

// node:sqlite binds a named parameter by its name only, so the values the
// adapters pass by position are matched to the names in the order they
// first appear, which is the order the build numbered them in. A statement
// with `?` parameters, such as the migration history's own insert, binds
// by position.
export function storageOf(db: DatabaseSync): StorageLike {
  return {
    sql: {
      exec(sql: string, ...bindings: unknown[]) {
        const statement = db.prepare(sql);
        const names = bindings.length === 0 ? [] : namedParams(sql).names;
        const rows = names.length > 0 ? statement.all(Object.fromEntries(names.map((n, i) => [n, bindings[i]])) as Record<string, never>) : statement.all(...(bindings as never[]));
        // node:sqlite rows have no prototype; a plain object compares equal
        // to a literal in a test.
        return { toArray: () => rows.map((r) => ({ ...r })) };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("begin");
      try {
        const out = closure();
        db.exec("commit");
        return out;
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
}
