// Responsibility: verify migration rehearsal against populated snapshots.
// Boundary: deployment ordering and arbitrary data meaning remain caller
// checks. The two tests that exercise rehearse() itself, through an
// on-disk source database and its backup phase, live in
// test/slow/rehearse-file.test.ts; every test here calls rehearseSnapshot()
// against an in-memory database instead.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rehearseSnapshot } from '../src/build/rehearse.ts';
import { diff, introspect, open } from '../src/build/migration.ts';
import { quoteIdent } from '../src/build/scan.ts';

const cleanupFault = vi.hoisted(() => ({ failDiffCleanup: false, failedPath: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      if (cleanupFault.failDiffCleanup && path.includes('solarsql-rehearse-diff-')) {
        cleanupFault.failedPath = path;
        throw new Error('cleanup boom');
      }
      return actual.rmSync(...args);
    },
  };
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

test('a pre-existing CHECK constraint violation fails the baseline, before any proposed SQL runs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key, a integer check(a > 0))');
    // ignore_check_constraints lets this insert bypass the CHECK it violates,
    // the same way a value written before solarsql managed the schema, or by
    // a tool that skips constraints, could reach the database.
    db.exec('pragma ignore_check_constraints = on');
    db.exec('insert into t values (1, -1)');
    db.exec('pragma ignore_check_constraints = off');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'BASELINE_FAILED', message: 'SQLite integrity_check failed' }]);
  } finally { db.close(); }
});

test('a pre-existing foreign key violation fails the baseline, before any proposed SQL runs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // foreign_keys off (SQLite's own default) lets this insert reach an
    // orphaned row, the same way a database written before FK enforcement
    // was turned on could carry one in.
    db.exec('pragma foreign_keys = off');
    db.exec('create table parents(id integer primary key)');
    db.exec('create table children(p integer references parents(id))');
    db.exec('insert into children values (99)');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'BASELINE_FAILED', message: 'SQLite foreign_key_check failed' }]);
  } finally { db.close(); }
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
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "mixed" uses one parameter name with more than one prefix: :x, $x' }]);
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

test('a case parameter explicitly set to undefined is reported as missing, not bound as an unsupported value', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select :id as id', params: { ':id': undefined } } },
    } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" is missing parameter: :id' }]);
  } finally { db.close(); }
});

test('a case lists more than one missing or unexpected parameter together, pluralized', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const missing = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select :a as a, :b as b', params: {} } },
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" is missing parameters: :a, :b' }]);
    const extra = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select :a as a', params: { ':a': 1, x: 2, y: 3 } } },
    });
    assert.equal(extra.ok, false);
    assert.deepEqual(extra.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" has unexpected parameters: x, y' }]);
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

test('a case parameter nested inside an object is validated key by key, reporting the failing key\'s own path', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select json_extract(:o, \'$.k\') as v', params: { ':o': { k: Number.POSITIVE_INFINITY } } } },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" parameter :o.k must be a finite number' }]);
  } finally { db.close(); }
});

test('a case parameter of an unsupported type nested inside an array is rejected, not silently accepted as an object', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select json_array_length(:p) as n', params: { ':p': [() => 1] } } },
    } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" parameter :p[0] has an unsupported value type' }]);
  } finally { db.close(); }
});

test('a case binds a plain scalar parameter as itself, including null, not JSON-encoded like an array or object', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', {
      cases: {
        probe: {
          sql: "select json_extract('{\"a\":1}', :path) as v, json_extract('{\"a\":1}', :none) as w",
          params: { ':path': '$.a', ':none': null },
        },
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['probe']);
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

test('checks.cases itself must be a plain, non-array object', () => {
  const message = 'cases must be an object of names and case definitions';
  for (const bad of [null, 5, 'x', []] as unknown[]) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', { cases: bad } as unknown as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message }], JSON.stringify(bad));
    } finally { db.close(); }
  }
});

test('a case entry itself must be a plain, non-array object', () => {
  const message = 'case "probe" must be an object with sql and params';
  for (const bad of [null, 5, 'x', []] as unknown[]) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', { cases: { probe: bad } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message }], JSON.stringify(bad));
    } finally { db.close(); }
  }
});

test('a case entry with no sql field is rejected with the field\'s own message', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { cases: { probe: { params: {} } } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe".sql must be a string' }]);
  } finally { db.close(); }
});

test('a case entry\'s params must be a plain, non-array object', () => {
  const message = 'case "probe".params must be an object';
  for (const bad of [null, 5, 'x', []] as unknown[]) {
    const db = new DatabaseSync(':memory:');
    try {
      const result = rehearseSnapshot(db, 'select 1', { cases: { probe: { sql: 'select 1', params: bad } } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message }], JSON.stringify(bad));
    } finally { db.close(); }
  }
});

test('a case entry with exactly one unknown field reports it singular, not pluralized', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { cases: { probe: { sql: 'select 1', params: {}, a: 1 } } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" has unknown field: a' }]);
  } finally { db.close(); }
});

test('a case entry with more than one unknown field lists them together, pluralized', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { cases: { probe: { sql: 'select 1', params: {}, a: 1, b: 2 } } } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'CHECKS_INVALID', message: 'case "probe" has unknown fields: a, b' }]);
  } finally { db.close(); }
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

