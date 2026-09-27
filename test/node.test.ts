// The example modules on node:sqlite, in-process: the migration files
// apply, and queries, commands, and failures as values behave as they do on
// D1 and on a Durable Object. This is the loop a module's own tests run in.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, MigrationHistoryError, node } from "../src/node.ts";
import { diff, introspect, open, render } from "../src/build/migration.ts";
import { REBUILD_HEADER, splitStatements } from "../src/build/scan.ts";
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

  // Own ids, placed after the last row count this describe block reads: two
  // SQLite builds sharing a major.minor were measured returning different
  // values for the same float expression (see
  // test/miniflare/sqlite-version.test.ts's value-differential probe). This
  // pins the same fact on node(): a price written as 0.1 + 0.2 must come
  // back through orders.withLines's JSON lines exactly as it went in.
  test("a line price written as 0.1 + 0.2 reads back through JSON lines exactly, not rounded", async () => {
    const floatOrder = "o-float" as OrdersId;
    await db.run(customerCommands.create, { id: "c-float" as CustomersId, name: "Flo", email: "flo@example.com" });
    await db.run(orderCommands.place, {
      id: floatOrder,
      customer_id: "c-float" as CustomersId,
      lines: [{ id: "l-float" as OrderLinesId, sku: "F", qty: 1, price: 0.1 + 0.2 }],
    });
    const order = await db.first(orderQueries.withLines, { id: floatOrder });
    assert.deepEqual(order!.lines.map((l) => l.price), [0.1 + 0.2]);
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
// single non-INTEGER primary-key column to read back, or, on a single
// INTEGER PRIMARY KEY, one declared with AUTOINCREMENT (migrate() then uses
// the rowid itself in place of a column readback); on a table with a plain
// INTEGER PRIMARY KEY, a composite key, or WITHOUT ROWID, migrate() cannot
// rule this file out, and blames it still.
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

// A single-column INTEGER PRIMARY KEY with AUTOINCREMENT is a rowid alias
// too, but AUTOINCREMENT itself is the guarantee the plain-INTEGER exclusion
// above lacks: it forces every new rowid past sqlite_sequence's own
// high-water mark, so the same row's rowid never gets reused the way a plain
// `integer primary key`'s can. violationKeys() (src/durable.ts) keys such a
// table by row.rowid itself instead of leaving it unkeyable, so a later,
// unrelated migration file still reads an untouched, pre-existing violation
// on it as predating that file. Generated through diff()/render(), the same
// pipeline a real project's migration files come from, adding a column
// unrelated to the foreign key: this emits a plain `alter table add column`
// here (not a table rebuild), so the child table's own rowid is untouched
// by the file the test applies.
test("a migration file generated by diff()/render() that adds an unrelated column to an AUTOINCREMENT table still reads a pre-existing violation as predating that file", () => {
  const before = [
    `create table parent (id text primary key not null)`,
    `create table child (id integer primary key autoincrement, parent_id text references parent(id))`,
  ];
  const after = [
    `create table parent (id text primary key not null)`,
    `create table child (id integer primary key autoincrement, parent_id text references parent(id), note text)`,
  ];
  const initial = diff(introspect(open([])), introspect(open(before)));
  if (initial.kind !== 'ok') throw new Error(initial.reason);
  const f1 = render(1, 'initial', initial.statements);
  const added = diff(introspect(open(before)), introspect(open(after)));
  if (added.kind !== 'ok') throw new Error(added.reason);
  assert.deepEqual(added.rebuilds ?? [], [], 'expected an unrelated column add to stay a plain ALTER TABLE, not a rebuild, for this test to guard what it names');
  const f2 = render(2, 'add_note', added.statements, added.rebuilds ?? []);

  const raw = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(raw, [{ name: f1.filename, sql: f1.sql }]), [f1.filename]);
    raw.exec("insert into parent values ('p1')");
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing')");
    raw.exec('pragma foreign_keys=on');

    assert.throws(() => migrate(raw, [{ name: f1.filename, sql: f1.sql }, { name: f2.filename, sql: f2.sql }]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.match((e as Error).message, /predates/);
      return true;
    });
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: f1.filename }]);
  } finally { raw.close(); }
});

