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
import { withDeniedFunctions, withWorkerdLimits } from "./facts.ts";
import { created, definitions, isKeyword, normalize, parseRebuildRecords, parseViewRecords, quoteIdent, redeclaredByFile, REBUILD_HEADER, VIEW_HEADER, type ViewRecord, renamedColumn, revivedDeclaration, searchFill, significant, splitStatements, sqliteName, tokenize, triggerBodyBegin, triggerInsertTarget, type RebuildRecord, type Token, unknownDeclaration } from "./scan.ts";
import { BuildError } from "./build-error.ts";

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
export type Plan = { kind: "ok"; statements: string[]; rebuilds?: RebuildRecord[]; views?: ViewRecord[] } | { kind: "blocked"; reason: string; drops?: DropIntent[]; renames?: Rename[]; renameCandidates?: RenameRepair[] };

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
  // Which migration most recently (re-)introduced a given table's column,
  // so a refusal below can name it accurately even when the column was
  // dropped and later re-added.
  const introducedBy = new Map<string, { label: string; renamedFrom?: string }>();
  let schema = introspect(db);
  for (const [i, file] of files.entries()) {
    const label = names ? names[i]! : `migration file ${i + 1} of ${files.length}`;
    // `schema` here is still the shape this file starts from (the previous
    // iteration's introspect(), or the empty database for the first file).
    // A key present after this file runs and absent from `before` was
    // (re-)introduced by it.
    const before = new Set<string>();
    for (const [tableName, table] of schema.tables) {
      for (const column of table.columns) before.add(`${tableName} ${column.name}`);
    }
    for (const { table, columns, constraints, indexes, triggers } of parseRebuildRecords(file)) {
      const actual = schema.tables.get(table);
      if (!actual) continue;
      const recorded = new Map(columns.map((c) => [c.name, c.def]));
      const action = `Delete ${label} and run \`solarsql migration\` again against the merged schema.`;
      const unknown = actual.columns.map((c) => c.name).find((n) => !recorded.has(n));
      if (unknown !== undefined) {
        // introducedBy always has an entry here: applied() always starts
        // from an empty in-memory database, and the loop at the bottom of
        // this function attributes every column of every table to the file
        // that (re-)introduced it, for every file processed so far. A
        // column already present in `actual` (the schema this file starts
        // from) was necessarily introduced by one of those earlier files.
        const addedBy = introducedBy.get(`${table} ${unknown}`);
        const attribution = addedBy === undefined
          ? "added by an earlier migration"
          : addedBy.renamedFrom !== undefined
          ? `renamed from ${quoteIdent(addedBy.renamedFrom)} by ${addedBy.label}`
          : `added by ${addedBy.label}`;
        // This file's own copy statement -- `create table
        // "_solarsql_copy_<table>" as select ... from <table>` -- can hold
        // a stale, quoted reference to a column the live table no longer
        // has (for example a name a later migration renamed away). Whether
        // that reference throws or silently resolves as a string literal
        // depends on the double-quoted-string fallback, and the engines
        // disagree: node:sqlite ships it off, so the stale reference throws
        // there. D1 and Durable Object SQLite -- the engines that actually
        // replay this file -- ship it on: D1 runs the file's statements as
        // the file holds them, and a Durable Object runs them the same way
        // through migrate() (src/durable.ts), once past that function's own
        // rebuild-record checks for a lost column, constraint, index, or
        // trigger. So the same statement runs to completion there with a
        // wrong literal value where `unknown`'s data belonged. A build-time
        // prepare() on
        // node:sqlite can only report what node:sqlite would do, which is
        // not a sound prediction of the replay target's behavior. The
        // message below does not condition on it: replaying `label` always
        // loses `unknown` and its data. test/miniflare/dqs-fallback.test.ts pins the
        // fallback fact this reasoning depends on, against Miniflare's D1
        // and Durable Object SQLite.
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} without knowledge of column ${quoteIdent(unknown)}, ${attribution}. ` +
          `A database that replays ${label} loses ${quoteIdent(unknown)} and its data. ` +
          action,
          undefined,
          action,
        );
      }
      // The unknown-column check above already refused unless every name in
      // actual.columns is a key of `recorded`, so recorded.get(c.name) is
      // always defined here and the ?? "" fallback is never used.
      const changed = actual.columns.find((c) => c.def !== (recorded.get(c.name) ?? ""));
      if (changed) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} with a stale declaration of column ${quoteIdent(changed.name)}: it now declares ${JSON.stringify(changed.def)}, but this file's generator saw ${JSON.stringify(recorded.get(changed.name))}. ` +
          `A database that replays ${label} loses that change. ` +
          action,
          undefined,
          action,
        );
      }
      const badConstraint = unknownDeclaration(constraints, actual.constraints);
      if (badConstraint !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} without knowledge of a table-level constraint it already has: ${JSON.stringify(badConstraint)}. ` +
          `A database that replays ${label} loses that constraint. ` +
          action,
          undefined,
          action,
        );
      }
      // badIndex and badTrigger (used just below and further down) can fail
      // to parse: SQLite accepts a string-literal name (`create index 'qi'
      // on ...`) and stores it back verbatim, so created(), which only
      // names an identifier token, returns null for it (measured). The ??
      // fallback to the raw declaration text below is that case's error
      // message. revivedIndex and revivedTrigger (further below) do not
      // need the same fallback: revivedDeclaration's byName branch only
      // returns an entry whose own created()?.name is already defined.
      const actualIndexSql = [...schema.indexes.values()].filter((i) => i.table === table).map((i) => normalize(i.sql));
      const badIndex = unknownDeclaration(indexes, actualIndexSql);
      if (badIndex !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} without knowledge of index ${quoteIdent(created(badIndex)?.name ?? badIndex)} it already has: ${JSON.stringify(badIndex)}. ` +
          `A database that replays ${label} loses that index. ` +
          action,
          undefined,
          action,
        );
      }
      const actualTriggerSql = [...schema.triggers.values()].filter((t) => sameSqliteName(t.table, table)).map((t) => normalize(t.sql));
      const badTrigger = unknownDeclaration(triggers, actualTriggerSql);
      if (badTrigger !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} without knowledge of trigger ${quoteIdent(created(badTrigger)?.name ?? badTrigger)} it already has: ${JSON.stringify(badTrigger)}. ` +
          `A database that replays ${label} loses that trigger and the behavior it maintains. ` +
          action,
          undefined,
          action,
        );
      }
      // The mirror direction of the checks above: something this
      // rebuild's generator saw and recorded is now missing from the schema
      // this file starts from (an earlier migration removed it), and this
      // file's own statements redeclare it. Replaying it would restore what
      // that earlier migration meant to remove. An entry recorded but
      // missing, and not redeclared by this file, stays allowed: this
      // rebuild's own generator chose to drop it, the case ADR 0099 and ADR
      // 0102 already permit.
      const redeclared = redeclaredByFile(file, table);
      const revivedConstraint = revivedDeclaration(constraints, actual.constraints, redeclared.constraints, false);
      if (revivedConstraint !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} and would restore a table-level constraint an earlier migration already removed: ${JSON.stringify(revivedConstraint)}. ` +
          `A database that replays ${label} would bring that constraint back. ` +
          action,
          undefined,
          action,
        );
      }
      const revivedIndex = revivedDeclaration(indexes, actualIndexSql, redeclared.indexes, true);
      if (revivedIndex !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} and would restore index ${quoteIdent(created(revivedIndex)?.name ?? revivedIndex)}, which an earlier migration already removed: ${JSON.stringify(revivedIndex)}. ` +
          `A database that replays ${label} would bring that index back. ` +
          action,
          undefined,
          action,
        );
      }
      const revivedTrigger = revivedDeclaration(triggers, actualTriggerSql, redeclared.triggers, true);
      if (revivedTrigger !== undefined) {
        throw new BuildError(
          `migration ${label} rebuilds table ${quoteIdent(table)} and would restore trigger ${quoteIdent(created(revivedTrigger)?.name ?? revivedTrigger)}, which an earlier migration already removed: ${JSON.stringify(revivedTrigger)}. ` +
          `A database that replays ${label} would bring that trigger, and the behavior it maintains, back. ` +
          action,
          undefined,
          action,
        );
      }
    }
    for (const { view, triggers } of parseViewRecords(file)) {
      if (![...schema.views.keys()].some((name) => sameSqliteName(name, view))) continue;
      const action = `Delete ${label} and run \`solarsql migration\` again against the merged schema.`;
      const actualTriggerSql = [...schema.triggers.values()].filter((t) => sameSqliteName(t.table, view)).map((t) => normalize(t.sql));
      const badTrigger = unknownDeclaration(triggers, actualTriggerSql);
      if (badTrigger !== undefined) {
        throw new BuildError(
          `migration ${label} drops view ${quoteIdent(view)} without knowledge of trigger ${quoteIdent(created(badTrigger)?.name ?? badTrigger)} it already has: ${JSON.stringify(badTrigger)}. ` +
          `A database that replays ${label} loses that trigger and the behavior it maintains. ` +
          action,
          undefined,
          action,
        );
      }
      const revivedTrigger = revivedDeclaration(triggers, actualTriggerSql, redeclaredByFile(file, view).triggers, true);
      if (revivedTrigger !== undefined) {
        throw new BuildError(
          `migration ${label} drops view ${quoteIdent(view)} and would restore trigger ${quoteIdent(created(revivedTrigger)?.name ?? revivedTrigger)}, which an earlier migration already removed: ${JSON.stringify(revivedTrigger)}. ` +
          `A database that replays ${label} would bring that trigger, and the behavior it maintains, back. ` +
          action,
          undefined,
          action,
        );
      }
    }
    // Reassigned below, before `ordinal` (next) is ever non-null: the catch
    // block only reads `statements.length` when `ordinal` is non-null, so
    // this placeholder is never read.
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
        // The Engine constructor (facts.ts) checks the same allowlist and
        // the same workerd prepare-time limits against the current declared
        // schema, but never sees a migration file already written to disk:
        // a file generated before either check existed, or edited by hand,
        // reaches a function-call denial (ADR 0114) or a limit refusal
        // (ADR 0134) only here.
        withWorkerdLimits(db, () => withDeniedFunctions(db, () => db.exec(s)));
      }
      ordinal = null;
      db.exec("commit");
    } catch (e) {
      const at = ordinal === null ? "" : `, statement ${ordinal} of ${statements.length}`;
      throw names ? new BuildError(`migration ${names[i]}${at}: ${(e as Error).message}`) : e;
    }
    schema = introspect(db);
    for (const [tableName, table] of schema.tables) {
      for (const column of table.columns) {
        const key = `${tableName} ${column.name}`;
        if (before.has(key)) continue;
        // By the time `r?.table === tableName` is true, `r` is already
        // known truthy: `tableName` is a real Map key, never undefined, and
        // `r?.table` can equal a real string only when `r` itself is not
        // null or undefined. The `?.` on `r?.to`, just after, only repeats
        // a check `&&` already guarantees at that point.
        const rename = statements.map(renamedColumn).find((r) => r?.table === tableName && r?.to === column.name);
        introducedBy.set(key, rename ? { label, renamedFrom: rename.from } : { label });
      }
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
  // A same-named object can shadow a pragma table function; PRAGMA statements read the engine catalog.
  const attributes = new Map((db.prepare(`pragma main.table_list`).all() as { schema: string; name: string; type: string; wr: number; strict: number }[]).filter(r => r.schema === 'main').map((r) => [r.name, r]));
  const rows = db
    .prepare(`select type, name, tbl_name, sql from sqlite_schema where sql is not null and lower(name) not glob 'sqlite_*' order by name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  for (const row of rows) {
    const table = attributes.get(row.name);
    // `attributes` is keyed by name alone, and a trigger does not share a
    // table's namespace the way an index or a view does (SQLite accepts a
    // trigger and a table, or a trigger and a search table, under the exact
    // same name), so every branch below checks `row.type` itself first: a
    // trigger row named the same as some virtual table must still become a
    // trigger, not get folded into `virtuals` by name alone.
    if (row.type === "table" && table?.type === "shadow") continue;
    if (row.type === "table" && table?.type === "virtual") {
      virtuals.set(row.name, { name: row.name, sql: row.sql });
    } else if (row.type === "table") {
      // definitions() returns null only when a CREATE TABLE has no top-level
      // parenthesized body. SQLite never stores a live table's own schema SQL
      // without one -- even `CREATE TABLE ... AS SELECT` is normalized to a
      // plain column list in sqlite_schema -- so `defs` is never null here:
      // the `?.` on `defs?.columns` and `defs?.constraints` below is never
      // exercised, and their `?? ""` / `?? []` fallbacks are never read.
      const defs = definitions(row.sql);
      // hidden 2 and 3 are generated columns; they take part in the shape
      // and are left out of a rebuild's copy.
      // Read the same main table named by sqlite_schema, even when a TEMP
      // table shadows its unqualified name.
      const columns = (db.prepare(`pragma main.table_xinfo(${quoteIdent(row.name)})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }[]).filter(c => [0, 2, 3].includes(c.hidden)).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull === 1, dflt: c.dflt_value, pk: c.pk, def: defs?.columns.get(c.name) ?? "", generated: c.hidden !== 0 }));
      const foreignKeys = (db.prepare(`pragma main.foreign_key_list(${quoteIdent(row.name)})`).all() as {
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }[]).sort((a, b) => a.id - b.id || a.seq - b.seq).map((f) => ({ table: f.table, from: f.from, to: f.to, onUpdate: f.on_update, onDelete: f.on_delete }));
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
        // The `pragma_index_list ... origin = 'pk'` check below is the
        // deciding term: SQLite gives a table a pk autoindex for every PK
        // shape except a single-column INTEGER PRIMARY KEY without DESC on
        // a rowid table (measured, including WITHOUT ROWID: even its own
        // sole INTEGER PRIMARY KEY column gets one, since there is no rowid
        // for it to alias), so whenever the earlier terms of this chain
        // (whether it is a rowid table, the column count, the pk flag, and
        // the INTEGER type) would matter on their own, that autoindex is
        // already present and the chain is false regardless -- true
        // whether an earlier term is widened to `true` outright or only
        // loosened from `&&` to `||` against a neighboring term.
        rowidAlias: table!.wr === 0 && columns.filter(c => c.pk > 0).length === 1
          && columns.some(c => c.pk > 0 && c.type.toUpperCase() === "INTEGER")
          && !db.prepare(`pragma main.index_list(${quoteIdent(row.name)})`).all().some(r => r.origin === 'pk')
          ? columns.find(c => c.pk > 0)!.name : null,
      });
    } else if (row.type === "index") {
      indexes.set(row.name, { name: row.name, table: row.tbl_name, sql: row.sql });
    } else if (row.type === "trigger") {
      triggers.set(row.name, { name: row.name, table: row.tbl_name, sql: row.sql });
    } else if (row.type === "view") {
      // sqlite_schema's own "type" column has exactly four values (table,
      // index, trigger, view); the three checked above already exclude the
      // first three, so a row reaching this branch is always a view.
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
    // sqlite_schema keeps a trigger's table as its ON clause spells it, and
    // SQLite resolves that name under its identifier case rule.
    triggers: [...schema.triggers.values()].sort(byName).map((t) => ({ name: t.name, table: sqliteName(t.table), sql: normalize(t.sql) })),
    views: [...schema.views.values()].sort(byName).map((v) => ({ name: v.name, sql: normalize(v.sql) })),
    virtuals: [...schema.virtuals.values()].sort(byName).map((v) => ({ name: v.name, sql: normalize(v.sql) })),
  };
}

