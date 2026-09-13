// Responsibility: rehearse one SQL transition on a disposable database snapshot.
// Boundary: local SQLite evidence only; this does not deploy or certify data meaning.
import { setImmediate } from 'node:timers/promises';
import { backup, constants, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteIdent, significant, splitStatements, tokenize } from './scan.ts';
import { catalogStatement } from './statements.ts';

export type RehearsalChecks = { queries?: Record<string, string>; assertions?: Record<string, string> };
export type RehearsalResult = {
  version: 1;
  ok: boolean;
  sql: string;
  before: Record<string, number>;
  after: Record<string, number>;
  queries: string[];
  assertions: string[];
  diagnostics: { code: string; message: string }[];
};

function validateChecks(checks: unknown): asserts checks is RehearsalChecks {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('Checks must be an object with queries and/or assertions');
  for (const [key, value] of Object.entries(checks)) {
    if (!['queries', 'assertions'].includes(key)) throw new Error(`Unknown checks field ${key}; use queries or assertions`);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(sql => typeof sql !== 'string')) {
      throw new Error(`${key} must be an object of names and SQL strings`);
    }
  }
}

function counts(db: DatabaseSync): Record<string, number> {
  const names = db.prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name").all();
  return Object.fromEntries(names.map(r => [String(r.name), Number(db.prepare(`select count(*) as n from ${quoteIdent(String(r.name))}`).get()!.n)]));
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
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, queries: [], assertions: [], diagnostics: [] };
  try {
    source = new DatabaseSync(database, { readOnly: true });
    const path = join(dir, 'snapshot.sqlite');
    await backup(source, path);
    // Yield before closure; repeated backup tests stalled without this turn.
    await setImmediate();
    source.close();
    copy = new DatabaseSync(path);
    return rehearseSnapshot(copy, sql, checks);
  } catch (e) {
    result.diagnostics.push({code:stage, message:e instanceof Error ? e.message : String(e)});
  } finally {
    if (copy?.isOpen) {
      if (copy.isTransaction) copy.exec('rollback');
      copy.close();
    }
    if (source?.isOpen) source.close();
    rmSync(dir, {recursive:true, force:true});
  }
  return result;
}

// The caller supplies a disposable database. This seam keeps transition checks
// synchronous and allows property tests without filesystem scheduling.
export function rehearseSnapshot(db: DatabaseSync, sql: string, checks: RehearsalChecks = {}): RehearsalResult {
  let stage = 'CHECKS_INVALID';
  const result: RehearsalResult = { version: 1, ok: false, sql, before: {}, after: {}, queries: [], assertions: [], diagnostics: [] };
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
    const old = new Map<string, string>();
    for (const [name, query] of Object.entries(checks.queries ?? {})) {
      const statement = db.prepare(catalogStatement(query, 'read'));
      old.set(name, JSON.stringify(statement.columns().map(c => ({name:c.name, type:c.type}))));
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
    db.exec('commit');
    result.after = counts(db);
    stage = 'QUERY_COMPATIBILITY_FAILED';
    for (const [name, query] of Object.entries(checks.queries ?? {})) {
      const columns = db.prepare(catalogStatement(query, 'read')).columns().map(c => ({name:c.name, type:c.type}));
      if (JSON.stringify(columns) !== old.get(name)) throw new Error(`Result columns changed for query ${name}`);
      result.queries.push(name);
    }
    stage = 'ASSERTION_FAILED';
    for (const [name, query] of Object.entries(checks.assertions ?? {})) {
      const rows = db.prepare(catalogStatement(query, 'read')).all();
      if (rows.length !== 1 || Object.keys(rows[0]!).length !== 1 || Object.values(rows[0]!)[0] !== 1) throw new Error(`Assertion ${name} must return one row and one value equal to 1`);
      result.assertions.push(name);
    }
    result.ok = true;
  } catch (e) {
    result.diagnostics.push({code:stage, message:e instanceof Error ? e.message : String(e)});
  } finally {
    if (db.isTransaction) db.exec('rollback');
    db.setAuthorizer(null);
  }
  return result;
}