// The mirror of the test above: a file that introduces its own new
// violation on an AUTOINCREMENT primary key still reads as a violation this
// file caused, not one that predates it.
test("a file that introduces a new violation on an AUTOINCREMENT primary key is not read as predating the file", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key autoincrement, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');

    const file = { name: '0001_new_violation.sql', sql: "insert into child (parent_id) values ('missing');" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// AUTOINCREMENT's own guarantee, exercised the same way the TEXT primary-key
// rowid-reuse test above exercises the opposite case: there, a plain
// primary-key column let a deleted row's rowid come back on the very next
// insert, and the design still ruled out a false "predates" match by reading
// the referencing column's own value. Here, AUTOINCREMENT itself already
// rules out the reuse (measured below, on a fresh connection with no
// violation to roll back), so a file that deletes a violating row and
// inserts a replacement pointed at the very same missing parent still reads
// as a different, new violation: the replacement's rowid never comes back
// to the deleted row's rowid, so violationKeys()'s before/after comparison
// never even reaches the referencing column.
test("a file that deletes a pre-existing violating row on an AUTOINCREMENT primary key and inserts a replacement pointed at the same missing parent is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key autoincrement, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing')");
    assert.equal(raw.prepare('select id from child').get()!.id, 1);

    const file = { name: '0001_swap.sql', sql: "delete from child where id = 1; insert into child (parent_id) values ('missing');" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
  // The non-reuse claim above, proved directly on a fresh connection: the
  // same delete-then-insert on an AUTOINCREMENT table lands on rowid 2, not
  // the deleted row's rowid 1, unlike the plain-INTEGER-primary-key case the
  // durable.ts block comment on violationKeys() also measures.
  const proof = new DatabaseSync(':memory:');
  try {
    proof.exec('create table child (id integer primary key autoincrement, value text)');
    proof.exec("insert into child (value) values ('a')");
    proof.exec('delete from child where id = 1');
    proof.exec("insert into child (value) values ('b')");
    assert.equal(proof.prepare('select id from child').get()!.id, 2);
  } finally { proof.close(); }
});

// AUTOINCREMENT only guarantees a fresh rowid on insert; it says nothing
// about a statement that reassigns an existing row's rowid directly. A
// migration file that does this (measured directly: pragma_foreign_key_check
// reported rowid 999 after this statement, for a row it reported as rowid 1
// before the file ran) makes the before-snapshot's row.rowid stop matching
// the after-check's for that same row, so violationKeys() falls back to the
// safe default and blames the file, the same as an unkeyable row would,
// rather than wrongly reading it as predating the file.
test("a file that reassigns an AUTOINCREMENT row's own rowid is not read as predating the file", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key autoincrement, parent_id text references parent(id))');
    raw.exec("insert into parent values ('p1')");
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing')");
    raw.exec('pragma foreign_keys=on');
    assert.equal(raw.prepare('select id from child').get()!.id, 1);

    const file = { name: '0001_reassign.sql', sql: "update child set id = 999 where id = 1;" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
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

// migrate() computes its before-snapshot once for the whole call, then
// narrows it to empty after any file whose own after-check finds zero
// violations (src/durable.ts): carrying a resolved file's now-stale before
// forward could match a later file's new violation against a key the
// resolved file's own statements already cleared. Two new pending files in
// one migrate() call exercise that narrowing directly: file1 deletes the
// call's only pre-existing violation (zero violations afterward, so before
// narrows to empty), then file2 recreates a violation of the same shape
// (same table, primary-key value, parent table, and referencing value). If
// the narrowing did not happen, the stale before from the start of the call
// would still hold that same key and file2's new violation would misread as
// one that predates it.
test("a file that clears the call's last pre-existing violation, followed by a file that recreates the same-shaped violation, blames the second file, not the first", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    // Left off for the rest of this test, the same reason as the tests
    // above: file2's own insert below needs to reach migrate()'s own
    // pragma_foreign_key_check, not fail immediately.
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");

    const file1 = { name: '0001_delete.sql', sql: "delete from child where id = 'c1';" };
    const file2 = { name: '0002_reintroduce.sql', sql: "insert into child values ('c1', 'missing');" };
    assert.throws(() => migrate(raw, [file1, file2]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
    // file1 committed (its own after-check found zero violations); only
    // file2 rolled back.
    assert.deepEqual(raw.prepare('select name from solarsql_migrations').all().map(r => ({ ...r })), [{ name: file1.name }]);
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

// violationKeys() (src/durable.ts) caches a table's primary-key resolution
// and, per (table, fkid), its foreign-key column names, for the lifetime of
// one violationKeys() call: two violating rows on the same table, sharing
// the same single foreign key, must resolve both without a second
// `pragma table_info` or `pragma foreign_key_list` call. This counts both
// pragmas through a wrapped StorageLike across two separate violationKeys()
// calls (the before-snapshot and the one unrelated file's own after-check),
// each holding both rows: two calls, one pragma each, is two total; a cache
// miss on the second row of either call would make it four.
test('violationKeys() resolves a table primary key and a foreign key only once per call, for two violating rows sharing the same table and foreign key', async () => {
  const { storageOf } = await import('../src/node.ts');
  const { migrate: migrateStorage } = await import('../src/durable.ts');
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing-1')");
    raw.exec("insert into child values ('c2', 'missing-2')");

    const inner = storageOf(raw);
    let tableInfoCalls = 0;
    let foreignKeyListCalls = 0;
    const storage = {
      ...inner,
      sql: {
        exec: (sql: string, ...bindings: unknown[]) => {
          if (sql.includes('table_info("child")')) tableInfoCalls++;
          if (sql.includes('foreign_key_list("child")')) foreignKeyListCalls++;
          return inner.sql.exec(sql, ...bindings);
        },
      },
    };
    const file = { name: '0001_unrelated.sql', sql: 'create table unrelated (id text primary key not null);' };
    assert.throws(() => migrateStorage(storage, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      return true;
    });
    assert.equal(tableInfoCalls, 2, 'expected one pragma table_info(child) call per violationKeys() call (before-snapshot and after-check), not one per row');
    assert.equal(foreignKeyListCalls, 2, 'expected one pragma foreign_key_list(child) call per violationKeys() call, not one per row');
  } finally { raw.close(); }
});

// pks.length !== 1 (src/durable.ts) marks a composite primary key unkeyable
// (block comment above violationKeys()): a violation on such a table always
// reads as new, blaming whichever file's own after-check finds it, even one
// that is genuinely already present before that file runs, rather than
// reading it back by only the first of its two key columns.
test("a composite-primary-key table's violation always reads as new, even when it genuinely predates the unrelated file that finds it", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (a text not null, b text not null, parent_id text references parent(id), primary key (a, b))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('a1', 'b1', 'missing')");

    const file = { name: '0001_unrelated.sql', sql: 'create table unrelated (id text primary key not null);' };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// A plain `integer primary key`, with no AUTOINCREMENT, keeps no guarantee
// against rowid reuse (the block comment above violationKeys() measures
// this directly), so it stays unkeyable the same way a composite key does:
// a violation on it always reads as new, even one that genuinely predates
// the unrelated file that finds it, rather than being read back by the
// column's own value as though it carried AUTOINCREMENT's guarantee.
test("a plain INTEGER PRIMARY KEY table's violation always reads as new, even when it genuinely predates the unrelated file that finds it", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing')");

    const file = { name: '0001_unrelated.sql', sql: 'create table unrelated (id text primary key not null);' };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// violationKeys()'s key reads a single-column, non-INTEGER primary key back
// by its own value (block comment above violationKeys()), not by a stand-in:
// two rows sharing the same referencing-column value but different primary
// keys must resolve to different keys, so a file that introduces one of
// them (c2) does not borrow the other's (c1's) already-predating status.
test('two rows sharing the same referencing-column value but different primary keys are not read as the same violation, when only one predates the file', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");

    const file = { name: '0001_add_c2.sql', sql: "insert into child values ('c2', 'missing');" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// The AUTOINCREMENT mirror of the test above: violationKeys() reads such a
// table's key by row.rowid itself (block comment above violationKeys()), so
// two rows sharing the same referencing-column value but different
// AUTOINCREMENT ids must still resolve to different keys.
test('two rows on an AUTOINCREMENT primary key sharing the same referencing-column value but different ids are not read as the same violation, when only one predates the file', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key autoincrement, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing')");
    assert.equal(raw.prepare('select id from child').get()!.id, 1);

    const file = { name: '0001_add_second.sql', sql: "insert into child (parent_id) values ('missing');" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// violationKeys() includes an AUTOINCREMENT-keyed row's referencing-column
// value in its key too (the block comment above violationKeys(), and the
// TEXT-primary-key repointing tests above, make the same point for a
// non-INTEGER primary key): a single UPDATE that only changes the
// referencing column, with the row's own id unchanged, must not be read as
// the same, already-known violation.
test("a single UPDATE that only changes an AUTOINCREMENT row's own referencing column, with no delete or insert, is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id integer primary key autoincrement, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child (parent_id) values ('missing-A')");
    assert.equal(raw.prepare('select id from child').get()!.id, 1);

    const file = { name: '0001_update.sql', sql: "update child set parent_id = 'missing-B' where id = 1;" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// migrate()'s mirror-direction check (src/durable.ts) only refuses a rebuild
// that would restore a table-level constraint an earlier migration removed;
// a constraint that was never removed, and stays declared through an
// unrelated rebuild, must not itself be treated as revived.
test('a rebuild for an unrelated reason does not refuse its own table-level CHECK constraint, which no sibling migration ever dropped', () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer, check (a > 0)) strict";
  const target = "create table t (id text primary key not null, a integer not null, b integer not null, check (a > 0)) strict"; // tightens b to NOT NULL, unrelated to the CHECK
  const plan = diff(introspect(open([base])), introspect(open([target])));
  if (plan.kind !== 'ok') throw new Error(plan.reason);
  const file = render(2, 'b_not_null', plan.statements, plan.rebuilds ?? []);

  const db = new DatabaseSync(':memory:');
  try {
    assert.doesNotThrow(() => migrate(db, [
      { name: '0001_base.sql', sql: base + ';' },
      { name: '0002_b_not_null.sql', sql: file.sql },
    ]));
    assert.equal((db.prepare("select sql from sqlite_schema where name = 't'").get() as { sql: string }).sql.toLowerCase().includes('check'), true);
  } finally { db.close(); }
});

// pragma_foreign_key_check reports a WITHOUT ROWID table's violating row
// with rowid null (measured directly below), so violationKeys() (src/
// durable.ts) returns null for it before resolving a primary key at all:
// a WITHOUT ROWID table has no rowid column to read a key back by. Skipping
// that early return would reach the later `where rowid = ?` readback, which
// fails outright on a WITHOUT ROWID table (also measured directly below),
// rather than falling back to the unkeyable default.
test('a WITHOUT ROWID table reports rowid null from pragma_foreign_key_check, and a readback by rowid fails on it', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id)) without rowid');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");
    const violation = raw.prepare('pragma foreign_key_check').get() as { rowid: unknown };
    assert.equal(violation.rowid, null);
    assert.throws(() => raw.prepare('select id from child where rowid = ?').get(violation.rowid as never), /no such column: rowid/);
  } finally { raw.close(); }
});

// migrate()'s own before-snapshot and after-check (src/durable.ts) run this
// same WITHOUT ROWID shape through migrate(): a genuinely pre-existing
// violation on it still reads as new (unkeyable, the safe default), not as
// a crash and not as falsely "predates", when an unrelated file applies.
test('a WITHOUT ROWID table\'s violation always reads as new through migrate(), even when it genuinely predates the unrelated file that finds it', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id)) without rowid');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");

    const file = { name: '0001_unrelated.sql', sql: 'create table unrelated (id text primary key not null);' };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// violationKeys() (src/durable.ts) caches a table's foreign-key column names
// by (table, fkid) (block comment above violationKeys()): two different
// foreign keys on the same table, pointing at the same parent table through
// different referencing columns, must not share that cache entry, or the
// second's own readback selects the first's referencing column instead of
// its own -- since both point at the same parent table, `row.parent` alone
// cannot tell the two apart the way it would for two different parent
// tables. Both violations are found by the very same row, in the same
// single violationKeys() call (the file's own after-check), so a collapsed
// cache key would make the second foreign key's entry read back a_id's own
// value in place of b_id's, producing the exact same key a_id's own entry
// already has, and wrongly treating the foreign key this file's own
// statement just broke as though it already predated the file.
test('two different foreign keys on the same table, pointing at the same parent table through different columns, are not read as the same violation', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, a_id text references parent(id), b_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into parent values ('ok')");
    // b_id's foreign key predates the file below; a_id's is fine here and
    // the file introduces its own violation on it. `pragma foreign_key_list`
    // assigns b_id fkid 0 (declared last) and a_id fkid 1, and
    // `pragma_foreign_key_check` reports fkid 0 first (measured directly),
    // so a collapsed (table, fkid) cache would compute and cache b_id's own
    // foreign key first and hand it, wrongly, to a_id's own entry below.
    raw.exec("insert into child values ('c1', 'ok', 'missing-b')");

    const file = { name: '0001_break_a.sql', sql: "update child set a_id = 'missing-a' where id = 'c1';" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});

// violationKeys() (src/durable.ts) reads a single-column, non-INTEGER
// primary key's own value back to build its key (block comment above
// violationKeys()), not the table's own rowid: on a TEXT primary key, a
// deleted row's rowid can come back on the very next insert (proved
// directly below, the same way the rowid-reuse tests above prove it), so a
// key built from rowid instead of the declared primary key would read a
// replacement row with the same referencing-column value as the row it
// replaced.
test("a file that deletes a pre-existing violating row and inserts a different violating row with the same referencing-column value is not read as the same, already-known violation, even though the new row reuses the deleted row's rowid", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table parent (id text primary key not null)');
    raw.exec('create table child (id text primary key not null, parent_id text references parent(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into child values ('c1', 'missing')");
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1);

    const file = {
      name: '0001_swap.sql',
      sql: "delete from child where id = 'c1'; insert into child values ('c2', 'missing');",
    };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
    assert.equal(raw.prepare('select rowid from child').get()!.rowid, 1, "the replacement row must reuse the deleted row's rowid for this test to guard against the bug it names");
  } finally { raw.close(); }
});

// SQLite accepts a string-literal-quoted identifier as an object name and
// stores it in sqlite_schema written exactly that way (measured directly:
// `create trigger 'qt' ...` reads back unchanged), which created()
// (src/build/scan.ts) tokenizes as a string, not an identifier, so it
// returns null for it. migrate()'s own "without knowledge of trigger" error
// (src/durable.ts) reads a live trigger's own text this way when a stale
// rebuild record does not know about it (unknownDeclaration(), with no
// name-defined requirement of its own), so this case reaches durable.ts at
// runtime, not only applied()'s build-time twin (test/migration-replay-
// error.test.ts).
test("a Durable Object's runtime migrate() still names a trigger whose declared name is a string-literal-quoted identifier, when a stale rebuild does not know about it", () => {
  const file1 = { name: "0001_base.sql", sql: "create table t (id integer primary key not null, a integer) strict; create trigger 'qt' after insert on t begin select 1; end;" };
  const file2 = {
    name: "0002_stale.sql",
    sql: `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "id integer primary key not null" }, { name: "a", def: "a integer" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`,
  };
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, [file1]);
    assert.throws(() => migrate(db, [file1, file2]), (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" without knowledge of trigger "create trigger 'qt' after insert on t begin select 1; end" it already has/);
      return true;
    });
  } finally { db.close(); }
});