// A dropped column and a same-keyed expected.retyped declaration must not
// cancel each other out: only a genuine retype may excuse a retyped
// declaration, so a caller that pre-authorized a retype for a column the
// migration actually dropped still owes a review of that drop.
test('a stale expected.retyped entry is reported even when the same column was actually dropped', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, note text) strict');
    const result = rehearseSnapshot(db, 'alter table items drop column note', {
      expected: { dropped: [{ table: 'items', column: 'note' }], retyped: [{ table: 'items', column: 'note' }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: expected retyped items.note did not happen');
  } finally { db.close(); }
});

// The reverse of the test above: a genuine retype must not excuse a
// same-keyed expected.dropped declaration that never actually happened.
test('a stale expected.dropped entry is reported even when the same column was actually retyped', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table items(id integer primary key, qty integer) strict');
    const rebuild = 'create table "_new_items"(id integer primary key, qty text) strict; insert into "_new_items" select id, qty from items; drop table items; alter table "_new_items" rename to items';
    const result = rehearseSnapshot(db, rebuild, {
      expected: { retyped: [{ table: 'items', column: 'qty' }], dropped: [{ table: 'items', column: 'qty' }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'SCHEMA_SHAPE_CHANGED', JSON.stringify(result));
    assert.equal(result.diagnostics[0]!.message, 'Schema shape changed unexpectedly: expected dropped items.qty did not happen');
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
function binaryKeyItems(rows: readonly (readonly [string, string])[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('create table items(id text primary key collate binary, value text)');
  const insert = db.prepare('insert into items values (?, ?)');
  for (const [key, value] of rows) insert.run(key, value);
  return db;
}

function primaryKeyCollationRebuild(collation: 'binary' | 'nocase' | 'rtrim'): string {
  return `create table next_items(id text primary key collate ${collation}, value text);
    insert or replace into next_items select id, value from items;
    drop table items;
    alter table next_items rename to items`;
}

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

test('rows reports a deletion when a NOCASE primary-key rebuild merges two rows', () => {
  const db = binaryKeyItems([['A', 'same'], ['a', 'same']]);
  try {
    const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: 1, updated: 0 });
    assert.equal(result.diagnostics[0]?.code, 'ROWS_LOST_OR_CHANGED');
    assert.equal(result.diagnostics[0]?.message, 'Rows lost or changed unexpectedly: deleted items (1)');
  } finally { db.close(); }
});

test('an ambiguous before-row match fails without hiding an unmatched deletion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, v text); insert into t values (1,'a'),(2,'b')");
    const result = rehearseSnapshot(db, `
      create table n(id text primary key, v text);
      insert into n select cast(id as text), v from t where id = 1;
      insert into n values ('1.0','a');
      drop table t;
      alter table n rename to t
    `, { expected: { retyped: [{ table: 't', column: 'id' }], deleted: [{ table: 't' }] } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.t, { compared: true, inserted: 0, deleted: 1, updated: 0 });
    assert.equal(result.diagnostics[0]?.code, 'ROW_DIFF_FAILED');
    assert.equal(result.diagnostics[0]?.message, 'Primary-key row diff for t is unreliable: 1 before row matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one');
  } finally { db.close(); }
});

test('one before row matching two after rows fails the row diff', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, v text); insert into t values (1,'a')");
    const result = rehearseSnapshot(db, `
      create table n(id text primary key, v text);
      insert into n select cast(id as text), v from t;
      insert into n values ('1.0','a');
      drop table t;
      alter table n rename to t
    `, { expected: { retyped: [{ table: 't', column: 'id' }], deleted: [{ table: 't' }] } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.t, { compared: true, inserted: 0, deleted: 0, updated: 0 });
    assert.equal(result.diagnostics[0]?.code, 'ROW_DIFF_FAILED');
    assert.equal(result.diagnostics[0]?.message, 'Primary-key row diff for t is unreliable: 1 before row matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one');
  } finally { db.close(); }
});

test('opposite primary-key fan-ins do not cancel each other', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id numeric primary key, v text); insert into t values (1,'x'),('A','x'),('a','x')");
    const result = rehearseSnapshot(db, `
      create table n(id text primary key collate nocase, v text);
      insert into n values ('1','x'),('1.0','x'),('a','x');
      drop table t;
      alter table n rename to t
    `, { expected: { retyped: [{ table: 't', column: 'id' }] } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.t, { compared: true, inserted: 0, deleted: 1, updated: 0 });
    assert.equal(result.diagnostics[0]?.code, 'ROW_DIFF_FAILED');
    assert.equal(result.diagnostics[0]?.message, 'Primary-key row diff for t is unreliable: 1 before row matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one');
  } finally { db.close(); }
});

test('the unreliable row diff counts each before row that matches two or more after rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, v text); insert into t values (1,'x'),(2,'y')");
    const result = rehearseSnapshot(db, `
      create table n(id text primary key, v text);
      insert into n values ('1','x'),('1.0','x'),('2','y'),('2.0','y');
      drop table t;
      alter table n rename to t
    `, { expected: { retyped: [{ table: 't', column: 'id' }] } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, 'ROW_DIFF_FAILED');
    assert.equal(result.diagnostics[0]?.message, 'Primary-key row diff for t is unreliable: 2 before rows matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one');
  } finally { db.close(); }
});

