// The example modules on node:sqlite, in-process: the migration files
// apply, and queries, commands, and failures as values behave as they do on
// D1 and on a Durable Object. This is the loop a module's own tests run in.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, MigrationHistoryError, node } from "../src/node.ts";
import { diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";
import { read, type Observed } from "../src/index.ts";
import { migrations } from "../example/migrations/index.ts";
import { customerCommands, type CustomersId } from "../example/modules/customers/public.ts";
import { orderCommands, orderQueries, type OrderLinesId, type OrdersId } from "../example/modules/orders/public.ts";
import { reportQueries } from "../example/modules/reports/public.ts";

describe("the example on node:sqlite", () => {
  const raw = new DatabaseSync(":memory:");
  const events: Observed[] = [];
  const db = node(raw, { observe: (e) => events.push(e) });
  const c1 = "c1" as CustomersId;
  const o1 = "o1" as OrdersId;

  test("the migration files apply once, in name order", () => {
    assert.deepEqual(migrate(raw, migrations), ["0001_initial.sql", "0002_orders_customer_id.sql", "0003_views_and_triggers.sql", "0004_search.sql", "0005_customer_name_not_empty.sql"]);
    assert.deepEqual(migrate(raw, migrations), []);
  });

  test("a command with returns, then a unique failure as a value", async () => {
    assert.deepEqual(await db.run(customerCommands.create, { id: c1, name: "Ann", email: "ann@example.com" }), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }], changes: 1 });
    assert.deepEqual(await db.run(customerCommands.create, { id: "c2" as CustomersId, name: "Bob", email: "ann@example.com" }), { ok: false, kind: "unique", table: "customers", columns: ["email"] });
  });

  test("a plan with JSON rows, a JSON aggregation read back, and an assert that fails on the second run", async () => {
    const lines = [{ id: "l1" as OrderLinesId, sku: "A", qty: 2, price: 1.5 }, { id: "l2" as OrderLinesId, sku: "B", qty: 1, price: 4 }];
    const placed = await db.run(orderCommands.place, { id: o1, customer_id: c1, lines });
    assert.equal(placed.ok, true);
    if (placed.ok) assert.equal(placed.changes, 7);
    assert.deepEqual(await db.first(orderQueries.withLines, { id: o1 }), { id: "o1", status: "draft", lines: [{ id: "l1", sku: "A", qty: 2, price: 1.5 }, { id: "l2", sku: "B", qty: 1, price: 4 }] });
    const confirmed = await db.run(orderCommands.confirm, { id: o1 });
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.changes, 2);
    assert.deepEqual(await db.run(orderCommands.confirm, { id: o1 }), { ok: false, kind: "assert", assert: "was_draft" });
  });

  test("a passing or failing assert leaves no row in the guard table", () => {
    assert.equal(raw.prepare("select count(*) as n from solarsql_assert").get()!.n, 0);
  });

  test("a bulk update from JSON rows, the trigger's stamp, and a report through the view", async () => {
    const repriced = await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "l1" as OrderLinesId, price: 2 }] });
    assert.equal(repriced.ok, true);
    if (repriced.ok) assert.equal(repriced.changes, 1);
    assert.deepEqual(await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "nope" as OrderLinesId, price: 2 }] }), { ok: false, kind: "assert", assert: "all_lines_known" });
    const noted = await db.run(orderCommands.annotate, { id: o1, note: "rush" });
    assert.equal(noted.ok, true);
    if (noted.ok) {
      assert.equal(noted.changes, 8);
      assert.match(noted.rows[0]!.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.deepEqual(await db.all(reportQueries.confirmedOrders), [{ id: "o1", customer_id: "c1", customer_name: "Ann" }]);
    const hits = await db.all(orderQueries.searchNotes, { query: "rush" });
    assert.deepEqual(hits.map((h) => [h.id, h.note]), [["o1", "rush"]]);
    const [orders, lines] = await db.batch([read(orderQueries.byId, { id: o1 }), read(orderQueries.withLines, { id: o1 })]);
    assert.deepEqual(orders.map((o) => o.status), ["confirmed"]);
    assert.deepEqual(lines[0]!.lines.map((l) => l.id), ["l1", "l2"]);
    assert.deepEqual(await db.all(reportQueries.revenueByCustomer), [{ customer_id: "c1", name: "Ann", revenue: 8, orders: 1 }]);
  });

  test("the observe hook saw the calls", () => {
    const outcomes = events.map((e) => `${e.kind} ${e.name} ${e.outcome}`);
    assert.ok(outcomes.includes("command create unique"), outcomes.join("\n"));
    assert.ok(outcomes.includes("command confirm assert:was_draft"));
    assert.ok(outcomes.includes("query withLines ok"));
    assert.ok(events.every((e) => !("meta" in e)), "node:sqlite reports no engine meta");
  });

  test("a repeated clear reports zero after it removes all rows", async () => {
    const first = await db.run(orderCommands.clear);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.changes, 6);
    assert.deepEqual(await db.run(orderCommands.clear), { ok: true, rows: [], changes: 0 });
  });
});

