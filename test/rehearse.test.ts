// Responsibility: verify migration rehearsal against populated snapshots.
// Boundary: deployment ordering and arbitrary data meaning remain caller
// checks. The two tests that exercise rehearse() itself, through an
// on-disk source database and its backup phase, live in
// test/slow/rehearse-file.test.ts; every test here calls rehearseSnapshot()
// against an in-memory database instead.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    // The migration SQL's own :id sits unbound (db.exec runs it as raw text,
    // not through a parameter binding), so json_set writes null there and
    // genuinely rewrites the row; declare it, the same as any other update.
    const result = rehearseSnapshot(db, "update payloads set payload = json_set(payload, '$.id', :id)", {
      cases: { reader: { sql: "select json_extract(payload, '$.id') as id from payloads where id = :id", params: { ':id': 1 } } },
      expected: { updated: [{ table: 'payloads' }] },
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
      expected: { updated: [{ table: 'payloads' }] },
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

test('checks itself must be a plain, non-array object', () => {
  const message = 'Checks must be an object with queries, assertions, and/or cases';
  for (const bad of [null, 5, 'x', []] as unknown[]) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', bad as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message }], JSON.stringify(bad));
    } finally { db.close(); }
  }
});

test('an unknown checks field name is rejected, not silently ignored', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { assertion: { kept: 'select 1' } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'Unknown checks field assertion; use queries, assertions, cases, or expected' }]);
  } finally { db.close(); }
});

test('checks.queries must be an object of names and SQL strings', () => {
  const bad: unknown[] = [null, 5, 'select 1', ['select 1'], { a: 5 }, { a: 'select 1', b: 5 }];
  for (const queries of bad) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', { queries } as unknown as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false, JSON.stringify(queries));
      assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'queries must be an object of names and SQL strings' }], JSON.stringify(queries));
    } finally { db.close(); }
  }
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { queries: {} });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { db.close(); }
});

test('a case parameter accepts null, at the top level and nested inside an array', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: {
        probe: {
          sql: 'select :top as top, json_array_length(:nested) as n',
          params: { ':top': null, ':nested': [null, 1] },
        },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['probe']);
  } finally { db.close(); }
});

test('a case parameter array is validated element by element, and reports the failing element\'s own index', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select json_array_length(:p) as n', params: { ':p': [1, Number.POSITIVE_INFINITY] } } },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" parameter :p[1] must be a finite number' }]);
  } finally { db.close(); }
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

test('an assertion using more than one bound parameter lists them all, comma-separated', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { assertions: { probe: 'select :x, :y' } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'assertion "probe" takes no parameters, but uses :x, :y; bind real values with a case instead' }]);
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
    [{ expected: { deleted: 'oops' } }, /expected\.deleted must be an array/],
    [{ expected: { updated: [{ table: 'x', column: 'y' }] } }, /unknown field/],
    [{ expected: { deleted: [{}] } }, /needs a table string/],
    [{ expected: null }, /expected must be an object with dropped, retyped, deleted, and\/or updated/],
    [{ expected: 'oops' }, /expected must be an object with dropped, retyped, deleted, and\/or updated/],
    [{ expected: [] }, /expected must be an object with dropped, retyped, deleted, and\/or updated/],
    [{ expected: { dropped: [null] } }, /expected\.dropped entries must be objects with table and column/],
    [{ expected: { dropped: ['oops'] } }, /expected\.dropped entries must be objects with table and column/],
    [{ expected: { dropped: [[]] } }, /expected\.dropped entries must be objects with table and column/],
    [{ expected: { deleted: [null] } }, /expected\.deleted entries must be objects with table$/],
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

