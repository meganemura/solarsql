// Responsibility: rehearse one SQL transition on a disposable database snapshot.
// Boundary: local SQLite evidence only; this does not deploy or certify data meaning.
import { backup, constants, DatabaseSync } from 'node:sqlite';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namedParams, namedSlots, quoteIdent, significant, splitStatements, tokenize } from './scan.ts';
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
export type RehearsalExpected = { dropped?: ExpectedDrop[]; retyped?: ExpectedRetype[] };
export type RehearsalChecks = { queries?: Record<string, string>; assertions?: Record<string, string>; cases?: Record<string, RehearsalCase>; expected?: RehearsalExpected };
export type RehearsalColumn = { name: string; type: string; notnull: 0 | 1; pk: number };
export type RehearsalResult = {
  version: 1;
  ok: boolean;
  sql: string;
  before: Record<string, number>;
  after: Record<string, number>;
  columns: { before: Record<string, RehearsalColumn[]>; after: Record<string, RehearsalColumn[]> };
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

// expected names a schema-shape change the caller already reviewed, so a
// malformed entry must fail loudly rather than silently match nothing.
function validateExpected(expected: unknown): asserts expected is RehearsalExpected {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('expected must be an object with dropped and/or retyped');
  for (const [key, entries] of Object.entries(expected)) {
    if (key !== 'dropped' && key !== 'retyped') throw new Error(`Unknown expected field ${key}; use dropped or retyped`);
    if (!Array.isArray(entries)) throw new Error(`expected.${key} must be an array`);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`expected.${key} entries must be objects with table and column`);
      const fields = Object.keys(entry);
      const allowed = ['table', 'column'];
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
    const afterByName = new Map(afterColumns.map(c => [c.name.toLowerCase(), c]));
    for (const column of beforeColumns) {
      const match = afterByName.get(column.name.toLowerCase());
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

function healthy(db: DatabaseSync): void {
  const integrity = db.prepare('pragma integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('SQLite integrity_check failed');
  if (db.prepare('pragma foreign_key_check').all().length > 0) throw new Error('SQLite foreign_key_check failed');
}

export async function rehearse(database: string, sql: string, checks: RehearsalChecks = {}): Promise<RehearsalResult> {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearse-'));
  let source: DatabaseSync | undefined;
  let copy: DatabaseSync | undefined;
  const stage = 'SNAPSHOT_FAILED';
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, columns: { before: {}, after: {} }, queries: [], assertions: [], cases: [], diagnostics: [] };
  try {
    let end = phase('open-source');
    source = new DatabaseSync(database, { readOnly: true });
    end();
    const path = join(dir, 'snapshot.sqlite');
    end = phase('backup');
    await backup(source, path);
    end();
    end = phase('close-source');
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
    result.diagnostics.push({code:stage, message:e instanceof Error ? e.message : String(e)});
  } finally {
    if (copy?.isOpen) {
      const end = phase('close-copy');
      if (copy.isTransaction) copy.exec('rollback');
      copy.close();
      end();
    }
    if (source?.isOpen) source.close();
    const end = phase('cleanup');
    rmSync(dir, {recursive:true, force:true});
    end();
  }
  return result;
}

// The caller supplies a disposable database. This seam keeps transition checks
// synchronous and allows property tests without filesystem scheduling.
export function rehearseSnapshot(db: DatabaseSync, sql: string, checks: RehearsalChecks = {}): RehearsalResult {
  let stage = 'CHECKS_INVALID';
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, columns: { before: {}, after: {} }, queries: [], assertions: [], cases: [], diagnostics: [] };
  try {
    // A misspelled check must fail, rather than silently approve less evidence.
    validateChecks(checks);
    // Prevent a migration from reaching the original database through ATTACH
    // or directing SQLite temporary files to a caller-selected directory.
    db.setAuthorizer((action, arg) => {
      if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_PRAGMA && ['writable_schema', 'temp_store_directory', 'data_store_directory'].includes((arg ?? '').toLowerCase())) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    stage = 'BASELINE_FAILED';
    healthy(db);
    result.before = counts(db);
    result.columns.before = columns(db, Object.keys(result.before));
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
    // finally's rollback only undoes an open transaction, so every check
    // must run before commit for a failed check to undo the migration.
    stage = 'MIGRATION_FAILED';
    db.exec('commit');
    result.ok = true;
  } catch (e) {
    result.diagnostics.push({code:stage, message:e instanceof Error ? e.message : String(e)});
  } finally {
    if (db.isTransaction) db.exec('rollback');
    db.setAuthorizer(null);
  }
  return result;
}