test("SQLite scalar values survive the Node adapter", async () => {
  const { testAsync } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  const raw = new DatabaseSync(':memory:');
  raw.exec('create table values_test(n integer, text_value text, data blob, anything any) strict');
  const db = node(raw);
  try {
    await testAsync(async tc => {
      const n = tc.draw(gs.integers());
      const text = tc.draw(gs.text());
      const bytes = Uint8Array.from(tc.draw(gs.binary()));
      const anything = tc.draw(gs.sampledFrom([null, n, text]));
      raw.exec('delete from values_test');
      raw.prepare('insert into values_test values (?, ?, ?, ?)').run(n, text, bytes, anything);
      const query = { kind: 'query' as const, name: 'values', sql: 'select * from values_test', meta: { params: [], encode: [], json: [], reads: ['values_test'] } };
      assert.deepEqual(await db.all(query), [{ n, text_value: text, data: bytes, anything }]);
    });
  } finally { raw.close(); }
});

test("Node rejects an integer read outside the safe number range", async () => {
  const raw = new DatabaseSync(':memory:');
  try {
    const query = { kind: 'query' as const, name: 'large', sql: 'select 9223372036854775807 as n', meta: { params: [], encode: [], json: [], reads: [] } };
    await assert.rejects(node(raw).all(query), /too large|safely|range/i);
  } finally { raw.close(); }
});

test('migration history rejects changes, gaps, duplicates and insertion before an applied file', () => {
  const raw = new DatabaseSync(':memory:');
  const first = { name: '0002_initial.sql', sql: 'create table saved(value text); insert into saved values (\'retained\')' };
  try {
    migrate(raw, [first]);
    for (const [files, code] of [
      [[{ ...first, sql: first.sql + '; delete from saved' }], 'MIGRATION_CHANGED'],
      [[], 'MISSING_MIGRATION'],
      [[first, first], 'DUPLICATE_MIGRATION'],
      [[{name:'0001_earlier.sql', sql:'delete from saved'}, first], 'MIGRATION_ORDER'],
    ] as const) {
      assert.throws(() => migrate(raw, files), (e: unknown) => (e as {code: string}).code === code
        && (code !== 'DUPLICATE_MIGRATION' || /Duplicate migration: 0002_initial\.sql\. List each migration file once\./.test((e as Error).message)));
      assert.equal(raw.prepare('select value from saved').get()!.value, 'retained');
    }
    const bad = { name:'0003_bad.sql', sql:"delete from saved; insert into absent values (1)" };
    assert.throws(() => migrate(raw, [first, bad]));
    assert.equal(raw.prepare('select value from saved').get()!.value, 'retained');
    assert.equal(raw.prepare('select count(*) as n from solarsql_migrations').get()!.n, 1);
  } finally { raw.close(); }
});

test('legacy migration history requires explicit adoption before new SQL', () => {
  const raw = new DatabaseSync(':memory:');
  const first = { name:'0001_initial.sql', sql:'create table saved(value text)' };
  const second = { name:'0002_value.sql', sql:"insert into saved values ('new')" };
  try {
    raw.exec("create table solarsql_migrations(name text primary key not null, applied_at text not null) strict; insert into solarsql_migrations values ('0001_initial.sql','old'); create table saved(value text)");
    assert.throws(() => migrate(raw, [first, second]), (e: unknown) => (e as {code: string}).code === 'LEGACY_HISTORY');
    assert.equal(raw.prepare('select count(*) as n from saved').get()!.n, 0);
    assert.deepEqual(migrate(raw, [first, second], { adoptLegacyHistory: true }), [second.name]);
    assert.deepEqual(migrate(raw, [first, second]), []);
    assert.equal(raw.prepare('select sql from solarsql_migrations where name = ?').get(first.name)!.sql, first.sql);
  } finally { raw.close(); }
});

test('reapplying migration files preserves their data effects', async () => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const values = tc.draw(gs.arrays(gs.integers()));
    const raw = new DatabaseSync(':memory:');
    const files = [{name:'0001.sql',sql:'create table totals(n integer not null) strict'}, ...values.map((v,i) => ({name:`${String(i+2).padStart(6,'0')}.sql`,sql:`insert into totals values (${v})`}))];
    // Keep the creation first under the runner's lexicographic ordering.
    files[0]!.name = '000001.sql';
    try {
      migrate(raw, files);
      assert.deepEqual(migrate(raw, files), []);
      assert.deepEqual(raw.prepare('select n from totals order by rowid').all().map(r => r.n), values);
    } finally { raw.close(); }
  });
});

test('migration files cannot escape their transaction', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    for (const sql of ['commit', '-- comment\nBEGIN', 'savepoint x', 'end', 'rollback', 'release x']) {
      assert.throws(() => migrate(raw, [{name:'0001.sql',sql}]), (e: unknown) => (e as {code: string}).code === 'MIGRATION_TRANSACTION');
    }
  } finally { raw.close(); }
});

