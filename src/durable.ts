// Responsibility: run queries and commands on the SQLite storage of a
// Durable Object, and apply migration files to it.
// A command becomes one transactionSync() call. An assert that fails throws
// inside it, the transaction rolls back, and the adapter returns a value
// that names the assert. The API returns promises like the D1 adapter, so a
// module runs on both without a change.
// Boundary: no SQL is composed here beyond the assert statement that
// runtime/plan.ts defines.
import type { Command, CommandResult, Database, Entry, GeneratedMap, ParamsArg, PlanShape, Query, Row, SqlValue } from "./index.ts";
import { assertFailure, assertStatement, bindValues, parseJson } from "./runtime/plan.ts";
import { splitStatements } from "./build/scan.ts";

// The part of DurableObjectStorage this adapter uses. Structural, so no
// type package is needed.
export type StorageLike = {
  sql: { exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
};

export function durable(storage: StorageLike): Database {
  const rows = (sql: string, meta: { params: readonly string[]; json: readonly string[] }, params: Record<string, unknown>) =>
    parseJson(storage.sql.exec(sql, ...bindValues(meta, params)).toArray(), meta.json);

  return {
    async all<Q extends Query<string, Entry>>(query: Q, ...args: ParamsArg<Q>): Promise<Row<Q>[]> {
      return rows(query.sql, query.meta, (args[0] ?? {}) as Record<string, unknown>) as Row<Q>[];
    },
    async first<Q extends Query<string, Entry>>(query: Q, ...args: ParamsArg<Q>): Promise<Row<Q> | null> {
      const out = rows(query.sql, query.meta, (args[0] ?? {}) as Record<string, unknown>) as Row<Q>[];
      return out[0] ?? null;
    },
    async run<C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> {
      const params = (args[0] ?? {}) as Record<string, SqlValue>;
      try {
        const out = storage.transactionSync(() => {
          command.plan.forEach((item, i) => {
            const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate);
            storage.sql.exec(sql, ...bindValues(command.meta.statements[i]!, params)).toArray();
          });
          if (command.returns === null) return [];
          return rows(command.returns, command.meta.returns!, params);
        });
        return { ok: true, rows: out } as CommandResult<C>;
      } catch (e) {
        const failed = assertFailure(e, command.meta.asserts);
        if (failed !== null) return { ok: false, assert: failed } as CommandResult<C>;
        throw e;
      }
    },
  };
}

export type MigrationFile = { name: string; sql: string };

const HISTORY = "solarsql_migrations";

// Apply the migration files this object has not applied yet, in name order,
// one transaction per file. Call it inside blockConcurrencyWhile() from the
// constructor of the Durable Object. Returns the names applied now.
export function migrate(storage: StorageLike, files: readonly MigrationFile[]): string[] {
  storage.sql.exec(`create table if not exists ${HISTORY} (name text primary key not null, applied_at text not null)`);
  const done = new Set(storage.sql.exec(`select name from ${HISTORY}`).toArray().map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (done.has(file.name)) continue;
    storage.transactionSync(() => {
      for (const statement of splitStatements(file.sql)) storage.sql.exec(statement);
      storage.sql.exec(`insert into ${HISTORY} (name, applied_at) values (?, ?)`, file.name, new Date().toISOString());
    });
    applied.push(file.name);
  }
  return applied;
}
