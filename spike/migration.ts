// Spike: a migration is the difference between two schemas that both live in
// node:sqlite. The current schema comes from the migration files applied in
// order. The target schema comes from the declared DDL. No snapshot file.
//
// Responsibility: introspect both databases, compute the statements that take
// the current schema to the target schema, and render a wrangler-style file.
// Boundary: no SQL parser. A scanner that tracks string literals and
// parenthesis depth finds column definitions and splits statements. The
// engine decides everything else: a candidate ALTER runs on a scratch database
// and is kept only when the scratch shape equals the target shape.
// Views and triggers are out of scope for this spike.
import { DatabaseSync } from "node:sqlite";

export type Column = {
  name: string;
  type: string;
  notnull: boolean;
  dflt: string | null;
  pk: number;
  // The declared text of the column, normalized. ADD COLUMN needs the text,
  // and a change in the text (a CHECK, a REFERENCES) means a rebuild.
  def: string;
};
export type ForeignKey = { table: string; from: string; to: string; onUpdate: string; onDelete: string };
export type Table = {
  name: string;
  sql: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
  // Table-level constraints (CHECK, UNIQUE, PRIMARY KEY, FOREIGN KEY), normalized.
  constraints: string[];
  withoutRowid: boolean;
};
export type Index = { name: string; table: string; sql: string };
export type Schema = { tables: Map<string, Table>; indexes: Map<string, Index> };
export type Rename = { table: string; from: string; to: string };
export type Plan = { kind: "ok"; statements: string[] } | { kind: "blocked"; reason: string };

// --- scanner -----------------------------------------------------------------

// Split `text` at top-level separators. The scanner skips string literals,
// double-quoted identifiers, and nested parentheses.
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (text[i + 1] === quote) {
          current += quote;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === separator && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// The body of a CREATE TABLE: the text between the outer parentheses.
function tableBody(sql: string): { body: string; tail: string } {
  const open = sql.indexOf("(");
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === quote && sql[i + 1] !== quote) quote = null;
      else if (ch === quote) i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { body: sql.slice(open + 1, i), tail: sql.slice(i + 1) };
    }
  }
  throw new Error(`unbalanced CREATE TABLE: ${sql}`);
}

export function normalize(text: string): string {
  return text
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

function unquote(token: string): string {
  const m = /^"((?:[^"]|"")*)"$|^`([^`]*)`$|^\[([^\]]*)\]$/.exec(token);
  if (!m) return token;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/""/g, '"');
}

const constraintKeywords = new Set(["constraint", "primary", "unique", "check", "foreign"]);

// Column definitions and table constraints, from the CREATE TABLE text.
function definitions(sql: string): { columns: Map<string, string>; constraints: string[] } {
  const { body } = tableBody(sql);
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const item of splitTopLevel(body, ",")) {
    const first = /^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/.exec(item)![1]!;
    if (constraintKeywords.has(first.toLowerCase())) constraints.push(normalize(item));
    // RENAME COLUMN rewrites the stored text with the name as given, quoted or
    // bare, so the name is unquoted before the text is compared.
    else columns.set(unquote(first), normalize(unquote(first) + item.slice(first.length)));
  }
  return { columns, constraints };
}

// Statements in a migration file. A trigger body holds semicolons between
// BEGIN and END, so the scanner counts that block as one statement.
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let inTrigger = false;
  let current = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && sql[i + 1] !== quote) quote = null;
      else if (ch === quote) {
        current += quote;
        i++;
      }
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      current += "\n";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    const word = /^[A-Za-z_]+/.exec(sql.slice(i, i + 8))?.[0]?.toLowerCase();
    const atWordStart = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]!);
    if (atWordStart && word === "begin" && depth === 0 && /^begin\b/i.test(sql.slice(i))) inTrigger = true;
    if (atWordStart && word === "end" && depth === 0 && inTrigger && /^end\b/i.test(sql.slice(i))) inTrigger = false;
    if (ch === ";" && depth === 0 && !inTrigger) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

