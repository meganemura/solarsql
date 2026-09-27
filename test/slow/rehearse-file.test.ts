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
import { test, onTestFinished, vi } from 'vitest';
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
  // the handle must close before the directory goes. One hook does both, in
  // that order: Vitest runs onTestFinished hooks in reverse registration
  // order, so two hooks would remove the directory first.
  onTestFinished(() => { db.close(); rmSync(dir, {recursive:true,force:true,maxRetries:5}); });
  db.exec('pragma journal_mode = wal; create table parents(id integer primary key); create table children(p integer references parents(id)); insert into parents values (1); insert into children values (1)');
  db.exec("create table identities(value text); insert into identities(rowid,value) values (42,'kept')");
  const started = performance.now();
  const report = await rehearse(path,'alter table children add column note text', {
    assertions: { identity: "select count(*) = 1 and min(rowid) = 42 and min(value) = 'kept' from identities" },
  });
  const elapsed = performance.now() - started;
  assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.before,{children:1,identities:1,parents:1});
  assert.deepEqual(events.filter(e => e.event === 'start').map(e => e.phase), ['open-source','backup','close-source','open-copy','validate','close-copy','cleanup']);
  assert.deepEqual(events.filter(e => e.event === 'end').map(e => e.phase), events.filter(e => e.event === 'start').map(e => e.phase));
  // The upper bound (not just >= 0) catches an end event's own elapsed ms
  // being computed as a sum instead of a difference from its start.
  assert.ok(events.filter(e => e.event === 'end').every(e => Number.isFinite(e.ms) && e.ms! >= 0 && e.ms! <= elapsed));
  const failed = await rehearse(path,'pragma defer_foreign_keys = on; delete from parents');
  assert.equal(failed.ok,false);
  assert.equal(db.prepare('select count(*) as n from parents').get()!.n,1);
});

test('a subscriber that joins mid-rehearsal receives no end event for a phase whose start it missed', async () => {
  const events: { phase: string; event: string }[] = [];
  const observe = (message: unknown) => events.push(message as typeof events[number]);
  let joined = false;
  // rehearse() reads checks.queries more than once while phase('validate')
  // is open (validateChecks's own Object.entries(checks) is the first read),
  // so the guard keeps this subscribing only on the first read.
  const checks = {
    get queries() {
      if (!joined) { joined = true; subscribe('solarsql.rehearse', observe); }
      return {};
    },
  } as unknown as Parameters<typeof rehearse>[2];
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-latejoin-'));
  onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir,'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table t(id integer primary key) strict');
  db.close();
  try {
    const report = await rehearse(path,'select 1',checks);
    assert.equal(report.ok,true,JSON.stringify(report));
    // validate's phase() ran while there were no subscribers, so it
    // published no start and set up no end. A subscriber that joins
    // mid-way through validate sees every later phase's start and end,
    // and neither of validate's own events.
    assert.deepEqual(events.map(e => `${e.phase} ${e.event}`), ['close-copy start','close-copy end','cleanup start','cleanup end']);
  } finally {
    if (joined) unsubscribe('solarsql.rehearse', observe);
  }
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

test('opening a missing source database resolves with a diagnostic, not a rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-missing-'));
  onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir, 'does-not-exist.sqlite');
  const report = await rehearse(path, 'select 1');
  assert.equal(report.ok, false);
  assert.equal(report.diagnostics[0]!.code, 'SNAPSHOT_FAILED');
  assert.match(report.diagnostics[0]!.message, /unable to open database file/);
});

// mkdtempSync appends its own random suffix directly to the string it is
// given, with no separator of its own; join(tmpdir(), '') returns tmpdir()
// with no trailing separator, so a bare tmpdir() here would make the six
// random characters a *sibling* of tmpdir() (inside tmpdir()'s own parent),
// not a child of it. TMPDIR=/tmp exercises this on the real filesystem: '/'
// is not writable by an ordinary user, so a snapshot directory built from a
// bare '/tmp' (no trailing slash) would fail to create, where one built
// from '/tmp/solarsql-rehearse-' succeeds.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "a rehearsal's own snapshot directory is created as tmpdir()'s child, not its sibling",
  async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp';
    const dir = mkdtempSync(join('/tmp', 'solarsql-rehearsal-tmpdirchild-'));
    try {
      const path = join(dir, 'source.sqlite');
      const db = new DatabaseSync(path);
      db.exec('create table t(id integer primary key) strict');
      db.close();
      const report = await rehearse(path, 'select 1');
      assert.equal(report.ok, true, JSON.stringify(report));
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('a rehearsal closes the copy it diffed against, not just the read-only source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-closecount-'));
  onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir, 'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table t(id integer primary key) strict');
  db.close();
  const originalClose = DatabaseSync.prototype.close;
  let closes = 0;
  const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    closes++;
    return originalClose.call(this);
  });
  try {
    const report = await rehearse(path, 'select 1');
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(closes, 2, `expected the read-only source and the copy to each close once, saw ${closes} close call(s)`);
  } finally {
    closeSpy.mockRestore();
  }
});

test('a failed backup still closes the read-only source handle it opened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-rehearsal-backupfail-'));
  onTestFinished(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir, 'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table t(id integer primary key) strict');
  db.close();
  const originalPrepare = DatabaseSync.prototype.prepare;
  const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'vacuum into ?') throw new Error('forced backup failure');
    return originalPrepare.call(this, sql);
  });
  const originalClose = DatabaseSync.prototype.close;
  let closes = 0;
  const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    closes++;
    return originalClose.call(this);
  });
  try {
    const report = await rehearse(path, 'select 1');
    // A failure this early never reaches rehearseSnapshot, so the report is
    // exactly rehearse()'s own initial RehearsalResult plus one diagnostic:
    // every other field keeps its declared default.
    assert.deepEqual(report, {
      version: 1, ok: false, sql: 'select 1', before: {}, after: {},
      columns: { before: {}, after: {} }, rows: {}, queries: [], assertions: [], cases: [],
      diagnostics: [{ code: 'SNAPSHOT_FAILED', message: 'forced backup failure' }],
    });
    assert.equal(closes, 1, `expected the read-only source to close even though the backup step failed, saw ${closes} close call(s)`);
  } finally {
    prepareSpy.mockRestore();
    closeSpy.mockRestore();
  }
});