test('an unexpected field on an expected entry is reported by name, and pluralizes when there is more than one', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const one = rehearseSnapshot(db, 'select 1', { expected: { dropped: [{ table: 'x', extra: 1 }] } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(one.ok, false);
    assert.deepEqual(one.diagnostics, [{ code: 'CHECKS_INVALID', message: 'expected.dropped entry has unknown field: extra' }]);
    const two = rehearseSnapshot(db, 'select 1', { expected: { dropped: [{ table: 'x', extra: 1, other: 2 }] } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(two.ok, false);
    assert.deepEqual(two.diagnostics, [{ code: 'CHECKS_INVALID', message: 'expected.dropped entry has unknown fields: extra, other' }]);
  } finally { db.close(); }
});

test('expected.dropped rejects a non-string column with the field\'s own message', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { expected: { dropped: [{ table: 't', column: 5 }] } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'expected.dropped entry\'s column must be a string' }]);
  } finally { db.close(); }
});

// The dropped-only column check keys off the entry's own kind
// (expected.dropped), not merely "a column field is readable": an
// expected.deleted entry allows no column field at all, but Object.keys
// skips an inherited property, so a non-string value reachable only
// through the entry's own prototype must still pass.
test('an expected.deleted entry with an inherited non-string column still passes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a')");
    const entry = Object.create({ column: 5 }) as { table: string };
    entry.table = 'customers';
    const result = rehearseSnapshot(db, 'delete from customers where id = 1', { expected: { deleted: [entry] } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, true, JSON.stringify(result));
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

// ADR 0139: rehearsal reports rows inserted, updated, and deleted per
// table, by primary key, against a before-copy taken with the working
// connection's own VACUUM INTO.
test('rows reports 0/0/0 for a leaf rebuild that changes no data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a'),(2,'b'),(3,'c')");
    const result = rehearseSnapshot(db, 'alter table customers add column note text');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { customers: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports updated for a value rewrite that keeps the same rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a'),(2,'B')");
    const result = rehearseSnapshot(db, 'update customers set name = upper(name)', { expected: { updated: [{ table: 'customers' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { customers: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
  } finally { db.close(); }
});

test('rows reports deleted for a lost row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a'),(2,'b'),(3,'c')");
    const result = rehearseSnapshot(db, "delete from customers where id = 3", { expected: { deleted: [{ table: 'customers' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { customers: { compared: true, inserted: 0, deleted: 1, updated: 0 } });
  } finally { db.close(); }
});

test('rows compares over the columns a rebuild kept, without throwing on a dropped column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, keep text, drop_me text) strict; insert into t values (1,'k','d')");
    const rebuild = 'create table t_new(id integer primary key, keep text) strict; insert into t_new select id, keep from t; drop table t; alter table t_new rename to t;';
    const result = rehearseSnapshot(db, rebuild, { expected: { dropped: [{ table: 't', column: 'drop_me' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports updated for a note column moving to and from NULL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, note text); insert into t values (1,null),(2,'kept'),(3,null)");
    const result = rehearseSnapshot(db, "update t set note = 'filled' where note is null", { expected: { updated: [{ table: 't' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 2 } });
  } finally { db.close(); }
});

test('rows skips a table with no primary key, and every table of an FTS5 virtual table', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(a integer, b text); insert into t values (1,'x')");
      const result = rehearseSnapshot(db, "insert into t values (2,'y')");
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { t: { compared: false, reason: 'no primary key, or a changed primary key' } });
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create virtual table docs using fts5(body); insert into docs(body) values ('hello')");
      const result = rehearseSnapshot(db, "insert into docs(body) values ('world')");
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, {});
    } finally { db.close(); }
  }
});

test('rows reports a changed primary key as not compared', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, name text) strict; insert into t values (1,'a')");
    const rebuild = 'create table t_new(id integer, name text, primary key (id, name)) strict; insert into t_new select id, name from t; drop table t; alter table t_new rename to t;';
    const result = rehearseSnapshot(db, rebuild);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'no primary key, or a changed primary key' } });
  } finally { db.close(); }
});

// ADR 0139: a rowid table stores NULL in a non-INTEGER primary-key column;
// `=` never matches NULL to NULL, so a no-op rehearsal used to report an
// untouched NULL-keyed row as both inserted and deleted.
test('rows reports compared:false for a no-op rehearsal on a table with two NULL-keyed rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),(null,2),('a',3)");
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'more than one row shares the same primary key containing NULL, so rows cannot be matched one to one' } });
  } finally { db.close(); }
});

