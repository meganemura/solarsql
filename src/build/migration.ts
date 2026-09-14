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
import { definitions, isKeyword, normalize, quoteIdent, splitStatements, tokenize, type Token } from "./scan.ts";
import { BuildError } from "./typegen.ts";

export type Column = { name: string; type: string; notnull: boolean; dflt: string | null; pk: number; def: string; generated: boolean };
export type ForeignKey = { table: string; from: string; to: string; onUpdate: string; onDelete: string };
export type Table = { name: string; sql: string; columns: Column[]; foreignKeys: ForeignKey[]; constraints: string[]; withoutRowid: boolean; strict: boolean; rowidAlias: string | null };
export type Index = { name: string; table: string; sql: string };
export type Trigger = { name: string; table: string; sql: string };
export type View = { name: string; sql: string };
export type Virtual = { name: string; sql: string };
export type Schema = { tables: Map<string, Table>; indexes: Map<string, Index>; triggers: Map<string, Trigger>; views: Map<string, View>; virtuals: Map<string, Virtual> };
export type Rename = { table: string; from: string; to: string };
export type RenameRepair = { table: string; from: string[]; to: string[] };
// A drop names the SQLite object by its logical name, not by SQL text. This
// keeps a dot in a quoted identifier as one name instead of a table/column
// separator. The CLI writes the SQL spelling only for its diagnostic.
export type DropIntent = { kind: "table"; table: string } | { kind: "column"; table: string; column: string };
export type Plan = { kind: "ok"; statements: string[] } | { kind: "blocked"; reason: string; drops?: DropIntent[]; renames?: Rename[]; renameCandidates?: RenameRepair[] };

export function open(statements: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const s of statements) db.exec(s);
  return db;
}

