// Responsibility: rehearse one SQL transition on a disposable database snapshot.
// Boundary: local SQLite evidence only; this does not deploy or certify data meaning.
// rehearseSnapshot() also takes its own synchronous VACUUM INTO copy (ADR
// 0139), so it is no longer filesystem-free the way a pure in-memory
// property test would be; every filesystem call it makes is synchronous, so
// a caller driving it from a property test still needs no async scheduling.
import { constants, DatabaseSync } from 'node:sqlite';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namedParams, namedSlots, quoteIdent, significant, splitStatements, sqliteName, tokenize } from './scan.ts';
import { busyTimeoutMs, isLockError, lockMessage } from './lock-timeout.ts';
import { catalogStatement } from './statements.ts';

const lifecycle = channel('solarsql.rehearse');

// The last start event identifies a blocked native operation without a timer
// that could change the scheduling behavior under investigation.
function phase(name: string): () => void {
  if (!lifecycle.hasSubscribers) return () => {};
  const start = performance.now();
  lifecycle.publish({ phase: name, event: 'start' });
  return () => lifecycle.publish({ phase: name, event: 'end', ms: performance.now() - start });
}

export type RehearsalCaseValue = string | number | boolean | null | RehearsalCaseValue[] | { [key: string]: RehearsalCaseValue };
export type RehearsalCase = { sql: string; params: Record<string, RehearsalCaseValue> };
export type ExpectedDrop = { table: string; column?: string };
export type ExpectedRetype = { table: string; column: string };
export type ExpectedRowChange = { table: string };
export type RehearsalExpected = { dropped?: ExpectedDrop[]; retyped?: ExpectedRetype[]; deleted?: ExpectedRowChange[]; updated?: ExpectedRowChange[] };
export type RehearsalChecks = { queries?: Record<string, string>; assertions?: Record<string, string>; cases?: Record<string, RehearsalCase>; expected?: RehearsalExpected };
export type RehearsalColumn = { name: string; type: string; notnull: 0 | 1; pk: number };
export type RowDiff = { compared: true; inserted: number; deleted: number; updated: number } | { compared: false; reason: string };
export type RehearsalResult = {
  version: 1;
  ok: boolean;
  sql: string;
  before: Record<string, number>;
  after: Record<string, number>;
  columns: { before: Record<string, RehearsalColumn[]>; after: Record<string, RehearsalColumn[]> };
  rows: Record<string, RowDiff>;
  queries: string[];
  assertions: string[];
  cases: string[];
  diagnostics: { code: string; message: string }[];
};

function validateChecks(checks: unknown): asserts checks is RehearsalChecks {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('Checks must be an object with queries, assertions, and/or cases');
  for (const [key, value] of Object.entries(checks)) {
    if (!['queries', 'assertions', 'cases', 'expected'].includes(key)) throw new Error(`Unknown checks field ${key}; use queries, assertions, cases, or expected`);
    if (key === 'cases') { validateCases(value); continue; }
    if (key === 'expected') { validateExpected(value); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(sql => typeof sql !== 'string')) {
      throw new Error(`${key} must be an object of names and SQL strings`);
    }
    if (key === 'assertions') validateAssertionParams(value as Record<string, string>);
  }
}

// expected names a schema-shape change, or a row loss or rewrite, the caller
// already reviewed, so a malformed entry must fail loudly rather than
// silently match nothing. deleted and updated (ADR 0139) name a table only:
// unlike a dropped or retyped column, a lost or rewritten row is never
// scoped to one column, so a per-column entry would claim a precision the
// row diff cannot back.
function validateExpected(expected: unknown): asserts expected is RehearsalExpected {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('expected must be an object with dropped, retyped, deleted, and/or updated');
  for (const [key, entries] of Object.entries(expected)) {
    if (key !== 'dropped' && key !== 'retyped' && key !== 'deleted' && key !== 'updated') throw new Error(`Unknown expected field ${key}; use dropped, retyped, deleted, or updated`);
    if (!Array.isArray(entries)) throw new Error(`expected.${key} must be an array`);
    const allowed = key === 'dropped' || key === 'retyped' ? ['table', 'column'] : ['table'];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`expected.${key} entries must be objects with ${allowed.join(' and ')}`);
      const fields = Object.keys(entry);
      const unexpected = fields.filter(f => !allowed.includes(f));
      if (unexpected.length > 0) throw new Error(`expected.${key} entry has unknown field${unexpected.length > 1 ? 's' : ''}: ${unexpected.join(', ')}`);
      if (typeof (entry as Record<string, unknown>).table !== 'string') throw new Error(`expected.${key} entry needs a table string`);
      const column = (entry as Record<string, unknown>).column;
      if (key === 'retyped' && typeof column !== 'string') throw new Error('expected.retyped entry needs a column string');
      if (key === 'dropped' && column !== undefined && typeof column !== 'string') throw new Error('expected.dropped entry\'s column must be a string');
    }
  }
}

