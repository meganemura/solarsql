// Responsibility: run queries and commands on the SQLite storage of a
// Durable Object, and apply migration files to it.
// A command becomes one transactionSync() call. An assert that fails or a
// constraint that rejects a row throws inside it, the transaction rolls
// back, and the adapter returns a value that says which. The API returns
// promises like the D1 adapter, so a module runs on both without a change.
// Boundary: no SQL is composed here beyond the assert statement that
// runtime/plan.ts defines.
import type { AdapterOptions, BatchRows, Command, CommandResult, Database, Entry, GeneratedMap, ParamsArg, PlanShape, Query, Read, Row, SqlValue, StatementMeta } from "./index.ts";
import { assertFailure, assertStatement, bindValues, constraintFailure, observed, outcomeOf, parseJson } from "./runtime/plan.ts";
import { splitStatements } from "./build/scan.ts";

// The part of DurableObjectStorage this adapter uses. Structural, so no
// type package is needed.
export type StorageLike = {
  sql: { exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
};

export function durable(storage: StorageLike, options: AdapterOptions = {}): Database {
  const rows = (sql: string, meta: StatementMeta, params: Record<string, unknown>) =>
    parseJson(storage.sql.exec(sql, ...bindValues(meta, params)).toArray(), meta.json);

  const all = <Q extends Query<string, Entry>>(query: Q, ...args: ParamsArg<Q>): Promise<Row<Q>[]> =>
    observed(options.observe, "query", query.name, async () => rows(query.sql, query.meta, (args[0] ?? {}) as Record<string, unknown>) as Row<Q>[], () => "ok");

  return {
    all,
    async first(query, ...args) {
      const out = await all(query, ...args);
      return out[0] ?? null;
    },
    // The storage is local, so a batch of reads is the reads in order.
    batch: <const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>> =>
      observed(options.observe, "batch", reads.map((r) => r.query.name).join("+"), async () => reads.map((r) => rows(r.query.sql, r.query.meta, r.params)) as unknown as BatchRows<R>, () => "ok"),
    run: <C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> =>
      observed(options.observe, "command", command.name, async () => {
        const params = (args[0] ?? {}) as Record<string, SqlValue>;
        try {
          const out = storage.transactionSync(() => {
            let changes = 0;
            command.plan.forEach((item, i) => {
              const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate);
              const before = totalChanges(storage);
              storage.sql.exec(sql, ...bindValues(command.meta.statements[i]!, params)).toArray();
              if (typeof item === "string") changes += totalChanges(storage) - before;
            });
            const resultRows = command.returns === null ? [] : rows(command.returns, command.meta.returns!, params);
            return { rows: resultRows, changes };
          });
          return { ok: true, ...out } as CommandResult<C>;
        } catch (e) {
          const failed = assertFailure(e, command.meta.asserts);
          if (failed !== null) return { ok: false, kind: "assert", assert: failed } as CommandResult<C>;
          const constraint = constraintFailure(e);
          if (constraint !== null) return { ok: false, ...constraint } as CommandResult<C>;
          throw e;
        }
      }, (r) => outcomeOf(r as { ok: boolean; kind?: string; assert?: string })),
  };
}

// D1 reports a statement's changes as the difference of total_changes(),
// which counts the rows a trigger wrote too, and changes() does not. The
// same difference here keeps the count equal on the three adapters.
function totalChanges(storage: StorageLike): number {
  const n = storage.sql.exec("select total_changes() as n").toArray()[0]?.n;
  return typeof n === "number" ? n : 0;
}

export type MigrationFile = { name: string; sql: string };

const HISTORY = "solarsql_migrations";

// Apply the migration files this object has not applied yet, in name order,
// one transaction per file. Call it inside blockConcurrencyWhile() from the
// constructor of the Durable Object. Returns the names applied now.
export function migrate(storage: StorageLike, files: readonly MigrationFile[]): string[] {
  storage.sql.exec(`create table if not exists ${HISTORY} (name text primary key not null, applied_at text not null) strict`);
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