// The schema after the migration files, applied in order, one transaction
// per file, the way wrangler applies them.
// `names`, when given, lets a replay failure name the specific migration
// file it came from, matching the location a build error carries
// everywhere else. Callers that only have raw SQL fragments (most tests)
// omit it and get the engine's own message unwrapped, as before.
export function applied(files: readonly string[], names?: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const [i, file] of files.entries()) {
    let statements: string[] = [];
    // Non-null only while a specific statement of this file is running, so
    // a failure at "begin" or "commit" itself (for example a deferred
    // foreign key checked at commit) is not misattributed to the last
    // statement that happened to run before it.
    let ordinal: number | null = null;
    try {
      statements = splitStatements(file);
      db.exec("begin");
      for (const [j, s] of statements.entries()) {
        ordinal = j + 1;
        db.exec(s);
      }
      ordinal = null;
      db.exec("commit");
    } catch (e) {
      const at = ordinal === null ? "" : `, statement ${ordinal} of ${statements.length}`;
      throw names ? new BuildError(`migration ${names[i]}${at}: ${(e as Error).message}`) : e;
    }
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
  const attributes = new Map((db.prepare(`select name, type, wr, strict from pragma_table_list where schema = 'main'`).all() as { name: string; type: string; wr: number; strict: number }[]).map((r) => [r.name, r]));
  const rows = db
    .prepare(`select type, name, tbl_name, sql from sqlite_schema where sql is not null and lower(name) not glob 'sqlite_*' order by name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  for (const row of rows) {
    const table = attributes.get(row.name);
    if (row.type === "table" && table?.type === "shadow") continue;
    if (row.type === "table" && table?.type === "virtual") {
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
        withoutRowid: table!.wr === 1,
        strict: table!.strict === 1,
        // INTEGER PRIMARY KEY DESC has a separate primary-key index and
        // therefore does not alias rowid. Let SQLite distinguish that case.
        rowidAlias: table!.wr === 0 && columns.filter(c => c.pk > 0).length === 1
          && columns.some(c => c.pk > 0 && c.type.toUpperCase() === "INTEGER")
          && !db.prepare(`select 1 from pragma_index_list(?) where origin = 'pk'`).get(row.name)
          ? columns.find(c => c.pk > 0)!.name : null,
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
  return { name: t.name, columns: t.columns, foreignKeys: t.foreignKeys, constraints: [...t.constraints].sort(), withoutRowid: t.withoutRowid, strict: t.strict, rowidAlias: t.rowidAlias };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The declared CREATE TABLE under another name.
function renamedCreate(sql: string, newName: string): string {
  return sql.replace(/^(\s*create\s+table\s+(?:if\s+not\s+exists\s+)?)("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/i, `$1${quoteIdent(newName)}`);
}

function tableStatements(current: Table, target: Table, renames: readonly Rename[], drops: readonly DropIntent[], keptIndexes: readonly string[]): Plan & { rebuilt?: boolean } {
  const statements: string[] = [];
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  let currentAlias = current.rowidAlias;
  for (const r of renames.filter((r) => r.table === current.name)) {
    const from = currentColumns.get(r.from);
    if (!from || currentColumns.has(r.to) || !target.columns.some((c) => c.name === r.to)) {
      return { kind: "blocked", reason: `table ${current.name}: rename ${r.from} -> ${r.to} does not match the schemas` };
    }
    statements.push(`alter table ${quoteIdent(current.name)} rename column ${quoteIdent(r.from)} to ${quoteIdent(r.to)}`);
    currentColumns.delete(r.from);
    currentColumns.set(r.to, { ...from, name: r.to });
    if (currentAlias === r.from) currentAlias = r.to;
  }
  const targetNames = new Set(target.columns.map((c) => c.name));
  const removed = [...currentColumns.keys()].filter((n) => !targetNames.has(n));
  const added = target.columns.filter((c) => !currentColumns.has(c.name)).map((c) => c.name);
  const unreviewedRemoved = removed.filter(column => !drops.some(drop => drop.kind === "column" && drop.table === current.name && drop.column === column));
  if (unreviewedRemoved.length > 0 && added.length > 0) {
    return {
      kind: "blocked",
      reason:
        `table ${current.name}: columns [${unreviewedRemoved.join(", ")}] removed and [${added.join(", ")}] added in one change. ` +
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

  // Rebuild. Rows re-enter under the final name so deferred NO ACTION
  // references return to zero. diff() blocks delete actions before this
  // plan can reach a database with child rows.
  // A generated column computes itself, so the copy leaves it out.
  const common = target.columns.filter((c) => !c.generated).map((c) => c.name).filter((n) => currentColumns.has(n));
  const capture = common.map(quoteIdent), destination = common.map(quoteIdent), restore = common.map(quoteIdent);
  if (!current.withoutRowid && !target.withoutRowid) {
    const address = (columns: Iterable<string>, alias: string | null) => {
      const names = new Set([...columns].map(name => name.toLowerCase()));
      return alias ?? ["rowid", "_rowid_", "oid"].find(name => !names.has(name));
    };
    const from = address(currentColumns.keys(), currentAlias);
    const to = address(target.columns.map(c => c.name), target.rowidAlias);
    if (!from || !to || (target.rowidAlias !== null && target.rowidAlias !== currentAlias)) {
      return { kind: "blocked", reason: `table ${current.name}: the rebuild cannot prove rowid preservation because an identifier is shadowed or its primary-key alias changes. Keep an accessible identifier and its alias, or write an explicit migration with a data check.` };
    }
    // A preserved INTEGER PRIMARY KEY already carries the identifier.
    // Otherwise capture it separately, under a name that cannot mask data.
    if (target.rowidAlias === null) {
      let saved = "_solarsql_rowid";
      while (common.some(name => name.toLowerCase() === saved.toLowerCase())) saved += "_";
      capture.push(`${quoteIdent(from)} as ${quoteIdent(saved)}`);
      destination.push(quoteIdent(to));
      restore.push(quoteIdent(saved));
    }
  }
  const name = quoteIdent(current.name);
  const fresh = quoteIdent(`_solarsql_new_${current.name}`);
  const copy = quoteIdent(`_solarsql_copy_${current.name}`);
  const sequence = quoteIdent(`_solarsql_sequence_${current.name}`);
  const tableLiteral = `'${current.name.replaceAll("'", "''")}'`;
  const keepsSequence = [current, target].every(table => tokenize(table.sql).some(token => isKeyword(token, "autoincrement")));
  return {
    kind: "ok",
    rebuilt: true,
    statements: [
      ...statements,
      renamedCreate(target.sql, `_solarsql_new_${current.name}`),
      `create table ${copy} as select ${capture.join(", ")} from ${name}`,
      ...(keepsSequence ? [`create table ${sequence} as select max(seq) as seq from sqlite_sequence where name = ${tableLiteral}`] : []),
      `drop table ${name}`,
      `alter table ${fresh} rename to ${name}`,
      `insert into ${name} (${destination.join(", ")}) select ${restore.join(", ")} from ${copy}`,
      // Deleted maxima are absent from copied rows. Keep their high-water
      // mark in SQL so even a 64-bit sequence never passes through JavaScript.
      ...(keepsSequence ? [
        `insert into sqlite_sequence (name, seq) select ${tableLiteral}, seq from ${sequence} where seq is not null and not exists (select 1 from sqlite_sequence where name = ${tableLiteral})`,
        `update sqlite_sequence set seq = max(seq, coalesce((select seq from ${sequence}), seq)) where name = ${tableLiteral}`,
        `drop table ${sequence}`,
      ] : []),
      `drop table ${copy}`,
    ],
  };
}

function dropKey(drop: DropIntent): string {
  return drop.kind === "table" ? `table\u0000${drop.table}` : `column\u0000${drop.table}\u0000${drop.column}`;
}

function sameSqliteName(left: string, right: string): boolean {
  const normalizeName = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return normalizeName(left) === normalizeName(right);
}

// requiredDrops and renameIntentPlan below, and tableStatements's own
// removed/added comparison above, all match a supplied table or column name
// against the declared DDL with exact === , not this fold. A rename intent's
// `to` is written into the generated SQL and into the rebuild's working
// column map exactly as supplied (tableStatements, above); folding the match
// here without also folding every one of those uses would let an intent
// spelled in a different case rename a column under that spelling while the
// rebuild's copy step still looks it up by the declared DDL spelling,
// silently dropping the column's rows. Case-exact matching fails closed
// instead.

export function dropReference(drop: DropIntent): string {
  return drop.kind === "table" ? `table ${quoteIdent(drop.table)}` : `column ${quoteIdent(drop.table)}.${quoteIdent(drop.column)}`;
}

// A table drop owns its columns. A column is removed only when its table
// remains. A declared rename consumes its source name before this comparison.
function requiredDrops(current: Schema, target: Schema, renames: readonly Rename[]): DropIntent[] {
  const required: DropIntent[] = [];
  for (const table of current.tables.values()) {
    const next = target.tables.get(table.name);
    if (!next) {
      required.push({ kind: "table", table: table.name });
      continue;
    }
    const targetColumns = new Set(next.columns.map(column => column.name));
    for (const column of table.columns) {
      const renamed = renames.some(rename => rename.table === table.name && rename.from === column.name && targetColumns.has(rename.to));
      if (!renamed && !targetColumns.has(column.name)) required.push({ kind: "column", table: table.name, column: column.name });
    }
  }
  return required;
}

function dropIntentPlan(required: readonly DropIntent[], supplied: readonly DropIntent[]): Plan | null {
  const suppliedKeys = new Set<string>();
  for (const drop of supplied) {
    const key = dropKey(drop);
    if (suppliedKeys.has(key)) return { kind: "blocked", reason: `destructive intent repeats ${dropReference(drop)}. Supply each removed object once.`, drops: [...required] };
    suppliedKeys.add(key);
  }
  const requiredKeys = new Set(required.map(dropKey));
  const extra = supplied.find(drop => !requiredKeys.has(dropKey(drop)));
  if (extra) return { kind: "blocked", reason: `destructive intent does not match a removed ordinary object: ${dropReference(extra)}.`, drops: [...required] };
  const missing = required.filter(drop => !suppliedKeys.has(dropKey(drop)));
  if (missing.length > 0) {
    return {
      kind: "blocked",
      reason: `automatic migration removes ordinary objects: ${missing.map(dropReference).join(", ")}. Supply an exact destructive intent before generation.`,
      drops: [...required],
    };
  }
  return null;
}

function renameKey(rename: Rename): string {
  return `${rename.table}\u0000${rename.from}\u0000${rename.to}`;
}

// Validate declarations before the diff mutates a working column map. A
// declaration must describe one source that disappears and one target that
// appears. This rejects a declaration that would otherwise turn a drop and an
// add into an accidental copy.
function renameIntentPlan(current: Schema, target: Schema, renames: readonly Rename[]): Plan | null {
  const exact = new Set<string>();
  for (const rename of renames) {
    const key = renameKey(rename);
    if (exact.has(key)) return { kind: "blocked", reason: `rename intent repeats ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)}. Supply each rename once.` };
    exact.add(key);
  }
  for (const rename of renames) {
    if (renames.some(other => other !== rename && other.table === rename.table && other.from === rename.to)) {
      return { kind: "blocked", reason: `rename intent chains through ${quoteIdent(rename.table)}.${quoteIdent(rename.to)}. Split it into separate migrations.` };
    }
  }
  const from = new Map<string, Rename>();
  const to = new Map<string, Rename>();
  for (const rename of renames) {
    if (rename.from === rename.to) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} does not change a column.` };
    const table = current.tables.get(rename.table);
    const targetTable = target.tables.get(rename.table);
    if (!table || !targetTable) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} has a missing source or target table.` };
    const sourceColumns = new Set(table.columns.map(column => column.name));
    const targetColumns = new Set(targetTable.columns.map(column => column.name));
    if (!sourceColumns.has(rename.from)) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} has a missing source column. Match the declared DDL spelling exactly, including its case.` };
    if (!targetColumns.has(rename.to)) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} has a missing target column. Match the declared DDL spelling exactly, including its case.` };
    if (sourceColumns.has(rename.to)) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} conflicts with an existing source column.` };
    if (targetColumns.has(rename.from)) return { kind: "blocked", reason: `rename intent ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)} is unused because its source remains in the target schema.` };
    const fromKey = `${rename.table}\u0000${rename.from}`;
    const toKey = `${rename.table}\u0000${rename.to}`;
    if (from.has(fromKey) || to.has(toKey)) return { kind: "blocked", reason: `rename intent conflicts at ${quoteIdent(rename.table)}.${quoteIdent(rename.from)} -> ${quoteIdent(rename.to)}.` };
    from.set(fromKey, rename);
    to.set(toKey, rename);
  }
  return null;
}

// A table with both a disappearing and an appearing column needs a rename
// map. A singleton pair is safe to print as a ready-to-use intent. Larger
// sets remain candidates because the generator cannot choose their mapping.
function renameRepairPlan(current: Schema, target: Schema, renames: readonly Rename[], drops: readonly DropIntent[]): Plan | null {
  const required = new Set(requiredDrops(current, target, renames).map(dropKey));
  const candidates: RenameRepair[] = [];
  for (const [name, table] of current.tables) {
    const targetTable = target.tables.get(name);
    if (!targetTable) continue;
    const source = new Set(table.columns.map(column => column.name));
    for (const rename of renames.filter(rename => rename.table === name)) {
      source.delete(rename.from);
      source.add(rename.to);
    }
    const targetNames = new Set(targetTable.columns.map(column => column.name));
    // A reviewed exact column drop is not a rename source. An unmatched or
    // duplicate entry stays visible here and later fails drop validation.
    const removed = [...source].filter(column => !targetNames.has(column) && !drops.some(drop => drop.kind === "column" && drop.table === name && drop.column === column && required.has(dropKey(drop))));
    const added = [...targetNames].filter(column => !source.has(column));
    if (removed.length > 0 && added.length > 0) candidates.push({ table: name, from: removed, to: added });
  }
  if (candidates.length === 0) return null;
  const exact = candidates.every(candidate => candidate.from.length === 1 && candidate.to.length === 1)
    ? candidates.map(candidate => ({ table: candidate.table, from: candidate.from[0]!, to: candidate.to[0]! })) : undefined;
  const detail = candidates.map(candidate => `table ${candidate.table}: columns [${candidate.from.join(", ")}] removed and [${candidate.to.join(", ")}] added in one change`).join("; ");
  return {
    kind: "blocked",
    reason: `${detail}. Declare a rename if the data must move, or split the change into two migrations.`,
    ...(exact ? { renames: exact } : {}),
    renameCandidates: candidates,
  };
}

export function diff(current: Schema, target: Schema, renames: readonly Rename[] = [], drops: readonly DropIntent[] = []): Plan {
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

  const renameIntent = renameIntentPlan(current, target, renames);
  if (renameIntent) return renameIntent;
  const renameRepair = renameRepairPlan(current, target, renames, drops);
  if (renameRepair) return renameRepair;
  const intent = dropIntentPlan(requiredDrops(current, target, renames), drops);
  if (intent) return intent;

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
  const removedTables = [...current.tables.keys()].filter(name => !target.tables.has(name));
  for (const name of removedTables) {
    // DROP TABLE runs the same delete actions as deleting every parent row.
    // An intent reviews the parent table, but it cannot review rows that
    // survive in a child table, so this path needs an explicit migration.
    for (const schema of [current, target]) {
      for (const table of schema.tables.values()) {
        if (!target.tables.has(table.name)) continue;
        for (const reference of table.foreignKeys) {
          if (sameSqliteName(reference.table, name) && reference.onDelete !== "NO ACTION") {
            return {
              kind: "blocked",
              reason: `${table.name}.${reference.from} has ON DELETE ${reference.onDelete} referencing ${name}. Removing ${name} drops the table and can delete or change child rows, or fail. Write an explicit migration that preserves the data and foreign keys.`,
            };
          }
        }
      }
    }
    dropTables.push(`drop table ${quoteIdent(name)}`);
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
    const plan = tableStatements(current_, target_, renames, drops, keptIndexes.get(name) ?? []);
    if (plan.kind === "blocked") return plan;
    if (plan.rebuilt) {
      // DROP TABLE runs foreign-key delete actions even when checks are
      // deferred. Inspect both schemas: an earlier table change can install
      // a target reference before this parent's rebuild.
      for (const schema of [current, target]) {
        for (const table of schema.tables.values()) {
          for (const reference of table.foreignKeys) {
            if (sameSqliteName(reference.table, name) && reference.onDelete !== "NO ACTION") {
              return {
                kind: "blocked",
                reason: `${table.name}.${reference.from} has ON DELETE ${reference.onDelete} referencing ${name}. Rebuilding ${name} drops the table and can delete or change child rows, or fail. Write an explicit migration that preserves the data and foreign keys.`,
              };
            }
          }
        }
      }
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
export function render(sequence: number, name: string, statements: readonly string[], width = 4): { filename: string; sql: string } {
  const filename = `${String(sequence).padStart(width, "0")}_${name}.sql`;
  const sql = `-- Migration ${filename}. Generated by solarsql from the declared schema.\n` + statements.map((s) => `${s.trim()};`).join("\n") + "\n";
  return { filename, sql };
}
