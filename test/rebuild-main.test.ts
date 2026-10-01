// Responsibility: rebuilds must preserve main and TEMP rows independently.
// Boundary: workerd execution is covered by the Miniflare companion test.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { applied, diff, introspect, open, render, shape, type DropIntent, type Rename } from "../src/build/migration.ts";
import { migrate, storageOf } from "../src/node.ts";
import { migrate as migrateDurable } from "../src/durable.ts";

test("introspect reads main columns and foreign keys beneath TEMP shadows", () => {
  const ddl = ["create table parent(id integer primary key)", "create table t(a integer primary key,b text,c integer references parent(id))"];
  const db = open(ddl), direct = open(ddl);
  try {
    db.exec("create temp table other(id integer primary key); create temp table t(a integer primary key,b text references other(id))");
    assert.deepEqual(introspect(db), introspect(direct));
  } finally { db.close(); direct.close(); }
});

test("qualified and unqualified ALTER and DROP histories replay to the same main schema", () => {
  hegel.test(tc => {
    const schema = [..."main"].map(c => tc.draw(gs.booleans()) ? c.toUpperCase() : c).join("");
    const prefix = tc.draw(gs.sampledFrom([`${schema}.`, `"${schema}".`, `\`${schema}\`.`, `[${schema}].`, `'${schema}'.`]));
    const first = "create table t(a int,b text); create index i on t(b); create view v as select b from t; create trigger tr after insert on t begin select 1; end; create table obsolete(a int);";
    const history = (qualifier: string) => `drop view ${qualifier}v; drop trigger ${qualifier}tr; drop index ${qualifier}i; alter table ${qualifier}t rename column b to c; alter table ${qualifier}t drop column a; alter table ${qualifier}t add column d text; drop table ${qualifier}obsolete;`;
    const qualified = applied([first, history(prefix)]), unqualified = applied([first, history("")]);
    try { assert.deepEqual(shape(introspect(qualified)), shape(introspect(unqualified))); }
    finally { qualified.close(); unqualified.close(); }
  });
});

test.each(["node", "durable"] as const)("%s migrate fills a main search table from main rows while preserving TEMP rows", target => {
  const base = "create table t(a integer primary key,b text)";
  const db = open([base]);
  const declared = open([base, "create virtual table search using fts5(b)", "create trigger tr after insert on t begin insert into search(b) values(new.b); end"]);
  try {
    db.exec("insert into main.t values(1,'main'); create temp table t(a integer primary key,b text); insert into temp.t values(2,'temp'); create temp table search(b text); insert into temp.search values('untouched')");
    const tempSchema = db.prepare("select * from temp.sqlite_schema order by name").all();
    const plan = diff(introspect(db), introspect(declared));
    if (plan.kind !== "ok") throw new Error(plan.reason);
    assert.equal(plan.statements[1], 'insert into main."search" ("b") select "b" from main."t"');
    const file = render(1, "search", plan.statements, plan.rebuilds);
    if (target === "node") migrate(db, [{ name: file.filename, sql: file.sql }]);
    else migrateDurable(storageOf(db), [{ name: file.filename, sql: file.sql }]);
    assert.deepEqual(db.prepare("select b from main.search").all().map(r => ({ ...r })), [{ b: "main" }]);
    assert.deepEqual(db.prepare("select * from temp.search").all().map(r => ({ ...r })), [{ b: "untouched" }]);
    assert.deepEqual(db.prepare("select * from temp.t").all().map(r => ({ ...r })), [{ a: 2, b: "temp" }]);
    assert.deepEqual(db.prepare("select * from temp.sqlite_schema order by name").all(), tempSchema);
  } finally { db.close(); declared.close(); }
});