// A RebuildRecord's own `table` field (src/durable.ts) names whatever a
// migration file's own header claims to rebuild, not a name this function
// itself derived from the live schema, so it can name something that is no
// longer a table by the time this later file actually applies. Measured
// directly: pragma_table_xinfo() reports a view's own columns just as it
// would a table's (actualColumns.length > 0, so this loop does not `continue`
// past it), but the schemaRow lookup right after filters on `type = 'table'`
// and finds nothing for a view, leaving defs null. The revivedConstraint
// check below must handle that null gracefully, the same way the
// badConstraint check just above it already does.
test("a Durable Object's runtime migrate() does not crash when a stale rebuild record names something that is now a view, not a table", () => {
  const file1 = { name: "0001_base.sql", sql: "create table t (id integer primary key, a integer); create view v as select id, a from t;" };
  const header = REBUILD_HEADER + JSON.stringify([{ table: "v", columns: [{ name: "id", def: "" }, { name: "a", def: "" }], constraints: [], indexes: [], triggers: [] }]);
  const file2 = { name: "0002_stale.sql", sql: `${header}\nselect 1;` };
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db, [file1]);
    assert.deepEqual(migrate(db, [file1, file2]), [file2.name]);
  } finally { db.close(); }
});

// pragma_foreign_key_check only ever looks at main (measured directly: a
// TEMP table's own violation never appears in its result), but an
// unqualified `pragma table_info(...)`, `pragma foreign_key_list(...)`, or
// `select ... from ...` resolves against a same-named TEMP table first when
// one exists (SQLite's ordinary shadowing rule), reading that TEMP table's
// shape and rows in place of the main table pragma_foreign_key_check named.
// violationKeys() (src/durable.ts) now schema-qualifies all three of its own
// reads to main; before that fix, a TEMP table shadowing the violating
// table made every one of these reads return the TEMP table's own
// (unrelated, unchanging) data instead. Reproduced directly: a TEXT primary
// key's classic rowid-reuse case (the same pattern the plain rowid-reuse
// tests above exercise), where the file's own delete-then-insert replaces
// main's violating row with a materially different one, at the same reused
// rowid the file's own statements never expose to a TEMP table at all. Under
// the shadowing bug, both the before-snapshot's and the after-check's own
// readback returned the TEMP table's own unchanging row instead, making the
// two keys equal and misreporting the file's own new violation as
// predating it.
test("a TEMP table shadowing the violating table's name does not make migrate() misread the file's own new violation as predating it", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table p (id text primary key not null)');
    raw.exec('create table c (id text primary key not null, pid text references p(id))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into c values ('c1', 'missing-A')");
    // A TEMP table of the same name, with its own single unchanging row: the
    // file's own statements below name `main.c` explicitly, so they touch
    // only the main table; this TEMP table exists only to shadow durable.ts's
    // own unqualified reads, the way an application's own scratch table
    // (created earlier on the same connection, for an unrelated reason)
    // would.
    raw.exec('create temp table c (id text primary key not null, pid text references p(id))');
    raw.exec("insert into c values ('shadow', 'shadow-value')");
    assert.equal(raw.prepare('select rowid from temp.c').get()!.rowid, 1);
    assert.equal(raw.prepare('select rowid from main.c').get()!.rowid, 1);

    const file = {
      name: '0001_swap.sql',
      sql: "delete from main.c where id = 'c1'; insert into main.c values ('c2', 'missing-B');",
    };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
    // The failed file rolled back: main's replacement row reused rowid 1,
    // confirming this test exercises the same rowid the TEMP table also
    // holds a row at, the shape the shadowing bug needs to misread.
    assert.equal(raw.prepare('select rowid from main.c').get()!.rowid, 1, 'expected the reverted row to still be at rowid 1');
    // The TEMP table's own row is untouched by the file's statements (which
    // name main.c explicitly), proving the shadowing this test guards
    // against, not an accidental write to the TEMP table itself.
    assert.deepEqual(raw.prepare('select * from temp.c').all().map(r => ({ ...r })), [{ id: 'shadow', pid: 'shadow-value' }]);
  } finally { raw.close(); }
});