// An assertion runs with no bound values, unlike a case: rehearseSnapshot's
// assertion stage calls .all() with nothing bound. node:sqlite silently
// binds an unbound named parameter to NULL rather than throwing, so a
// stray :param neutralizes the assertion's own predicate instead of
// failing loudly. checks.queries is exempt: it is only ever compared by
// column shape (.columns()), never executed with bound values, so a
// parameter there carries no false-success risk.
function validateAssertionParams(assertions: Record<string, string>): void {
  for (const [name, sql] of Object.entries(assertions)) {
    const slots = namedSlots(sql);
    const anonymous = namedParams(sql).anonymous;
    if (slots.length > 0 || anonymous.length > 0) {
      const used = [...slots.map(s => s.sqlName), ...anonymous.map(() => '?')];
      throw new Error(`assertion ${JSON.stringify(name)} takes no parameters, but uses ${used.join(', ')}; bind real values with a case instead`);
    }
  }
}

// JSON has no BLOB or BigInt literal; a case that needs one must encode it
// as a string itself, the same repair the build asks for on generated params.
function validateCaseValue(name: string, slot: string, value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`case ${JSON.stringify(name)} parameter ${slot} must be a finite number`);
    return;
  }
  if (typeof value === 'bigint') throw new Error(`case ${JSON.stringify(name)} parameter ${slot} is a BigInt; bind it as a string instead`);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) throw new Error(`case ${JSON.stringify(name)} parameter ${slot} is a BLOB; bind it as a string instead`);
  if (Array.isArray(value)) { value.forEach((v, i) => validateCaseValue(name, `${slot}[${i}]`, v)); return; }
  if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) validateCaseValue(name, `${slot}.${k}`, v); return; }
  throw new Error(`case ${JSON.stringify(name)} parameter ${slot} has an unsupported value type`);
}

// A case names its slots by the full SQLite name (":id", not "id") so that
// distinct prefixes for the same bare name cannot collide, matching the
// bind convention storageOf() already uses in src/node.ts.
function validateCases(cases: unknown): asserts cases is Record<string, RehearsalCase> {
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) throw new Error('cases must be an object of names and case definitions');
  for (const [name, kase] of Object.entries(cases)) {
    if (!kase || typeof kase !== 'object' || Array.isArray(kase)) throw new Error(`case ${JSON.stringify(name)} must be an object with sql and params`);
    const unexpected = Object.keys(kase).filter(f => f !== 'sql' && f !== 'params');
    if (unexpected.length > 0) throw new Error(`case ${JSON.stringify(name)} has unknown field${unexpected.length > 1 ? 's' : ''}: ${unexpected.join(', ')}`);
    const sql = (kase as Record<string, unknown>).sql;
    const params = (kase as Record<string, unknown>).params;
    if (typeof sql !== 'string') throw new Error(`case ${JSON.stringify(name)}.sql must be a string`);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(`case ${JSON.stringify(name)}.params must be an object`);
    catalogStatement(sql, 'read');
    if (namedParams(sql).anonymous.length > 0) throw new Error(`case ${JSON.stringify(name)} uses an anonymous parameter; name every slot`);
    const slots = namedSlots(sql);
    const mixed = [...new Set(slots.filter(s => s.key === s.sqlName).map(s => s.sqlName))];
    if (mixed.length > 0) throw new Error(`case ${JSON.stringify(name)} uses one parameter name with more than one prefix: ${mixed.join(', ')}`);
    const slotNames = new Set(slots.map(s => s.sqlName));
    const missing = [...slotNames].filter(n => !Object.hasOwn(params, n) || (params as Record<string, unknown>)[n] === undefined);
    const extra = Object.keys(params).filter(k => !slotNames.has(k));
    if (missing.length > 0) throw new Error(`case ${JSON.stringify(name)} is missing parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    if (extra.length > 0) throw new Error(`case ${JSON.stringify(name)} has unexpected parameter${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
    for (const slot of slotNames) validateCaseParamValue(name, slot, (params as Record<string, unknown>)[slot]);
  }
}

// SqlValue (src/index.ts) has no boolean; a real generated query parameter
// is never one, so a top-level boolean would rehearse a bind shape no
// caller can construct.
function validateCaseParamValue(name: string, slot: string, value: unknown): void {
  if (typeof value === 'boolean') {
    throw new Error(`case ${JSON.stringify(name)} parameter ${slot} is a boolean; SqlValue has no boolean and no generated query parameter is ever one; bind 0 or 1 instead`);
  }
  validateCaseValue(name, slot, value);
}

// Arrays and objects go through as JSON text, the same repair the build
// documentation asks callers to apply.
function encodeCaseParams(params: Record<string, RehearsalCaseValue>): Record<string, string | number | null> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => {
    if (typeof v === 'object' && v !== null) return [k, JSON.stringify(v)];
    // validateCaseParamValue already rejected a top-level boolean; only a
    // string, a finite number, or null remain here.
    return [k, v as string | number | null];
  }));
}

function counts(db: DatabaseSync): Record<string, number> {
  const names = db.prepare("select name from sqlite_schema where type = 'table' and lower(name) not glob 'sqlite_*' order by name").all();
  return Object.fromEntries(names.map(r => [String(r.name), Number(db.prepare(`select count(*) as n from ${quoteIdent(String(r.name))}`).get()!.n)]));
}

// hidden 0 is an ordinary column; 2 and 3 are generated columns (VIRTUAL and
// STORED), which a rebuild can lose the same as any other; 1, a virtual
// table's own hidden column, is left out -- the same selection migrate() in
// src/durable.ts already reads.
function columnsOf(db: DatabaseSync, table: string): RehearsalColumn[] {
  return db.prepare('select name, type, "notnull", pk from pragma_table_xinfo(?) where hidden in (0, 2, 3) order by cid')
    .all(table)
    .map(r => ({ name: String(r.name), type: String(r.type), notnull: (r.notnull ? 1 : 0) as 0 | 1, pk: Number(r.pk) }));
}