test.each(["node", "durable"] as const)("%s migrate changes main through ALTER, DROP and object replacement while preserving TEMP objects", target => {
  const base = "create table t(a integer primary key,b text)";
  const cases: { name: string; before: string[]; after: string[]; statement: string | string[]; renames?: Rename[]; drops?: DropIntent[] }[] = [
    { name: "add column", before: [base], after: ["create table t(a integer primary key,b text,c text)"], statement: 'alter table main."t" add column c text' },
    { name: "drop column", before: [base], after: ["create table t(a integer primary key)"], statement: 'alter table main."t" drop column "b"', drops: [{ kind: "column", table: "t", column: "b" }] },
    { name: "rename column", before: [base], after: ["create table t(a integer primary key,c text)"], statement: 'alter table main."t" rename column "b" to "c"', renames: [{ table: "t", from: "b", to: "c" }] },
    { name: "drop table", before: [base], after: [], statement: 'drop table main."t"', drops: [{ kind: "table", table: "t" }] },
    { name: "drop index", before: [base, "create index i on t(b)"], after: [base], statement: 'drop index main."i"' },
    { name: "drop trigger", before: [base, "create trigger tr after insert on t begin select 1; end"], after: [base], statement: 'drop trigger main."tr"' },
    { name: "drop view", before: [base, "create view v as select * from t"], after: [base], statement: 'drop view main."v"' },
    { name: "replace index", before: [base, "create index i on t(a)"], after: [base, "create index i on t(b)"], statement: ['drop index main."i"', 'CREATE INDEX main.i on t(b)'] },
    { name: "replace trigger", before: [base, "create trigger tr after insert on t begin select 1; end"], after: [base, "create trigger tr after insert on t begin select 3; end"], statement: ['drop trigger main."tr"', 'CREATE TRIGGER main.tr after insert on t BEGIN select 3; END'] },
  ];
  for (const scenario of cases) {
    const db = open(scenario.before), declared = open(scenario.after);
    try {
      db.exec("insert into main.t values(1,'main')");
      db.exec("create temp table t(a integer primary key,b text); insert into temp.t values(2,'temp')");
      db.exec("create index temp.i on t(b); create temp view v as select * from temp.t; create temp trigger tr after insert on t begin select 2; end");
      const tempSchema = db.prepare("select * from temp.sqlite_schema order by name").all();
      const tempRows = db.prepare("select * from temp.t").all();
      const plan = diff(introspect(db), introspect(declared), scenario.renames, scenario.drops);
      if (plan.kind !== "ok") throw new Error(`${scenario.name}: ${plan.reason}`);
      assert.deepEqual(plan.statements, Array.isArray(scenario.statement) ? scenario.statement : [scenario.statement], scenario.name);
      assert.equal(plan.rebuilds, undefined, scenario.name);
      const file = render(1, scenario.name.replaceAll(" ", "_"), plan.statements, plan.rebuilds);
      if (target === "node") migrate(db, [{ name: file.filename, sql: file.sql }]);
      else migrateDurable(storageOf(db), [{ name: file.filename, sql: file.sql }]);
      assert.deepEqual(db.prepare("select * from temp.sqlite_schema order by name").all(), tempSchema, scenario.name);
      assert.deepEqual(db.prepare("select * from temp.t").all(), tempRows, scenario.name);
      const actual = introspect(db);
      actual.tables.delete("solarsql_migrations");
      assert.deepEqual(shape(actual), shape(introspect(declared)), scenario.name);
      if (scenario.name !== "drop table") {
        const expected = scenario.name === "drop column" ? { a: 1 } : scenario.name === "rename column" ? { a: 1, c: "main" } : scenario.name === "add column" ? { a: 1, b: "main", c: null } : { a: 1, b: "main" };
        assert.deepEqual({ ...db.prepare("select * from main.t").get() }, expected, scenario.name);
      }
    } finally { db.close(); declared.close(); }
  }
});