// --- engine side -------------------------------------------------------------

export function open(statements: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const s of statements) db.exec(s);
  return db;
}

export function introspect(db: DatabaseSync): Schema {
  const tables = new Map<string, Table>();
  const indexes = new Map<string, Index>();
  const rows = db
    .prepare(`select type, name, tbl_name, sql from sqlite_schema where sql is not null and name not like 'sqlite_%' order by name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  for (const row of rows) {
    if (row.type === "table") {
      const defs = definitions(row.sql);
      const columns = (db.prepare(`select name, type, "notnull" as nn, dflt_value, pk from pragma_table_xinfo(?) where hidden = 0`).all(row.name) as {
        name: string;
        type: string;
        nn: number;
        dflt_value: string | null;
        pk: number;
      }[]).map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.nn === 1,
        dflt: c.dflt_value,
        pk: c.pk,
        def: defs.columns.get(c.name) ?? "",
      }));
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
        constraints: defs.constraints,
        withoutRowid: /\bwithout\s+rowid\b/i.test(tableBody(row.sql).tail),
      });
    } else if (row.type === "index") {
      indexes.set(row.name, { name: row.name, table: row.tbl_name, sql: row.sql });
    }
  }
  return { tables, indexes };
}

// A comparable value. Two schemas with equal shapes accept the same rows and
// enforce the same constraints. The CREATE text itself is not compared, since
// ADD COLUMN and RENAME rewrite it in their own way.
export function shape(schema: Schema): unknown {
  return {
    tables: [...schema.tables.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({ ...c })),
        foreignKeys: t.foreignKeys,
        constraints: [...t.constraints].sort(),
        withoutRowid: t.withoutRowid,
      })),
    indexes: [...schema.indexes.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => ({ name: i.name, table: i.table, sql: normalize(i.sql) })),
  };
}

function sameShape(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// The declared CREATE TABLE, renamed. The name token follows CREATE TABLE
// (with an optional IF NOT EXISTS), quoted or bare.
function renamedCreate(sql: string, newName: string): string {
  return sql.replace(/^(\s*create\s+table\s+(?:if\s+not\s+exists\s+)?)("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/i, `$1${quoteIdent(newName)}`);
}

// --- diff --------------------------------------------------------------------

// keptIndexes: the CREATE INDEX statements on this table that the migration
// keeps. The scratch database needs them, because DROP COLUMN fails on an
// indexed column and the candidate must fail the same way there.
function tableStatements(current: Table, target: Table, renames: Rename[], keptIndexes: string[]): Plan & { rebuilt?: boolean } {
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
  // NOT NULL column without a default has no value for those rows, so the
  // generator stops instead of shipping a file that fails on the first row.
  for (const n of added) {
    const col = target.columns.find((c) => c.name === n)!;
    if (col.notnull && col.dflt === null) {
      return {
        kind: "blocked",
        reason: `table ${current.name}: new column ${n} is NOT NULL without a default. Existing rows have no value for it. Add a default or allow null.`,
      };
    }
  }

  // Candidate: the cheap ALTERs. The engine judges them on a scratch copy.
  const candidate = [...statements];
  for (const n of removed) candidate.push(`alter table ${quoteIdent(current.name)} drop column ${quoteIdent(n)}`);
  for (const n of added) {
    const col = target.columns.find((c) => c.name === n)!;
    candidate.push(`alter table ${quoteIdent(current.name)} add column ${col.def}`);
  }
  const scratch = open([current.sql, ...keptIndexes]);
  try {
    for (const s of candidate) scratch.exec(s);
    const after = introspect(scratch).tables.get(current.name)!;
    if (sameShape(tableShape(after), tableShape(target))) return { kind: "ok", statements: candidate };
  } catch {
    // The engine refused the cheap path. Rebuild below.
  } finally {
    scratch.close();
  }

  // Rebuild. Only this order commits inside one transaction when the table
  // is a foreign-key parent: the rows must re-enter under the final name so
  // the deferred foreign-key counter returns to zero.
  const common = target.columns.map((c) => c.name).filter((n) => currentColumns.has(n)).map(quoteIdent).join(", ");
  const name = quoteIdent(current.name);
  const fresh = quoteIdent(`_solarsql_new_${current.name}`);
  const copy = quoteIdent(`_solarsql_copy_${current.name}`);
  const rebuilt = [
    ...statements,
    renamedCreate(target.sql, `_solarsql_new_${current.name}`),
    `create table ${copy} as select ${common} from ${name}`,
    `drop table ${name}`,
    `alter table ${fresh} rename to ${name}`,
    `insert into ${name} (${common}) select ${common} from ${copy}`,
    `drop table ${copy}`,
  ];
  return { kind: "ok", statements: rebuilt, rebuilt: true };
}

function tableShape(t: Table): unknown {
  return {
    columns: t.columns,
    foreignKeys: t.foreignKeys,
    constraints: [...t.constraints].sort(),
    withoutRowid: t.withoutRowid,
  };
}

export function diff(current: Schema, target: Schema, renames: Rename[] = []): Plan {
  // Order: drop indexes, drop tables, change tables, create indexes.
  // An index that names a column must go before the column does, and an
  // index on a rebuilt table disappears with the table.
  const dropIndexes: string[] = [];
  const dropTables: string[] = [];
  const changeTables: string[] = [];
  const createIndexes: string[] = [];
  const rebuilt = new Set<string>();
  let needsDefer = false;

  const keptIndexes = new Map<string, string[]>();
  for (const [name, index] of current.indexes) {
    const t = target.indexes.get(name);
    if (!t || normalize(t.sql) !== normalize(index.sql)) dropIndexes.push(`drop index ${quoteIdent(name)}`);
    else keptIndexes.set(index.table, [...(keptIndexes.get(index.table) ?? []), index.sql]);
  }
  for (const name of current.tables.keys()) {
    if (!target.tables.has(name)) dropTables.push(`drop table ${quoteIdent(name)}`);
  }
  for (const [name, target_] of target.tables) {
    const current_ = current.tables.get(name);
    if (!current_) {
      changeTables.push(target_.sql);
      continue;
    }
    if (sameShape(tableShape(current_), tableShape(target_))) continue;
    const plan = tableStatements(current_, target_, renames, keptIndexes.get(name) ?? []);
    if (plan.kind === "blocked") return plan;
    if (plan.rebuilt) {
      rebuilt.add(name);
      needsDefer = true;
    }
    changeTables.push(...plan.statements);
  }
  for (const [name, index] of target.indexes) {
    const c = current.indexes.get(name);
    if (rebuilt.has(index.table) || !c || normalize(c.sql) !== normalize(index.sql)) createIndexes.push(index.sql);
  }
  // Indexes on a rebuilt table are already gone when the table is dropped.
  const drops = dropIndexes.filter((s) => {
    const name = /drop index "((?:[^"]|"")*)"/.exec(s)![1]!.replace(/""/g, '"');
    return !rebuilt.has(current.indexes.get(name)!.table);
  });
  const statements = [...drops, ...dropTables, ...changeTables, ...createIndexes];
  if (needsDefer) statements.unshift(`pragma defer_foreign_keys = on`);
  return { kind: "ok", statements };
}

// wrangler applies `migrations/<NNNN>_<name>.sql` in name order and records
// each file in d1_migrations. The file holds statements separated by ';'.
export function render(sequence: number, name: string, statements: string[]): { filename: string; sql: string } {
  const filename = `${String(sequence).padStart(4, "0")}_${name}.sql`;
  const sql = `-- Migration ${filename}. Generated from the declared schema.\n` + statements.map((s) => `${s.trim()};`).join("\n") + "\n";
  return { filename, sql };
}

// The schema after the migration files, in order.
export function applied(files: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) {
    db.exec("begin");
    for (const s of splitStatements(file)) db.exec(s);
    db.exec("commit");
  }
  return db;
}