function columns(db: DatabaseSync, tables: string[]): Record<string, RehearsalColumn[]> {
  return Object.fromEntries(tables.map(table => [table, columnsOf(db, table)]));
}

type SchemaShapeFinding = { table: string; column?: string; kind: 'dropped' | 'retyped' };

// Only what before names and after lacks, or what changed type, are
// findings; an added table or an added column is never one (an addition
// cannot lose data a caller relied on).
function schemaShapeFindings(before: Record<string, RehearsalColumn[]>, after: Record<string, RehearsalColumn[]>): SchemaShapeFinding[] {
  const findings: SchemaShapeFinding[] = [];
  for (const [table, beforeColumns] of Object.entries(before)) {
    const afterColumns = after[table];
    if (!afterColumns) { findings.push({ table, kind: 'dropped' }); continue; }
    const afterByName = new Map(afterColumns.map(c => [sqliteName(c.name), c]));
    for (const column of beforeColumns) {
      const match = afterByName.get(sqliteName(column.name));
      if (!match) { findings.push({ table, column: column.name, kind: 'dropped' }); continue; }
      if (match.type.toLowerCase() !== column.type.toLowerCase()) findings.push({ table, column: column.name, kind: 'retyped' });
    }
  }
  return findings;
}

function findingKey(f: { table: string; column?: string }): string {
  return f.column ? `${f.table}.${f.column}` : f.table;
}

// A stale expected entry -- naming a loss this migration did not actually
// perform -- is refused too, so an old checks.json cannot pre-authorize a
// future, unrelated loss it was never reviewed against.
function unmatchedSchemaShape(findings: SchemaShapeFinding[], expected: RehearsalExpected | undefined): { unexpected: SchemaShapeFinding[]; stale: string[] } {
  const droppedKeys = new Set((expected?.dropped ?? []).map(findingKey));
  const retypedKeys = new Set((expected?.retyped ?? []).map(findingKey));
  const unexpected = findings.filter(f => !(f.kind === 'dropped' ? droppedKeys : retypedKeys).has(findingKey(f)));
  const foundDropped = new Set(findings.filter(f => f.kind === 'dropped').map(findingKey));
  const foundRetyped = new Set(findings.filter(f => f.kind === 'retyped').map(findingKey));
  const stale = [
    ...[...droppedKeys].filter(k => !foundDropped.has(k)).map(k => `dropped ${k}`),
    ...[...retypedKeys].filter(k => !foundRetyped.has(k)).map(k => `retyped ${k}`),
  ];
  return { unexpected, stale };
}

