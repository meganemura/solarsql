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
import { durable, migrate as migrateStorage, type MigrationFile, type MigrationOptions, type StorageLike } from "./durable.ts";
import { namedSlots } from "./build/scan.ts";

export function node(db: DatabaseSync, options: AdapterOptions = {}): Database {
  return durable(storageOf(db), options);
}

// Apply the migration files this database has not applied yet, in name
// order. Returns the names applied now.
export function migrate(db: DatabaseSync, files: readonly MigrationFile[], options: MigrationOptions = {}): string[] {
  return migrateStorage(storageOf(db), files, options);
}

// Bind full SQLite names so distinct prefixes cannot collide in Node's
// bare-name lookup. Positional values follow the build's slot order.
export function storageOf(db: DatabaseSync): StorageLike {
  return {
    sql: {
      exec(sql: string, ...bindings: unknown[]) {
        const statement = db.prepare(sql);
        const slots = bindings.length === 0 ? [] : namedSlots(sql);
        statement.setAllowBareNamedParameters(false);
        const rows = slots.length > 0 ? statement.all(Object.fromEntries(slots.map((slot, i) => [slot.sqlName, bindings[i]])) as Record<string, never>) : statement.all(...(bindings as never[]));
        // node:sqlite rows have no prototype; a plain object compares equal
        // to a literal in a test.
        return { toArray: () => rows.map((r) => ({ ...r })) };
      },
    },
    // node:sqlite reports this true as soon as any SAVEPOINT is open, not
    // only a caller's own `begin`; migrate() (src/durable.ts) reads this
    // before opening its own savepoint for that reason.
    inTransaction: () => db.isTransaction,
    transactionSync<T>(closure: () => T): T {
      // SAVEPOINT owns an inner rollback boundary without committing the
      // caller's transaction. Repeated names resolve to the innermost mark.
      db.exec("savepoint solarsql_transaction");
      try {
        const out = closure();
        db.exec("release savepoint solarsql_transaction");
        return out;
      } catch (e) {
        try {
          db.exec("rollback to savepoint solarsql_transaction; release savepoint solarsql_transaction");
        } catch (cleanup) {
          throw new AggregateError([e, cleanup], "The Node transaction failed and its savepoint cleanup also failed", { cause: e });
        }
        throw e;
      }
    },
  };
}

export { MigrationHistoryError, type MigrationOptions } from "./durable.ts";