test.each(["node", "durable"] as const)("%s migrate rebuilds main while preserving same-named TEMP objects", target => {
  hegel.test(tc => {
    const value = tc.draw(gs.text());
    const ddl = [
      "create table t(id integer primary key autoincrement,value text)",
      "create index i on t(value)",
      "create view v as select * from t",
      "create trigger tr after insert on t begin select 1; end",
    ];
    const db = open(ddl), declared = open([ddl[0]! + " strict", ...ddl.slice(1)]);
    try {
      db.prepare("insert into main.t values(100,?)").run(value);
      db.exec("delete from main.t");
      db.prepare("insert into main.t values(1,?)").run(value);
      db.exec("create temp table t(id integer primary key autoincrement,value text); insert into temp.t values(2,'temp')");
      db.exec("create index temp.i on t(value); create temp view v as select * from temp.t; create temp trigger tr after insert on t begin select 2; end");
      for (const name of ["_solarsql_new_t", "_solarsql_copy_t", "_solarsql_sequence_t"]) {
        db.exec(`create temp table "${name}"(value text); insert into temp."${name}" values('untouched')`);
      }
      const tempSchema = db.prepare("select * from temp.sqlite_schema order by name").all();
      const tempRows = db.prepare("select * from temp.t").all();
      const tempSequence = db.prepare("select * from temp.sqlite_sequence").all();
      const plan = diff(introspect(db), introspect(declared));
      if (plan.kind !== "ok") throw new Error(plan.reason);
      const file = render(1, "strict", plan.statements, plan.rebuilds);
      const files = [{ name: file.filename, sql: file.sql }];
      if (target === "node") migrate(db, files);
      else migrateDurable(storageOf(db), files);
      assert.equal(introspect(db).tables.get("t")!.strict, true);
      assert.deepEqual(db.prepare("select * from main.t").all().map(r => ({ ...r })), [{ id: 1, value }]);
      assert.deepEqual(db.prepare("select * from temp.t").all(), tempRows);
      assert.deepEqual(db.prepare("select * from temp.sqlite_sequence").all(), tempSequence);
      assert.deepEqual(db.prepare("select * from temp.sqlite_schema order by name").all(), tempSchema);
      for (const name of ["_solarsql_new_t", "_solarsql_copy_t", "_solarsql_sequence_t"]) {
        assert.deepEqual(db.prepare(`select * from temp."${name}"`).all().map(r => ({ ...r })), [{ value: "untouched" }]);
      }
      assert.equal(db.prepare("insert into main.t(value) values('next') returning id").get()!.id, 101);
      const actual = introspect(db);
      actual.tables.delete("solarsql_migrations");
      assert.deepEqual(diff(actual, introspect(declared)), { kind: "ok", statements: [] });
    } finally { db.close(); declared.close(); }
  });
});

test.each(["constraint", "index", "trigger"] as const)("qualified rebuild still refuses to revive a removed %s", kind => {
  const base = "create table t(a int)";
  const declaration = kind === "constraint" ? "create table t(a int,check(a>0))" : base;
  const extra = kind === "index" ? ["create index i on t(a)"] : kind === "trigger" ? ["create trigger tr after insert on t begin select 1; end"] : [];
  const recorded = open([declaration, ...extra]), target = open([declaration + " strict", ...extra]), live = open([base]);
  try {
    const plan = diff(introspect(recorded), introspect(target));
    if (plan.kind !== "ok") throw new Error(plan.reason);
    const file = render(1, "strict", plan.statements, plan.rebuilds);
    assert.throws(() => migrate(live, [{ name: file.filename, sql: file.sql }]), /already removed/);
    assert.throws(() => applied([base + ";", file.sql]), /already removed/);
    assert.equal(introspect(live).tables.get("t")!.strict, false);
  } finally { recorded.close(); target.close(); live.close(); }
});