test('the unreliable row diff names every table whose before rows match two or more after rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table s(id integer primary key, v text); insert into s values (1,'x'); create table t(id integer primary key, v text); insert into t values (1,'x')");
    const result = rehearseSnapshot(db, `
      create table ns(id text primary key, v text);
      insert into ns values ('1','x'),('1.0','x');
      drop table s;
      alter table ns rename to s;
      create table nt(id text primary key, v text);
      insert into nt values ('1','x'),('1.0','x');
      drop table t;
      alter table nt rename to t
    `, { expected: { retyped: [{ table: 's', column: 'id' }, { table: 't', column: 'id' }] } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, 'ROW_DIFF_FAILED');
    assert.equal(result.diagnostics[0]?.message, 'Primary-key row diff for s is unreliable: 1 before row matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one; Primary-key row diff for t is unreliable: 1 before row matched two or more after rows; primary-key affinity or collation differences made the join non-one-to-one');
  } finally { db.close(); }
});

test('rows reports two deletions when three primary keys merge into one', () => {
  const db = binaryKeyItems([['AA', 'same'], ['Aa', 'same'], ['aa', 'same']]);
  try {
    const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: 2, updated: 0 });
    assert.equal(result.diagnostics[0]?.code, 'ROWS_LOST_OR_CHANGED');
    assert.equal(result.diagnostics[0]?.message, 'Rows lost or changed unexpectedly: deleted items (2)');
  } finally { db.close(); }
});

test('a merged row stays unchanged when one before row has its values', () => {
  const db = binaryKeyItems([['A', 'lost'], ['a', 'kept']]);
  try {
    const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'), { expected: { deleted: [{ table: 'items' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: 1, updated: 0 });
  } finally { db.close(); }
});

test('NOCASE primary-key merges report one deletion for each extra before row', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 8 }));
    const variants = ['aaa', 'Aaa', 'aAa', 'AAa', 'aaA', 'AaA', 'aAA', 'AAA'].slice(0, count);
    const db = binaryKeyItems(variants.map(key => [key, 'same'] as const));
    try {
      const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'), { expected: { deleted: [{ table: 'items' }] } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: count - 1, updated: 0 });
    } finally { db.close(); }
  });
});

test('expected.deleted accepts rows merged by a NOCASE primary-key rebuild', () => {
  const db = binaryKeyItems([['A', 'same'], ['a', 'same']]);
  try {
    const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'), { expected: { deleted: [{ table: 'items' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: 1, updated: 0 });
  } finally { db.close(); }
});

test('an inserted row counts only as inserted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table customers(id integer primary key, name text) strict; insert into customers values (1,'a')");
    const result = rehearseSnapshot(db, "insert into customers values (2,'b')");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { customers: { compared: true, inserted: 1, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows stays compared with no changes when a NOCASE primary-key rebuild merges no rows', () => {
  const db = binaryKeyItems([['A', 'same'], ['b', 'same']]);
  try {
    const result = rehearseSnapshot(db, primaryKeyCollationRebuild('nocase'));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows.items, { compared: true, inserted: 0, deleted: 0, updated: 0 });
  } finally { db.close(); }
});

test('successful primary-key affinity rebuilds reconcile nonnegative row differences', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const beforeAffinity = tc.draw(gs.sampledFrom(['integer', 'text'] as const));
    const afterAffinity = tc.draw(gs.sampledFrom(['integer', 'text'] as const));
    const baseKey = tc.draw(gs.integers({ minValue: Number.MIN_SAFE_INTEGER + 1, maxValue: Number.MAX_SAFE_INTEGER - 1 }));
    const secondKey = afterAffinity === 'text'
      ? tc.draw(gs.sampledFrom([String(baseKey + 1), `${baseKey}.0`]))
      : String(baseKey + 1);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`create table items(id ${beforeAffinity} primary key, value text); insert into items values (${baseKey}, 'same')`);
      const checks = beforeAffinity === afterAffinity
        ? {}
        : { expected: { retyped: [{ table: 'items', column: 'id' }] } };
      const result = rehearseSnapshot(db, `
        create table next_items(id ${afterAffinity} primary key, value text);
        insert into next_items select cast(id as ${afterAffinity}), value from items;
        insert into next_items values ('${secondKey}', 'same');
        drop table items;
        alter table next_items rename to items
      `, checks);
      if (!result.ok) return;
      for (const [table, rowDiff] of Object.entries(result.rows)) {
        if (!rowDiff.compared) continue;
        assert.ok(rowDiff.deleted >= 0, table);
        assert.equal(result.after[table]! - result.before[table]!, rowDiff.inserted - rowDiff.deleted, table);
      }
    } finally { db.close(); }
  });
});

