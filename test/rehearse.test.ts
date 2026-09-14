// Responsibility: verify migration rehearsal against populated snapshots.
// Boundary: deployment ordering and arbitrary data meaning remain caller checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rehearse, rehearseSnapshot } from '../src/build/rehearse.ts';
import { diff, introspect, open } from '../src/build/migration.ts';

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
    ['alter table items drop column value', {queries:{old:'select id, value from items'}}, 'QUERY_COMPATIBILITY_FAILED'],
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

test('a nullable column transition preserves arbitrary stored values', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const n = tc.draw(gs.integers());
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table values_test(n integer) strict');
      db.prepare('insert into values_test values (?)').run(n);
      const result = rehearseSnapshot(db, 'alter table values_test add column extra text', {assertions:{retained:`select n = ${n} from values_test`}});
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(db.prepare('select n from values_test').get()!.n,n);
    } finally { db.close(); }
  });
});

test('rehearsal counts include legal sqlite-prefixed tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table sqliteCache(id integer primary key autoincrement); insert into sqliteCache values(42)");
    const result = rehearseSnapshot(db,'insert into sqliteCache values(43)');
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(result.before,{sqliteCache:1});
    assert.deepEqual(result.after,{sqliteCache:2});
  } finally {db.close();}
});

test('a case executes a representative old query with named params before and after the migration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table payloads(id integer primary key, payload text not null) strict; insert into payloads values (1, '{\"id\":1}')");
    const result = rehearseSnapshot(db, "update payloads set payload = json_set(payload, '$.id', :id)", {
      cases: { reader: { sql: "select json_extract(payload, '$.id') as id from payloads where id = :id", params: { ':id': 1 } } },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['reader']);
  } finally { db.close(); }
});

// checks.queries only compares result columns, so a migration that keeps the
// same column shape but breaks stored JSON passes it. A case executes the
// query and catches this, the gap ADR 0057 names as a compilation-time limit.
test('a case catches a migration that keeps the result shape but breaks stored JSON, where checks.queries would not', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table payloads(id integer primary key, payload text not null) strict; insert into payloads values(1, '{\"id\":1}')");
    const asQuery = rehearseSnapshot(db, "update payloads set payload = 'not-json'", {
      queries: { reader: "select json_extract(payload, '$.id') as id from payloads" },
    });
    assert.equal(asQuery.ok, true, JSON.stringify(asQuery));
  } finally { db.close(); }
  const db2 = new DatabaseSync(':memory:');
  try {
    db2.exec("create table payloads(id integer primary key, payload text not null) strict; insert into payloads values(1, '{\"id\":1}')");
    const asCase = rehearseSnapshot(db2, "update payloads set payload = 'not-json'", {
      cases: { reader: { sql: "select json_extract(payload, '$.id') as id from payloads", params: {} } },
    });
    assert.equal(asCase.ok, false);
    assert.equal(asCase.diagnostics[0]!.code, 'CASE_COMPATIBILITY_FAILED', JSON.stringify(asCase));
  } finally { db2.close(); }
});

// checks.cases has only ever run against hand-written SQL above. A case must
// also fail this way against a real generated migration, one built by
// diff()/render() from an actual column rename.
test('a case naming a pre-rename column fails after a generated column rename', () => {
  const scratchCurrent = open(['create table items (id integer primary key, name text not null) strict']);
  const scratchTarget = open(['create table items (id integer primary key, full_name text not null) strict']);
  let plan;
  try {
    plan = diff(introspect(scratchCurrent), introspect(scratchTarget), [{ table: 'items', from: 'name', to: 'full_name' }]);
  } finally {
    scratchCurrent.close();
    scratchTarget.close();
  }
  assert.equal(plan.kind, 'ok', JSON.stringify(plan));
  if (plan.kind !== 'ok') return;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table items (id integer primary key, name text not null) strict; insert into items values (1, 'alice')");
    const result = rehearseSnapshot(db, plan.statements.join(';\n'), {
      cases: { byName: { sql: 'select name from items where id = :id', params: { ':id': 1 } } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CASE_COMPATIBILITY_FAILED', JSON.stringify(result));
  } finally {
    db.close();
  }
});

test('a case rejects a bare parameter name used with more than one prefix in the same SQL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { mixed: { sql: 'select :x as a, $x as b', params: { ':x': 1, '$x': 2 } } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(result));
    assert.match(result.diagnostics[0]!.message, /more than one prefix/);
  } finally { db.close(); }
});

test('a case requires params keyed by the full prefixed name, not the bare name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const missing = rehearseSnapshot(db, 'select 1', {
      cases: { badkey: { sql: 'select :id as id', params: { id: 1 } } },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(missing));
    assert.match(missing.diagnostics[0]!.message, /missing parameter: :id/);
    const extra = rehearseSnapshot(db, 'select 1', {
      cases: { toomany: { sql: 'select :id as id', params: { ':id': 1, id: 2 } } },
    });
    assert.equal(extra.ok, false);
    assert.equal(extra.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(extra));
    assert.match(extra.diagnostics[0]!.message, /unexpected parameter: id/);
  } finally { db.close(); }
});