// pragma integrity_check reports exactly one row of the literal text 'ok'
// when the database has no problem; any other row count is only reached by
// reporting one problem per row, so a row count other than 1 always carries
// at least one row whose own value already differs from 'ok' (measured:
// two independent CHECK violations produced two rows, both non-'ok' text).
function healthy(db: DatabaseSync): void {
  const integrity = db.prepare('pragma integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('SQLite integrity_check failed');
  if (db.prepare('pragma foreign_key_check').all().length > 0) throw new Error('SQLite foreign_key_check failed');
}

// A fixed schema name for the before-copy's own ATTACH, so the row-diff
// authorizer (below) can allow SQLITE_DETACH by name without trusting any
// value the proposed SQL or checks.json could have chosen.
const BEFORE_SCHEMA = 'solarsql_rehearse_before';

// ATTACH's own authorizer callback sees the resolved literal text of its
// filename argument, not a bound parameter's value (`?` reports null;
// measured on node:sqlite 3.53.4) -- unlike `vacuum into ?` above, which
// only ever runs its own statement, never one an authorizer must recognize
// by argument. The path this module builds (a mkdtemp() directory joined
// with a fixed filename) never contains a single quote in practice, but
// the escape is applied anyway, matching the same convention
// test/slow/rehearse-file.test.ts already uses for an ATTACH literal.
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// pragma_table_list's own `type` distinguishes an ordinary table ('table')
// from a virtual table ('virtual', e.g. an FTS5 table) and that virtual
// table's own shadow tables ('shadow', e.g. FTS5's own *_data, *_idx). Row
// diffing skips both: a virtual table has no ordinary row storage to VACUUM
// INTO copy meaningfully, and a shadow table is that virtual table's own
// implementation detail, not a table an agent wrote.
function tableTypes(db: DatabaseSync): Map<string, string> {
  return new Map(db.prepare("select name, type from pragma_table_list where schema = 'main'").all().map(r => [sqliteName(String(r.name)), String(r.type)]));
}

type ColumnPair = { after: string; before: string };

// undefined when either side has no primary key or the primary-key counts differ.
// It is also undefined when SQLite's identifier case rule finds no matching column.
// Each condition makes the primary key unsuitable for the row diff join.
function pkPairs(beforeColumns: RehearsalColumn[], afterColumns: RehearsalColumn[]): ColumnPair[] | undefined {
  const beforePk = beforeColumns.filter(c => c.pk > 0);
  const afterPk = afterColumns.filter(c => c.pk > 0);
  // The first two disjuncts are each implied by the other two combined
  // with ||: if one side has zero primary-key columns and the other does
  // not, the lengths already differ (the third disjunct); if both sides
  // have zero, the other of the first two disjuncts already holds. So the
  // condition's result depends only on whether the two counts differ or
  // either is zero (checked for every count pair from 0 to 3). The third
  // disjunct has no such
  // redundancy: a primary key narrowed to fewer columns on one side, with
  // every remaining column still matching by name, depends on it alone.
  if (beforePk.length === 0 || afterPk.length === 0 || beforePk.length !== afterPk.length) return undefined;
  const beforeByName = new Map(beforePk.map(c => [sqliteName(c.name), c]));
  const pairs: ColumnPair[] = [];
  for (const afterColumn of afterPk) {
    const match = beforeByName.get(sqliteName(afterColumn.name));
    if (!match) return undefined;
    pairs.push({ after: afterColumn.name, before: match.name });
  }
  return pairs;
}

// Every non-primary-key column present on both sides is matched with SQLite's identifier case rule.
// A one-sided column is a schemaShapeFindings drop or a new column, so it plays no part here.
function commonColumns(beforeColumns: RehearsalColumn[], afterColumns: RehearsalColumn[], pk: ColumnPair[]): ColumnPair[] {
  const pkAfterNames = new Set(pk.map(p => sqliteName(p.after)));
  const beforeByName = new Map(beforeColumns.map(c => [sqliteName(c.name), c]));
  const pairs: ColumnPair[] = [];
  for (const afterColumn of afterColumns) {
    const nameKey = sqliteName(afterColumn.name);
    if (pkAfterNames.has(nameKey)) continue;
    const match = beforeByName.get(nameKey);
    if (match) pairs.push({ after: afterColumn.name, before: match.name });
  }
  return pairs;
}

// A rowid table stores NULL in a non-INTEGER primary-key column (SQLite
// only special-cases a lone INTEGER PRIMARY KEY as the rowid alias); `=`
// never matches NULL to NULL, so an untouched NULL-keyed row would join to
// nothing on either side and get reported as both inserted and deleted.
// Counted here as "rows whose primary-key tuple has NULL in at least one
// column and shares its full tuple with at least one other row" -- SQLite's
// own PRIMARY KEY/UNIQUE index already forbids a duplicate tuple that has
// no NULL at all, so a duplicate tuple can only arise where every row that
// shares it has NULL in the same column(s). With more than one row sharing
// such a tuple, `IS` joins them many to many, so a delete or an update
// among them cannot be counted; the table reports `compared: false` rather
// than a count that could be wrong.
function duplicateNullKeyCount(db: DatabaseSync, tableRef: string, columns: string[]): number {
  const quoted = columns.map(quoteIdent);
  const anyNull = quoted.map(c => `${c} is null`).join(' or ');
  const groupBy = quoted.join(', ');
  const row = db.prepare(`select count(*) as n from (select 1 from ${tableRef} where ${anyNull} group by ${groupBy} having count(*) > 1) x`).get();
  return Number(row!.n);
}

// Inserted: primary key present after, absent before. Deleted: the reverse.
// Updated: primary key in both, and at least one common column differs --
// `IS NOT ... COLLATE BINARY` catches a value change even across a NOCASE
// or other non-binary column collation (ADR 0139: measured, plain `IS NOT`
// alone misses an upper() rewrite on a COLLATE NOCASE column), and
// `typeof(a) IS NOT typeof(b)` catches a storage-class change (e.g.
// integer 1 -> real 1.0, or TEXT -> INTEGER) `IS NOT` alone treats as
// equal. The primary-key join uses `IS`, not `=`, so a row whose primary
// key is NULL in one or more of its columns still matches itself across the
// copies (ADR 0139); it runs under the column's own declared collation and
// can still use its own index for the correlated lookup (measured: `explain
// query plan` on this function's inserted count, against a `text primary
// key` table, shows the anti-join's inner lookup as `SEARCH b USING
// COVERING INDEX ... (k=?)`, the same as under `=`, not a table scan), so a
// NOCASE primary key still matches keys case-insensitively here too.
// valuePreservingColumns (ADR 0139 amendment, 2026-09-27) names a column
// `expected.retyped` declared: the type change alone must not count toward
// `remainingUpdated`, but a value the rebuild actually changed (wiped to
// NULL, a lossy cast) still must, the same as any other column. That column
// still takes part in the same `changed` disjunction as every other common
// column, just with its own `typeof` disjunct dropped -- `COLLATE BINARY`
// stays on both the strict and the relaxed predicate (COLLATE governs a
// text comparison's collating sequence, not SQLite's own comparison
// affinity conversion between a TEXT-affinity value and a NUMERIC-affinity
// value; dropping it, as an earlier version of this predicate did, let a
// genuine rewrite on a NOCASE- or RTRIM-collated retyped column pass
// unnoticed). One query computes both `updated` (the strict count this
// function always reported) and `remainingUpdated` (the declaration-aware
// count `unmatchedRowChanges` needs) with two `count(*) filter (where ...)`
// aggregates over the same join, so a table is diffed once regardless of
// whether `expected.retyped` names any of its columns.
function diffTable(db: DatabaseSync, table: string, beforeTable: string, pk: ColumnPair[], nonPk: ColumnPair[], valuePreservingColumns: Set<string> = new Set()): { inserted: number; deleted: number; updated: number; remainingUpdated: number } {
  const mainTable = `main.${quoteIdent(table)}`;
  const beforeTableRef = `${quoteIdent(BEFORE_SCHEMA)}.${quoteIdent(beforeTable)}`;
  const pkJoin = pk.map(p => `a.${quoteIdent(p.after)} is b.${quoteIdent(p.before)}`).join(' and ');
  const inserted = Number(db.prepare(`select count(*) as n from ${mainTable} a where not exists (select 1 from ${beforeTableRef} b where ${pkJoin})`).get()!.n);
  const deleted = Number(db.prepare(`select count(*) as n from ${beforeTableRef} b where not exists (select 1 from ${mainTable} a where ${pkJoin})`).get()!.n);
  let updated = 0;
  let remainingUpdated = 0;
  if (nonPk.length > 0) {
    const strictTerms = nonPk.map(c => `(a.${quoteIdent(c.after)} is not b.${quoteIdent(c.before)} collate binary or typeof(a.${quoteIdent(c.after)}) is not typeof(b.${quoteIdent(c.before)}))`);
    const relaxedTerms = nonPk.map((c, i) => valuePreservingColumns.has(c.before) ? `(a.${quoteIdent(c.after)} is not b.${quoteIdent(c.before)} collate binary)` : strictTerms[i]!);
    const row = db.prepare(`select count(*) filter (where ${strictTerms.join(' or ')}) as updated, count(*) filter (where ${relaxedTerms.join(' or ')}) as remaining from ${mainTable} a join ${beforeTableRef} b on ${pkJoin}`).get();
    updated = Number(row!.updated);
    remainingUpdated = Number(row!.remaining);
  }
  return { inserted, deleted, updated, remainingUpdated };
}

// The before-side column name a caller's expected.retyped entry names,
// grouped by table: schemaShapeFindings (above) keys a retyped finding the
// same way, by iterating beforeColumns, so a rebuild that also changes a
// column's name case (Qty -> qty) is matched here the way SCHEMA_SHAPE_CHANGED
// already matched it, instead of failing ROWS_LOST_OR_CHANGED right after
// passing that check.
function retypedColumnsByTable(expected: RehearsalExpected | undefined): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  // A guard, not a default-empty-array fallback: `expected.retyped` may
  // genuinely be absent, and a fallback array here would only ever add a
  // phantom entry no real table name could match, giving a mutant nothing
  // for a test to observe.
  if (expected?.retyped) {
    for (const r of expected.retyped) {
      const columns = byTable.get(r.table) ?? new Set<string>();
      columns.add(r.column);
      byTable.set(r.table, columns);
    }
  }
  return byTable;
}