test('rows attributes a deletion to table Ä without attributing it to table ä', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table "Ä"(id integer primary key); create table "ä"(id integer primary key); insert into "Ä" values (1),(2); insert into "ä" values (1)');
    const result = rehearseSnapshot(db, 'delete from "Ä" where id = 2');
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, {
      'Ä': { compared: true, inserted: 0, deleted: 1, updated: 0 },
      'ä': { compared: true, inserted: 0, deleted: 0, updated: 0 },
    });
    assert.equal(result.diagnostics[0]?.message, 'Rows lost or changed unexpectedly: deleted Ä (1)');
  } finally { db.close(); }
});

test('rows attributes a deletion to table ä without attributing it to table Ä', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table "Ä"(id integer primary key); create table "ä"(id integer primary key); insert into "Ä" values (1),(2); insert into "ä" values (1)');
    const result = rehearseSnapshot(db, 'delete from "ä" where id = 1');
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, {
      'Ä': { compared: true, inserted: 0, deleted: 0, updated: 0 },
      'ä': { compared: true, inserted: 0, deleted: 1, updated: 0 },
    });
    assert.equal(result.diagnostics[0]?.message, 'Rows lost or changed unexpectedly: deleted ä (1)');
  } finally { db.close(); }
});

test('schema shape reports column Ä as dropped while column ä remains', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key, "Ä" text, "ä" text)');
    const result = rehearseSnapshot(db, 'alter table t drop column "Ä"');
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.message, 'Schema shape changed unexpectedly: dropped t.Ä');
    assert.deepEqual(result.columns.after.t!.map(column => column.name), ['id', 'ä']);
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

// mkdtempSync appends its own random suffix directly to the string it is
// given, with no separator of its own; join(tmpdir(), '') returns tmpdir()
// with no trailing separator, so a bare tmpdir() here would make the six
// random characters a *sibling* of tmpdir() (inside tmpdir()'s own parent),
// not a child of it. TMPDIR=/tmp exercises this on the real filesystem: '/'
// is not writable by an ordinary user, so a diffDir built from a bare '/tmp'
// (no trailing slash) would fail to create, where one built from
// '/tmp/solarsql-rehearse-diff-' succeeds.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "a rehearsal succeeds when only tmpdir() itself, not its parent, is writable",
  () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp';
    try {
      const db = new DatabaseSync(':memory:');
      try {
        const result = rehearseSnapshot(db, 'select 1');
        assert.equal(result.ok, true, JSON.stringify(result));
      } finally { db.close(); }
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
  },
);

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

test('a checks-validation failure before any table is inspected still reports empty column snapshots', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'select 1', { bogus: {} } as unknown as Parameters<typeof rehearseSnapshot>[2]);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CHECKS_INVALID');
    assert.deepEqual(result.columns, { before: {}, after: {} });
  } finally { db.close(); }
});

test('a caller-open transaction on db fails the before-copy step, before any authorizer is installed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict; begin');
    const result = rehearseSnapshot(db, 'select 1');
    assert.deepEqual(result.diagnostics, [{ code: 'BEFORE_COPY_FAILED', message: 'cannot VACUUM from within a transaction' }]);
    assert.equal(result.ok, false);
  } finally { db.close(); }
});

test('a migration is refused for pragma writable_schema, temp_store_directory, or data_store_directory', () => {
  for (const name of ['writable_schema', 'temp_store_directory', 'data_store_directory']) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key) strict');
      const result = rehearseSnapshot(db, `pragma ${name} = 1`);
      assert.equal(result.ok, false, name);
      assert.equal(result.diagnostics[0]!.code, 'MIGRATION_FAILED', name);
      assert.match(result.diagnostics[0]!.message, /not authorized/, name);
    } finally { db.close(); }
  }
});

// The three denied pragma names, read as plain identifiers, also name a
// table CREATE TABLE could declare; only the PRAGMA action on that exact
// name is refused, not every action whose own argument happens to match it.
test('a table may be named after a denied pragma name; only the pragma action itself is refused', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'create table writable_schema(id integer primary key)');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.after, { writable_schema: 0 });
  } finally { db.close(); }
});

test('an insert used as a checks.queries entry is refused at the baseline, not silently accepted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'select 1', { queries: { bad: 'insert into t values (1)' } });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'BASELINE_FAILED');
    assert.match(result.diagnostics[0]!.message, /SELECT or VALUES/);
  } finally { db.close(); }
});

test('checks.queries is read again at the compatibility stage, and an insert there is refused there too', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    let reads = 0;
    // The first two reads (validateChecks, then the baseline loop) return a
    // plain SELECT so the baseline stage passes; only the third read, at
    // the compatibility loop, returns an insert.
    const checks = {
      get queries() {
        reads++;
        return { q: reads <= 2 ? 'select id from t' : 'insert into t values (1)' };
      },
    } as unknown as Parameters<typeof rehearseSnapshot>[2];
    const result = rehearseSnapshot(db, 'select 1', checks);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'QUERY_COMPATIBILITY_FAILED');
    assert.match(result.diagnostics[0]!.message, /SELECT or VALUES/);
    assert.equal(reads, 3);
  } finally { db.close(); }
});

