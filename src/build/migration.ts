// Responsibility: the statements that take the current schema to the
// declared schema. The current schema is the result of the migration files
// applied in order. The declared schema is the DDL of every module plus the
// guard table. Both live in node:sqlite, and the engine decides whether a
// cheap ALTER is enough: the candidate runs on a scratch database and is
// kept only when the scratch shape equals the declared shape.
// Boundary: no file system. build.ts reads and writes the files. Tables,
// indexes, search tables, views, and triggers are diffed. A search table
// (CREATE VIRTUAL TABLE) has no ALTER: a change drops it and creates it
// again, and its shadow tables are the engine's own.
import { DatabaseSync } from "node:sqlite";
import { definitions, normalize, quoteIdent, splitStatements, tokenize, type Token } from "./scan.ts";

export type Column = { name: string; type: string; notnull: boolean; dflt: string | null; pk: number; def: string; generated: boolean };
export type ForeignKey = { table: string; from: string; to: string; onUpdate: string; onDelete: string };
export type Table = { name: string; sql: string; columns: Column[]; foreignKeys: ForeignKey[]; constraints: string[]; withoutRowid: boolean; strict: boolean };
export type Index = { name: string; table: string; sql: string };
export type Trigger = { name: string; table: string; sql: string };
export type View = { name: string; sql: string };
export type Virtual = { name: string; sql: string };
export type Schema = { tables: Map<string, Table>; indexes: Map<string, Index>; triggers: Map<string, Trigger>; views: Map<string, View>; virtuals: Map<string, Virtual> };
export type Rename = { table: string; from: string; to: string };
export type Plan = { kind: "ok"; statements: string[] } | { kind: "blocked"; reason: string };

export function open(statements: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const s of statements) db.exec(s);
  return db;
}

// The schema after the migration files, applied in order, one transaction
// per file, the way wrangler applies them.
export function applied(files: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) {
    db.exec("begin");
    for (const s of splitStatements(file)) db.exec(s);
    db.exec("commit");
  }
  return db;
}

export function introspect(db: DatabaseSync): Schema {
  const tables = new Map<string, Table>();
  const indexes = new Map<string, Index>();
  const triggers = new Map<string, Trigger>();
  const views = new Map<string, View>();
  const virtuals = new Map<string, Virtual>();
  // pragma table_list tells a virtual table and its shadow tables apart
  // from a plain table; sqlite_schema calls all three "table".
  const kinds = new Map((db.prepare(`select name, type from pragma_table_list where schema = 'main'`).all() as { name: string; type: string }[]).map((r) => [r.name, r.type]));
  const rows = db
    .prepare(`select type, name, tbl_name, sql from sqlite_schema where sql is not null and name not like 'sqlite_%' order by name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  for (const row of rows) {
    if (row.type === "table" && kinds.get(row.name) === "shadow") continue;
    if (row.type === "table" && kinds.get(row.name) === "virtual") {
      virtuals.set(row.name, { name: row.name, sql: row.sql });
    } else if (row.type === "table") {
      const defs = definitions(row.sql);
      // hidden 2 and 3 are generated columns; they take part in the shape
      // and are left out of a rebuild's copy.
      const columns = (db.prepare(`select name, type, "notnull" as nn, dflt_value, pk, hidden from pragma_table_xinfo(?) where hidden in (0, 2, 3)`).all(row.name) as {
        name: string;
        type: string;
        nn: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }[]).map((c) => ({ name: c.name, type: c.type, notnull: c.nn === 1, dflt: c.dflt_value, pk: c.pk, def: defs?.columns.get(c.name) ?? "", generated: c.hidden !== 0 }));
      const foreignKeys = (db.prepare(`select "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(?) order by id, seq`).all(row.name) as {
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }[]).map((f) => ({ table: f.table, from: f.from, to: f.to, onUpdate: f.on_update, onDelete: f.on_delete }));
      tables.set(row.name, {
        name: row.name,
        sql: row.sql,
        columns,
        foreignKeys,
        constraints: defs?.constraints ?? [],
        withoutRowid: /\bwithout\s+rowid\b/i.test(row.sql.slice(row.sql.lastIndexOf(")"))),
        strict: /\bstrict\b/i.test(row.sql.slice(row.sql.lastIndexOf(")"))),
      });
    } else if (row.type === "index") {
      indexes.set(row.name, { name: row.name, table: row.tbl_name, sql: row.sql });
    } else if (row.type === "trigger") {
      triggers.set(row.name, { name: row.name, table: row.tbl_name, sql: row.sql });
    } else if (row.type === "view") {
      views.set(row.name, { name: row.name, sql: row.sql });
    }
  }
  return { tables, indexes, triggers, views, virtuals };
}