test('rows reports 0/0/0 for a no-op rehearsal on a table with one NULL-keyed row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),('a',2)");
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports deleted when a NULL-keyed row is actually removed, if it is the only NULL-keyed row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),('a',2)");
    const result = rehearseSnapshot(db, 'delete from t where k is null', { expected: { deleted: [{ table: 't' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 1, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports updated when a NULL-keyed row is rewritten, if it is the only NULL-keyed row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),('a',2)");
    const result = rehearseSnapshot(db, 'update t set v = 9 where k is null', { expected: { updated: [{ table: 't' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
  } finally { db.close(); }
});

test('rows reports 0/0/0 for a no-op rehearsal on a composite primary key with a partial NULL column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(a text, b integer not null, v int, primary key (a, b)); insert into t values (null,1,10),(null,2,20),(\'x\',1,30)');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports compared:false for a composite primary key where two rows share the same NULL-inclusive tuple', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(a text, b integer not null, v int, primary key (a, b)); insert into t values (null,1,10),(null,1,20)');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'more than one row shares the same primary key containing NULL, so rows cannot be matched one to one' } });
  } finally { db.close(); }
});

test('rows reports compared:false when only the before-copy has a duplicate NULL-keyed pair, even after one is deleted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),(null,2),('a',3)");
    const result = rehearseSnapshot(db, 'delete from t where k is null and v = 1', { expected: { deleted: [{ table: 't' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'more than one row shares the same primary key containing NULL, so rows cannot be matched one to one' } });
  } finally { db.close(); }
});

test('rows reports compared:false when only the after-copy has a duplicate NULL-keyed pair, newly inserted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(k text primary key, v int); insert into t values (null,1),('a',2)");
    const result = rehearseSnapshot(db, 'insert into t values (null,5)');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'more than one row shares the same primary key containing NULL, so rows cannot be matched one to one' } });
  } finally { db.close(); }
});

test('rows reports updated for upper() on a COLLATE NOCASE column and for a retyped storage class', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, name text collate nocase) strict; insert into t values (1,'abc'),(2,'def')");
      const result = rehearseSnapshot(db, "update t set name = upper(name) where id = 1", { expected: { updated: [{ table: 't' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table items(id integer primary key, qty integer) strict; insert into items values (1,5),(2,7)");
      const rebuild = 'create table "_new_items"(id integer primary key, qty text) strict; insert into "_new_items" select id, qty from items; drop table items; alter table "_new_items" rename to items';
      // expected.retyped alone accounts for the retyped column's own
      // storage-class change in every kept row, with no separate
      // expected.updated entry (ADR 0139): a retype declaration already
      // predicts that column's own values will differ.
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 'items', column: 'qty' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { items: { compared: true, inserted: 0, deleted: 0, updated: 2 } });
    } finally { db.close(); }
  }
});

// ADR 0139 (2026-09-27): a rehearsal fails by default when a compared
// table's own row diff shows a deleted or an updated row, unless
// checks.json declares it under expected.deleted or expected.updated.
test('a rehearsal fails when a compared table loses or rewrites rows without a declaration', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a'),(2,'b')");
      const result = rehearseSnapshot(db, 'delete from customers where id = 2');
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: deleted customers (1)');
      assert.equal(db.prepare('select count(*) as n from customers').get()!.n, 2);
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a')");
      const result = rehearseSnapshot(db, "update customers set name = 'A'");
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated customers (1)');
    } finally { db.close(); }
  }
});

