// Responsibility: verify migration rehearsal against an on-disk source
// database, through rehearse()'s own backup phase.
// Boundary: deployment ordering and arbitrary data meaning remain caller
// checks; rehearseSnapshot's in-process checks (cases, assertions, queries,
// expected findings) live in test/rehearse.test.ts, not here.
// These tests live apart from the rest of rehearse.test.ts because they go
// through rehearse()'s on-disk snapshot step against a real file, not an
// in-memory database. That step used node:sqlite's native backup(), whose
// BUSY/LOCKED retry loop measured 8,000-30,000 ms per call on macOS once a
// WAL source had been touched earlier in the same process (ADR 0121);
// rehearse() now uses `vacuum into`, and the last test below asserts that
// phase stays under 2,000 ms so a regression back to backup() fails loudly.
import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rehearse } from '../../src/build/rehearse.ts';

test('rehearsal checks data and old queries without changing the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-test-'));
  onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir,'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec("create table items(id integer primary key, value text not null) strict; insert into items values (1,'kept')");
  db.close();
  const original = readFileSync(path);
  const report = await rehearse(path,'alter table items add column note text', {
    queries: {old:'select id, value from items where id = :id'},
    assertions: {preserved:"select count(*) = 1 and min(value) = 'kept' from items"},
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.before, {items:1});
  assert.deepEqual(report.after, {items:1});
  assert.deepEqual(report.queries, ['old']);
  assert.deepEqual(report.assertions, ['preserved']);
  assert.deepEqual(readFileSync(path), original);
  for (const [sql, checks, code] of [
    ['alter table items drop column value', {queries:{old:'select id, value from items'}}, 'SCHEMA_SHAPE_CHANGED'],
    ['delete from items', {assertions:{retained:'select count(*) = 1 from items'}}, 'ASSERTION_FAILED'],
    ["insert into items values (2, null)", {}, 'MIGRATION_FAILED'],
    [`attach database '${path.replaceAll("'", "''")}' as source; delete from source.items`, {}, 'MIGRATION_FAILED'],
    ['commit', {}, 'MIGRATION_FAILED'],
  ] as const) {
    const failed = await rehearse(path,sql,checks);
    assert.equal(failed.ok,false);
    assert.equal(failed.diagnostics[0]!.code,code,JSON.stringify(failed));
    assert.deepEqual(readFileSync(path),original);
  }
});

test('rehearsal snapshots committed WAL data and rejects broken foreign keys', async () => {
  const events: { phase: string; event: string; ms?: number }[] = [];
  const observe = (message: unknown) => events.push(message as typeof events[number]);
  subscribe('solarsql.rehearse', observe);
  onTestFinished(() => { unsubscribe('solarsql.rehearse', observe); });
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-wal-'));
  const path = join(dir,'source.sqlite');
  const db = new DatabaseSync(path);
  // Windows refuses to remove a directory holding an open SQLite handle, so
  // the close hook must run before the rmSync hook; Vitest runs
  // onTestFinished hooks in registration order, so close is registered first.
  onTestFinished(() => db.close());
  onTestFinished(() => rmSync(dir, {recursive:true,force:true,maxRetries:5}));
  db.exec('pragma journal_mode = wal; create table parents(id integer primary key); create table children(p integer references parents(id)); insert into parents values (1); insert into children values (1)');
  db.exec("create table identities(value text); insert into identities(rowid,value) values (42,'kept')");
  const report = await rehearse(path,'alter table children add column note text', {
    assertions: { identity: "select count(*) = 1 and min(rowid) = 42 and min(value) = 'kept' from identities" },
  });
  assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.before,{children:1,identities:1,parents:1});
  assert.deepEqual(events.filter(e => e.event === 'start').map(e => e.phase), ['open-source','backup','close-source','open-copy','validate','close-copy','cleanup']);
  assert.deepEqual(events.filter(e => e.event === 'end').map(e => e.phase), events.filter(e => e.event === 'start').map(e => e.phase));
  assert.ok(events.filter(e => e.event === 'end').every(e => Number.isFinite(e.ms) && e.ms! >= 0));
  const failed = await rehearse(path,'pragma defer_foreign_keys = on; delete from parents');
  assert.equal(failed.ok,false);
  assert.equal(db.prepare('select count(*) as n from parents').get()!.n,1);
});

test('rehearsal snapshots a one-row database quickly, plain and WAL', async () => {
  for (const mode of ['plain', 'wal'] as const) {
    const events: { phase: string; event: string; ms?: number }[] = [];
    const observe = (message: unknown) => events.push(message as typeof events[number]);
    subscribe('solarsql.rehearse', observe);
    onTestFinished(() => { unsubscribe('solarsql.rehearse', observe); });
    const dir = mkdtempSync(join(tmpdir(), `solarsql-rehearsal-speed-${mode}-`));
    onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
    const path = join(dir,'source.sqlite');
    const db = new DatabaseSync(path);
    if (mode === 'wal') db.exec('pragma journal_mode = wal');
    db.exec("create table items(id integer primary key, value text not null); insert into items values (1,'kept')");
    db.close();
    const report = await rehearse(path,'alter table items add column note text', {});
    assert.equal(report.ok,true,JSON.stringify(report));
    const backupMs = events.find(e => e.phase === 'backup' && e.event === 'end')?.ms;
    assert.ok(backupMs !== undefined && backupMs < 2000, `${mode} backup phase took ${backupMs} ms`);
  }
});

test('rehearsal preserves implicit row identities across the snapshot step, plain and WAL (ADR 0063/0068)', async () => {
  // vacuum into (ADR 0121) rewrites the file; SQLite's own VACUUM docs warn
  // rowids of a table with no INTEGER PRIMARY KEY "may" change, so this
  // checks a table with a gap-and-reorder-prone rowid sequence, not just one
  // row, plus an AUTOINCREMENT table's sqlite_sequence counter.
  for (const mode of ['plain', 'wal'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `solarsql-rehearsal-rowid-${mode}-`));
    onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
    const path = join(dir,'source.sqlite');
    const db = new DatabaseSync(path);
    if (mode === 'wal') db.exec('pragma journal_mode = wal');
    db.exec('create table t(value text)');
    db.exec("insert into t(rowid,value) values (1,'a'),(5,'b'),(42,'c')");
    db.exec('create table seq_check(id integer primary key autoincrement, v text)');
    db.exec("insert into seq_check(v) values ('x'),('y')");
    db.exec('delete from seq_check where id = 1');
    db.close();
    const report = await rehearse(path,'select 1', {
      assertions: {
        rowidsPreserved: "select group_concat(rowid) = '1,5,42' from t",
        sequencePreserved: "select seq = 2 from sqlite_sequence where name = 'seq_check'",
      },
    });
    assert.equal(report.ok,true,JSON.stringify(report));
    assert.deepEqual(report.assertions,['rowidsPreserved','sequencePreserved']);
  }
});