// A comparable value. Two schemas with equal shapes accept the same rows
// and enforce the same constraints. The CREATE text of a table is not
// compared, since ADD COLUMN and RENAME rewrite it in their own way.
export function shape(schema: Schema): unknown {
  return {
    tables: [...schema.tables.values()].sort(byName).map(tableShape),
    indexes: [...schema.indexes.values()].sort(byName).map((i) => ({ name: i.name, table: i.table, sql: normalize(i.sql) })),
    triggers: [...schema.triggers.values()].sort(byName).map((t) => ({ name: t.name, table: t.table, sql: normalize(t.sql) })),
    views: [...schema.views.values()].sort(byName).map((v) => ({ name: v.name, sql: normalize(v.sql) })),
    virtuals: [...schema.virtuals.values()].sort(byName).map((v) => ({ name: v.name, sql: normalize(v.sql) })),
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function tableShape(t: Table): unknown {
  return { name: t.name, columns: t.columns, foreignKeys: t.foreignKeys, constraints: [...t.constraints].sort(), withoutRowid: t.withoutRowid, strict: t.strict };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The declared CREATE TABLE under another name.
function renamedCreate(sql: string, newName: string): string {
  return sql.replace(/^(\s*create\s+table\s+(?:if\s+not\s+exists\s+)?)("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/i, `$1${quoteIdent(newName)}`);
}

function tableStatements(current: Table, target: Table, renames: readonly Rename[], keptIndexes: readonly string[]): Plan & { rebuilt?: boolean } {
  const statements: string[] = [];
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  for (const r of renames.filter((r) => r.table === current.name)) {
    const from = currentColumns.get(r.from);
    if (!from || currentColumns.has(r.to) || !target.columns.some((c) => c.name === r.to)) {
      return { kind: "blocked", reason: `table ${current.name}: rename ${r.from} -> ${r.to} does not match the schemas` };
    }
    statements.push(`alter table ${quoteIdent(current.name)} rename column ${quoteIdent(r.from)} to ${quoteIdent(r.to)}`);
    currentColumns.delete(r.from);
    currentColumns.set(r.to, { ...from, name: r.to });
  }
  const targetNames = new Set(target.columns.map((c) => c.name));
  const removed = [...currentColumns.keys()].filter((n) => !targetNames.has(n));
  const added = target.columns.filter((c) => !currentColumns.has(c.name)).map((c) => c.name);
  if (removed.length > 0 && added.length > 0) {
    return {
      kind: "blocked",
      reason:
        `table ${current.name}: columns [${removed.join(", ")}] removed and [${added.join(", ")}] added in one change. ` +
        `Declare a rename if the data must move, or split the change into two migrations.`,
    };
  }
  // A migration runs on databases with rows the generator cannot see. A new
  // NOT NULL column without a default has no value for those rows.
  for (const n of added) {
    const col = target.columns.find((c) => c.name === n)!;
    if (col.notnull && col.dflt === null && !col.generated) {
      return {
        kind: "blocked",
        reason: `table ${current.name}: new column ${n} is NOT NULL without a default. Existing rows have no value for it. Add a default or allow null.`,
      };
    }
  }

  // Candidate: the cheap ALTERs. The engine judges them on a scratch copy
  // that carries the indexes the migration keeps, because DROP COLUMN fails
  // on an indexed column there as it would in production. The scratch has
  // no rows, and ADD COLUMN of a STORED generated column fails only on a
  // table with rows, so that case goes straight to the rebuild.
  const addsStored = added.some((n) => {
    const c = target.columns.find((x) => x.name === n)!;
    return c.generated && /\bstored\b/i.test(c.def);
  });
  const candidate = addsStored ? null : [...statements];
  if (candidate !== null) {
    for (const n of removed) candidate.push(`alter table ${quoteIdent(current.name)} drop column ${quoteIdent(n)}`);
    for (const n of added) candidate.push(`alter table ${quoteIdent(current.name)} add column ${target.columns.find((c) => c.name === n)!.def}`);
    const scratch = open([current.sql, ...keptIndexes]);
    try {
      for (const s of candidate) scratch.exec(s);
      const after = introspect(scratch).tables.get(current.name)!;
      if (same(tableShape(after), tableShape(target))) return { kind: "ok", statements: candidate };
    } catch {
      // The engine refused the cheap path. Rebuild below.
    } finally {
      scratch.close();
    }
  }

  // Rebuild. Only this order commits inside one transaction when the table
  // is a foreign-key parent: the rows must re-enter under the final name so
  // the deferred foreign-key counter returns to zero.
  // A generated column computes itself, so the copy leaves it out.
  const common = target.columns.filter((c) => !c.generated).map((c) => c.name).filter((n) => currentColumns.has(n)).map(quoteIdent).join(", ");
  const name = quoteIdent(current.name);
  const fresh = quoteIdent(`_solarsql_new_${current.name}`);
  const copy = quoteIdent(`_solarsql_copy_${current.name}`);
  return {
    kind: "ok",
    rebuilt: true,
    statements: [
      ...statements,
      renamedCreate(target.sql, `_solarsql_new_${current.name}`),
      `create table ${copy} as select ${common} from ${name}`,
      `drop table ${name}`,
      `alter table ${fresh} rename to ${name}`,
      `insert into ${name} (${common}) select ${common} from ${copy}`,
      `drop table ${copy}`,
    ],
  };
}

export function diff(current: Schema, target: Schema, renames: readonly Rename[] = []): Plan {
  // Order: drop views, drop triggers and indexes, drop tables, change
  // tables, create indexes, views, and triggers. An index that names a
  // column must go before the column does. An index or trigger on a rebuilt
  // table disappears with it. A rebuild renames a table under the views,
  // and RENAME fails while a view names a table that is gone, so every view
  // is dropped before a rebuild and created again after it.
  const dropViews: string[] = [];
  const dropFirst: string[] = [];
  const dropTables: string[] = [];
  const changeTables: string[] = [];
  const createLast: string[] = [];
  const rebuilt = new Set<string>();
  let needsDefer = false;

  const keptIndexes = new Map<string, string[]>();
  const dropIndexOf = new Map<string, string>();
  for (const [name, index] of current.indexes) {
    const t = target.indexes.get(name);
    if (!t || normalize(t.sql) !== normalize(index.sql)) dropIndexOf.set(name, index.table);
    else keptIndexes.set(index.table, [...(keptIndexes.get(index.table) ?? []), index.sql]);
  }
  const dropTriggerOf = new Map<string, string>();
  for (const [name, trigger] of current.triggers) {
    const t = target.triggers.get(name);
    if (!t || normalize(t.sql) !== normalize(trigger.sql)) dropTriggerOf.set(name, trigger.table);
  }
  for (const name of current.tables.keys()) {
    if (!target.tables.has(name)) dropTables.push(`drop table ${quoteIdent(name)}`);
  }
  // A search table has no ALTER. A changed or removed one is dropped, and
  // a changed or new one is created after the tables, before the triggers
  // that write it.
  const virtualSame = (name: string) => {
    const c = current.virtuals.get(name);
    const t = target.virtuals.get(name);
    return c !== undefined && t !== undefined && normalize(c.sql) === normalize(t.sql);
  };
  for (const name of current.virtuals.keys()) if (!virtualSame(name)) dropTables.push(`drop table ${quoteIdent(name)}`);
  const createVirtuals = [...target.virtuals.values()].filter((v) => !virtualSame(v.name)).map((v) => v.sql);
  for (const [name, target_] of target.tables) {
    const current_ = current.tables.get(name);
    if (!current_) {
      changeTables.push(target_.sql);
      continue;
    }
    if (same(tableShape(current_), tableShape(target_))) continue;
    const plan = tableStatements(current_, target_, renames, keptIndexes.get(name) ?? []);
    if (plan.kind === "blocked") return plan;
    if (plan.rebuilt) {
      rebuilt.add(name);
      needsDefer = true;
    }
    changeTables.push(...plan.statements);
  }
  const viewSame = (name: string) => {
    const c = current.views.get(name);
    const t = target.views.get(name);
    return c !== undefined && t !== undefined && normalize(c.sql) === normalize(t.sql);
  };
  const allViews = rebuilt.size > 0;
  for (const name of current.views.keys()) if (allViews || !viewSame(name)) dropViews.push(`drop view ${quoteIdent(name)}`);
  const gone = (table: string) => rebuilt.has(table) || !target.tables.has(table);
  for (const [name, table] of dropTriggerOf) if (!gone(table)) dropFirst.push(`drop trigger ${quoteIdent(name)}`);
  for (const [name, table] of dropIndexOf) if (!gone(table)) dropFirst.push(`drop index ${quoteIdent(name)}`);
  for (const [name, index] of target.indexes) {
    const c = current.indexes.get(name);
    if (rebuilt.has(index.table) || !c || normalize(c.sql) !== normalize(index.sql)) createLast.push(index.sql);
  }
  for (const [name, view] of target.views) if (allViews || !viewSame(name)) createLast.push(view.sql);
  for (const [name, trigger] of target.triggers) {
    const c = current.triggers.get(name);
    if (rebuilt.has(trigger.table) || !c || normalize(c.sql) !== normalize(trigger.sql)) createLast.push(triggerForD1(trigger.sql));
  }
  const statements = [...dropViews, ...dropFirst, ...dropTables, ...changeTables, ...createVirtuals, ...createLast];
  if (needsDefer) statements.unshift(`pragma defer_foreign_keys = on`);
  return { kind: "ok", statements };
}

// D1's HTTP API splits a request into statements on its own, and it keeps a
// trigger body whole only when the BEGIN that opens it is uppercase
// (workers-sdk issue 15314; measured on a remote database on 2026-09-06:
// `begin` and `Begin` fail with "incomplete input", `BEGIN` passes, and the
// case of END makes no difference). SQLite reads every case, so the
// migration file writes both keywords uppercase. normalize() lowercases
// them for the diff, so the file and the declaration still compare equal.
function triggerForD1(sql: string): string {
  const tokens = tokenize(sql);
  const bare = (t: Token, word: string) => t.type === "ident" && t.text.toLowerCase() === word;
  const begin = tokens.find((t) => bare(t, "begin"));
  const end = tokens.findLast((t) => bare(t, "end"));
  if (!begin || !end) return sql;
  let out = sql;
  for (const t of [end, begin]) out = out.slice(0, t.start) + t.text.toUpperCase() + out.slice(t.end);
  return out;
}

// wrangler applies `migrations/<NNNN>_<name>.sql` in name order and records
// each file in d1_migrations. The file holds statements separated by ';'.
export function render(sequence: number, name: string, statements: readonly string[]): { filename: string; sql: string } {
  const filename = `${String(sequence).padStart(4, "0")}_${name}.sql`;
  const sql = `-- Migration ${filename}. Generated by solarsql from the declared schema.\n` + statements.map((s) => `${s.trim()};`).join("\n") + "\n";
  return { filename, sql };
}