test('migration history uses the same ordering for Unicode names', () => {
  const raw = new DatabaseSync(':memory:');
  const files = [{name:'\uE000.sql',sql:'select 1'}, {name:'\u{10000}.sql',sql:'select 2'}];
  try {
    assert.deepEqual(migrate(raw, files), ['\u{10000}.sql', '\uE000.sql']);
    assert.deepEqual(migrate(raw, files), []);
  } finally { raw.close(); }
});

test('named parameter slots retain SQLite values for every prefix and repeated reference', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {namedSlots}=await import('../src/build/scan.ts');
  const {storageOf}=await import('../src/node.ts');
  property(tc=>{
    const names=tc.draw(gs.arrays(gs.sampledFrom([':id','@id','$id',':$id',':名前',':1','$id::suffix(key)']),{minSize:1,maxSize:20}));
    const sql='select '+names.map((name,i)=>`${name} as c${i}`).join(',');
    const slots=namedSlots(sql);
    const values=slots.map(()=>tc.draw(gs.integers({minValue:-10000,maxValue:10000})));
    const raw=new DatabaseSync(':memory:');
    try {
      const oracle=raw.prepare(sql);oracle.setAllowBareNamedParameters(false);
      const expected=oracle.all(Object.fromEntries(slots.map((slot,i)=>[slot.sqlName,values[i]!]))).map(row=>({...row}));
      assert.equal(new Set(slots.map(slot=>slot.key)).size,slots.length);
      const actual=storageOf(raw).sql.exec(sql,...values).toArray();
      assert.deepEqual(actual,expected);
      assert.deepEqual(Object.values(actual[0]!),names.map(name=>values[slots.findIndex(slot=>slot.sqlName===name)]));
    }finally{raw.close();}
  });
});

test('missing parameters report the exact generated keys', async () => {
  const {bindValues,validateParams}=await import('../src/runtime/plan.ts');
  assert.throws(()=>bindValues({params:[':id','@id'],encode:[],json:[],reads:[]},{}),{message:'missing parameters: ":id", "@id"'});
  assert.throws(()=>bindValues({params:['id'],encode:[],json:[],reads:[]},{}),{message:'missing parameter: "id"'});
  assert.throws(()=>bindValues({params:['id'],encode:[],json:[],reads:[]},Object.create({id:1})),{message:'missing parameter: "id"'});
  assert.doesNotThrow(()=>validateParams([{params:['id'],encode:[],json:[],reads:[]}],{id:null},'query x'));
});

test('operation parameter contracts use own exact keys across statement subsets', async () => {
  const {validateParams}=await import('../src/runtime/plan.ts');
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const name=gs.fromRegex('[:@$]?[a-z][a-z0-9_]{0,6}');
  const subject='query x';
  property(tc=>{
    const expected=[...new Set(tc.draw(gs.arrays(name,{minSize:1,maxSize:8})))];
    const midpoint=Math.ceil(expected.length/2);
    const metas=[expected.slice(0,midpoint),expected.slice(midpoint)].map(params=>({params,encode:[],json:[],reads:[]}));
    const own=expected.filter(()=>tc.draw(gs.booleans()));
    const extras=[...new Set(tc.draw(gs.arrays(name,{maxSize:4})))].filter(key=>!expected.includes(key));
    const params=Object.assign(Object.create(Object.fromEntries(expected.map(key=>[key,99]))),Object.fromEntries([...own,...extras].map(key=>[key,1])));
    const missing=expected.filter(key=>!own.includes(key)).sort();
    const unexpected=[...extras].sort();
    if(missing.length===0&&unexpected.length===0)assert.doesNotThrow(()=>validateParams(metas,params,subject));
    else {
      const parts=[
        ...(missing.length?[`missing parameter${missing.length>1?'s':''}: ${missing.map(key=>JSON.stringify(key)).join(', ')}`]:[]),
        ...(unexpected.length?[`unexpected parameter${unexpected.length>1?'s':''}: ${unexpected.map(key=>JSON.stringify(key)).join(', ')}`]:[]),
      ];
      const declared=[...expected].sort();
      assert.throws(()=>validateParams(metas,params,subject),{message:`${parts.join('; ')} (${subject} declares: ${declared.length?declared.join(', '):'none'})`});
    }
  },{testCases:1000});
});

test('public Node commands share a caller-owned transaction with direct SQL', async () => {
  const raw=new DatabaseSync(':memory:');
  try {
    migrate(raw,migrations);
    const db=node(raw);
    raw.exec('begin');
    raw.exec("insert into customers(id,name,email) values('direct','Direct','direct@example.com')");
    const success=await db.run(customerCommands.create,{id:'typed' as CustomersId,name:'Typed',email:'typed@example.com'});
    assert.equal(success.ok,true);
    const failure=await db.run(customerCommands.create,{id:'duplicate' as CustomersId,name:'Duplicate',email:'direct@example.com'});
    assert.equal(failure.ok,false);
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,2);
    raw.exec('rollback');
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,0);
    raw.exec('begin');
    assert.equal((await db.run(customerCommands.create,{id:'committed' as CustomersId,name:'Committed',email:'commit@example.com'})).ok,true);
    raw.exec('commit');
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,1);
  }finally{raw.close();}
});