// Every table present under SQLite's identifier case rule both before and after,
// excluding a virtual or shadow table on either side. `remainingUpdated`,
// alongside the reported `rows`, is `diffTable`'s own declaration-aware
// updated count for every compared table (ADR 0139 amendment): computed
// here, in the same query that already produces `rows[table].updated`, so
// `unmatchedRowChanges` can read it back without diffing the table a second
// time.
function diffAllTables(
  db: DatabaseSync,
  before: Record<string, number>, after: Record<string, number>,
  beforeColumns: Record<string, RehearsalColumn[]>, afterColumns: Record<string, RehearsalColumn[]>,
  beforeTypes: Map<string, string>, afterTypes: Map<string, string>,
  retypedColumns: Map<string, Set<string>>,
): { rows: Record<string, RowDiff>; remainingUpdated: Record<string, number> } {
  const beforeByName = new Map(Object.keys(before).map(name => [sqliteName(name), name]));
  const rows: Record<string, RowDiff> = {};
  const remainingUpdated: Record<string, number> = {};
  for (const table of Object.keys(after)) {
    const beforeTable = beforeByName.get(sqliteName(table));
    // before and beforeTypes both read the same pre-migration schema:
    // counts() names every table sqlite_schema reports as type 'table'
    // (an ordinary table, an FTS5 virtual table's own entry, and each of
    // its shadow tables all report 'table' there), and tableTypes() names
    // every one of those same names again, this time with pragma_table_list's
    // finer type. pragma_table_list also names views, which counts() leaves
    // out. So whenever beforeTable is undefined, beforeTypes has either no
    // entry for the name or a type other than 'table' (a view the migration
    // replaced with a table, for example), and the type check right below
    // already turns that into a skip.
    if (beforeTable === undefined) continue;
    const nameKey = sqliteName(table);
    if (beforeTypes.get(nameKey) !== 'table' || afterTypes.get(nameKey) !== 'table') continue;
    // beforeTable and table are both drawn from the same key sets columns()
    // just built beforeColumns and afterColumns from, so a lookup here can
    // never miss: no fallback array could ever surface.
    const pk = pkPairs(beforeColumns[beforeTable]!, afterColumns[table]!);
    if (!pk) { rows[table] = { compared: false, reason: 'no primary key, or a changed primary key' }; continue; }
    const mainTable = `main.${quoteIdent(table)}`;
    const beforeTableRef = `${quoteIdent(BEFORE_SCHEMA)}.${quoteIdent(beforeTable)}`;
    const duplicateNullKeys = duplicateNullKeyCount(db, mainTable, pk.map(p => p.after)) > 0
      || duplicateNullKeyCount(db, beforeTableRef, pk.map(p => p.before)) > 0;
    if (duplicateNullKeys) {
      rows[table] = { compared: false, reason: 'more than one row shares the same primary key containing NULL, so rows cannot be matched one to one' };
      continue;
    }
    // Same guarantee as the pkPairs lookup above: both lookups always hit.
    const nonPk = commonColumns(beforeColumns[beforeTable]!, afterColumns[table]!, pk);
    const diffed = diffTable(db, table, beforeTable, pk, nonPk, retypedColumns.get(table));
    rows[table] = { compared: true, inserted: diffed.inserted, deleted: diffed.deleted, updated: diffed.updated };
    remainingUpdated[table] = diffed.remainingUpdated;
  }
  return { rows, remainingUpdated };
}