// Every caller sorts a collection whose entries carry pairwise distinct
// names: a Schema's own Maps, each keyed by name, or one table's own
// columns, which SQLite refuses to declare twice. So a and b's names are
// never equal here, and Array.prototype.sort only reads the sign of this
// function's return value for each pair it compares, never its exact
// magnitude.
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Column and foreign-key order is declaration order, not a property of the
// table's shape: `ALTER TABLE ... ADD COLUMN` appends at the end, so two
// legitimate histories (two branches each adding a column, merged in either
// order) can declare the same columns in a different order, the same fact
// ADR 0101 established for a rebuild's replay-time check. Reordering a
// column with an inline `references` clause also reorders `foreignKeys`
// (SQLite's own `pragma_foreign_key_list` follows declaration order), so
// both fields sort here, the same way `constraints` already did.
function tableShape(t: Table): unknown {
  return {
    name: t.name,
    columns: [...t.columns].sort(byName),
    foreignKeys: [...t.foreignKeys].sort(byForeignKey),
    constraints: [...t.constraints].sort(),
    withoutRowid: t.withoutRowid,
    strict: t.strict,
    rowidAlias: t.rowidAlias,
  };
}

// The objects whose shapes differ between two schemas, as "<kind> <name>".
export function shapeDifferences(left: Schema, right: Schema): string[] {
  const kinds = [["tables", "table"], ["indexes", "index"], ["triggers", "trigger"], ["views", "view"], ["virtuals", "search table"]] as const;
  const a = shape(left) as Record<string, { name: string }[]>;
  const b = shape(right) as Record<string, { name: string }[]>;
  const differences: string[] = [];
  for (const [kind, label] of kinds) {
    const entriesByName = (entries: { name: string }[]) => new Map(entries.map((entry) => [entry.name, JSON.stringify(entry)]));
    const before = entriesByName(a[kind]!);
    const after = entriesByName(b[kind]!);
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (before.get(name) !== after.get(name)) differences.push(`${label} ${name}`);
    }
  }
  return differences;
}