test('a case binds an array or object parameter as JSON text, readable with json_ functions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: {
        nested: {
          sql: "select json_array_length(:arr) as n, json_extract(:obj, '$.k') as k",
          params: { ':arr': [1, 2, 3], ':obj': { k: 'v' } },
        },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['nested']);
  } finally { db.close(); }
});

test('a case binds a boolean nested inside an array or object, only rejecting one at the top level', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: {
        flags: {
          sql: "select json_array_length(:flags) as n, json_extract(:obj, '$.active') as active",
          params: { ':flags': [true, false], ':obj': { active: true } },
        },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['flags']);
  } finally { db.close(); }
});

test('a case is rejected when the migration changes its result columns or breaks its execution', () => {
  for (const [sql, message] of [
    ['alter table t drop column note', 'Result columns changed for case reader'],
    ['alter table t rename to t2', 'no such table: t'],
  ] as const) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key, note text)');
      const result = rehearseSnapshot(db, sql, {
        cases: { reader: { sql: 'select * from t where id = :id', params: { ':id': 1 } } },
      });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'CASE_COMPATIBILITY_FAILED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, message);
    } finally { db.close(); }
  }
});

test('checks.cases rejects malformed case definitions', () => {
  const malformed: [Record<string, unknown>, RegExp][] = [
    [{ sql: 'select ? as id', params: {} }, /anonymous parameter/],
    [{ sql: 'select :id as id', params: { ':id': 1n } }, /BigInt/],
    [{ sql: 'select :id as id', params: { ':id': new Uint8Array([1, 2]) } }, /BLOB/],
    [{ sql: 'select :id as id', params: { ':id': Number.NaN } }, /finite number/],
    [{ sql: 'select :id as id', params: { ':id': Number.POSITIVE_INFINITY } }, /finite number/],
    [{ sql: 'select :id as id', params: { ':id': true } }, /boolean/],
    [{ sql: 'update t set a = 1', params: {} }, /SELECT or VALUES/],
    [{ sql: 'select 1', params: {}, note: 'oops' }, /unknown field/],
  ];
  for (const [kase, message] of malformed) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', { cases: { probe: kase } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(result));
      assert.match(result.diagnostics[0]!.message, message);
    } finally { db.close(); }
  }
});

test('an assertion rejects a named or anonymous parameter, instead of silently binding it to NULL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const named = rehearseSnapshot(db, 'select 1', {
      assertions: { noOrphans: 'select count(*) = 0 as ok from sqlite_master where name = :missing' },
    });
    assert.equal(named.ok, false);
    assert.equal(named.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(named));
    assert.match(named.diagnostics[0]!.message, /assertion "noOrphans" takes no parameters, but uses :missing/);

    const anonymous = rehearseSnapshot(db, 'select 1', {
      assertions: { bad: 'select count(*) = 0 as ok from sqlite_master where name = ?' },
    });
    assert.equal(anonymous.ok, false);
    assert.equal(anonymous.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(anonymous));
    assert.match(anonymous.diagnostics[0]!.message, /assertion "bad" takes no parameters, but uses \?/);
  } finally { db.close(); }
});

test('an assertion that ignored its own named parameter no longer reports a false ok for a real violation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table users (id integer primary key) strict');
    db.exec('create table orders (id integer primary key, user_id integer not null) strict');
    db.exec('insert into users (id) values (1)');
    db.exec('insert into orders (id, user_id) values (1, 1), (2, 2), (3, 3)'); // 2 and 3 reference a nonexistent user
    const result = rehearseSnapshot(db, 'select 1', {
      assertions: { noOrphans: 'select count(*) = 0 as ok from orders o where o.user_id = :uid and not exists (select 1 from users u where u.id = o.user_id)' },
    });
    // Before the fix this reported ok: true (the unbound :uid made the
    // WHERE clause vacuous). Now it is rejected before the check ever runs.
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(result));
  } finally { db.close(); }
});

test('checks.queries keeps accepting a named parameter, since it is only ever compared by column shape', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items (id integer primary key, value text not null) strict');
    db.exec("insert into items values (1, 'kept')");
    const result = rehearseSnapshot(db, 'select 1', {
      queries: { oldRead: 'select id, value from items where id = :id' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.queries, ['oldRead']);
  } finally { db.close(); }
});

test('a case round-trips an array parameter through JSON text for any JSON-safe element', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const values = tc.draw(gs.arrays(gs.integers()));
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', {
        cases: { roundtrip: { sql: 'select json_array_length(:values) as n', params: { ':values': values } } },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(db.prepare('select json_array_length(?) as n').get(JSON.stringify(values))!.n, values.length);
    } finally { db.close(); }
  });
});