// A lost or rewritten row fails the rehearsal by default (owner decision,
// 2026-09-27): a migration that drops or rewrites data the caller did not
// review is exactly the failure a rehearsal exists to catch. `expected`
// gains two more arrays beside `dropped` and `retyped`: `deleted` and
// `updated` each name only a table (not a column: a row loss is never
// scoped to one column the way a dropped or retyped column is), the same
// way `dropped` names a whole table with no `column`.
//
// A `compared: false` table cannot report deleted/updated counts, but a row
// count that shrank is still evidence of a loss, so that table also needs a
// `deleted` declaration once `after` is smaller than `before`; `updated`
// carries no signal there, since a `compared: false` table's rewritten
// values are invisible either way. A table that only grows, or stays the
// same size, is not flagged: `compared: false`'s own reason already says its
// contents cannot be verified (ADR 0139), and a same-size table could hide a
// delete-and-insert pair no count-only check can see -- accepted, since only
// a per-row comparison could catch it, and that comparison is exactly what
// `compared: false` means the diff could not do.
//
// A column drop already excludes that column from `nonPk` (`commonColumns`
// above only pairs columns present on both sides), so the value it carried
// away never counts as an update; test 'rows compares over the columns a
// rebuild kept' pins this.
//
// `retyped` on a column excuses only the type change itself, not a genuine
// value change alongside it (owner decision, 2026-09-27, amending the
// initial ADR 0139 row-loss decision): a row where that column's own value
// is unchanged once SQLite's own comparison affinity is applied (an
// integer retyped to the text of the same number) is not "updated" on
// account of that column, but a row where the value actually changed (wiped
// to NULL, a lossy cast, a botched `cast()`) still is, the same as any other
// column, and still needs its own `updated` declaration. `remainingUpdated`
// (one entry per compared table, from `diffAllTables`) already carries this:
// it is `diffTable`'s own declaration-aware count, computed in the same
// query as the reported `updated`, so this function only compares counts
// and never touches `db` itself. `retyped` never excuses `deleted`, and
// never a different column's own change on the same row.
function unmatchedRowChanges(
  rows: Record<string, RowDiff>, before: Record<string, number>, after: Record<string, number>,
  remainingUpdated: Record<string, number>,
  expected: RehearsalExpected | undefined,
): { unexpected: string[]; stale: string[] } {
  const deletedDeclared = new Set((expected?.deleted ?? []).map(r => r.table));
  const updatedDeclared = new Set((expected?.updated ?? []).map(r => r.table));
  const beforeByName = new Map(Object.keys(before).map(name => [sqliteName(name), name]));
  const unexpected: string[] = [];
  const matchedDeleted = new Set<string>();
  const matchedUpdated = new Set<string>();
  for (const [table, diff] of Object.entries(rows)) {
    if (diff.compared) {
      if (diff.deleted > 0) {
        if (deletedDeclared.has(table)) matchedDeleted.add(table);
        else unexpected.push(`deleted ${table} (${diff.deleted})`);
      }
      const updated = remainingUpdated[table]!;
      if (updated > 0) {
        if (updatedDeclared.has(table)) matchedUpdated.add(table);
        else unexpected.push(`updated ${table} (${updated})`);
      }
    } else {
      const beforeTable = beforeByName.get(sqliteName(table))!;
      const beforeCount = before[beforeTable]!;
      const afterCount = after[table]!;
      if (afterCount < beforeCount) {
        if (deletedDeclared.has(table)) matchedDeleted.add(table);
        else unexpected.push(`deleted ${table} (before ${beforeCount}, after ${afterCount})`);
      }
    }
  }
  const stale = [
    ...[...deletedDeclared].filter(t => !matchedDeleted.has(t)).map(t => `deleted ${t}`),
    ...[...updatedDeclared].filter(t => !matchedUpdated.has(t)).map(t => `updated ${t}`),
  ].map(s => `expected ${s} did not happen`);
  return { unexpected, stale };
}