test('a query is refused at the compatibility stage when its own result column type changes, even for a declared retype', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(x integer); insert into t values (1)');
    const result = rehearseSnapshot(
      db,
      'create table t_new(x text); insert into t_new select x from t; drop table t; alter table t_new rename to t;',
      { queries: { old: 'select x from t' }, expected: { retyped: [{ table: 't', column: 'x' }] } },
    );
    assert.deepEqual(result.diagnostics, [{ code: 'QUERY_COMPATIBILITY_FAILED', message: 'Result columns changed for query old' }]);
    assert.equal(result.ok, false);
  } finally { db.close(); }
});

test('a case that only fails when it actually executes is caught at the baseline, not just at prepare time', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'select 1', {
      cases: { probe: { sql: 'select value from json_each(:j)', params: { ':j': 'not json' } } },
    });
    assert.deepEqual(result.diagnostics, [{ code: 'CASE_BASELINE_FAILED', message: 'malformed JSON' }]);
    assert.equal(result.ok, false);
  } finally { db.close(); }
});

test('checks.cases is read again at the baseline stage, and an insert there is refused there too', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    let reads = 0;
    // The first read (validateChecks, through validateCases) returns a
    // plain SELECT so validation passes; the second read, at the baseline
    // loop, returns an insert.
    const checks = {
      get cases() {
        reads++;
        return { probe: { sql: reads === 1 ? 'select 1 as v' : 'insert into t values (1)', params: {} } };
      },
    } as unknown as Parameters<typeof rehearseSnapshot>[2];
    const result = rehearseSnapshot(db, 'select 1', checks);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CASE_BASELINE_FAILED');
    assert.match(result.diagnostics[0]!.message, /SELECT or VALUES/);
    assert.equal(reads, 2);
  } finally { db.close(); }
});

test('checks.cases is read a third time at the compatibility stage, and an insert there is refused there too', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let reads = 0;
    const checks = {
      get cases() {
        reads++;
        return { probe: { sql: reads <= 2 ? 'select 1 as v' : 'insert into t values (1)', params: {} } };
      },
    } as unknown as Parameters<typeof rehearseSnapshot>[2];
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'select 1', checks);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'CASE_COMPATIBILITY_FAILED');
    assert.match(result.diagnostics[0]!.message, /SELECT or VALUES/);
    assert.equal(reads, 3);
  } finally { db.close(); }
});

// A bare :id and a bare $id share the bare name "id"; node:sqlite's own
// bare-name binding mode rejects that as an ambiguous bind target even when
// every bound key already carries its own full, distinct prefix (measured).
// setAllowBareNamedParameters(false) is what keeps a case like this out of
// that mode, at both the baseline and the compatibility stage.
test('a case sql with two differently-prefixed slots for the same bare name still binds, at the baseline stage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let reads = 0;
    const checks = {
      get cases() {
        reads++;
        return { probe: reads === 1 ? { sql: 'select 1 as v', params: {} } : { sql: 'select 1 as v where :id = $id', params: { ':id': 1, '$id': 1 } } };
      },
    } as unknown as Parameters<typeof rehearseSnapshot>[2];
    const result = rehearseSnapshot(db, 'select 1', checks);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['probe']);
    assert.equal(reads, 3);
  } finally { db.close(); }
});

test('a case sql with two differently-prefixed slots for the same bare name still binds, at the compatibility stage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let reads = 0;
    const checks = {
      get cases() {
        reads++;
        return { probe: reads <= 2 ? { sql: 'select 1 as v', params: {} } : { sql: 'select 1 as v where :id = $id', params: { ':id': 1, '$id': 1 } } };
      },
    } as unknown as Parameters<typeof rehearseSnapshot>[2];
    const result = rehearseSnapshot(db, 'select 1', checks);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.cases, ['probe']);
    assert.equal(reads, 3);
  } finally { db.close(); }
});

test('every transaction-control statement is refused before rehearsal opens its own transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    for (const verb of ['begin', 'commit', 'end', 'rollback', 'savepoint', 'release']) {
      const result = rehearseSnapshot(db, verb);
      assert.deepEqual(result.diagnostics, [{ code: 'MIGRATION_FAILED', message: 'Rehearsal owns the transaction; remove transaction control statements' }], verb);
      assert.equal(result.ok, false, verb);
    }
  } finally { db.close(); }
});

// stripComments joins a segment's remaining tokens with no separator, so a
// block comment sitting directly between two hyphens ("-/**/-") leaves
// "--" behind; re-tokenized on its own, that text opens a line comment, so
// the segment carries no significant token at all.
test('a statement that becomes a line comment only once its own block comment is stripped is a no-op, not a crash', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = rehearseSnapshot(db, 'create table t(a);-/**/- hi');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { db.close(); }
});

test('a deferred foreign-key violation left by the migration fails before commit', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('pragma foreign_keys = on; create table parents(id integer primary key); create table children(p integer references parents(id) deferrable initially deferred)');
    const result = rehearseSnapshot(db, 'pragma defer_foreign_keys = on; insert into children values (99)');
    assert.deepEqual(result.diagnostics, [{ code: 'MIGRATION_FAILED', message: 'SQLite foreign_key_check failed' }]);
    assert.equal(result.ok, false);
  } finally { db.close(); }
});