// An uncompared table (no usable primary key here) cannot report a count,
// but a shrinking row count is still evidence of a loss; a same-size or
// growing uncompared table is not flagged (ADR 0139: a delete-and-insert
// pair could still hide inside it, but only a per-row comparison this table
// cannot do would catch that).
test('a rehearsal fails when an uncompared table has fewer rows after than before, unless declared', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(k text primary key, v int); insert into t values (null,1),(null,2),('a',3)");
      const result = rehearseSnapshot(db, 'delete from t where k is null and v = 1');
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: deleted t (before 3, after 2)');
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(k text primary key, v int); insert into t values (null,1),(null,2),('a',3)");
      const result = rehearseSnapshot(db, 'delete from t where k is null and v = 1', { expected: { deleted: [{ table: 't' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally { db.close(); }
  }
});

// expected.retyped names one column; it excuses only that column's own
// contribution to updated, and never a deleted row, even on the same table.
test('expected.retyped excuses that column\'s own updated rows, but not a deleted row or a different column\'s update, on the same table', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, n integer) strict; insert into t values (1,1),(2,2)");
      // The rebuild both retypes n (declared) and drops id 2's row (not
      // declared): the retype excuses id 1's own updated row, but the lost
      // row still needs its own expected.deleted entry.
      const rebuild = 'create table "_new_t"(id integer primary key, n text) strict; insert into "_new_t" select id, n from t where id = 1; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'n' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: deleted t (1)');
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, n integer, note text) strict; insert into t values (1,1,'kept')");
      // The rebuild retypes n (declared) and also rewrites note (not
      // declared) for the same row: the retype excuses n's own change, but
      // note's own change still needs its own expected.updated entry.
      const rebuild = "create table \"_new_t\"(id integer primary key, n text, note text) strict; insert into \"_new_t\" select id, n, 'changed' from t; drop table t; alter table \"_new_t\" rename to t";
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'n' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated t (1)');
    } finally { db.close(); }
  }
});

// Owner amendment, 2026-09-27: expected.retyped excuses a retyped column's
// own updated rows only when SQLite's own comparison affinity says the
// value itself is unchanged; a genuine value change on that same column
// still needs expected.updated, the same as any other column.
test('expected.retyped does not excuse a retyped column whose own value actually changed', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q integer) strict; insert into t values (1,5)");
      const rebuild = 'create table "_new_t"(id integer primary key, q text) strict; insert into "_new_t" select id, null from t; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated t (1)');
    } finally { db.close(); }
  }
  {
    // A lossy cast (1.5 truncated to 1) counts the same as a wipe to NULL.
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q real) strict; insert into t values (1,1.5)");
      const rebuild = 'create table "_new_t"(id integer primary key, q integer) strict; insert into "_new_t" select id, cast(q as integer) from t; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated t (1)');
    } finally { db.close(); }
  }
  {
    // Naming the table under expected.updated too accepts the wipe.
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q integer) strict; insert into t values (1,5)");
      const rebuild = 'create table "_new_t"(id integer primary key, q text) strict; insert into "_new_t" select id, null from t; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }], updated: [{ table: 't' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
    } finally { db.close(); }
  }
});

// Second review round, 2026-09-27: the relaxed predicate's plain `IS NOT`
// used to run under the after column's own declared collation, so a rebuild
// that also declares NOCASE or RTRIM on the retyped column let a genuine
// rewrite escape as "value-preserving". `COLLATE BINARY` on the relaxed
// predicate closes this: it governs only the collating sequence for a text
// comparison, not SQLite's own comparison affinity conversion between a
// TEXT-affinity value and a NUMERIC-affinity value, so a value-preserving
// retype (same number, different affinity) still passes.
test('expected.retyped does not excuse a genuine rewrite hidden by a NOCASE collation on the retyped column', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q varchar); insert into t values (1,'abc')");
      const rebuild = "create table \"_new_t\"(id integer primary key, q text collate nocase); insert into \"_new_t\" select id, upper(q) from t; drop table t; alter table \"_new_t\" rename to t";
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated t (1)');
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q integer) strict; insert into t values (1,5)");
      const rebuild = 'create table "_new_t"(id integer primary key, q text collate nocase) strict; insert into "_new_t" select id, q from t; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
    } finally { db.close(); }
  }
});

