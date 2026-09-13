// Adding STRICT to an existing table is a table rebuild, and a row whose
// stored value does not match the declared type fails that rebuild loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
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