test('Node savepoints isolate nested failures and retain outer rollback ownership', async () => {
  const {storageOf}=await import('../src/node.ts');
  const raw=new DatabaseSync(':memory:');
  try {
    raw.exec('create table t(value text)');
    const storage=storageOf(raw);
    const sentinel=new Error('inner failed');
    storage.transactionSync(()=>{
      raw.exec("insert into t values('outer')");
      assert.throws(()=>storage.transactionSync(()=>{raw.exec("insert into t values('inner')");throw sentinel;}),error=>error===sentinel);
      storage.transactionSync(()=>raw.exec("insert into t values('retained')"));
    });
    assert.deepEqual(raw.prepare('select value from t').all().map(r=>r.value),['outer','retained']);
    assert.throws(()=>storage.transactionSync(()=>{storage.transactionSync(()=>raw.exec("insert into t values('rolled back')"));throw sentinel;}),error=>error===sentinel);
    assert.equal(raw.prepare('select count(*) as n from t').get()!.n,2);
    raw.exec('savepoint solarsql_transaction');
    storage.transactionSync(()=>raw.exec("insert into t values('same name')"));
    raw.exec('rollback to solarsql_transaction; release solarsql_transaction');
    assert.equal(raw.prepare('select count(*) as n from t').get()!.n,2);
  }finally{raw.close();}
});

test('Node savepoints retain deferred foreign-key semantics at the outer boundary', async () => {
  const {storageOf}=await import('../src/node.ts');
  const raw=new DatabaseSync(':memory:');
  try {
    raw.exec('pragma foreign_keys=on; create table p(id integer primary key); create table c(id integer references p(id) deferrable initially deferred)');
    const storage=storageOf(raw);
    assert.throws(()=>storage.transactionSync(()=>raw.exec('insert into c values(1)')),/FOREIGN KEY/);
    assert.equal(raw.prepare('select count(*) as n from c').get()!.n,0);
    raw.exec('begin');
    storage.transactionSync(()=>raw.exec('insert into c values(2)'));
    assert.throws(()=>raw.exec('commit'),/FOREIGN KEY/);
    raw.exec('insert into p values(2);commit');
    assert.equal(raw.prepare('select count(*) as n from c').get()!.n,1);
  }finally{raw.close();}
});

// migrate() wraps a file's statements and its solarsql_migrations insert in
// one transactionSync() call (src/durable.ts). A rebuild that violates a
// new NOT NULL throws inside that closure, so storageOf's transactionSync
// (above) rolls back the savepoint before rethrowing: the schema, the row,
// and the history table all land back where the first file left them.
test('a Durable Object rebuild that violates a new NOT NULL rolls back the schema, the row, and the history insert together', () => {
  const before = [`create table orders (id text primary key not null, note text)`];
  const after = [`create table orders (id text primary key not null, note text not null)`];
  // Two plain open()-based schemas, diffed the way build.ts diffs them.
  // introspect()-ing a live, already-migrated database here would pick up
  // its own solarsql_migrations table as a schema object and make diff()
  // report kind: "blocked".
  const initial = diff(introspect(open([])), introspect(open(before)));
  if (initial.kind !== 'ok') throw new Error(initial.reason);
  const f1 = render(1, 'initial', [...initial.statements, "insert into orders values ('a', null)"]);
  const tightened = diff(introspect(open(before)), introspect(open(after)));
  if (tightened.kind !== 'ok') throw new Error(tightened.reason);
  const f2 = render(2, 'not_null', tightened.statements, tightened.rebuilds ?? []);
  const originalSchema = introspect(open(before)).tables.get('orders')!.sql;
  const raw = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migrate(raw, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /NOT NULL constraint failed: orders\.note/);
      return true;
    });
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: f1.filename }]);
    assert.equal((raw.prepare("select sql from sqlite_schema where name = 'orders'").get() as { sql: string }).sql, originalSchema);
    assert.deepEqual(raw.prepare('select * from orders').all().map(r => ({ ...r })), [{ id: 'a', note: null }]);
  } finally { raw.close(); }
});

