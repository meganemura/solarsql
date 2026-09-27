// Adding STRICT to an existing table is a table rebuild, and a row whose
// stored value does not match the declared type fails that rebuild loudly.
// The same is true of tightening an existing column's constraint -- NOT
// NULL, UNIQUE, CHECK, or a foreign key -- against rows the generator
// cannot see: the rebuild's own restore step re-inserts each row under the
// new declaration, the engine checks it there, and a violation rolls back
// the whole file the same way a STRICT type mismatch does.
import { test } from "vitest";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render, shape } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";

const before = [`create table t (id text primary key not null, n integer not null)`];
const after = [`create table t (id text primary key not null, n integer not null) strict`];

test("strict is part of the table shape and needs a rebuild", () => {
  const plan = diff(introspect(open(before)), introspect(open(after)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_t")), plan.statements.join("\n"));
  const db = applied([render(1, "before", before).sql, "insert into t values ('a', 1);", render(2, "strict", plan.statements).sql]);
  assert.equal((db.prepare("select sql from sqlite_schema where name = 't'").get() as { sql: string }).sql.toLowerCase().endsWith("strict"), true);
});

test("a stored text in an integer column fails the rebuild, and the file rolls back", () => {
  const plan = diff(introspect(open(before)), introspect(open(after)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  const db = applied([render(1, "before", before).sql, "insert into t values ('a', 'twelve');"]);
  db.exec("begin");
  assert.throws(() => {
    for (const s of splitStatements(render(2, "strict", plan.statements).sql)) db.exec(s);
  }, /cannot store TEXT value in INTEGER column/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from t").all().map((r) => ({ ...r })), [{ id: "a", n: "twelve" }]);
});

test("adding NOT NULL to an existing column fails the rebuild on a null row, and the file rolls back", () => {
  const before = [`create table orders (id text primary key not null, note text)`];
  const after = [`create table orders (id text primary key not null, note text not null)`];
  const plan = diff(introspect(open(before)), introspect(open(after)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  const db = applied([render(1, "before", before).sql, "insert into orders values ('a', null);"]);
  db.exec("begin");
  assert.throws(() => {
    for (const s of splitStatements(render(2, "not-null", plan.statements).sql)) db.exec(s);
  }, /NOT NULL constraint failed: orders\.note/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from orders").all().map((r) => ({ ...r })), [{ id: "a", note: null }]);
});

test("adding UNIQUE to an existing column fails the rebuild on a duplicate, and the file rolls back", () => {
  const before = [`create table customers (id text primary key not null, email text)`];
  const after = [`create table customers (id text primary key not null, email text unique)`];
  const plan = diff(introspect(open(before)), introspect(open(after)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  const seed = "insert into customers values ('a', 'x@example.com'); insert into customers values ('b', 'x@example.com');";
  const db = applied([render(1, "before", before).sql, seed]);
  db.exec("begin");
  assert.throws(() => {
    for (const s of splitStatements(render(2, "unique", plan.statements).sql)) db.exec(s);
  }, /UNIQUE constraint failed: customers\.email/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from customers").all().map((r) => ({ ...r })), [
    { id: "a", email: "x@example.com" },
    { id: "b", email: "x@example.com" },
  ]);
});

test("tightening a CHECK constraint fails the rebuild on a violating row, and the file rolls back", () => {
  const before = [`create table order_lines (id text primary key not null, qty integer)`];
  const after = [`create table order_lines (id text primary key not null, qty integer check (qty > 0))`];
  const plan = diff(introspect(open(before)), introspect(open(after)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  const db = applied([render(1, "before", before).sql, "insert into order_lines values ('a', -1);"]);
  db.exec("begin");
  assert.throws(() => {
    for (const s of splitStatements(render(2, "check", plan.statements).sql)) db.exec(s);
  }, /CHECK constraint failed: qty > 0/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from order_lines").all().map((r) => ({ ...r })), [{ id: "a", qty: -1 }]);
});

// pragma defer_foreign_keys defers a rebuild's own foreign-key checks to
// commit, so an orphaned row does not fail while the rebuild's statements
// run -- it fails at commit, and the whole file still rolls back.
test("adding a foreign key fails at commit on an orphaned row, not mid-rebuild, and the file rolls back", () => {
  const before = [`create table customers (id integer primary key)`, `create table orders (id text primary key not null, customer_id integer)`];
  const after = [`create table customers (id integer primary key)`, `create table orders (id text primary key not null, customer_id integer references customers(id))`];
  const plan = diff(introspect(open(before)), introspect(open(after)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  const db = applied([render(1, "before", before).sql, "insert into orders values ('a', 999);"]);
  db.exec("begin");
  assert.doesNotThrow(() => {
    for (const s of splitStatements(render(2, "foreign-key", plan.statements).sql)) db.exec(s);
  });
  assert.throws(() => db.exec("commit"), /FOREIGN KEY constraint failed/);
  db.exec("rollback");
  assert.deepEqual(db.prepare("select * from orders").all().map((r) => ({ ...r })), [{ id: "a", customer_id: 999 }]);
});

test('rebuilds retain accessible row identities across aliases, shadowing, and renames', () => {
  const cases = [
    { columns:'id text primary key not null, value text', identifier:'rowid', insert:"rowid,id,value", values:"42,'key','kept'" },
    { columns:'id integer primary key, value text', identifier:'id', insert:'id,value', values:"42,'kept'" },
    { columns:'id integer primary key desc, value text', identifier:'rowid', insert:'rowid,id,value', values:"42,99,'kept'" },
    { columns:'RowId text, _rowid_ text, value text', identifier:'oid', insert:'oid,RowId,_rowid_,value', values:"42,'shadow','other','kept'" },
    { columns:'id integer primary key, rowid text, _rowid_ text, oid text, value text', identifier:'id', insert:'id,rowid,_rowid_,oid,value', values:"42,'r','u','o','kept'" },
    { columns:'id text primary key, _solarsql_rowid integer, value text', identifier:'rowid', insert:'rowid,id,_solarsql_rowid,value', values:"42,'key',99,'kept'" },
  ];
  for (const fixture of cases) {
    const db = open([`create table t(${fixture.columns})`]);
    const target = open([`create table t(${fixture.columns.replace('value text','value text not null')})`]);
    try {
      db.exec(`insert into t(${fixture.insert}) values(${fixture.values})`);
      const before = db.prepare(`select ${fixture.identifier} as identity,* from t`).all();
      const plan = diff(introspect(db),introspect(target));
      assert.equal(plan.kind,'ok',JSON.stringify(plan));
      db.exec('begin');
      for (const sql of plan.statements) db.exec(sql);
      db.exec('commit');
      assert.deepEqual(db.prepare(`select ${fixture.identifier} as identity,* from t`).all(),before,fixture.columns);
    } finally { db.close();target.close(); }
  }
  const db = open(['create table t(id integer primary key, value text)']);
  const target = open(['create table t(key integer primary key, value text not null, computed text as (value))']);
  try {
    db.exec("insert into t values(42,'kept')");
    const plan = diff(introspect(db),introspect(target),[{table:'t',from:'id',to:'key'}]);
    if (plan.kind !== 'ok') throw new Error(plan.reason);
    db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
    assert.deepEqual({...db.prepare('select * from t').get()},{key:42,value:'kept',computed:'kept'});
  } finally {db.close();target.close();}
});

test('rebuilds block inaccessible row identities and changed primary-key aliases', () => {
  for (const [before,after] of [
    ['rowid text, _rowid_ text, oid text, value text','rowid text, _rowid_ text, oid text, value text not null'],
    ['id integer, value text','id integer primary key, value text not null'],
    ['id integer primary key desc, value text','id integer primary key, value text not null'],
  ]) {
    const db=open([`create table t(${before})`]), target=open([`create table t(${after})`]);
    try {
      const plan=diff(introspect(db),introspect(target));
      assert.equal(plan.kind,'blocked');
      if(plan.kind==='blocked')assert.match(plan.reason,/rowid preservation.*explicit migration/);
    }finally{db.close();target.close();}
  }
});

// The rowid-preservation section only applies when both sides keep a rowid:
// a WITHOUT ROWID table has no "rowid" column to select, so entering that
// section for one anyway fails the capture SELECT outright.
test('a rebuild only preserves rowid identity when neither side is WITHOUT ROWID', () => {
  const db = open(['create table t (id text primary key, value text) without rowid']);
  const target = open(['create table t (id text primary key, value text not null)']);
  try {
    const plan = diff(introspect(db), introspect(target));
    assert.equal(plan.kind, 'ok', plan.kind === 'blocked' ? plan.reason : '');
    if (plan.kind !== 'ok') return;
    for (const sql of plan.statements) db.exec(sql);
    assert.deepEqual(shape(introspect(db)), shape(introspect(target)));
  } finally { db.close(); target.close(); }
});

// A missing source identifier alone, with a free target identifier, must
// still refuse: either side missing its own usable identifier is enough,
// not only both sides missing one together.
test('a rebuild refuses when only the source side has no free row identifier', () => {
  const db = open(['create table t (rowid text, _rowid_ text, oid text, value text)']);
  const target = open(['create table t (rowid text, _rowid_ text, value text not null)']);
  try {
    const plan = diff(introspect(db), introspect(target), [], [{ kind: 'column', table: 't', column: 'oid' }]);
    assert.equal(plan.kind, 'blocked');
    if (plan.kind === 'blocked') assert.match(plan.reason, /rowid preservation.*explicit migration/);
  } finally { db.close(); target.close(); }
});

// A target column loses its INTEGER PRIMARY KEY alias without gaining a
// different one: rowidAlias becomes null, which does not by itself shadow
// or change an alias the way a *replaced* alias does, so this rebuild must
// proceed (capturing the identifier separately), not refuse.
test('a rebuild proceeds when the target only drops its primary-key alias, not replaces it', () => {
  const db = open(['create table t (id integer primary key, value text)']);
  const target = open(['create table t (id integer, value text not null)']);
  try {
    db.exec("insert into t (id, value) values (7, 'kept')");
    const plan = diff(introspect(db), introspect(target));
    assert.equal(plan.kind, 'ok', plan.kind === 'blocked' ? plan.reason : '');
    if (plan.kind !== 'ok') return;
    for (const sql of plan.statements) db.exec(sql);
    assert.deepEqual({ ...db.prepare('select rowid as identity, * from t').get() }, { identity: 7, id: 7, value: 'kept' });
  } finally { db.close(); target.close(); }
});

// A table named "" is a pathological but legal SQLite identifier: it forces
// the rebuild's own generated temporary names (its copy table, and its
// AUTOINCREMENT high-water-mark table) to differ from the real table they
// stand in for, or the CREATE TABLE that builds them collides with it.
test('a rebuild names its temporary tables apart from a table named the empty string', () => {
  const db = open([`create table "" (id integer primary key autoincrement, value text) strict`]);
  const target = open([`create table "" (id integer primary key autoincrement, value text not null) strict`]);
  try {
    db.exec(`insert into "" values (100, 'removed'); delete from ""`);
    const plan = diff(introspect(db), introspect(target));
    assert.equal(plan.kind, 'ok', plan.kind === 'blocked' ? plan.reason : '');
    if (plan.kind !== 'ok') return;
    for (const sql of plan.statements) db.exec(sql);
    assert.equal(db.prepare(`insert into "" (value) values ('next') returning id`).get()!.id, 101);
  } finally { db.close(); target.close(); }
});

// A table name holding a single quote must be escaped the same way inside
// the rebuild's sqlite_sequence string literal as SQL's own quoting rule:
// doubling the quote, not just any non-empty substitution.
test("a rebuild escapes a table name's own quote in its sqlite_sequence literal", () => {
  const ddl = (value: string) => `create table "o'clock" (id integer primary key autoincrement, ${value}) strict`;
  const db = open([ddl('value text')]);
  const target = open([ddl('value text not null')]);
  try {
    db.exec(`insert into "o'clock" values (100, 'removed'); delete from "o'clock"`);
    const plan = diff(introspect(db), introspect(target));
    assert.equal(plan.kind, 'ok', plan.kind === 'blocked' ? plan.reason : '');
    if (plan.kind !== 'ok') return;
    for (const sql of plan.statements) db.exec(sql);
    assert.equal(db.prepare(`insert into "o'clock" (value) values ('next') returning id`).get()!.id, 101);
  } finally { db.close(); target.close(); }
});

test('rebuilds preserve generated row identities and declared values', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  property(tc=>{
    const id=tc.draw(gs.integers({minValue:-1_000_000,maxValue:1_000_000}));
    const value=tc.draw(gs.text({maxSize:50}));
    const db=open(['create table t(id text primary key not null,value text) strict']);
    const target=open(['create table t(id text primary key not null,value text not null) strict']);
    try {
      db.prepare('insert into t(rowid,id,value) values(?,?,?)').run(id,'key',value);
      const before=db.prepare('select rowid,* from t').all();
      const plan=diff(introspect(db),introspect(target));
      if(plan.kind!=='ok')throw new Error(plan.reason);
      db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
      assert.deepEqual(db.prepare('select rowid,* from t').all(),before);
    }finally{db.close();target.close();}
  });
});

test('AUTOINCREMENT rebuilds preserve deleted maxima, empty history, and rollback', () => {
  const ddl='create table t(id integer primary key autoincrement,value text) strict';
  const target=open([ddl.replace('value text','value text not null')]);
  try {
    for(const seed of ["insert into t values(100,'removed');delete from t;insert into t values(1,'kept')", "insert into t values(100,'removed');delete from t", '']) {
      const db=open([ddl]);
      try {
        db.exec(seed);
        const plan=diff(introspect(db),introspect(target));
        if(plan.kind!=='ok')throw new Error(plan.reason);
        db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
        assert.equal(db.prepare("insert into t(value) values('next') returning id").get()!.id,seed?101:1);
      }finally{db.close();}
    }
    const db=open([ddl]);
    try {
      db.exec('insert into t values(100,null)');
      const plan=diff(introspect(db),introspect(target));
      if(plan.kind!=='ok')throw new Error(plan.reason);
      db.exec('begin');
      assert.throws(()=>{for(const sql of plan.statements)db.exec(sql);},/NOT NULL/);
      db.exec('rollback');
      assert.equal(db.prepare("insert into t(value) values('next') returning id").get()!.id,101);
      assert.equal(db.prepare('select count(*) as n from t').get()!.n,2);
    }finally{db.close();}
  }finally{target.close();}
});

test('sequence preservation follows the keyword and explicit AUTOINCREMENT transitions', () => {
  for(const [from,to] of [
    ['id integer primary key, value text /* autoincrement */', 'id integer primary key, value text not null /* autoincrement */'],
    ['id integer primary key, "autoincrement" text, value text', 'id integer primary key, "autoincrement" text, value text not null'],
    ['id integer primary key, value text default \'autoincrement\'', 'id integer primary key, value text not null default \'autoincrement\''],
    ['id integer primary key, value text','id integer primary key autoincrement, value text'],
    ['id integer primary key autoincrement, value text','id integer primary key, value text'],
  ]) {
    const db=open([`create table t(${from}) strict`]),target=open([`create table t(${to}) strict`]);
    try {
      db.exec("insert into t(id,value) values(1,'kept')");
      const plan=diff(introspect(db),introspect(target));
      if(plan.kind!=='ok')throw new Error(plan.reason);
      assert.equal(plan.statements.some(sql=>sql.includes('_solarsql_sequence_')),false);
      db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
      assert.equal(db.prepare("insert into t(value) values('next') returning id").get()!.id,2);
    }finally{db.close();target.close();}
  }
});

test('AUTOINCREMENT histories retain their next identifier after rebuilding', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  property(tc=>{
    const high=tc.draw(gs.integers({minValue:2,maxValue:1_000_000}));
    const keep=tc.draw(gs.booleans());
    const ddl='create table t(id integer primary key autoincrement,value text) strict';
    const db=open([ddl]),target=open([ddl.replace('value text','value text not null')]);
    try {
      db.prepare('insert into t values(?,null)').run(high);db.exec('delete from t');
      if(keep)db.exec("insert into t values(1,'kept')");
      const plan=diff(introspect(db),introspect(target));
      if(plan.kind!=='ok')throw new Error(plan.reason);
      db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
      assert.equal(db.prepare("insert into t(value) values('next') returning id").get()!.id,high+1);
    }finally{db.close();target.close();}
  });
});

test('an exhausted 64-bit AUTOINCREMENT history stays exhausted after rebuilding', () => {
  const ddl='create table t(id integer primary key autoincrement,value text) strict';
  const db=open([ddl]),target=open([ddl.replace('value text','value text not null')]);
  try {
    db.exec("insert into t values(9223372036854775807,'removed');delete from t");
    const plan=diff(introspect(db),introspect(target));
    if(plan.kind!=='ok')throw new Error(plan.reason);
    db.exec('begin');for(const sql of plan.statements)db.exec(sql);db.exec('commit');
    assert.throws(()=>db.exec("insert into t(value) values('next')"), /database or disk is full/);
  }finally{db.close();target.close();}
});