// The plan must reach its own target. The replay runs the rendered file text
// through applied(), the way a database applies it, and compares shapes, so
// it also sees an empty plan that leaves an object behind, which a second
// diff of the same two schemas cannot see.
export function replayDifferences(files: readonly string[], names: readonly string[], statements: readonly string[], rebuilds: readonly RebuildRecord[], target: Schema, views: readonly ViewRecord[] = []): string[] {
  const generated = statements.length > 0 ? [render(files.length + 1, "replay", statements, rebuilds, 4, views).sql] : [];
  const db = applied([...files, ...generated], [...names, ...generated.map(() => "the generated migration")]);
  try { return shapeDifferences(introspect(db), target); } finally { db.close(); }
}

export function requireReplayReachesTarget(files: readonly string[], names: readonly string[], statements: readonly string[], rebuilds: readonly RebuildRecord[], target: Schema, views: readonly ViewRecord[] = []): void {
  const differences = replayDifferences(files, names, statements, rebuilds, target, views);
  if (differences.length === 0) return;
  throw new BuildError(`The migration files plus the generated statements do not reach the declared schema; these objects differ after a replay: ${differences.join(", ")}. This is a gap in solarsql's migration diff. Write the next migration by hand so that a replay reaches the declared schema.`);
}

// Keyed on every field, not only `from`: SQLite allows more than one foreign
// key declared from the same column (with different actions or targets), and
// a partial key would leave those in declaration order, reintroducing the
// same order sensitivity this function exists to remove.
function byForeignKey(a: ForeignKey, b: ForeignKey): number {
  const key = (f: ForeignKey) => `${f.from}\0${f.table}\0${f.to}\0${f.onUpdate}\0${f.onDelete}`;
  const ka = key(a), kb = key(b);
  // Unlike byName()'s inputs, ka and kb can be equal: SQLite accepts two
  // identically-declared foreign keys on one table (an inline one and a
  // redundant table-level "foreign key (a) references p(id)", measured),
  // and a tied pair's two ForeignKey objects then carry the same
  // from/table/to/onUpdate/onDelete in both. A tied pair's own fields read
  // the same regardless of which one a sort places first, so nothing
  // outside this function can observe their relative order.
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// sqlite_schema supplies the CREATE header. Token spans preserve comments
// immediately after a name, which a bare-name regular expression consumed.
function renamedCreate(sql: string, newName?: string): string {
  // sqlite_schema drops IF NOT EXISTS and any comment before the name, so the
  // name is the first significant token after the object keyword.
  const tokens = significant(tokenize(sql));
  const name = tokens[tokens.findIndex(t => ["table", "index", "trigger", "view"].some(kind => isKeyword(t, kind))) + 1]!;
  // TEMP objects take precedence over unqualified names. Qualify the object
  // name; SQLite resolves an index's ON table within the index's schema.
  return sql.slice(0, name.start) + "main." + (newName === undefined ? name.text : quoteIdent(newName)) + sql.slice(name.end);
}

function tableStatements(current: Table, target: Table, renames: readonly Rename[], drops: readonly DropIntent[], keptIndexes: readonly string[]): Plan & { rebuilt?: boolean } {
  const statements: string[] = [];
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));
  let currentAlias = current.rowidAlias;
  for (const r of renames.filter((r) => r.table === current.name)) {
    const from = currentColumns.get(r.from);
    // diff() calls renameIntentPlan(current, target, renames) before it
    // ever reaches this table's own tableStatements() call, over this same
    // (current, target) pair, and returns without calling tableStatements()
    // at all when that finds a missing source column, a target that
    // already exists in current, or a target missing from target -- the
    // exact three conditions below. So through diff(), this guard's own
    // block never runs; it stays as a second layer against a future caller
    // that reaches tableStatements() a different way.
    if (!from || currentColumns.has(r.to) || !target.columns.some((c) => c.name === r.to)) {
      return { kind: "blocked", reason: `table ${current.name}: rename ${r.from} -> ${r.to} does not match the schemas` };
    }
    statements.push(`alter table main.${quoteIdent(current.name)} rename column ${quoteIdent(r.from)} to ${quoteIdent(r.to)}`);
    currentColumns.delete(r.from);
    // The replaced entry's own fields are never read back: later code only
    // calls currentColumns.has() and .keys() (a chained rename's earlier
    // target reappearing as a later source is already excluded by
    // renameIntentPlan's chain check), never .get() or .values() for a
    // renamed-to key, so what this stores under r.to does not matter.
    currentColumns.set(r.to, { ...from, name: r.to });
    if (currentAlias === r.from) currentAlias = r.to;
  }
  const targetNames = new Set(target.columns.map((c) => c.name));
  const removed = [...currentColumns.keys()].filter((n) => !targetNames.has(n));
  const added = target.columns.filter((c) => !currentColumns.has(c.name)).map((c) => c.name);
  // No unreviewed removal reaches this point: renameRepairPlan already blocks
  // a table with both a removed and an added column unless every removal is
  // covered by an exact drop, and dropIntentPlan already rejects a drops
  // list that omits or adds to that exact required set. So `removed`, by the
  // time diff() calls this function, is always already reviewed.

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
    for (const n of removed) candidate.push(`alter table main.${quoteIdent(current.name)} drop column ${quoteIdent(n)}`);
    for (const n of added) candidate.push(`alter table main.${quoteIdent(current.name)} add column ${target.columns.find((c) => c.name === n)!.def}`);
    // The scratch db is in-memory and unreferenced after this block; node:sqlite
    // reclaims it, so the close() in finally only frees it a bit sooner.
    const scratch = open([current.sql, ...keptIndexes]);
    try {
      for (const s of candidate) scratch.exec(s);
      const after = introspect(scratch).tables.get(current.name)!;
      // diff()'s caller only tests this plan's kind against "blocked"; any
      // other value reads as "not blocked" and only .statements is used.
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
    // A preserved INTEGER PRIMARY KEY already carries the identifier through
    // its own column, already part of `common`: capturing it again here
    // under a second name would just copy the same value twice, so this
    // only runs when the target keeps no such alias to carry it.
    // Otherwise capture it separately, under a name that cannot mask data.
    if (target.rowidAlias === null) {
      // The exact spelling is transient: it names a column only inside this
      // rebuild's own copy table, gone once the rebuild's DROP TABLE below
      // runs. The loop below still must find a name absent from `common`.
      let saved = "_solarsql_rowid";
      while (common.some(name => name.toLowerCase() === saved.toLowerCase())) saved += "_";
      capture.push(`${quoteIdent(from)} as ${quoteIdent(saved)}`);
      destination.push(quoteIdent(to));
      restore.push(quoteIdent(saved));
    }
  }
  const name = quoteIdent(current.name);
  const fresh = `main.${quoteIdent(`_solarsql_new_${current.name}`)}`;
  const copy = `main.${quoteIdent(`_solarsql_copy_${current.name}`)}`;
  const sequence = `main.${quoteIdent(`_solarsql_sequence_${current.name}`)}`;
  const tableLiteral = `'${current.name.replaceAll("'", "''")}'`;
  const keepsSequence = [current, target].every(table => tokenize(table.sql).some(token => isKeyword(token, "autoincrement")));
  // Same caller contract as the cheap-ALTER return above: only compared
  // against "blocked", and only .statements/.rebuilt are read afterward.
  return {
    kind: "ok",
    rebuilt: true,
    statements: [
      ...statements,
      renamedCreate(target.sql, `_solarsql_new_${current.name}`),
      `create table ${copy} as select ${capture.join(", ")} from main.${name}`,
      ...(keepsSequence ? [`create table ${sequence} as select max(seq) as seq from main.sqlite_sequence where name = ${tableLiteral}`] : []),
      `drop table main.${name}`,
      `alter table ${fresh} rename to ${name}`,
      `insert into main.${name} (${destination.join(", ")}) select ${restore.join(", ")} from ${copy}`,
      // Deleted maxima are absent from copied rows. Keep their high-water
      // mark in SQL so even a 64-bit sequence never passes through JavaScript.
      ...(keepsSequence ? [
        `update main.sqlite_sequence set seq = max(seq, coalesce((select seq from ${sequence}), seq)) where name = ${tableLiteral}`,
        `drop table ${sequence}`,
      ] : []),
      `drop table ${copy}`,
    ],
  };
}