test('an assertion is refused when it returns zero rows, or one row with more than one column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    for (const [sql, reason] of [['select 1 where 0', 'zero rows'], ['select 1, 2', 'two columns']] as const) {
      const result = rehearseSnapshot(db, 'select 1', { assertions: { probe: sql } });
      assert.deepEqual(result.diagnostics, [{ code: 'ASSERTION_FAILED', message: 'Assertion probe must return one row and one value equal to 1' }], reason);
      assert.equal(result.ok, false, reason);
    }
  } finally { db.close(); }
});

test('an insert used as an assertion is refused, the same as an insert used as a query or a case', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'select 1', { assertions: { bad: 'insert into t values (1)' } });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0]!.message, /SELECT or VALUES/);
  } finally { db.close(); }
});

test('a caller-attached schema already using the row diff\'s own reserved name fails the row diff step', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    // solarsql_rehearse_before mirrors rehearse.ts's own BEFORE_SCHEMA
    // constant; nothing here reads that constant directly.
    db.exec("attach database ':memory:' as solarsql_rehearse_before");
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]!.code, 'ROW_DIFF_FAILED');
    assert.match(result.diagnostics[0]!.message, /solarsql_rehearse_before/);
  } finally { db.close(); }
});

test('rows omits a table replaced by a same-named FTS5 virtual table, rather than diffing it as a changed primary key', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table docs(id integer primary key) strict; insert into docs values (1)");
    const rebuild = 'drop table docs; create virtual table docs using fts5(body);';
    const result = rehearseSnapshot(db, rebuild, { expected: { dropped: [{ table: 'docs', column: 'id' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, {});
  } finally { db.close(); }
});

test('rows omits a table that was an FTS5 virtual table before the migration, even once rebuilt as an ordinary table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create virtual table docs using fts5(body); insert into docs(body) values ('hello')");
    const rebuild = 'drop table docs; create table docs(id integer primary key) strict;';
    // FTS5's own shadow tables (docs_data, docs_idx, docs_docsize,
    // docs_content, docs_config) disappear along with the virtual table
    // itself, so each is its own whole-table drop, not just docs' column.
    const result = rehearseSnapshot(db, rebuild, {
      expected: {
        dropped: [
          { table: 'docs', column: 'body' },
          { table: 'docs_data' },
          { table: 'docs_idx' },
          { table: 'docs_docsize' },
          { table: 'docs_content' },
          { table: 'docs_config' },
        ],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, {});
  } finally { db.close(); }
});

test('rows omits a table the migration created, rather than diffing it against nothing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, "create table added(id integer primary key) strict; insert into added values (1)");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('rows reports a composite primary key narrowed to one column as not compared, even though that column still matches by name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(a integer, b integer, name text, primary key(a,b)) strict; insert into t values (1,1,'x'),(2,2,'y')");
    const rebuild = 'create table t_new(a integer primary key, b integer, name text) strict; insert into t_new select a, b, name from t; drop table t; alter table t_new rename to t;';
    const result = rehearseSnapshot(db, rebuild);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'no primary key, or a changed primary key' } });
  } finally { db.close(); }
});

test('rows reports a renamed primary key as not compared, not a missing-match crash', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, name text) strict; insert into t values (1,'a')");
    const rebuild = 'create table t_new(pk integer primary key, name text) strict; insert into t_new select id, name from t; drop table t; alter table t_new rename to t;';
    const result = rehearseSnapshot(db, rebuild, { expected: { dropped: [{ table: 't', column: 'id' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: false, reason: 'no primary key, or a changed primary key' } });
  } finally { db.close(); }
});

test('rows excludes the primary key column from its own value comparison, so a NOCASE case change there does not count as updated', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id text primary key collate nocase, v integer) strict; insert into t values ('abc', 1)");
    const result = rehearseSnapshot(db, "update t set id = upper(id)");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { t: { compared: true, inserted: 0, deleted: 0, updated: 0 } });
  } finally { db.close(); }
});

test('a TMPDIR containing a single quote is escaped correctly in the row diff\'s own ATTACH', () => {
  const saved = process.env.TMPDIR;
  const own = mkdtempSync(join(tmpdir(), "solarsql-rehearse-quote'-"));
  process.env.TMPDIR = own;
  try {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('create table t(id integer primary key) strict');
      const result = rehearseSnapshot(db, 'select 1');
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally { db.close(); }
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(own, { recursive: true, force: true });
  }
});

// The row-diff authorizer denies only a PRAGMA action on one of these three
// names; a table sharing one of those names is still read normally, since a
// table read is a different action.
test('a table named after a denied pragma name still has its rows diffed, not authorization-denied', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table writable_schema(id integer primary key, v text) strict; insert into writable_schema values (1, 'a')");
    const result = rehearseSnapshot(db, "update writable_schema set v = 'b' where id = 1", { expected: { updated: [{ table: 'writable_schema' }] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.rows, { writable_schema: { compared: true, inserted: 0, deleted: 0, updated: 1 } });
  } finally { db.close(); }
});

