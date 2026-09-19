// Responsibility: run queries and commands on the SQLite storage of a
// Durable Object, and apply migration files to it.
// A command becomes one transactionSync() call. An assert that fails or a
// constraint that rejects a row throws inside it, the transaction rolls
// back, and the adapter returns a value that says which. The API returns
// promises like the D1 adapter, so a module runs on both without a change.
// Boundary: no SQL is composed here beyond the assert statement that
// runtime/plan.ts defines.
import type { AdapterOptions, BatchRows, Command, CommandResult, Database, EngineMeta, Entry, GeneratedMap, ParamsArg, PlanShape, Query, Read, Row, SqlValue, StatementMeta } from "./index.ts";
import { GUARD_CLEANUP, assertFailure, assertStatement, assertToken, bindValues, constraintFailure, observed, outcomeOf, parseJson, validateParams } from "./runtime/plan.ts";
import { created, definitions, isKeyword, normalize, parseRebuildRecords, quoteIdent, redeclaredByFile, revivedDeclaration, significant, splitStatements, tokenize, unknownDeclaration } from "./build/scan.ts";

// The cursor shape this adapter reads meta from. rowsRead/rowsWritten are
// optional: a real Durable Object's SqlStorageCursor carries them (measured
// against Miniflare, Cloudflare's docs mark them for cost accounting), but
// node.ts's storageOf() fabricates a cursor with only toArray() for
// node:sqlite, which has no such counters. Making them required here would
// make that shim a type error.
type CursorLike = { toArray(): Record<string, unknown>[]; rowsRead?: number; rowsWritten?: number };

// The part of DurableObjectStorage this adapter uses. Structural, so no
// type package is needed.
export type StorageLike = {
  sql: { exec(sql: string, ...bindings: unknown[]): CursorLike };
  transactionSync<T>(closure: () => T): T;
  // Node's shim reports whether a transaction the caller opened before
  // calling migrate() is still open (running.md's caller-owned-transaction
  // composition). A Durable Object's storage has no such concept and leaves
  // this undefined, which migrate() below treats as "no caller transaction".
  inTransaction?: () => boolean;
};

// The rows a query, batch, or command touched, in the same shape D1's
// engineMeta() (runtime/plan.ts) produces, so one observe hook works on
// both adapters. duration is left out: a Durable Object has no server-side
// timing to report, and EngineMeta.duration is optional for exactly that
// (unlike D1, which always reports it). Reported only when at least one
// cursor gave both counters as numbers -- the same both-required rule
// engineMeta() applies to D1's reply.meta -- so a Node shim's cursor, which
// has neither, still reports no meta at all. Read after each cursor's own
// toArray() call, the order the counters were confirmed stable in
// (Cloudflare's docs describe rowsRead as a running total on the cursor;
// reading before consuming it was not the case this was measured against).
function cursorMeta(cursors: readonly CursorLike[]): EngineMeta | undefined {
  let out: EngineMeta | undefined;
  for (const c of cursors) {
    if (typeof c.rowsRead !== "number" || typeof c.rowsWritten !== "number") continue;
    if (!out) out = { rows_read: c.rowsRead, rows_written: c.rowsWritten };
    else { out.rows_read += c.rowsRead; out.rows_written += c.rowsWritten; }
  }
  return out;
}