// The "table" and "column" tags keep the two kinds' keys apart. Without the
// tag, a table-kind key (no column field, so its column position is always
// the string "undefined") would equal a column-kind key for a column
// literally named "undefined" on the same table, letting a caller's wrong
// table-drop intent pass review for an unrelated column removal instead.
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
    // This loop only reaches a `name` present in target (the continue
    // above), so `required` never holds that table's own table-kind key
    // here; a table-kind drop's required.has(dropKey(drop)) is already
    // false no matter what its kind check decides.
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
  const rebuilds: RebuildRecord[] = [];
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
    // SQLite's column names are case-insensitive, but the removed/added
    // comparison in tableStatements() below compares names exactly as
    // spelled. An index whose own text is unchanged can still name a column
    // by a different case than the one being dropped, and SQLite refuses to
    // DROP COLUMN a column an index still names. Carrying this index into
    // the scratch database lets that refusal steer such a case-only rename
    // to a rebuild instead of a cheap ALTER that a live database would
    // refuse the same way.
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
    dropTables.push(`drop table main.${quoteIdent(name)}`);
  }
  // A search table has no ALTER. A changed or removed one is dropped, and
  // a changed or new one is created after the tables, before the triggers
  // that write it. When the target schema names exactly one insert trigger
  // that writes into a created search table, and that trigger keeps to the
  // documented shape (schema.md, "Search tables": one `insert into <search>
  // (<cols>) values (new.<col>, ...)`, on a real table, no WHEN clause), the
  // rows already in that table can be read back through the same columns:
  // ADR 0118 emits that repopulation insert right after the search table's
  // own create statement. More than one candidate trigger, a WHEN clause, an
  // expression other than a bare new.<column>, or a base that is a view (not
  // a table) instead gets a comment on the create statement: the gap stays
  // visible in the migration file instead of becoming a silent one.
  const virtualSame = (name: string) => {
    const c = current.virtuals.get(name);
    const t = target.virtuals.get(name);
    return c !== undefined && t !== undefined && normalize(c.sql) === normalize(t.sql);
  };
  for (const name of current.virtuals.keys()) if (!virtualSame(name)) dropTables.push(`drop table main.${quoteIdent(name)}`);
  const targetTriggerSqls = [...target.triggers.values()].map((trigger) => trigger.sql);
  const createVirtuals: string[] = [];
  for (const v of target.virtuals.values()) {
    if (virtualSame(v.name)) continue;
    const candidates = targetTriggerSqls.filter((sql) => triggerInsertTarget(sql)?.search === v.name);
    const fill = candidates.length === 1 ? searchFill(candidates[0]!) : null;
    if (fill && target.tables.has(fill.base)) {
      createVirtuals.push(v.sql);
      createVirtuals.push(
        `insert into main.${quoteIdent(v.name)} (${fill.columns.map(quoteIdent).join(", ")}) select ${fill.sources.map(quoteIdent).join(", ")} from main.${quoteIdent(fill.base)}`,
      );
    } else {
      createVirtuals.push(
        `-- ${v.name} starts empty. No single INSERT trigger with only new.<column> values names how to fill it. Add an insert that repopulates it from its base table.\n${v.sql}`,
      );
    }
  }
  for (const [name, target_] of target.tables) {
    const current_ = current.tables.get(name);
    if (!current_) {
      changeTables.push(target_.sql);
      continue;
    }
    // tableStatements() below recomputes this same shape check as its first
    // cheap-ALTER candidate. Called on two tables whose shapes already
    // match, it always finds zero columns to add or remove and returns the
    // same empty statement list this skip already returns.
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
      rebuilds.push({
        table: name,
        columns: current_.columns.map((c) => ({ name: c.name, def: c.def })),
        constraints: [...current_.constraints],
        indexes: [...current.indexes.values()].filter((i) => i.table === name).map((i) => normalize(i.sql)),
        triggers: [...current.triggers.values()].filter((t) => sameSqliteName(t.table, name)).map((t) => normalize(t.sql)),
      });
    }
    changeTables.push(...plan.statements);
  }
  const viewSame = (name: string) => {
    const c = current.views.get(name);
    const t = target.views.get(name);
    return c !== undefined && t !== undefined && normalize(c.sql) === normalize(t.sql);
  };
  const allViews = rebuilt.size > 0;
  const droppedViews: string[] = [];
  for (const name of current.views.keys()) {
    if (allViews || !viewSame(name)) {
      droppedViews.push(name);
      dropViews.push(`drop view main.${quoteIdent(name)}`);
    }
  }
  // DROP VIEW takes the view's triggers with it, and DROP TABLE takes the
  // table's. A changed or removed trigger on a kept view still needs its own
  // DROP TRIGGER, so a view counts as gone only when this plan drops it.
  // An ON clause can spell its table in another case, so names match
  // under SQLite's identifier case rule.
  const droppedView = (name: string) => droppedViews.some(view => sameSqliteName(view, name));
  const views: ViewRecord[] = droppedViews.map((view) => ({ view, triggers: [...current.triggers.values()].filter((t) => sameSqliteName(t.table, view)).map((t) => normalize(t.sql)) }));
  const currentView = (name: string) => [...current.views.keys()].some(view => sameSqliteName(view, name));
  const rebuiltTable = (name: string) => [...rebuilt].some(table => sameSqliteName(table, name));
  const targetTable = (name: string) => [...target.tables.keys()].some(table => sameSqliteName(table, name));
  const gone = (table: string) => rebuiltTable(table) || droppedView(table) || (!targetTable(table) && !currentView(table));
  for (const [name, table] of dropTriggerOf) if (!gone(table)) dropFirst.push(`drop trigger main.${quoteIdent(name)}`);
  for (const [name, table] of dropIndexOf) if (!gone(table)) dropFirst.push(`drop index main.${quoteIdent(name)}`);
  for (const [name, index] of target.indexes) {
    const c = current.indexes.get(name);
    if (rebuiltTable(index.table) || !c || normalize(c.sql) !== normalize(index.sql)) createLast.push(renamedCreate(index.sql));
  }
  for (const [name, view] of target.views) if (allViews || !viewSame(name)) createLast.push(allViews ? renamedCreate(view.sql) : view.sql);
  for (const [name, trigger] of target.triggers) {
    const c = current.triggers.get(name);
    // A trigger on a view that this plan drops is created again after the view.
    if (rebuiltTable(trigger.table) || droppedView(trigger.table) || !c || normalize(c.sql) !== normalize(trigger.sql)) createLast.push(triggerForD1(renamedCreate(trigger.sql)));
  }
  const statements = [...dropViews, ...dropFirst, ...dropTables, ...changeTables, ...createVirtuals, ...createLast];
  if (needsDefer) statements.unshift(`pragma defer_foreign_keys = on`);
  return { kind: "ok", statements, ...(rebuilds.length > 0 ? { rebuilds } : {}), ...(views.length > 0 ? { views } : {}) };
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
  // tokenize() (scan.ts) keeps a quoted identifier's or a string literal's
  // surrounding quote characters as part of its text, so only a bare,
  // unquoted spelling of begin or end can match below; restricting the
  // check to ident tokens excludes no token type actually reachable here.
  const bare = (t: Token, word: string) => t.type === "ident" && t.text.toLowerCase() === word;
  // The body opener is not always the first bare `begin`: the trigger name,
  // an UPDATE OF column list, or a WHEN expression can spell the same word
  // (ADR 0036 needs the body BEGIN uppercase for remote D1). Walk the
  // CREATE TRIGGER header, then take the next bare `begin` that is not a
  // `new.begin` / `old.begin` qualification. The closing END is still the
  // last bare `end` (CASE...END pairs sit earlier).
  const begin = triggerBodyBegin(tokens);
  // sqlite_schema stores a trigger only up to its closing END, so the last
  // token is that END and the bare test cannot choose a different token.
  const end = tokens.findLast((t) => bare(t, "end"));
  // Every caller passes a trigger's own SQL from introspect(), read back
  // from SQLite's own sqlite_schema. SQLite only stores that row once the
  // trigger's required BEGIN and END parsed, so both are always found here.
  if (!begin || !end) return sql;
  let out = sql;
  for (const t of [end, begin]) out = out.slice(0, t.start) + t.text.toUpperCase() + out.slice(t.end);
  return out;
}

// wrangler applies `migrations/<NNNN>_<name>.sql` in name order and records
// each file in d1_migrations. The file holds statements separated by ';'.
export function render(sequence: number, name: string, statements: readonly string[], rebuilds: readonly RebuildRecord[] = [], width = 4, views: readonly ViewRecord[] = []): { filename: string; sql: string } {
  const filename = `${String(sequence).padStart(width, "0")}_${name}.sql`;
  const header = `-- Migration ${filename}. Generated by solarsql from the declared schema.\n`
    + (rebuilds.length > 0 ? `${REBUILD_HEADER}${JSON.stringify(rebuilds)}\n` : "")
    + (views.length > 0 ? `${VIEW_HEADER}${JSON.stringify(views)}\n` : "");
  const sql = header + statements.map((s) => `${s.trim()};`).join("\n") + "\n";
  return { filename, sql };
}