// The same shadowing risk, for a table this adapter reads to resolve an
// AUTOINCREMENT primary key's own declaration (src/durable.ts): an
// unqualified `select sql from sqlite_schema` does not need the same fix,
// because sqlite_schema itself does not merge a TEMP table's own schema row
// into an unqualified query against it (measured directly below); only
// pragma_table_info, pragma_foreign_key_list, and a table's own row data
// are shadowed by a same-named TEMP table. main's and the TEMP table's own
// declarations differ here (an extra column on the TEMP one) so the
// assertion below can tell which one's own text the query actually read;
// SQLite itself stores a TEMP table's declaration with the word TEMP
// stripped (measured directly), so a same-shaped pair could pass this
// assertion having actually read either one.
test("an unqualified sqlite_schema query reads main's own declaration, not a TEMP table of the same name", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table c (id integer primary key autoincrement)');
    raw.exec('create temp table c (id integer primary key autoincrement, extra text)');
    const rows = raw.prepare(`select sql from sqlite_schema where type = 'table' and lower(name) = lower(?)`).all('c') as { sql: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sql, 'CREATE TABLE c (id integer primary key autoincrement)');
  } finally { raw.close(); }
});

// fk.to (src/durable.ts) tells apart two foreign keys sharing both fk.from
// and the parent table: a file that only changes which of the parent's two
// UNIQUE columns the child row's own unchanged value matches moves the
// violation from one such foreign key to the other, with no write to the
// child row itself. Reproduced directly: swapping the parent row's two
// UNIQUE column values moves the child's own violation from fkid 1 (a
// references p.x) to fkid 0 (a references p.y); the child's own primary key
// and its own `a` column are identical throughout, so only fk.to
// distinguishes the two violations.
test("a file that only repoints which of a parent table's two UNIQUE columns a child's foreign key matches is not read as the same, already-known violation", () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec('create table p (id text primary key not null, x text unique, y text unique)');
    raw.exec('create table c (id text primary key not null, a text, foreign key(a) references p(x), foreign key(a) references p(y))');
    raw.exec('pragma foreign_keys=off');
    raw.exec("insert into p values ('p1', 'other', 'v')");
    raw.exec("insert into c values ('c1', 'v')");
    assert.equal((raw.prepare('pragma foreign_key_check').get() as { fkid: number }).fkid, 1, "expected c1's own violation to start on fkid 1 (a references p.x), for this test to guard what it names");

    const file = { name: '0001_swap_columns.sql', sql: "update p set x = 'v', y = 'other';" };
    assert.throws(() => migrate(raw, [file]), (e: unknown) => {
      assert.ok(!(e instanceof MigrationHistoryError), 'expected the raw engine error, not a MigrationHistoryError');
      assert.match((e as Error).message, /pragma_foreign_key_check/);
      assert.doesNotMatch((e as Error).message, /predates/);
      return true;
    });
  } finally { raw.close(); }
});