// A new foreign key defers its check to the end of the transaction
// (pragma defer_foreign_keys, src/build/migration.ts), so an orphaned row
// can pass every statement inside the transactionSync closure and only
// fail at "release savepoint solarsql_transaction", after the closure
// returns but still inside storageOf()'s try block. This test proves that
// migrate()'s own savepoint still rolls back the schema, the row, and the
// history insert together in that case, and leaves no open transaction
// behind, on Node's storageOf() implementation.
//
// A real Durable Object's own transactionSync used to not behave the same
// way for this one shape: measured directly against workerd (Miniflare's
// bundled runtime, the same engine Cloudflare deploys), a deferred foreign
// key added by migrate() was not caught at transactionSync's own RELEASE at
// all. The check instead fired at the request's own implicit commit, after
// migrate() had already returned normally; the caller's own code never saw
// an error, and the platform itself discarded the response and reset the
// object with its own error instead. Every migration file applied in that
// same request rolled back together, not only the violating one. migrate()
// closes that gap itself now: its per-file transactionSync closure runs
// `pragma foreign_key_check` before the history insert and throws a plain
// Error (matching this shim's own /FOREIGN KEY constraint failed/ message,
// asserted below) when it finds a violation, on every runtime, so only that
// file rolls back and the object stays usable (test/migrate-durable-object.
// test.ts covers this against workerd). That check is skipped when the
// caller already owns an outer transaction (StorageLike.inTransaction, only
// Node's storageOf() implements it): "migrate() composes with a
// caller-owned transaction..." below still relies on SQLite's own deferred
// check firing at the caller's own commit, unchanged. An immediate
// (non-deferred) constraint, such as the NOT NULL case above, never showed
// this divergence: it always threw synchronously and rolled back only its
// own file, matching this shim.
//
// pragma foreign_key_check scans every foreign key in the database, not
// only the ones the current file's own statements touch, so a violation
// that predates this file (a row a different table wrote while pragma
// foreign_keys was off, or one left over from before this check existed)
// could otherwise fail the next file that happens to run and blame that
// file for it. migrate() now tells the two cases apart: it keys each
// violated row by (table, parent table, referencing and referenced column
// names, primary-key value, referencing-column value) and compares that key
// across files; the error says the violation predates this file when every
// key named already existed before this file ran. That keying needs a
// single non-INTEGER primary-key column to
// read back; on a table with an INTEGER PRIMARY KEY, a composite key, or
// WITHOUT ROWID, migrate() cannot rule this file out, and blames it still.
//
// Each of these five related tests covers one neighboring part of this:
// - "a Durable Object rebuild that violates a new NOT NULL rolls back the
//   schema, the row, and the history insert together" (above) covers a
//   constraint that throws inside the closure, at the restore-insert
//   statement, rather than at RELEASE.
// - "Node savepoints retain deferred foreign-key semantics at the outer
//   boundary" (this file) covers the RELEASE-throw recovering cleanly, at
//   the raw storageOf()/transactionSync level with a hand-written
//   deferrable column, rather than through migrate()'s own composition of
//   the rebuild's statements and the history insert.
// - "adding a foreign key fails at commit on an orphaned row, not
//   mid-rebuild, and the file rolls back" (test/strict-migration.test.ts)
//   covers the same schema shape, the same pragma, the same FOREIGN KEY
//   message, and the same diff()/render() pipeline, through a raw
//   begin/statement-loop/commit/rollback, rather than through a migrate()
//   call and its savepoint.
// - "a transaction-ending conflict propagates failed cleanup through
//   public commands" (this file) covers the opposite outcome, where the
//   cleanup rollback itself also fails and produces an AggregateError.
// - "migrate() composes with a caller-owned transaction opened before the
//   call, and a deferred foreign key from the migration fails at the
//   caller's own commit" (below) opens the caller's transaction before
//   calling migrate(), pairing with "a rebuild that violates a new foreign
//   key rolls back the schema, the row, and the history insert together,
//   and leaves no transaction open, on Node's storageOf() shim" (below, no
//   caller transaction at all) and with "Node savepoints retain deferred
//   foreign-key semantics at the outer boundary" (this file, a
//   caller-owned transaction around a hand-written transactionSync rather
//   than around migrate() itself).
test("a rebuild that violates a new foreign key rolls back the schema, the row, and the history insert together, and leaves no transaction open, on Node's storageOf() shim", () => {
  const before = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text)`];
  const after = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text references parent(id))`];
  const initial = diff(introspect(open([])), introspect(open(before)));
  if (initial.kind !== 'ok') throw new Error(initial.reason);
  const f1 = render(1, 'initial', [...initial.statements, "insert into parent values ('p1')", "insert into child values ('c1', 'missing')"]);
  const tightened = diff(introspect(open(before)), introspect(open(after)));
  if (tightened.kind !== 'ok') throw new Error(tightened.reason);
  const f2 = render(2, 'foreign_key', tightened.statements, tightened.rebuilds ?? []);
  const originalSchema = introspect(open(before)).tables.get('child')!.sql;
  const raw = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migrate(raw, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /FOREIGN KEY constraint failed/);
      return true;
    });
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: f1.filename }]);
    assert.equal((raw.prepare("select sql from sqlite_schema where name = 'child'").get() as { sql: string }).sql, originalSchema);
    assert.deepEqual(raw.prepare('select * from child').all().map(r => ({ ...r })), [{ id: 'c1', parent_id: 'missing' }]);
    assert.doesNotThrow(() => raw.exec('begin'), 'the failed migration must leave no savepoint or transaction open');
    raw.exec('rollback');
  } finally { raw.close(); }
});