export async function rehearse(database: string, sql: string, checks: RehearsalChecks = {}, effectiveTimeoutMs = 30_000): Promise<RehearsalResult> {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearse-'));
  let source: DatabaseSync | undefined;
  let copy: DatabaseSync | undefined;
  const stage = 'SNAPSHOT_FAILED';
  const timeout = busyTimeoutMs(effectiveTimeoutMs);
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, columns: { before: {}, after: {} }, rows: {}, queries: [], assertions: [], cases: [], diagnostics: [] };
  try {
    let end = phase('open-source');
    source = new DatabaseSync(database, { readOnly: true, timeout });
    end();
    const path = join(dir, 'snapshot.sqlite');
    end = phase('backup');
    // node:sqlite's backup() runs sqlite3_backup_step on the threadpool and
    // opens a second native handle on the destination; measured at 8,000-
    // 30,000 ms per call on this machine once a WAL source had been touched
    // by an earlier call in the same process, with the process at 0% CPU (so
    // not a SQLite retry loop; node's own BUSY/LOCKED handling has no sleep
    // either -- src/node_sqlite.cc's BackupJob just reschedules). `vacuum
    // into` runs synchronously on the already-open source connection, reads
    // through the same B-tree layer so it still only sees committed data
    // (verified: test/slow/rehearse-file.test.ts's WAL-sourced test still
    // finds the committed row and not the in-progress one), and took under
    // 12 ms per call in the same reproduction. See ADR 0121.
    source.prepare('vacuum into ?').run(path);
    end();
    end = phase('close-source');
    // source closes here on any path that reaches this point; the finally
    // block's own `if (source?.isOpen) source.close()` closes it on any
    // path that doesn't, so every execution that opened source closes it
    // exactly once by the time rehearse() returns.
    source.close();
    end();
    end = phase('open-copy');
    copy = new DatabaseSync(path);
    end();
    end = phase('validate');
    const report = rehearseSnapshot(copy, sql, checks);
    end();
    return report;
  } catch (e) {
    result.diagnostics.push({code:stage, message: isLockError(e) ? lockMessage(database, timeout) : e instanceof Error ? e.message : String(e)});
  } finally {
    if (copy?.isOpen) {
      const end = phase('close-copy');
      // rehearseSnapshot never returns with its own transaction still open
      // (its own finally runs `if (db.isTransaction) db.exec('rollback')`
      // first), so copy.isTransaction is always false here and this
      // rollback never runs.
      if (copy.isTransaction) copy.exec('rollback');
      copy.close();
      end();
    }
    // A skipped close here only leaves the read-only source handle open a
    // little longer; it publishes no diagnostics-channel event and no later
    // step inspects it, so this guard's own effect never reaches the
    // returned report.
    if (source?.isOpen) source.close();
    const end = phase('cleanup');
    // dir always exists once this line runs (mkdtempSync created it above,
    // and nothing removes it earlier), so force -- which only changes
    // rmSync's behavior for a path that is already gone -- never applies.
    rmSync(dir, {recursive:true, force:true});
    end();
  }
  return result;
}