export function durable(storage: StorageLike, options: AdapterOptions = {}): Database {
  // sink, when given, collects the cursor after it is read, for cursorMeta()
  // above to sum once the caller is done issuing statements.
  const rows = (sql: string, meta: StatementMeta, params: Record<string, unknown>, sink?: CursorLike[]) => {
    const cursor = storage.sql.exec(sql, ...bindValues(meta, params));
    const data = parseJson(cursor.toArray(), meta.json);
    sink?.push(cursor);
    return data;
  };

  const all = <Q extends Query<string, Entry>>(query: Q, ...args: ParamsArg<Q>): Promise<Row<Q>[]> =>
    observed(options.observe, "query", query.name, async (report) => {
      const params=(args[0] ?? {}) as Record<string,unknown>;
      validateParams([query.meta], params, `query ${query.name}`);
      const cursors: CursorLike[] = [];
      const result = rows(query.sql, query.meta, params, cursors) as Row<Q>[];
      report(cursorMeta(cursors));
      return result;
    }, () => "ok");

  return {
    all,
    async first(query, ...args) {
      const out = await all(query, ...args);
      return out[0] ?? null;
    },
    // The storage is local, so a batch of reads is the reads in order.
    batch: <const R extends readonly Read<Query<string, Entry>>[]>(reads: R): Promise<BatchRows<R>> =>
      observed(options.observe, "batch", reads.map((r) => r.query.name).join("+"), async (report) => {
        for (const item of reads) validateParams([item.query.meta], item.params, `query ${item.query.name}`);
        const cursors: CursorLike[] = [];
        const result = reads.map((r) => rows(r.query.sql, r.query.meta, r.params, cursors)) as unknown as BatchRows<R>;
        report(cursorMeta(cursors));
        return result;
      }, () => "ok"),
    run: <C extends Command<GeneratedMap, PlanShape<GeneratedMap>>>(command: C, ...args: ParamsArg<C>): Promise<CommandResult<C>> =>
      observed(options.observe, "command", command.name, async (report) => {
        const params = (args[0] ?? {}) as Record<string, SqlValue>;
        validateParams([...command.meta.statements, ...(command.meta.returns ? [command.meta.returns] : [])], params, `command ${command.name}`);
        const token = assertToken();
        // Shared with the D1 command path's own accounting (src/d1.ts): sum
        // every cursor the plan, the assert cleanup, and the returns clause
        // touch, not only the plan's own statements (changes above stays
        // narrower, on purpose -- ADR 0042 counts only the plan's rows).
        const cursors: CursorLike[] = [];
        try {
          const out = storage.transactionSync(() => {
            let changes = 0;
            const hasAssert = command.plan.some((item) => typeof item !== "string");
            command.plan.forEach((item, i) => {
              const sql = typeof item === "string" ? item : assertStatement(item.name, item.predicate, token);
              const before = totalChanges(storage, cursors);
              const cursor = storage.sql.exec(sql, ...bindValues(command.meta.statements[i]!, params));
              cursor.toArray();
              cursors.push(cursor);
              if (typeof item === "string") changes += totalChanges(storage, cursors) - before;
            });
            const resultRows = command.returns === null ? [] : rows(command.returns, command.meta.returns!, params, cursors);
            // A passing assert's row has no further use once the plan and
            // its returns clause have read what they need; deleting it
            // here, after returns and still inside this transaction, keeps
            // the guard table at zero rows between commands (ADR 0093).
            if (hasAssert) {
              const cleanup = storage.sql.exec(GUARD_CLEANUP);
              cleanup.toArray();
              cursors.push(cleanup);
            }
            return { rows: resultRows, changes };
          });
          report(cursorMeta(cursors));
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
// sink, when given, collects this call's own cursor too: it reads 0 rows
// (measured against Miniflare), so folding it into cursorMeta()'s sum above
// does not inflate rows_read.
function totalChanges(storage: StorageLike, sink?: CursorLike[]): number {
  const cursor = storage.sql.exec("select total_changes() as n");
  const n = cursor.toArray()[0]?.n;
  sink?.push(cursor);
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
    if (ordered[i]!.name === ordered[i - 1]?.name) throw new MigrationHistoryError("DUPLICATE_MIGRATION", `Duplicate migration: ${ordered[i]!.name}. List each migration file once.`, ordered[i]!.name);
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
  // Read before transactionSync opens its own savepoint: storageOf()'s
  // transactionSync (src/node.ts) issues a SAVEPOINT itself, and
  // node:sqlite reports isTransaction true as soon as any SAVEPOINT is
  // open, whether or not the caller began one first. Reading
  // inTransaction() from inside a file's own closure would always see true
  // on Node and could never tell a caller-owned transaction apart from
  // migrate()'s own savepoint. Read once, here, for every file below: this
  // does not change file to file.
  const callerOwnsTransaction = storage.inTransaction?.() === true;
  // pragma foreign_key_check (below, per file) scans the whole database,
  // not only the rows that file's own statements touch, so a violation
  // already present before the first file runs would otherwise get blamed
  // on whichever later file happens to run next (migrations.md). Read it
  // once here, before any file's statements run, and resolve each row to a
  // key (violationKeys below) while every row still names the same data it
  // will after a later file's statements delete or replace it. Each file's
  // own after-check narrows this set to what still predates that file (see
  // the comment on that check).
  let before = new Set<string>();
  // Skip the scan itself when no file below will run: the per-file loop
  // (ordered.slice(history.length)) never touches before then, so it would
  // sit unread. An already-migrated Durable Object hits this on every
  // activation: migrations.md's constructor pattern calls
  // blockConcurrencyWhile(() => migrate(ctx.storage, migrations)) on every
  // instantiation and reactivation, not only the first.
  if (!callerOwnsTransaction && ordered.length > history.length) {
    for (const key of violationKeys(storage, storage.sql.exec(`pragma foreign_key_check`).toArray())) {
      if (key !== null) before.add(key);
    }
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
      // The mirror direction of the checks above: something this
      // rebuild's generator saw and recorded is now missing from the live
      // schema (an earlier migration, applied since, removed it), and this
      // file's own statements redeclare it. Replaying it would restore what
      // that earlier migration meant to remove. An entry recorded but
      // missing, and not redeclared by this file, stays allowed: this
      // rebuild's own generator chose to drop it, the case ADR 0099 and ADR
      // 0102 already permit.
      const redeclared = redeclaredByFile(file.sql, table);
      const revivedConstraint = revivedDeclaration(constraints, defs?.constraints ?? [], redeclared.constraints, false);
      if (revivedConstraint !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_REVIVES_DECLARATION",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} and would restore a table-level constraint an earlier migration already removed: ${JSON.stringify(revivedConstraint)}. This file's target schema was generated before that removal and still declares it. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      const revivedIndex = revivedDeclaration(indexes, actualIndexSql, redeclared.indexes, true);
      if (revivedIndex !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_REVIVES_DECLARATION",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} and would restore index ${quoteIdent(created(revivedIndex)?.name ?? revivedIndex)}, which an earlier migration already removed: ${JSON.stringify(revivedIndex)}. This file's target schema was generated before that removal and still declares it. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
      const revivedTrigger = revivedDeclaration(triggers, actualTriggerSql, redeclared.triggers, true);
      if (revivedTrigger !== undefined) {
        throw new MigrationHistoryError(
          "REBUILD_REVIVES_DECLARATION",
          `Migration ${file.name} rebuilds table ${quoteIdent(table)} and would restore trigger ${quoteIdent(created(revivedTrigger)?.name ?? revivedTrigger)}, which an earlier migration already removed: ${JSON.stringify(revivedTrigger)}. This file's target schema was generated before that removal and still declares it. Regenerate ${file.name} against the current schema.`,
          file.name,
        );
      }
    }
    storage.transactionSync(() => {
      for (const statement of splitStatements(file.sql)) storage.sql.exec(statement).toArray();
      // A new foreign key defers its check to commit (pragma
      // defer_foreign_keys, src/build/migration.ts), so an orphaned row can
      // pass every statement above and still violate the constraint. A real
      // Durable Object does not raise that violation at this
      // transactionSync's own RELEASE; it only fires at the request's own
      // implicit commit, after migrate() has already returned, and the
      // platform discards the response and resets the object instead of
      // giving the caller a catchable error (see migrations.md). Running
      // the same check the engine will run later, before this closure
      // returns, converts it into an ordinary throw here, so it rolls back
      // only this file, on every runtime. Skipped when the caller already
      // owns an outer transaction (running.md's composition contract):
      // that caller can still resolve an orphaned row before their own
      // commit, and this check must not foreclose that by throwing early.
      if (!callerOwnsTransaction) {
        const violations = storage.sql.exec(`pragma foreign_key_check`).toArray();
        if (violations.length === 0) {
          // The whole database has no foreign-key violation at this point,
          // so the next file's own before is empty; carrying this file's
          // now-stale before forward could match a later file's own new
          // violation against a key this file's statements already cleared.
          before = new Set();
        } else {
          const afterKeys = violationKeys(storage, violations);
          const allPredate = afterKeys.every((key) => key !== null && before.has(key));
          if (allPredate) {
            throw new Error(`Migration ${file.name}: FOREIGN KEY constraint failed (pragma_foreign_key_check): ${JSON.stringify(violations)}. Every violation listed predates ${file.name}. This file's own statements did not introduce it. Repair the violation, then apply ${file.name} again.`);
          }
          throw new Error(`Migration ${file.name}: FOREIGN KEY constraint failed (pragma_foreign_key_check): ${JSON.stringify(violations)}`);
        }
      }
      storage.sql.exec(`insert into ${HISTORY} (name, applied_at, sql) values (?, ?, ?)`, file.name, new Date().toISOString(), file.sql);
    });
    applied.push(file.name);
  }
  return applied;
}

// Resolve each row pragma foreign_key_check returns ({table, rowid, parent,
// fkid}) to a key comparable across two different calls (a before-snapshot
// and a later file's after-check), or null when the row cannot be resolved
// that way.
//
// How this key reads a table's single primary-key column, per the block
// comment below: an ordinary named column read back by value, `row.rowid`
// itself in place of a column readback (AUTOINCREMENT's rowid-alias case),
// or null when the table stays unkeyable (composite key, WITHOUT ROWID, or
// a plain `integer primary key` with no AUTOINCREMENT).
type PkResolution = { kind: "column"; name: string } | { kind: "rowid" } | null;
//
// rowid alone is not a safe key: a file that deletes a violating row and
// then inserts a different, new violating row in the same statement can
// have the new row reuse the deleted row's rowid (measured directly --
// a table with exactly one row, that row deleted and immediately replaced
// by one insert, got the same rowid `1` the deleted row had, because the
// first insert into an empty rowid table always gets rowid `1`). Keying on
// rowid alone would then read the new row as the same already-known
// violation the before-snapshot named.
//
// row.fkid is not safe either, even together with the primary-key value: a
// rebuild of the violating row's own table can renumber it. SQLite assigns
// fkid by each foreign key's position in the table's current declaration,
// so a rebuild that adds, drops, or reorders a sibling foreign key on the
// same table changes the surviving fkid values -- measured directly: a
// table with two foreign keys keeps their fkid values only as long as its
// declaration does not change; a rebuild that appends a third foreign key
// can leave the earlier two at the same fkid values or renumber one of
// them, depending on the column order the rebuild's CREATE TABLE ends up
// with. A file that never touches the violating foreign key at all can
// still renumber it this way, so the before-snapshot's fkid for that row
// stops matching the after-check's, and the file gets blamed for a
// violation that predates it. The key below identifies a foreign key by
// what it points at instead: the parent table (`row.parent`, from
// pragma_foreign_key_check itself) and the referencing and referenced
// column names (`pragma foreign_key_list(table)`, matched by fkid within
// one violationKeys() call only -- see the cache note below). Neither of
// those changes when an unrelated foreign key is added, dropped, or
// reordered on the same table.
//
// (table, fkid, primary-key value) is not enough either, on its own: a file
// can leave the primary key untouched and still change which row the
// foreign key points at, with no delete or insert at all. A plain
// `update child set parent_id = 'missing-B' where id = 'c1'`, changing an
// existing violation's referenced value from one missing row to another,
// reproduces this (measured directly against node:sqlite): the primary key
// `'c1'` matches the before-snapshot, so a key without the referencing
// column reads it as the same already-known violation, when this file's own
// statement is the one that pointed it at a currently-missing parent. The
// key below adds the referencing column's (or columns', for a composite
// foreign key) current value, read with `pragma foreign_key_list(table)` to
// find which column or columns the given fkid names.
//
// (table, parent table, referencing and referenced column names,
// primary-key value, referencing-column values) tells every case above
// apart, and also two foreign keys on the same table that share a
// referencing column but point at different columns of the same parent
// table (measured directly: SQLite accepts two table-level FOREIGN KEY
// clauses naming the same column with different REFERENCES targets) --
// the referenced column name (`to`, alongside `from`) rules that out; the
// referencing column name alone would collapse both into one key. The
// primary-key half of the readback, `select <pk column>, <referencing
// columns...> from <table> where rowid = ?`, only works for a table with
// exactly one primary-key column (pragma table_info reports pk 1, 2, ... on
// every column of a composite key, so requiring exactly one pk column
// excludes those) whose declared type is not INTEGER (an `integer primary
// key` column is a rowid alias, so reading it back would just read the same
// rowid this key is trying to improve on) -- unless that column also carries
// AUTOINCREMENT, read from the table's own CREATE TABLE text the same way
// tableStatements() (src/build/migration.ts) already does, with the same
// tokenize()/isKeyword() pair. AUTOINCREMENT is exactly the guarantee this
// key needs: it forces every new rowid to exceed sqlite_sequence's own
// high-water mark, so a plain `integer primary key` can reuse a deleted
// row's rowid but an autoincrementing one never does (measured directly:
// deleting the one row of each kind of table and inserting a new one left
// the plain table's new row at the deleted rowid, and the autoincrementing
// table's new row past it). On that shape, this key uses `row.rowid` itself
// in place of a column readback -- reading the column back would only
// return the same rowid a second time. A plain `integer primary key`, with
// no AUTOINCREMENT, keeps no such guarantee and stays unkeyable. A WITHOUT
// ROWID table (rowid always null) has no rowid to look the row up by in the
// first place, and a composite primary key has no single column to read;
// both stay unkeyable too, and an unkeyable row always makes its file's own
// after-check treat the violation as new (see allPredate above): this
// project does not try to tell a pre-existing violation apart from a new
// one on those tables. A migration that renames the referencing column
// itself joins the unkeyable list: the name is part of this key, so the
// rename changes it even though the same row still names the same missing
// parent (migrations.md). A migration whose statements reassign an
// AUTOINCREMENT row's own rowid (`update child set id = ... where ...`)
// joins it too, in effect: nothing here tracks that reassignment, so the
// before-snapshot's `row.rowid` for that row no longer matches the row's
// rowid at the after-check, and the mismatch falls back to blaming the
// file, the same safe default an unkeyable row gets (measured directly:
// reassigning id from 1 to 999 changed pragma_foreign_key_check's own
// reported rowid from 1 to 999 between the two calls).
//
// table_info and foreign_key_list are cached per table for the lifetime of
// one violationKeys() call (its own map, declared inside the function, not
// shared across calls), so a violation-heavy pragma_foreign_key_check
// result queries a table's shape once, not once per row. row.fkid is stable
// within that one call (both are cache lookup keys here, not part of the
// returned key), so the cache keys on it safely; the cache does not span
// the two call sites in migrate() above (the before-snapshot and each
// file's own after-check): a rebuild between those two calls can recreate a
// table with a different fkid numbering or a different referencing column,
// and a cache spanning both would then read the wrong column, or a column
// that no longer exists, for a row the later call resolves.
function violationKeys(storage: StorageLike, violations: Record<string, unknown>[]): (string | null)[] {
  const pkColumn = new Map<string, PkResolution>();
  const foreignKeys = new Map<string, { from: string[]; to: string[] } | null>();
  return violations.map((row) => {
    if (row.rowid === null || row.rowid === undefined) return null;
    const table = String(row.table);
    let resolution = pkColumn.get(table);
    if (resolution === undefined) {
      const info = storage.sql.exec(`pragma table_info(${quoteIdent(table)})`).toArray();
      const pks = info.filter((c) => Number(c.pk) !== 0);
      if (pks.length !== 1) {
        resolution = null;
      } else if (String(pks[0]!.type).toUpperCase() !== "INTEGER") {
        resolution = { kind: "column", name: String(pks[0]!.name) };
      } else {
        // A single-column INTEGER PRIMARY KEY: a rowid alias. Read the
        // table's own declaration, the same way tableStatements()
        // (src/build/migration.ts) already does, to tell an AUTOINCREMENT
        // one (see the block comment above) from a plain one.
        const schemaRow = storage.sql.exec(`select sql from sqlite_schema where type = 'table' and lower(name) = lower(?)`, table).toArray()[0];
        const auto = schemaRow !== undefined && tokenize(String(schemaRow.sql)).some((t) => isKeyword(t, "autoincrement"));
        resolution = auto ? { kind: "rowid" } : null;
      }
      pkColumn.set(table, resolution);
    }
    if (resolution === null) return null;
    const cacheKey = JSON.stringify([table, row.fkid]);
    let fk = foreignKeys.get(cacheKey);
    if (fk === undefined) {
      const fkList = storage.sql.exec(`pragma foreign_key_list(${quoteIdent(table)})`).toArray()
        .filter((r) => Number(r.id) === Number(row.fkid))
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      fk = fkList.length > 0 ? { from: fkList.map((r) => String(r.from)), to: fkList.map((r) => String(r.to)) } : null;
      foreignKeys.set(cacheKey, fk);
    }
    if (fk === null) return null;
    // AUTOINCREMENT's rowid-alias column is not part of this select: it
    // would only read back the same row.rowid already in hand (see the
    // block comment above), so this list holds the referencing columns
    // alone in that case. Every selected column still gets its own alias,
    // even a referencing column that is also the primary-key column (a
    // foreign key declared on the primary-key column itself): without an
    // alias per position, a repeated column name would collapse to one
    // property on the result row, silently losing one of the readings this
    // key needs.
    const pkColumns = resolution.kind === "column" ? [resolution.name] : [];
    const selectList = [...pkColumns, ...fk.from].map((c, i) => `${quoteIdent(c)} as v${i}`).join(", ");
    const readback = storage.sql.exec(`select ${selectList} from ${quoteIdent(table)} where rowid = ?`, row.rowid).toArray()[0];
    if (readback === undefined) return null;
    const values = [...pkColumns, ...fk.from].map((_, i) => readback[`v${i}`]);
    const pkValue = resolution.kind === "rowid" ? row.rowid : values[0];
    const referencingValues = resolution.kind === "rowid" ? values : values.slice(1);
    return JSON.stringify([table, String(row.parent), fk.from, fk.to, pkValue, ...referencingValues]);
  });
}