// A generated column's expression runs a registered SQL function during the
// row diff's own SELECT, so a function that issues its own nested statement
// reaches the row-diff authorizer while it is active, not just the ATTACH
// this call issues itself.
test('the row-diff authorizer denies a nested PRAGMA on each of the three reserved names', () => {
  for (const name of ['writable_schema', 'temp_store_directory', 'data_store_directory']) {
    const db = new DatabaseSync(':memory:');
    try {
      // The healthy() integrity check also evaluates this generated column,
      // under the deny-all first authorizer, which denies this PRAGMA too --
      // so a plain call count can't tell that phase apart from the row-diff
      // one this test means to check. A DETACH of the row diff's own schema
      // only reports SQLite's own "is locked" (rather than the authorizer's
      // "not authorized") once that authorizer is the one running, so it
      // marks which phase this particular call belongs to.
      const pragmaResults: string[] = [];
      db.function('probe', { deterministic: true }, () => {
        let pragmaResult: string;
        try { db.exec(`pragma ${name}`); pragmaResult = 'allowed'; }
        catch (e) { pragmaResult = e instanceof Error ? e.message : String(e); }
        let inRowDiff = false;
        try { db.exec('detach solarsql_rehearse_before'); }
        catch (e) { inRowDiff = (e instanceof Error ? e.message : String(e)) === 'database solarsql_rehearse_before is locked'; }
        if (inRowDiff) pragmaResults.push(pragmaResult);
        return 1;
      });
      db.exec('create table t(id integer primary key, v integer, g integer generated always as (probe()) virtual) strict');
      db.exec('insert into t (id, v) values (1, 10)');
      const result = rehearseSnapshot(db, 'insert into t (id, v) values (2, 20)');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(pragmaResults.length > 0, name);
      assert.ok(pragmaResults.every(r => r === 'not authorized'), JSON.stringify({ name, pragmaResults }));
    } finally { db.close(); }
  }
});

test('the row-diff authorizer allows a nested DETACH only for its own reserved schema name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Each call records both outcomes as one pair, so the test can read the
    // last pair. Earlier calls run before any authorizer exists, where a
    // DETACH of "main" gets SQLite's own refusal, or under the first
    // (deny-all) authorizer, where it gets "not authorized" too. Telling the
    // row-diff authorizer apart by that message alone would hide a change
    // scoped to only the row-diff authorizer.
    const pairs: string[] = [];
    db.function('probe', { deterministic: true }, () => {
      let main: string; let before: string;
      try { db.exec('detach main'); main = 'allowed'; }
      catch (e) { main = e instanceof Error ? e.message : String(e); }
      try { db.exec('detach solarsql_rehearse_before'); before = 'allowed'; }
      catch (e) { before = e instanceof Error ? e.message : String(e); }
      pairs.push(`${main} | ${before}`);
      return 1;
    });
    db.exec('create table t(id integer primary key, v integer, g integer generated always as (probe()) virtual) strict');
    db.exec('insert into t (id, v) values (1, 10)');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    // The last pair is the row diff's own read, run under the row-diff
    // authorizer: a DETACH of "main" is refused by the authorizer itself
    // ("not authorized"); a DETACH of the row-diff's own reserved schema
    // clears the authorizer's own denial and instead meets SQLite's refusal
    // to detach a database an active statement is still reading ("database
    // solarsql_rehearse_before is locked"), a message that only a genuine
    // SQLITE_OK from the authorizer produces.
    assert.equal(pairs[pairs.length - 1], 'not authorized | database solarsql_rehearse_before is locked', JSON.stringify(pairs));
  } finally { db.close(); }
});

test('the row-diff authorizer denies a nested ATTACH of anything other than its own before-copy path', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Same marker as the DETACH test above: a nested detach of the row
    // diff's own reserved schema names "is locked" only once that
    // authorizer is the one running, so it isolates the calls this test
    // means to check from the ones that run earlier, under the first
    // (deny-all) authorizer, where a nested ATTACH is denied for a
    // different reason and would otherwise look the same.
    const attachResults: string[] = [];
    db.function('probe', { deterministic: true }, () => {
      let attachResult: string;
      try { db.exec("attach ':memory:' as bogus"); attachResult = 'allowed'; try { db.exec('detach bogus'); } catch { /* best effort cleanup */ } }
      catch (e) { attachResult = e instanceof Error ? e.message : String(e); }
      let inRowDiff = false;
      try { db.exec('detach solarsql_rehearse_before'); }
      catch (e) { inRowDiff = (e instanceof Error ? e.message : String(e)) === 'database solarsql_rehearse_before is locked'; }
      if (inRowDiff) attachResults.push(attachResult);
      return 1;
    });
    db.exec('create table t(id integer primary key, v integer, g integer generated always as (probe()) virtual) strict');
    db.exec('insert into t (id, v) values (1, 10)');
    const result = rehearseSnapshot(db, 'select 1');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(attachResults.length > 0, JSON.stringify(attachResults));
    assert.ok(attachResults.every(r => r === 'not authorized'), JSON.stringify(attachResults));
  } finally { db.close(); }
});