// The caller supplies a disposable database. This seam keeps transition checks
// synchronous and allows property tests without filesystem scheduling.
export function rehearseSnapshot(db: DatabaseSync, sql: string, checks: RehearsalChecks = {}): RehearsalResult {
  let stage = 'CHECKS_INVALID';
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, columns: { before: {}, after: {} }, rows: {}, queries: [], assertions: [], cases: [], diagnostics: [] };
  // Own temp directory, separate from rehearse()'s own snapshot directory:
  // this one holds only the row diff's before-copy, created and removed
  // inside this call regardless of which caller (rehearse(), or a direct
  // in-process caller) supplied `db` (ADR 0139).
  const diffDir = mkdtempSync(join(tmpdir(), 'solarsql-rehearse-diff-'));
  const beforeCopyPath = join(diffDir, 'before.sqlite');
  try {
    // A misspelled check must fail, rather than silently approve less evidence.
    validateChecks(checks);
    // The before-copy is taken before any authorizer exists: a deny-all
    // authorizer (installed next) denies VACUUM INTO too, since it performs
    // its own internal SQLITE_ATTACH (measured: "authorization denied",
    // action 24). No proposed SQL has run yet, so `db` is still exactly the
    // state the caller supplied.
    stage = 'BEFORE_COPY_FAILED';
    db.prepare('vacuum into ?').run(beforeCopyPath);
    // Prevent a migration from reaching the original database through ATTACH
    // or directing SQLite temporary files to a caller-selected directory.
    db.setAuthorizer((action, arg) => {
      if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) return constants.SQLITE_DENY;
      // node:sqlite always passes a PRAGMA action's own name as arg, never
      // null or undefined, so the fallback empty string here never
      // substitutes for a real value.
      if (action === constants.SQLITE_PRAGMA && ['writable_schema', 'temp_store_directory', 'data_store_directory'].includes((arg ?? '').toLowerCase())) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    stage = 'BASELINE_FAILED';
    healthy(db);
    result.before = counts(db);
    result.columns.before = columns(db, Object.keys(result.before));
    const beforeTypes = tableTypes(db);
    const old = new Map<string, string>();
    for (const [name, query] of Object.entries(checks.queries ?? {})) {
      const statement = db.prepare(catalogStatement(query, 'read'));
      old.set(name, JSON.stringify(statement.columns().map(c => ({name:c.name, type:c.type}))));
    }
    const caseColumns = new Map<string, string>();
    stage = 'CASE_BASELINE_FAILED';
    for (const [name, kase] of Object.entries(checks.cases ?? {})) {
      const statement = db.prepare(catalogStatement(kase.sql, 'read'));
      caseColumns.set(name, JSON.stringify(statement.columns().map(c => ({name:c.name, type:c.type}))));
      statement.setAllowBareNamedParameters(false);
      statement.all(encodeCaseParams(kase.params));
    }
    stage = 'MIGRATION_FAILED';
    const statements = splitStatements(sql);
    for (const statement of statements) {
      const verb = significant(tokenize(statement))[0]?.text.toUpperCase();
      if (verb && ['BEGIN','COMMIT','END','ROLLBACK','SAVEPOINT','RELEASE'].includes(verb)) throw new Error('Rehearsal owns the transaction; remove transaction control statements');
    }
    db.exec('begin');
    for (const statement of statements) db.exec(statement);
    healthy(db);
    result.after = counts(db);
    result.columns.after = columns(db, Object.keys(result.after));
    const afterTypes = tableTypes(db);
    stage = 'SCHEMA_SHAPE_CHANGED';
    {
      const findings = schemaShapeFindings(result.columns.before, result.columns.after);
      const { unexpected, stale } = unmatchedSchemaShape(findings, checks.expected);
      const messages = [
        ...unexpected.map(f => `${f.kind === 'dropped' ? 'dropped' : 'retyped'} ${findingKey(f)}`),
        ...stale.map(s => `expected ${s} did not happen`),
      ];
      if (messages.length > 0) throw new Error(`Schema shape changed unexpectedly: ${messages.join(', ')}`);
    }
    stage = 'QUERY_COMPATIBILITY_FAILED';
    for (const [name, query] of Object.entries(checks.queries ?? {})) {
      const columns = db.prepare(catalogStatement(query, 'read')).columns().map(c => ({name:c.name, type:c.type}));
      if (JSON.stringify(columns) !== old.get(name)) throw new Error(`Result columns changed for query ${name}`);
      result.queries.push(name);
    }
    stage = 'CASE_COMPATIBILITY_FAILED';
    for (const [name, kase] of Object.entries(checks.cases ?? {})) {
      const statement = db.prepare(catalogStatement(kase.sql, 'read'));
      const columns = JSON.stringify(statement.columns().map(c => ({name:c.name, type:c.type})));
      if (columns !== caseColumns.get(name)) throw new Error(`Result columns changed for case ${name}`);
      statement.setAllowBareNamedParameters(false);
      statement.all(encodeCaseParams(kase.params));
      result.cases.push(name);
    }
    stage = 'ASSERTION_FAILED';
    for (const [name, query] of Object.entries(checks.assertions ?? {})) {
      const rows = db.prepare(catalogStatement(query, 'read')).all();
      if (rows.length !== 1 || Object.keys(rows[0]!).length !== 1 || Object.values(rows[0]!)[0] !== 1) throw new Error(`Assertion ${name} must return one row and one value equal to 1`);
      result.assertions.push(name);
    }
    // This authorizer sees every action any statement performs while it is
    // installed, not just the ones the two statements below issue: a
    // function the caller registered on db, called from a query this call
    // runs (a generated column's own expression, for example), can run its
    // own nested statement, and that statement's actions reach this
    // authorizer too. The checks below hold for any of those, not only for
    // the ATTACH and DETACH this call's own code issues.
    stage = 'ROW_DIFF_FAILED';
    db.setAuthorizer((action, arg) => {
      // This call's own code issues exactly one ATTACH from here on, whose
      // argument is always beforeCopyPath; any other ATTACH is denied.
      if (action === constants.SQLITE_ATTACH) return arg === beforeCopyPath ? constants.SQLITE_OK : constants.SQLITE_DENY;
      // This call's own code detaches only the reserved before-schema name,
      // and only after clearing this authorizer first, in the finally
      // block below; any DETACH seen here is denied unless it names that
      // same reserved schema.
      if (action === constants.SQLITE_DETACH) return arg === BEFORE_SCHEMA ? constants.SQLITE_OK : constants.SQLITE_DENY;
      // node:sqlite always passes a PRAGMA action's own name as arg, never
      // null or undefined, so the fallback empty string here never
      // substitutes for a real value.
      if (action === constants.SQLITE_PRAGMA && ['writable_schema', 'temp_store_directory', 'data_store_directory'].includes((arg ?? '').toLowerCase())) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.exec(`attach database ${sqlString(beforeCopyPath)} as ${quoteIdent(BEFORE_SCHEMA)}`);
    const diffed = diffAllTables(db, result.before, result.after, result.columns.before, result.columns.after, beforeTypes, afterTypes, retypedColumnsByTable(checks.expected));
    result.rows = diffed.rows;
    stage = 'ROWS_LOST_OR_CHANGED';
    {
      const { unexpected, stale } = unmatchedRowChanges(result.rows, result.before, result.after, diffed.remainingUpdated, checks.expected);
      const messages = [...unexpected, ...stale];
      if (messages.length > 0) throw new Error(`Rows lost or changed unexpectedly: ${messages.join(', ')}`);
    }
    // finally's rollback only undoes an open transaction, so every check
    // must run before commit for a failed check to undo the migration.
    stage = 'MIGRATION_FAILED';
    db.exec('commit');
    result.ok = true;
  } catch (e) {
    result.diagnostics.push({code:stage, message:e instanceof Error ? e.message : String(e)});
  } finally {
    if (db.isTransaction) db.exec('rollback');
    // DETACH cannot run inside an open transaction ("database ... is
    // locked"), so rollback runs first. The authorizer is cleared before
    // the attempt (rather than kept at the ATTACH-stage's narrow allowance)
    // so a run that never reached that stage still gets SQLite's own "no
    // such database" for a schema that was never attached, instead of an
    // authorization denial that would mask it; no proposed SQL runs after
    // this point, so nothing is exposed by clearing it early.
    db.setAuthorizer(null);
    try { db.exec(`detach ${quoteIdent(BEFORE_SCHEMA)}`); }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes('no such database')) result.diagnostics.push({ code: 'DETACH_FAILED', message });
    }
    rmSync(diffDir, { recursive: true, force: true });
  }
  return result;
}
