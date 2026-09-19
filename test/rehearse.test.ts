// Responsibility: verify migration rehearsal against populated snapshots.
// Boundary: deployment ordering and arbitrary data meaning remain caller
// checks. The two tests that exercise rehearse() itself, through an
// on-disk source database and its backup phase, live in
// test/slow/rehearse-file.test.ts; every test here calls rehearseSnapshot()
// against an in-memory database instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rehearseSnapshot } from '../src/build/rehearse.ts';
import { diff, introspect, open } from '../src/build/migration.ts';
import { quoteIdent } from '../src/build/scan.ts';

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

test('a failing assertion leaves the stored value unchanged, not just the reported result', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const n = tc.draw(gs.integers());
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table values_test(n integer) strict');
      db.prepare('insert into values_test values (?)').run(n);
      const result = rehearseSnapshot(db, 'alter table values_test add column extra text', {assertions:{retained:`select n = ${n + 1} from values_test`}});
      assert.equal(result.ok,false);
      assert.equal(result.diagnostics[0]!.code, 'ASSERTION_FAILED', JSON.stringify(result));
      assert.equal(db.prepare('select n from values_test').get()!.n,n);
      // The n-value check above passes even without a rollback, since this
      // migration never touches n; only the added column's absence proves
      // the ALTER TABLE itself was undone.
      assert.equal(db.prepare("select count(*) as n from pragma_table_info('values_test')").get()!.n,1);
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
    assert.equal(db2.prepare('select payload from payloads').get()!.payload, '{"id":1}');
  } finally { db2.close(); }
});

// A failed check must undo the migration, not just report it: commit only
// runs after every check passes, so finally's rollback still has an open
// transaction to undo when a check fails.
test('a compatibility failure leaves the source schema unchanged, not just the reported result', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table items(id integer primary key, value text not null) strict; insert into items values (1,'kept')");
    const result = rehearseSnapshot(db, 'alter table items drop column value', {
      queries: { oldRead: 'select id, value from items' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(db.prepare('select value from items').get()!.value, 'kept');
  } finally { db.close(); }
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
      // A rename shows up as one drop and one add; name it under dropped,
      // the same repair migrations.md documents, to reach the case check.
      expected: { dropped: [{ table: 'items', column: 'name' }] },
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
  for (const [sql, expected, message] of [
    ['alter table t drop column note', { dropped: [{ table: 't', column: 'note' }] }, 'Result columns changed for case reader'],
    ['alter table t rename to t2', { dropped: [{ table: 't' }] }, 'no such table: t'],
  ] as const) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key, note text)');
      const result = rehearseSnapshot(db, sql, {
        expected: { dropped: expected.dropped.map(d => ({ ...d })) },
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

test('a rebuild that drops a column fails with the new stage and names table.column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, note text) strict');
    const result = rehearseSnapshot(db, 'alter table items drop column note');
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: dropped items.note');
  } finally { db.close(); }
});

test('expected.dropped names a lost column, and the report keeps it out of columns.after', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, note text) strict');
    const result = rehearseSnapshot(db, 'alter table items drop column note', {
      expected: { dropped: [{ table: 'items', column: 'note' }] },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.columns.after.items!.map(c => c.name), ['id']);
  } finally { db.close(); }
});

test('a dropped table fails with the new stage and passes when expected names it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table retired(id integer primary key) strict');
    const dropped = rehearseSnapshot(db, 'drop table retired');
    assert.equal(dropped.ok, false);
    assert.equal(dropped.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(dropped));
    assert.equal(dropped.diagnostics[0]!.message, 'Schema shape changed unexpectedly: dropped retired');
  } finally { db.close(); }
  const db2 = new DatabaseSync(':memory:');
  try {
    db2.exec('create table retired(id integer primary key) strict');
    const allowed = rehearseSnapshot(db2, 'drop table retired', { expected: { dropped: [{ table: 'retired' }] } });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.columns.after.retired, undefined);
  } finally { db2.close(); }
});

test('a changed column type fails with the new stage and passes when expected names it as retyped', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, qty integer) strict');
    const rebuild = 'create table "_new_items"(id integer primary key, qty text) strict; insert into "_new_items" select id, qty from items; drop table items; alter table "_new_items" rename to items';
    const result = rehearseSnapshot(db, rebuild);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: retyped items.qty');
  } finally { db.close(); }
  const db2 = new DatabaseSync(':memory:');
  try {
    db2.exec('create table items(id integer primary key, qty integer) strict');
    const rebuild = 'create table "_new_items"(id integer primary key, qty text) strict; insert into "_new_items" select id, qty from items; drop table items; alter table "_new_items" rename to items';
    const result = rehearseSnapshot(db2, rebuild, { expected: { retyped: [{ table: 'items', column: 'qty' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { db2.close(); }
});

test('an expected entry the migration did not perform is a failure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, note text) strict');
    const result = rehearseSnapshot(db, 'select 1', { expected: { dropped: [{ table: 'items', column: 'note' }] } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: expected dropped items.note did not happen');
  } finally { db.close(); }
});

test('two unexpected findings appear together in one message', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, note text) strict; create table retired(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'alter table items drop column note; drop table retired');
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: dropped items.note, dropped retired');
  } finally { db.close(); }
});

test('malformed expected is rejected with a message naming the field', () => {
  const db = new DatabaseSync(':memory:');
  const malformed: [unknown, RegExp][] = [
    [{ expected: { dropped: 'oops' } }, /expected\.dropped must be an array/],
    [{ expected: { dropped: [{ column: 'x' }] } }, /needs a table string/],
    [{ expected: { retyped: [{ table: 'x' }] } }, /needs a column string/],
    [{ expected: { dropped: [{ table: 'x', extra: 1 }] } }, /unknown field/],
    [{ expected: { moved: [] } }, /Unknown expected field/],
  ];
  try {
    for (const [checks, message] of malformed) {
      const result = rehearseSnapshot(db, 'select 1', checks as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'CHECKS_INVALID', JSON.stringify(result));
      assert.match(result.diagnostics[0]!.message, message);
    }
  } finally { db.close(); }
});

// House style: a random set of column names, kept as-is, must round-trip
// through columns.before and columns.after unchanged.
test('a rebuild that keeps every column reports ok and equal before/after column lists', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const names = [...tc.draw(gs.sets(gs.fromRegex('[a-z][a-z0-9_]{0,6}'), { minSize: 1, maxSize: 5 }))].filter(n => n !== 'id');
    const db = new DatabaseSync(':memory:');
    try {
      const columnsSql = names.map(n => `, ${quoteIdent(n)} text`).join('');
      db.exec(`create table cols(id integer primary key${columnsSql}) strict`);
      const result = rehearseSnapshot(db, 'select 1');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.columns.before, result.columns.after);
      assert.deepEqual(result.columns.before.cols!.map(c => c.name).slice(1).sort(), names.slice().sort());
    } finally { db.close(); }
  });
});
