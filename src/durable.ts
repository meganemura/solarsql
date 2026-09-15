// Responsibility: run queries and commands on the SQLite storage of a
// Durable Object, and apply migration files to it.
// A command becomes one transactionSync() call. An assert that fails or a
// constraint that rejects a row throws inside it, the transaction rolls
// back, and the adapter returns a value that says which. The API returns
// promises like the D1 adapter, so a module runs on both without a change.
// Boundary: no SQL is composed here beyond the assert statement that
// runtime/plan.ts defines.
import type { AdapterOptions, BatchRows, Command, CommandResult, Database, Entry, GeneratedMap, ParamsArg, PlanShape, Query, Read, Row, SqlValue, StatementMeta } from "./index.ts";
import { GUARD_CLEANUP, assertFailure, assertStatement, assertToken, bindValues, constraintFailure, observed, outcomeOf, parseJson, validateParams } from "./runtime/plan.ts";
import { created, definitions, normalize, parseRebuildRecords, quoteIdent, significant, splitStatements, tokenize, unknownDeclaration } from "./build/scan.ts";

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
    observed(options.observe, "query", query.name, async () => {
      const params=(args[0] ?? {}) as Record<string,unknown>;
      validateParams([query.meta], params, `query ${query.name}`);
      return rows(query.sql, query.meta, params) as Row<Q>[];
    }, () => "ok");

  return {
    all,
    async first(query, ...args) {
      const out = await all(query, ...args);
      return out[0] ?? null;
    },
    // The storage is local, so a batch of reads is the reads in order.
    batch: <const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>> =>
      observed(options.observe, "batch", reads.map((r) => r.query.name).join("+"), async () => {
        for (const item of reads) validateParams([item.query.meta], item.params, `query ${item.query.name}`);
        return reads.map((r) => rows(r.query.sql, r.query.meta, r.params)) as unknown as BatchRows<R>;
      }, () => "ok"),
    run: <C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> =>
      observed(options.observe, "command", command.name, async () => {
        const params = (args[0] ?? {}) as Record<string, SqlValue>;
        validateParams([...command.meta.statements, ...(command.meta.returns ? [command.meta.returns] : [])], params, `command ${command.name}`);
        const token = assertToken();
        try {
          const out = storage.transactionSync(() => {
            let changes = 0;
            const hasAssert = command.plan.some((item) => typeof item !== "string");
            command.plan.forEach((item, i) => {
              const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate, token);
              const before = totalChanges(storage);
              storage.sql.exec(sql, ...bindValues(command.meta.statements[i]!, params)).toArray();
              if (typeof item === "string") changes += totalChanges(storage) - before;
            });
            const resultRows = command.returns === null ? [] : rows(command.returns, command.meta.returns!, params);
            // A passing assert's row has no further use once the plan and
            // its returns clause have read what they need; deleting it
            // here, after returns and still inside this transaction, keeps
            // the guard table at zero rows between commands (ADR 0093).
            if (hasAssert) storage.sql.exec(GUARD_CLEANUP).toArray();
            return { rows: resultRows, changes };
          });
          return { ok: true, ...out } as CommandResult<C>;
        } catch (e) {
          const failed = assertFailure(e, command.meta.asserts, token);
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
export type MigrationOptions = {
  // The caller has checked the legacy files and accepts them as the baseline.
  adoptLegacyHistory?: boolean;
};

export class MigrationHistoryError extends Error {
  readonly code: string;
  readonly migration: string | null;
  constructor(code: string, message: string, migration: string | null = null) {
    super(message);
    this.name = "MigrationHistoryError";
    this.code = code;
    this.migration = migration;
  }
}

const HISTORY = "solarsql_migrations";

// Store the complete SQL to compare content without a hash implementation in
// the synchronous Worker path. A name-only legacy record requires explicit trust.
export function migrate(storage: StorageLike, files: readonly MigrationFile[], options: MigrationOptions = {}): string[] {
  const ordered = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.name === ordered[i - 1]?.name) throw new MigrationHistoryError("DUPLICATE_MIGRATION", `Duplicate migration: ${ordered[i]!.name}`, ordered[i]!.name);
    for (const sql of splitStatements(ordered[i]!.sql)) {
      const first = significant(tokenize(sql))[0]?.text.toUpperCase();
      if (first && ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(first)) {
        throw new MigrationHistoryError("MIGRATION_TRANSACTION", "The migration runner owns the transaction. Remove transaction control statements.", ordered[i]!.name);
      }
    }
  }
  storage.sql.exec(`create table if not exists ${HISTORY} (name text primary key not null, applied_at text not null, sql text not null) strict`);
  const hasSql = storage.sql.exec(`pragma table_info(${HISTORY})`).toArray().some(c => c.name === "sql");
  // Use one ordering for both inputs; SQLite BINARY and JavaScript order
  // supplementary Unicode characters differently.
  const history = storage.sql.exec(`select name${hasSql ? ", sql" : ""} from ${HISTORY}`).toArray()
    .sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  for (const [i, row] of history.entries()) {
    const name = String(row.name);
    const file = ordered.find(f => f.name === name);
    if (!file) throw new MigrationHistoryError("MISSING_MIGRATION", `Applied migration is missing: ${name}. Supply the full history.`, name);
    if (ordered[i]!.name !== name) throw new MigrationHistoryError("MIGRATION_ORDER", `A new migration precedes applied migration ${name}. Append a new file instead.`, name);
    if (row.sql === undefined || row.sql === null) {
      if (!options.adoptLegacyHistory) throw new MigrationHistoryError("LEGACY_HISTORY", `Migration ${name} has no recorded SQL. Verify the legacy files before using adoptLegacyHistory.`, name);
    } else if (row.sql !== file.sql) throw new MigrationHistoryError("MIGRATION_CHANGED", `Applied migration changed: ${name}. Restore it and append a new migration.`, name);
  }
  if (!hasSql || history.some(r => r.sql === null || r.sql === undefined)) {
    storage.transactionSync(() => {
      if (!hasSql) storage.sql.exec(`alter table ${HISTORY} add column sql text`);
      for (const row of history) {
        storage.sql.exec(`update ${HISTORY} set sql = ? where name = ?`, ordered.find(f => f.name === row.name)!.sql, row.name);
      }
    });
  }
  const applied: string[] = [];
  for (const file of ordered.slice(history.length)) {
    for (const { table, columns, constraints, indexes, triggers } of parseRebuildRecords(file.sql)) {
      // pragma_table_xinfo, unlike pragma_table_info, includes a generated
      // column -- the same shape introspect() (src/build/migration.ts)
      // already reads, so a generated column a sibling migration added is
      // caught here too, the same as any other column.
      const actualColumns = storage.sql.exec(`select name from pragma_table_xinfo(?) where hidden in (0, 2, 3)`, table).toArray().map((r) => String(r.name));
      if (actualColumns.length === 0) continue;
      const recorded = new Map(columns.map((c) => [c.name, c.def]));
      const unknown = actualColumns.find((n) => !recorded.has(n));
      if (unknown !== undefined) {
        // Every earlier file in this history is already applied here (this
        // loop only reaches files past the recorded history), so there is
        // no "not deployed yet" branch to offer, unlike applied()'s.
        throw new MigrationHistoryError(
          "REBUILD_LOSES_COLUMN",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} without knowledge of column ${quoteIdent(unknown)}. This database has already applied every earlier migration, so ${quoteIdent(unknown)}'s data on ${quoteIdent(table)} would be lost if this migration ran. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      // The declaration text, not just the column list: the same shape
      // definitions() gives applied() via Column.def, read here from the
      // table's own CREATE TABLE text so a column whose declared shape
      // changed since this file was generated is caught the same way an
      // unknown column is.
      // Case-insensitive, like pragma_table_xinfo above: a RebuildRecord's
      // recorded table name and the live table's actual name are the same
      // identifier even if their case differs (SQLite table names are
      // case-insensitive). A case-sensitive lookup here would find no row,
      // read every declaration as the empty string, and refuse every such
      // table as having a "stale declaration" even when nothing changed.
      const schemaRow = storage.sql.exec(`select sql from sqlite_schema where type = 'table' and lower(name) = lower(?)`, table).toArray()[0];
      const defs = schemaRow ? definitions(String(schemaRow.sql)) : null;
      const changed = actualColumns.find((n) => (defs?.columns.get(n) ?? "") !== (recorded.get(n) ?? ""));
      if (changed !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_LOSES_COLUMN",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} with a stale declaration of column ${quoteIdent(changed)}. This database has already applied every earlier migration, so replaying ${file.name} would lose that column's current shape on ${quoteIdent(table)}. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      const badConstraint = unknownDeclaration(constraints, defs?.constraints ?? []);
      if (badConstraint !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_LOSES_COLUMN",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} without knowledge of a table-level constraint it already has: ${JSON.stringify(badConstraint)}. This database has already applied every earlier migration, so that constraint would be lost if this migration ran. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      // Same case-insensitive match as the table lookup above: tbl_name
      // must be compared the same way pragma_table_xinfo already compares
      // name, or a case-mismatched record would find no index here and
      // silently miss one a sibling migration really added.
      const actualIndexSql = storage.sql.exec(`select sql from sqlite_schema where lower(tbl_name) = lower(?) and type = 'index' and sql is not null`, table).toArray().map((r) => normalize(String(r.sql)));
      const badIndex = unknownDeclaration(indexes, actualIndexSql);
      if (badIndex !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_LOSES_COLUMN",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} without knowledge of index ${quoteIdent(created(badIndex)?.name ?? badIndex)} it already has: ${JSON.stringify(badIndex)}. This database has already applied every earlier migration, so that index would be lost if this migration ran. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      // Same case-insensitive match as the index lookup above, for the
      // same reason.
      const actualTriggerSql = storage.sql.exec(`select sql from sqlite_schema where lower(tbl_name) = lower(?) and type = 'trigger' and sql is not null`, table).toArray().map((r) => normalize(String(r.sql)));
      const badTrigger = unknownDeclaration(triggers, actualTriggerSql);
      if (badTrigger !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_LOSES_COLUMN",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} without knowledge of trigger ${quoteIdent(created(badTrigger)?.name ?? badTrigger)} it already has: ${JSON.stringify(badTrigger)}. This database has already applied every earlier migration, so that trigger, and the behavior it maintains, would be lost if this migration ran. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
    }
    storage.transactionSync(() => {
      for (const statement of splitStatements(file.sql)) storage.sql.exec(statement).toArray();
      storage.sql.exec(`insert into ${HISTORY} (name, applied_at, sql) values (?, ?, ?)`, file.name, new Date().toISOString(), file.sql);
    });
    applied.push(file.name);
  }
  return applied;
}