test('rehearseSnapshot returns a result, rather than throwing, when its own temp directory is gone by cleanup time', () => {
  // os.tmpdir() reads TMPDIR on POSIX, but TEMP or TMP on Windows; setting
  // all three keeps mkdtempSync landing under `own` on every platform CI runs.
  const savedVars = ['TMPDIR', 'TEMP', 'TMP'].map(name => [name, process.env[name]] as const);
  const own = mkdtempSync(join(tmpdir(), 'solarsql-rehearse-wipe-'));
  for (const [name] of savedVars) process.env[name] = own;
  try {
    const db = new DatabaseSync(':memory:');
    try {
      // healthy()'s own pragma integrity_check evaluates every generated
      // column while it validates the schema, so this generated column's
      // own function call runs before the migration, once for the baseline
      // and once after the migration; it removes every directory this call
      // has created under `own` so far, so by the time the row diff's own
      // ATTACH runs, its before-copy directory is already gone -- standing
      // in for another process racing this call's own cleanup.
      db.function('wipe', { deterministic: true }, () => {
        for (const name of readdirSync(own)) {
          try { rmSync(join(own, name), { recursive: true, force: true }); } catch { /* already gone */ }
        }
        return 1;
      });
      db.exec('create table t(id integer primary key, v integer, g integer generated always as (wipe()) virtual) strict');
      db.exec('insert into t (id, v) values (1, 10)');
      const result = rehearseSnapshot(db, 'select 1');
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0]!.code, 'ROW_DIFF_FAILED');
      assert.match(result.diagnostics[0]!.message, /^unable to open database: .*before\.sqlite$/);
    } finally { db.close(); }
  } finally {
    for (const [name, value] of savedVars) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(own, { recursive: true, force: true });
  }
});

test('a migration that fails before the row-diff ATTACH leaves exactly one diagnostic, not a masked detach failure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'not valid sql at all');
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'MIGRATION_FAILED', message: 'near "not": syntax error' }]);
  } finally { db.close(); }
});

test('the row-diff schema is detached after a failed rehearsal, so a second call on the same db still succeeds', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("create table t(id integer primary key, v text) strict; insert into t values (1, 'a')");
    const first = rehearseSnapshot(db, "update t set v = 'b' where id = 1");
    assert.equal(first.ok, false);
    assert.deepEqual(first.diagnostics, [{ code: 'ROWS_LOST_OR_CHANGED', message: 'Rows lost or changed unexpectedly: updated t (1)' }]);
    const second = rehearseSnapshot(db, 'select 1');
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.diagnostics, []);
  } finally { db.close(); }
});

// With detachFirst, the real DETACH runs before the error is thrown. The
// before-copy is then no longer open, so the temporary directory removal
// succeeds on every platform. Without it, Windows keeps the attached file
// open and refuses to remove the directory.
function rehearseWithDetachFailure(message: string, { detachFirst = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const originalExec = db.exec.bind(db);
  try {
    db.exec('create table t(id integer primary key) strict');
    (db as unknown as { exec: typeof db.exec }).exec = ((sql: string) => {
      if (sql.startsWith('detach ')) {
        if (detachFirst) originalExec(sql);
        throw new Error(message);
      }
      return originalExec(sql);
    }) as typeof db.exec;
    return rehearseSnapshot(db, 'insert into t values (1)');
  } finally {
    (db as unknown as { exec: typeof db.exec }).exec = originalExec;
    db.close();
  }
}

test('a detach failure other than "no such database" is reported with its own message, after a successful commit', () => {
  const result = rehearseWithDetachFailure('boom', { detachFirst: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.diagnostics, [{ code: 'DETACH_FAILED', message: 'boom' }]);
});

test('a temporary-directory cleanup failure after a detach failure is returned as a second diagnostic', () => {
  cleanupFault.failDiffCleanup = true;
  cleanupFault.failedPath = undefined;
  try {
    const result = rehearseWithDetachFailure('detach boom');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.diagnostics, [
      { code: 'DETACH_FAILED', message: 'detach boom' },
      { code: 'TEMP_CLEANUP_FAILED', message: `Failed to remove temporary directory ${cleanupFault.failedPath}: cleanup boom` },
    ]);
  } finally {
    cleanupFault.failDiffCleanup = false;
    if (cleanupFault.failedPath) rmSync(cleanupFault.failedPath, { recursive: true, force: true });
    cleanupFault.failedPath = undefined;
  }
});

test('a successful rehearsal actually commits the migration to the caller\'s own db, not just to the reported result', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('create table t(id integer primary key) strict');
    const result = rehearseSnapshot(db, 'insert into t values (1)');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(db.prepare('select count(*) as n from t').get()!.n, 1);
  } finally { db.close(); }
});

test('a failed commit reports MIGRATION_FAILED with the commit error, leaving ok false', () => {
  const db = new DatabaseSync(':memory:');
  const originalExec = db.exec.bind(db);
  try {
    db.exec('create table t(id integer primary key) strict');
    (db as unknown as { exec: typeof db.exec }).exec = ((sql: string) => {
      if (sql === 'commit') throw new Error('commit boom');
      return originalExec(sql);
    }) as typeof db.exec;
    const result = rehearseSnapshot(db, 'insert into t values (1)');
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [{ code: 'MIGRATION_FAILED', message: 'commit boom' }]);
  } finally {
    (db as unknown as { exec: typeof db.exec }).exec = originalExec;
    db.close();
  }
});