test('expected.retyped does not excuse a genuine rewrite hidden by an RTRIM collation on the retyped column', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q varchar); insert into t values (1,'abc')");
      const rebuild = "create table \"_new_t\"(id integer primary key, q text collate rtrim); insert into \"_new_t\" select id, q || '   ' from t; drop table t; alter table \"_new_t\" rename to t";
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: updated t (1)');
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table t(id integer primary key, q integer) strict; insert into t values (1,5)");
      const rebuild = 'create table "_new_t"(id integer primary key, q text collate rtrim) strict; insert into "_new_t" select id, q from t; drop table t; alter table "_new_t" rename to t';
      const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 't', column: 'q' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
    } finally { db.close(); }
  }
});

// schemaShapeFindings keys a retyped finding by the before-side column name
// (it iterates beforeColumns); the row-change exemption above now matches
// the same way, so a rebuild that also changes a retyped column's case
// (Qty -> qty) still passes here after SCHEMA_SHAPE_CHANGED already passed.
test('expected.retyped matches a retyped column by its before-side name, even when the rebuild also changes its case', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table items(id integer primary key, Qty integer) strict; insert into items values (1,5),(2,7)");
    const rebuild = 'create table "_new_items"(id integer primary key, qty text) strict; insert into "_new_items" select id, Qty from items; drop table items; alter table "_new_items" rename to items';
    const result = rehearseSnapshot(db, rebuild, { expected: { retyped: [{ table: 'items', column: 'Qty' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { items: { compared: true, inserted: 0, deleted: 0, updated: 2 } });
  } finally { db.close(); }
});

test('a declared expected.deleted or expected.updated table with no matching loss is a stale entry', () => {
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a')");
      const result = rehearseSnapshot(db, 'select 1', { expected: { deleted: [{ table: 'customers' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: expected deleted customers did not happen');
    } finally { db.close(); }
  }
  {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a')");
      const result = rehearseSnapshot(db, 'select 1', { expected: { updated: [{ table: 'customers' }] } });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
      assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: expected updated customers did not happen');
    } finally { db.close(); }
  }
});

test('two unexpected row changes on different tables appear together in one message', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table a(id integer primary key, v text) strict; create table b(id integer primary key, v text) strict; insert into a values (1,'x'); insert into b values (1,'y')");
    const result = rehearseSnapshot(db, "delete from a where id = 1; update b set v = 'z'");
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'ROWS_LOST_OR_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Rows lost or changed unexpectedly: deleted a (1), updated b (1)');
  } finally { db.close(); }
});

test('proposed SQL cannot use ATTACH or DETACH, including while the row diff\'s own attachment exists', () => {
  const attempts = ["attach database ':memory:' as x", 'detach main'];
  for (const attempt of attempts) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key) strict');
      const result = rehearseSnapshot(db, attempt);
      assert.equal(result.ok, false, attempt);
      assert.match(result.diagnostics[0]!.message, /not authorized/);
    } finally { db.close(); }
  }
});

test('the row diff leaves no file behind, on success or on a migration failure', () => {
  // A private TMPDIR, read by tmpdir() on each call: the shared one can hold
  // another run's leftovers (an interrupted test, a mutation run) or a
  // parallel test's live directory, and neither is this test's to judge.
  const saved = process.env.TMPDIR;
  const own = mkdtempSync(join(tmpdir(), 'solarsql-rehearse-tmpdir-'));
  process.env.TMPDIR = own;
  try {
    for (const sql of ['alter table t add column note text', 'insert into t values (1)']) {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec('create table t(id integer primary key) strict; insert into t values (2)');
        rehearseSnapshot(db, sql);
      } finally { db.close(); }
    }
    assert.deepEqual(readdirSync(own), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(own, { recursive: true, force: true });
  }
});

test('a Hegel property: a no-op rebuild always reports 0/0/0 for every random row set', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const rows = tc.draw(gs.arrays(gs.tuples(gs.integers({ minValue: 1, maxValue: 1000 }), gs.text({ maxSize: 20 })), { minSize: 0, maxSize: 20 }));
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key, v text) strict');
      const insert = db.prepare('insert or ignore into t values (:id, :v)');
      for (const [id, v] of rows) insert.run({ id, v });
      const result = rehearseSnapshot(db, 'alter table t add column note text');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows.t, { compared: true, inserted: 0, deleted: 0, updated: 0 });
    } finally { db.close(); }
  });
});