test("migrate() composes with a caller-owned transaction opened before the call, and a deferred foreign key from the migration fails at the caller's own commit", () => {
  const before = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text)`];
  const after = [`create table parent (id text primary key not null)`, `create table child (id text primary key not null, parent_id text references parent(id))`];
  const initial = diff(introspect(open([])), introspect(open(before)));
  if (initial.kind !== 'ok') throw new Error(initial.reason);
  const f1 = render(1, 'initial', [...initial.statements, "insert into parent values ('p1')", "insert into child values ('c1', 'missing')"]);
  const tightened = diff(introspect(open(before)), introspect(open(after)));
  if (tightened.kind !== 'ok') throw new Error(tightened.reason);
  const f2 = render(2, 'foreign_key', tightened.statements, tightened.rebuilds ?? []);
  const originalSchema = introspect(open(before)).tables.get('child')!.sql;
  const raw = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(raw, [{ name: f1.filename, sql: f1.sql }]), [f1.filename]);
    raw.exec('begin');
    assert.deepEqual(migrate(raw, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]), [f2.filename]);
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: f1.filename }, { name: f2.filename }]);
    assert.equal(raw.isTransaction, true);
    assert.throws(() => raw.exec('commit'), /FOREIGN KEY constraint failed/);
    assert.equal(raw.isTransaction, true);
    raw.exec('rollback');
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: f1.filename }]);
    assert.equal((raw.prepare("select sql from sqlite_schema where name = 'child'").get() as { sql: string }).sql, originalSchema);
    assert.deepEqual(raw.prepare('select * from child').all().map(r => ({ ...r })), [{ id: 'c1', parent_id: 'missing' }]);
  } finally { raw.close(); }
});

// migrate()'s pre-existing-violation message (src/durable.ts) keys a
// pragma_foreign_key_check row by (table, parent table, referencing and
// referenced column names, primary-key value, referencing-column values),
// read back with one `select <pk column>,
// <referencing columns...> from <table> where rowid = ?`, rather than by
// rowid alone: a file that deletes the table's only violating row and then
// inserts a different violating row can have the new row reuse the deleted
// row's rowid, and a rowid-only key would then wrongly read the new
// violation as the same one that predated the file.
test("a file that deletes a pre-existing violating row and inserts a different violating row is not read as the same, already-known violation, even though the new row reuses the deleted row's rowid", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    // Left off for the rest of this test: an immediate (non-deferred)
    // foreign key otherwise refuses every orphaned insert below on the
    // spot, before migrate()'s own pragma_foreign_key_check ever runs.
    // pragma foreign_key_check finds a violation regardless of this
    // setting, so leaving it off does not hide the violation from migrate().
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1);

    // The rowid-reuse claim the comment above relies on, proved directly:
    // deleting the table's only row and inserting a new one reuses rowid 1,
    // because the first insert into an empty rowid table always gets it.
    raw.exec("delete from child where id = 'c1'");
    raw.exec("insert into child values ('reuse-check', 'still-missing')");
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1);
    raw.exec("delete from child where id = 'reuse-check'");
    raw.exec("insert into child values ('c1', 'missing')");
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1);

    // migrate()'s before-snapshot reads this row (rowid 1, key keyed on
    // 'c1') here, before the file below runs.
    const file = {
      name: '0001_swap.sql',
      // One file both fixes the pre-existing violation and introduces a
      // different one, on a row that reuses the fixed row's rowid (this
      // table holds exactly one row throughout, so the insert right after
      // the delete always gets rowid 1 back).
      sql: "delete from child where id = 'c1'; insert into child values ('c2', 'also-missing');",
    };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /FOREIGN KEY constraint failed/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
    // The failed file rolled back: the original, pre-existing row is back.
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1);
    assert.deepEqual(raw.prepare('select * from child').all().map(r => ({ ...r })), [{ id: 'c1', parent_id: 'missing' }]);
  } finally { raw.close(); }
});