test.each(["t3/* x */", '"t3"/* x */', "'t3'/* x */", "`t3`/* x */", "[t3]/* x */"])("rebuild preserves the name-adjacent comment in %s", name => {
  const db = open([`create table ${name}(a int)`]);
  const declared = open([`create table ${name}(a int) strict`]);
  const direct = open([`create table ${name}(a int) strict`]);
  try {
    const plan = diff(introspect(db), introspect(declared));
    if (plan.kind !== "ok") throw new Error(plan.reason);
    assert.ok(plan.statements.some(s => s.includes('main."_solarsql_new_t3"/* x */')));
    for (const sql of plan.statements) db.exec(sql);
    direct.exec('alter table t3 rename to other; alter table other rename to "t3"');
    assert.deepEqual(introspect(db), introspect(direct));
  } finally { db.close(); declared.close(); direct.close(); }
});

test.each(["/* c */", "if not exists", "/* c */ if not exists /* d */"])("rebuild executes object headers normalized by SQLite from %s", header => {
  const objects = [
    `create index ${header} i on t(a /* column */)`,
    `create trigger ${header} tr after insert on t begin select 1 /* body */; end`,
    `create view ${header} v as select a /* result */ from t`,
  ];
  const db = open(["create table t(a int)", ...objects]);
  const declared = open(["create table t(a int) strict", ...objects]);
  try {
    const target = introspect(declared);
    assert.equal(target.indexes.get("i")!.sql, "CREATE INDEX i on t(a /* column */)");
    assert.equal(target.triggers.get("tr")!.sql, "CREATE TRIGGER tr after insert on t begin select 1 /* body */; end");
    assert.equal(target.views.get("v")!.sql, "CREATE VIEW v as select a /* result */ from t");
    db.exec("insert into t values(7)");
    const plan = diff(introspect(db), target);
    if (plan.kind !== "ok") throw new Error(plan.reason);
    for (const sql of plan.statements) db.exec(sql);
    assert.deepEqual(shape(introspect(db)), shape(target));
    assert.deepEqual({ ...db.prepare("select * from main.v").get() }, { a: 7 });
    db.exec("insert into main.t values(8)");
    assert.equal(db.prepare("select count(*) as n from main.v").get()!.n, 2);
  } finally { db.close(); declared.close(); }
});

test.each([0, 1])("AUTOINCREMENT rebuild preserves a deleted maximum with %i copied rows", rows => {
  const ddl = "create table t(id integer primary key autoincrement,value text)";
  const db = open([ddl]), declared = open([ddl + " strict"]);
  try {
    db.exec("insert into t values(100,'deleted'); delete from t");
    if (rows) db.exec("insert into t values(1,'kept')");
    const plan = diff(introspect(db), introspect(declared));
    if (plan.kind !== "ok") throw new Error(plan.reason);
    for (const sql of plan.statements) db.exec(sql);
    assert.deepEqual(db.prepare("select name,seq from main.sqlite_sequence").all().map(row => ({ ...row })), [{ name: "t", seq: 100 }]);
    assert.equal(db.prepare("select count(*) as n from main.t").get()!.n, rows);
    assert.equal(db.prepare("insert into main.t(value) values('next') returning id").get()!.id, 101);
  } finally { db.close(); declared.close(); }
});

test("a TEMP table with a non-integer primary key does not hide main's rowid alias from the rebuild", () => {
  const ddl = "create table t(id integer primary key, value text)";
  const db = open([ddl]), declared = open([`create table t(id integer primary key, value text check (value <> ''))`]);
  try {
    db.exec("insert into main.t values(1,'main'); create temp table t(id text primary key, value text); insert into temp.t values('x','temp')");
    const plan = diff(introspect(db), introspect(declared));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    const file = render(1, "check", plan.statements, plan.rebuilds);
    migrate(db, [{ name: file.filename, sql: file.sql }]);
    assert.deepEqual(db.prepare("select * from main.t").all().map(r => ({ ...r })), [{ id: 1, value: "main" }]);
    assert.deepEqual(db.prepare("select * from temp.t").all().map(r => ({ ...r })), [{ id: "x", value: "temp" }]);
    assert.match(String(db.prepare("select sql from main.sqlite_schema where name = 't'").get()!.sql), /check/i);
  } finally { db.close(); declared.close(); }
});
