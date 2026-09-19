// Responsibility: verify migration rehearsal against an on-disk source
// database, through rehearse()'s own backup phase.
// Boundary: deployment ordering and arbitrary data meaning remain caller
// checks; rehearseSnapshot's in-process checks (cases, assertions, queries,
// expected findings) live in test/rehearse.test.ts, not here.
// These two tests live apart from the rest of rehearse.test.ts because they
// go through node:sqlite's native on-disk backup, whose lock wait was
// measured at 8-30 seconds per call on macOS (the same backup takes 2 ms in
// a standalone script); every other rehearse() behavior is exercised through
// rehearseSnapshot() against an in-memory database, in milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rehearse } from '../../src/build/rehearse.ts';

test('rehearsal checks data and old queries without changing the source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-test-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
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

test('rehearsal snapshots committed WAL data and rejects broken foreign keys', async t => {
  const events: { phase: string; event: string; ms?: number }[] = [];
  const observe = (message: unknown) => events.push(message as typeof events[number]);
  subscribe('solarsql.rehearse', observe);
  t.after(() => { unsubscribe('solarsql.rehearse', observe); });
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-wal-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir,'source.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
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