// (table, parent table, referencing and referenced column names,
// primary-key value) alone is not enough: a file that only changes which
// missing parent a violating row points at, leaving the primary-key value
// untouched, would still read as "the same already-known violation" under
// that key. Reproduced directly against node:sqlite (a raw
// delete-then-insert with the same primary-key value below, and, in the
// third test, a single update with no delete or insert at all).
// violationKeys() (src/durable.ts) adds the referencing column's (or
// columns') current value, read with pragma foreign_key_list, to rule this
// out; each test below asserts doesNotMatch(/predates/) to prove the fix,
// not the bug.
test("a file that deletes a pre-existing violating row and inserts a different violating row with the same primary-key value, pointed at a different missing parent, is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    // Left off for the rest of this test: an immediate (non-deferred)
    // foreign key otherwise refuses the file's own delete-then-insert
    // below on the spot, before migrate()'s own pragma_foreign_key_check
    // ever runs.
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing-A')");

    const file = {
      name: '0001_repoint.sql',
      sql: "delete from child where id = 'c1'; insert into child values ('c1', 'missing-B');",
    };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

test("the same repointing case, with a healthy sibling row present so the new row's rowid is not reused, still is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    raw.exec("insert into parent values ('p1')");
    // Left off for the rest of this test, the same reason as the previous
    // test's: the file's own delete-then-insert below needs to reach
    // migrate()'s own pragma_foreign_key_check, not fail immediately.
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1a', 'missing-A')");
    raw.exec("insert into child values ('c0', 'p1')");
    assert.equal(raw.prepare("select rowid from child where id = 'c1a'").get()!.rowid, 1);
    assert.equal(raw.prepare("select rowid from child where id = 'c0'").get()!.rowid, 2);

    const file = {
      name: '0001_repoint.sql',
      sql: "delete from child where id = 'c1a'; insert into child values ('c1a', 'missing-B');",
    };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
  // The rowid assertions above ran before the file, and this file's own
  // insert rolls back with the rest of it, so prove the non-reuse claim on
  // a fresh connection instead: the same delete-then-insert, with the same
  // healthy sibling row present, lands on rowid 3, not the deleted row's
  // rowid 1 -- this test does not depend on rowid reuse at all.
  const proof = new DatabaseSync(':memory:');
  try {
    proof.exec('create table child (id text primary key not null, parent_id text)');
    proof.exec("insert into child values ('c1a', 'x')");
    proof.exec("insert into child values ('c0', 'y')");
    proof.exec("delete from child where id = 'c1a'");
    proof.exec("insert into child values ('c1a', 'z')");
    assert.equal(proof.prepare("select rowid from child where id = 'c1a'").get()!.rowid, 3);
  } finally { proof.close(); }
});

test("a single UPDATE that only changes a violating row's referencing column, with no delete or insert, is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    // Left off for the rest of this test, the same reason as the two tests
    // above: the file's own UPDATE below needs to reach migrate()'s own
    // pragma_foreign_key_check, not fail immediately.
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing-A')");

    const file = { name: '0001_update.sql', sql: "update child set parent_id = 'missing-B' where id = 'c1';" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// The positive control for the three tests above, and Node's side of
// migrate-durable-object.test.ts's matching Durable Object test: a raw
// violation that predates every file migrate() applies, left untouched by
// an unrelated file, does read as "predates", on Node as on a real Durable
// Object.
test("an unrelated file applied after a raw, pre-existing violation reads that violation as predating the file, on Node as on a Durable Object", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    raw.exec("insert into parent values ('p1')");
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");
    raw.exec('pragma foreign_keys=on');

    const file = { name: '0001_unrelated.sql', sql: "create table unrelated (id text primary key not null);" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.match((e as Error).message, /predates/);
      return true;
    });
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all(), []);
  } finally { raw.close(); }
});

// SQLite assigns a foreign key's fkid by its position in the table's
// current declaration, so a rebuild of the violating row's own table can
// renumber a foreign key the rebuild never touched: adding a third foreign
// key to a two-foreign-key table can change which fkid the earlier two
// keep. violationKeys() (src/durable.ts) used to include row.fkid in its
// key, so a violation on the untouched foreign key stopped matching the
// before-snapshot across that rebuild, and this file's own
// pragma_foreign_key_check treated a violation that predates it as newly
// introduced. The key now identifies a foreign key by what it points at
// (the parent table and the referencing and referenced column names)
// instead of by its position, so it survives the renumbering.
test("a rebuild that adds an unrelated foreign key to the violating row's own table, renumbering an untouched foreign key, still reads the violation as predating the file", () => {
  const before = [
    `create table parentA (id text primary key not null)`,
    `create table parentB (id text primary key not null)`,
    `create table child (id text primary key not null, a_id text references parentA(id), b_id text references parentB(id))`,
  ];
  const after = [
    `create table parentA (id text primary key not null)`,
    `create table parentB (id text primary key not null)`,
    `create table child (id text primary key not null, a_id text references parentA(id), b_id text references parentB(id), c_id text references parentA(id))`,
  ];
  const initial = diff(introspect(open([])), introspect(open(before)));
  if (initial.kind !== 'ok') throw new Error(initial.reason);
  const f1 = render(1, 'initial', [...initial.statements, "insert into parentA values ('a1')", "insert into parentB values ('b1')"]);
  const added = diff(introspect(open(before)), introspect(open(after)));
  if (added.kind !== 'ok') throw new Error(added.reason);
  const f2 = render(2, 'add_c', added.statements, added.rebuilds ?? []);

  const fkidOf = (db: DatabaseSync) => (db.prepare('pragma foreign_key_list(child)').all() as { from: string; id: number }[]).find(fk => fk.from === 'b_id')!.id;

  // The rebuild really does renumber b_id's fkid, checked on its own
  // connection with no violation to roll back: without this, the assertion
  // below would pass even if this SQLite version happened not to renumber
  // anything here, guarding nothing.
  const probe = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(probe, [{ name: f1.filename, sql: f1.sql }]), [f1.filename]);
    const fkidBefore = fkidOf(probe);
    for (const statement of splitStatements(f2.sql)) probe.exec(statement);
    assert.notEqual(fkidOf(probe), fkidBefore, "the rebuild must renumber b_id's fkid for this test to guard against the bug it names");
  } finally { probe.close(); }

  const raw = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(raw, [{ name: f1.filename, sql: f1.sql }]), [f1.filename]);

    // A pre-existing violation on b_id, injected the same way the positive
    // control above does: bypassing migrate() entirely, as a raw write or a
    // row left over from before this check existed would.
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'a1', 'missing-b')");
    raw.exec('pragma foreign_keys=on');

    assert.throws(() => migrate(raw, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.match((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

test('nested Node transactions retain exactly the successful writes', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {storageOf}=await import('../src/node.ts');
  property(tc=>{
    const steps=tc.draw(gs.arrays(gs.composite(tc=>({value:tc.draw(gs.text({maxSize:30})),fail:tc.draw(gs.booleans())})),{maxSize:20}));
    const failOuter=tc.draw(gs.booleans());
    const raw=new DatabaseSync(':memory:');
    const sentinel=new Error('rollback');
    try {
      raw.exec("create table t(value text);insert into t values('seed')");
      const storage=storageOf(raw);
      const run=()=>storage.transactionSync(()=>{
        for(const step of steps) {
          const inner=()=>storage.transactionSync(()=>{raw.prepare('insert into t values(?)').run(step.value);if(step.fail)throw sentinel;});
          if(step.fail)assert.throws(inner,error=>error===sentinel);else inner();
        }
        if(failOuter)throw sentinel;
      });
      if(failOuter)assert.throws(run,error=>error===sentinel);else run();
      assert.deepEqual(raw.prepare('select value from t order by rowid').all().map(row=>row.value),['seed',...(failOuter?[]:steps.filter(step=>!step.fail).map(step=>step.value))]);
    }finally{raw.close();}
  });
});

test('a transaction-ending conflict propagates failed cleanup through public commands', async () => {
  const {commands}=await import('../src/index.ts');
  const sql='insert or rollback into t values(1)';
  const command=commands({[sql]:{params:[],encode:[],json:[],reads:['t']}},{conflict:{plan:[sql]}}).conflict;
  const raw=new DatabaseSync(':memory:');
  try {
    raw.exec('create table t(id integer primary key);insert into t values(1);begin;insert into t values(2)');
    await assert.rejects(node(raw).run(command),error=>{
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length,2);
      assert.match((error.cause as Error).message,/UNIQUE/);
      return true;
    });
    assert.deepEqual(raw.prepare('select id from t').all().map(row=>row.id),[1]);
    assert.throws(()=>raw.exec('commit'),/no transaction/);
  }finally{raw.close();}
});

// migrate()'s before-snapshot (src/durable.ts) exists to tell a violation
// that predates the first file apart from one a later file introduces, so
// it only has work to do when a file below will actually run. Once every
// listed file is already applied, the per-file loop never runs, before is
// never read, and the scan is a wasted full-database pass -- paid on every
// call a Durable Object constructor makes, not only the first. This test
// counts pragma foreign_key_check calls through a wrapped StorageLike. The
// first assert observes the pragma running while a file applies (it does not
// by itself tell the before-snapshot's one call apart from the per-file
// after-check's own call, both of which match); the second assert is the fix
// itself: no new call when nothing is left to apply.
test('migrate() skips its pre-loop pragma foreign_key_check when every listed migration file is already applied', async () => {
  const { storageOf } = await import('../src/node.ts');
  const { migrate: migrateStorage } = await import('../src/durable.ts');
  const raw = new DatabaseSync(':memory:');
  try {
    const inner = storageOf(raw);
    let foreignKeyCheckCalls = 0;
    const storage = {
      ...inner,
      sql: {
        exec: (sql: string, ...bindings: unknown[]) => {
          if (sql.includes('foreign_key_check')) foreignKeyCheckCalls++;
          return inner.sql.exec(sql, ...bindings);
        },
      },
    };
    const files = [{ name: '0001_initial.sql', sql: 'create table t (id integer primary key not null)' }];
    assert.deepEqual(migrateStorage(storage, files), [files[0]!.name]);
    assert.ok(foreignKeyCheckCalls > 0, 'expected pragma foreign_key_check to run while a file applies');
    const callsAfterFirstRun = foreignKeyCheckCalls;
    assert.deepEqual(migrateStorage(storage, files), []);
    assert.equal(foreignKeyCheckCalls, callsAfterFirstRun, 'migrate() must not call pragma foreign_key_check again once every listed file is already applied');
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: files[0]!.name }]);
  } finally { raw.close(); }
});
