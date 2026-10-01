// Responsibility: a table rebuild that never knew about a column the table
// actually has, at replay time, refuses instead of silently losing the
// column or its data (ADR 0099).
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { REBUILD_HEADER, splitStatements } from "../src/build/scan.ts";
import { BuildError } from "../src/build/typegen.ts";
import { migrate, MigrationHistoryError } from "../src/node.ts";

test('migrate reads the real columns past a pragma_table_xinfo shadow and refuses a rebuild that loses one', () => {
  const error = /rebuilds table "c" without knowledge of column "value"/;
  for (const ddl of [
    'create table pragma_table_xinfo(name, hidden)',
    "create view PrAgMa_TaBlE_XiNfO as select 'id' as name, 0 as hidden",
    'create virtual table pragma_table_xinfo using fts5(name, hidden)',
  ]) {
    const raw = new DatabaseSync(':memory:');
    try {
      const first = { name: '0001.sql', sql: 'create table c(id integer primary key, value text) strict; insert into c values(1,\'keep\');' + ddl };
      migrate(raw, [first]);
      const record = [{ table: 'c', columns: [{ name: 'id', def: 'integer primary key' }], constraints: [], indexes: [], triggers: [] }];
      const rebuild = { name: '0002.sql', sql: `${REBUILD_HEADER}${JSON.stringify(record)}\ndelete from main.c;` };
      assert.throws(() => migrate(raw, [first, rebuild]), error);
      assert.deepEqual(raw.prepare('select * from main.c').all().map(r => ({ ...r })), [{ id: 1, value: 'keep' }]);
      assert.deepEqual(raw.prepare('select name from solarsql_migrations order by name').all().map(r => r.name), ['0001.sql']);
    } finally { raw.close(); }
  }
});

test("a column's attribution to the file that introduced it survives an unrelated later file's own change to the same table", () => {
  const base = "create table t (id text primary key not null, a text not null, b text not null) strict";
  const addC = "alter table t add column c text";
  // A hand-crafted rebuild header: it knows about "id", "b", and "c" (added
  // by addC), but not "a" -- so "a" is the unknown column, and it must still
  // be named as added by the base file, not by the unrelated addC file that
  // ran afterward and touched the same table.
  const stale = `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "" }, { name: "b", def: "" }, { name: "c", def: "" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(
    () => applied([base + ";", addC + ";", stale], ["0001_base.sql", "0002_add_c.sql", "0003_stale.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_stale\.sql rebuilds table "t" without knowledge of column "a", added by 0001_base\.sql/);
      return true;
    },
  );
});

test("a rebuild-refusal error does not misattribute an unrelated new column to a sibling rename in the same file", () => {
  const base = "create table t (id text primary key not null, a text not null, other text not null) strict";
  // One file both renames "a" to "b" and, unrelatedly, adds "c".
  const renameAndAddC = "alter table t rename column a to b; alter table t add column c text;";
  const stale = `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "" }, { name: "b", def: "" }, { name: "other", def: "" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(
    () => applied([base + ";", renameAndAddC, stale], ["0001_base.sql", "0002_rename_a_add_c.sql", "0003_stale.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_stale\.sql rebuilds table "t" without knowledge of column "c", added by 0002_rename_a_add_c\.sql/);
      assert.doesNotMatch(e.message, /renamed from/);
      return true;
    },
  );
});

test("a rebuild-refusal error does not misattribute a new column to another table's rename that happens to share its target name", () => {
  const base = "create table t1 (id text primary key not null, x text not null) strict; "
    + "create table t2 (id text primary key not null, other text not null) strict";
  // One file renames t1.x to t1.shared and, unrelatedly, adds t2.shared: two
  // different tables, coincidentally the same target column name.
  const renameT1AddT2 = "alter table t1 rename column x to shared; alter table t2 add column shared text;";
  const stale = `${REBUILD_HEADER}${JSON.stringify([{ table: "t2", columns: [{ name: "id", def: "" }, { name: "other", def: "" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(
    () => applied([base + ";", renameT1AddT2, stale], ["0001_base.sql", "0002_rename_t1_add_t2.sql", "0003_stale.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_stale\.sql rebuilds table "t2" without knowledge of column "shared", added by 0002_rename_t1_add_t2\.sql/);
      assert.doesNotMatch(e.message, /renamed from/);
      return true;
    },
  );
});

test("a rebuild that never knew about a concurrently added column refuses to replay, instead of silently losing it", () => {
  const base = "create table customers (id text primary key not null, email text not null, name text not null) strict";
  const targetA = "create table customers (id text primary key not null, email text, name text not null) strict"; // branch A: drops NOT NULL on email, never heard of fax
  const targetB = "create table customers (id text primary key not null, email text not null, name text not null, fax text) strict"; // branch B: adds fax

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "email_nullable", planA.statements, planA.rebuilds ?? []);

  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_fax", planB.statements, planB.rebuilds ?? []);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_add_fax.sql", "0003_email_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_email_nullable\.sql rebuilds table "customers" without knowledge of column "fax", added by 0002_add_fax\.sql/);
      assert.match(e.message, /Delete 0003_email_nullable\.sql and run `solarsql migration` again/);
      assert.equal(e.action, 'Delete 0003_email_nullable.sql and run `solarsql migration` again against the merged schema.');
      return true;
    },
  );
});

test("a rebuild-refusal error names the file that most recently (re-)introduced a column, not the file that first ever did", () => {
  const base = "create table t (id text primary key not null, y text not null) strict";
  const addX = "alter table t add column x text";
  const dropX = "alter table t drop column x";
  const reAddX = "alter table t add column x text";

  const beforeReAdd = open([base, addX, dropX]);
  const target = "create table t (id text primary key not null, y text) strict"; // drop NOT NULL on y
  const plan = diff(introspect(beforeReAdd), introspect(open([target])));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const file5 = render(5, "y_nullable", plan.statements, plan.rebuilds ?? []);

  assert.throws(
    () => applied(
      [base + ";", addX + ";", dropX + ";", reAddX + ";", file5.sql],
      ["0001_base.sql", "0002_add_x.sql", "0003_drop_x.sql", "0004_readd_x.sql", "0005_y_nullable.sql"],
    ),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0005_y_nullable\.sql rebuilds table "t" without knowledge of column "x", added by 0004_readd_x\.sql/);
      assert.doesNotMatch(e.message, /0002_add_x\.sql/);
      return true;
    },
  );
});

test("a rebuild-refusal error names a column renamed by RENAME COLUMN as renamed, not added", () => {
  const base = "create table t (id text primary key not null, a text not null, y text not null) strict";
  const baseDb = open([base]);

  // 0002: an independent migration renames "a" to "b" with a plain RENAME
  // COLUMN, no rebuild involved.
  const targetRenamed = "create table t (id text primary key not null, b text not null, y text not null) strict";
  const planRename = diff(introspect(baseDb), introspect(open([targetRenamed])), [{ table: "t", from: "a", to: "b" }]);
  assert.equal(planRename.kind, "ok");
  if (planRename.kind !== "ok") return;
  const fileRename = render(2, "rename_a_to_b", planRename.statements, planRename.rebuilds ?? []);

  // 0003: a concurrently generated, unrelated rebuild (dropping NOT NULL on
  // "y"), generated against the pre-rename schema. Its RebuildRecord still
  // names "a", not "b".
  const targetYNullable = "create table t (id text primary key not null, a text not null, y text) strict";
  const planY = diff(introspect(baseDb), introspect(open([targetYNullable])));
  assert.equal(planY.kind, "ok");
  if (planY.kind !== "ok") return;
  const fileY = render(3, "y_nullable", planY.statements, planY.rebuilds ?? []);

  assert.throws(
    () => applied(
      [base + ";", fileRename.sql, fileY.sql],
      ["0001_base.sql", "0002_rename_a_to_b.sql", "0003_y_nullable.sql"],
    ),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /rebuilds table "t" without knowledge of column "b", renamed from "a" by 0002_rename_a_to_b\.sql/);
      assert.match(e.message, /A database that replays 0003_y_nullable\.sql loses "b" and its data\./);
      assert.doesNotMatch(e.message, /added by 0002_rename_a_to_b\.sql/);
      return true;
    },
  );
});

test("a rebuild that redeclares a concurrently added column under the same name refuses to replay, instead of nulling its value", () => {
  const base = "create table customers (id text primary key not null, email text not null, name text not null) strict";
  const targetA = "create table customers (id text primary key not null, email text, name text not null, fax text) strict"; // branch A rebuilds AND independently adds fax
  const targetB = "create table customers (id text primary key not null, email text not null, name text not null, fax text) strict"; // branch B just adds fax

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "email_nullable_and_fax", planA.statements, planA.rebuilds ?? []);

  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_fax", planB.statements, planB.rebuilds ?? []);

  // A live database: base, then B (adds and populates fax), matching what a
  // real deploy already did before the renumbered A ever runs.
  const live = new DatabaseSync(":memory:");
  live.exec(base);
  live.exec(`insert into customers (id, email, name) values ('c1', 'a@b.com', 'Alice')`);
  for (const s of splitStatements(fileB.sql)) live.exec(s);
  live.exec(`update customers set fax = '555-1234' where id = 'c1'`);
  assert.deepEqual({ ...live.prepare("select fax from customers where id='c1'").get() }, { fax: "555-1234" });

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_add_fax.sql", "0003_email_nullable_and_fax.sql"]),
    /rebuilds table "customers" without knowledge of column "fax"/,
  );

  // The refusal is a build-time replay check on a fresh in-memory database,
  // not an action on `live`; confirm the live row is untouched regardless.
  assert.deepEqual({ ...live.prepare("select fax from customers where id='c1'").get() }, { fax: "555-1234" });
});

test("a rebuild that intentionally drops a column it saw at generation time still replays", () => {
  const before = ["create table t (id text primary key not null, extra text) strict"];
  const target = open(["create table t (id text primary key not null) strict"]);
  const current = open(before);
  const plan = diff(introspect(current), introspect(target), [], [{ kind: "column", table: "t", column: "extra" }]);
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const file = render(2, "drop_extra", plan.statements, plan.rebuilds ?? []);
  const db = applied([before[0]! + ";", "insert into t (id, extra) values ('a', 'x');", file.sql], ["0001_before.sql", "0002_insert.sql", "0003_drop_extra.sql"]);
  assert.deepEqual({ ...db.prepare("select * from t").get() }, { id: "a" });
});

test("regenerating the rebuild against the merged schema replays cleanly and preserves the data", () => {
  const base = "create table customers (id text primary key not null, email text not null, name text not null) strict";
  const targetB = "create table customers (id text primary key not null, email text not null, name text not null, fax text) strict";
  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_fax", planB.statements, planB.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  live.exec(`insert into customers (id, email, name) values ('c1', 'a@b.com', 'Alice')`);
  for (const s of splitStatements(fileB.sql)) live.exec(s);
  live.exec(`update customers set fax = '555-1234' where id = 'c1'`);

  // The developer's repair: delete the refused file, generate a new one
  // against the schema as it now stands (fax already present).
  const mergedTarget = "create table customers (id text primary key not null, email text, name text not null, fax text) strict";
  const regenerated = diff(introspect(live), introspect(open([mergedTarget])));
  assert.equal(regenerated.kind, "ok");
  if (regenerated.kind !== "ok") return;
  const fileC = render(3, "email_nullable", regenerated.statements, regenerated.rebuilds ?? []);
  for (const s of splitStatements(fileC.sql)) live.exec(s);
  assert.deepEqual({ ...live.prepare("select * from customers where id='c1'").get() }, { id: "c1", email: "a@b.com", name: "Alice", fax: "555-1234" });
});

test("a Durable Object's runtime migrate() also refuses a rebuild that does not know about a column the table already has", () => {
  const base = "create table customers (id text primary key not null, email text not null, name text not null) strict";
  const targetA = "create table customers (id text primary key not null, email text, name text not null) strict";
  const targetB = "create table customers (id text primary key not null, email text not null, name text not null, fax text) strict";

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "email_nullable", planA.statements, planA.rebuilds ?? []);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_fax", planB.statements, planB.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_fax.sql", sql: fileB.sql }]);
  db.exec(`insert into customers (id, email, name) values ('c1', 'a@b.com', 'Alice')`);
  db.exec(`update customers set fax = '555-1234' where id = 'c1'`);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_fax.sql", sql: fileB.sql },
      { name: "0003_email_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "customers" without knowledge of column "fax"/);
      return true;
    },
  );

  assert.deepEqual({ ...db.prepare("select fax from customers where id='c1'").get() }, { fax: "555-1234" });
});

test("a Durable Object's runtime migrate() also refuses a rebuild that does not know about a concurrently added generated column", () => {
  const base = "create table t (id text primary key not null, a integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer) strict"; // branch A: drops NOT NULL on a, never heard of b
  const targetB = "create table t (id text primary key not null, a integer not null, b integer as (a * 2) stored) strict"; // branch B: adds a STORED generated column

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_b", planB.statements, planB.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_b.sql", sql: fileB.sql }]);
  db.exec("insert into t (id, a) values ('x', 5)");

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_b.sql", sql: fileB.sql },
      { name: "0003_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" without knowledge of column "b"/);
      return true;
    },
  );

  assert.deepEqual({ ...db.prepare("select * from t where id='x'").get() }, { id: "x", a: 5, b: 10 });
});

test("two independent rebuilds of the same table, each dropping NOT NULL on a different column, refuse to replay when the later one's recorded shape is stale", () => {
  const base = "create table t (id text primary key not null, a text not null, c text not null) strict";
  const targetA = "create table t (id text primary key not null, a text, c text not null) strict"; // branch A: drops NOT NULL on a, never heard of B's change to c
  const targetB = "create table t (id text primary key not null, a text not null, c text) strict"; // branch B: drops NOT NULL on c, independently of A

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "c_nullable", planB.statements, planB.rebuilds ?? []);

  // A live database: base, then B (drops NOT NULL on c), matching what a
  // real deploy already did before the renumbered A ever runs.
  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);
  const cBefore = live.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "c") as { notnull: number };
  assert.equal(cBefore.notnull, 0);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_c_nullable.sql", "0003_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_a_nullable\.sql rebuilds table "t" with a stale declaration of column "c"/);
      assert.match(e.message, /A database that replays 0003_a_nullable\.sql loses that change\./);
      return true;
    },
  );

  // The refusal is a build-time replay check on a fresh in-memory database,
  // not an action on `live`; confirm B's change (c's NOT NULL already
  // dropped) is still the live database's actual shape, not "c" reverted
  // to NOT NULL and not any other mutation.
  const cAfter = live.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "c") as { notnull: number };
  assert.equal(cAfter.notnull, 0);
});

test("a Durable Object's runtime migrate() also refuses a rebuild with a stale declaration of a column a sibling rebuild changed", () => {
  const base = "create table t (id text primary key not null, a text not null, c text not null) strict";
  const targetA = "create table t (id text primary key not null, a text, c text not null) strict";
  const targetB = "create table t (id text primary key not null, a text not null, c text) strict";

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "c_nullable", planB.statements, planB.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_c_nullable.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_c_nullable.sql", sql: fileB.sql },
      { name: "0003_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" with a stale declaration of column "c"/);
      return true;
    },
  );

  // The refusal runs before "0003_a_nullable.sql"'s statements execute, on
  // the same database migrate() operates on directly (not a copy): B's
  // change (c's NOT NULL already dropped) is still there, unmutated.
  const row = db.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "c") as { notnull: number };
  assert.equal(row.notnull, 0);
});

test("a single rebuild that changes a column's declared shape, with no conflicting sibling, still replays", () => {
  const base = "create table t (id text primary key not null, a text not null) strict";
  const target = "create table t (id text primary key not null, a text) strict"; // drops NOT NULL on a
  const current = open([base]);
  const plan = diff(introspect(current), introspect(open([target])));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const file = render(2, "a_nullable", plan.statements, plan.rebuilds ?? []);
  const db = applied([base + ";", file.sql], ["0001_base.sql", "0002_a_nullable.sql"]);
  const row = db.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "a") as { notnull: number };
  assert.equal(row.notnull, 0);
});

test("a Durable Object's runtime migrate() also accepts a single rebuild that changes a column's declared shape, with no conflicting sibling", () => {
  const base = "create table t (id text primary key not null, a text not null) strict";
  const target = "create table t (id text primary key not null, a text) strict";
  const current = open([base]);
  const plan = diff(introspect(current), introspect(open([target])));
  if (plan.kind !== "ok") throw new Error("plan blocked");
  const file = render(2, "a_nullable", plan.statements, plan.rebuilds ?? []);
  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_a_nullable.sql", sql: file.sql }]);
  const row = db.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "a") as { notnull: number };
  assert.equal(row.notnull, 0);
});

// ADR 0102: a rebuild's DROP TABLE also silently drops a table-level
// constraint, an index, or a trigger the table already has, unless the
// rebuild's own generator knew about it. The tests below extend the column
// checks above to those three kinds of declaration.

test("a table-level constraint added by one rebuild is lost when a sibling rebuild of the same table replays without knowing about it", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict"; // branch B: adds a table-level UNIQUE
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null, check (a + b > 0)) strict"; // branch A: independently adds a table-level CHECK

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_unique", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "add_check", planA.statements, planA.rebuilds ?? []);

  // A live database: base, then B (adds the UNIQUE), matching what a real
  // deploy already did before the renumbered A ever runs.
  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_add_unique.sql", "0003_add_check.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_add_check\.sql rebuilds table "t" without knowledge of a table-level constraint it already has/);
      assert.match(e.message, /unique\(a,b\)/);
      assert.match(e.message, /A database that replays 0003_add_check\.sql loses that constraint\./);
      return true;
    },
  );

  // The refusal does not touch `live`; B's UNIQUE is still there.
  const row = live.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.match(row.sql, /unique\s*\(\s*a\s*,\s*b\s*\)/i);
});

test("a Durable Object's runtime migrate() also refuses a rebuild that does not know about a table-level constraint a sibling rebuild added", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null, check (a + b > 0)) strict";

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_unique", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "add_check", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_unique.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_unique.sql", sql: fileB.sql },
      { name: "0003_add_check.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" without knowledge of a table-level constraint it already has/);
      assert.match(e.message, /unique\(a,b\)/);
      return true;
    },
  );

  const row = db.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.match(row.sql, /unique\s*\(\s*a\s*,\s*b\s*\)/i);
});

test("an index added by one branch is lost when an unrelated rebuild of the same table replays without knowing about it", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unrelated to the index

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([base, "create index idx_b on t(b)"])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_idx_b", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_add_idx_b.sql", "0003_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_a_nullable\.sql rebuilds table "t" without knowledge of index "idx_b" it already has/);
      assert.match(e.message, /A database that replays 0003_a_nullable\.sql loses that index\./);
      return true;
    },
  );

  const row = live.prepare(`select name from sqlite_schema where type = 'index' and tbl_name = 't' and name = 'idx_b'`).get();
  assert.ok(row, "idx_b should still exist on the live database");
});

test("a Durable Object's runtime migrate() also refuses a rebuild that does not know about an index an unrelated migration added", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict";

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([base, "create index idx_b on t(b)"])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_idx_b", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_idx_b.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_idx_b.sql", sql: fileB.sql },
      { name: "0003_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" without knowledge of index "idx_b" it already has/);
      return true;
    },
  );

  const row = db.prepare(`select name from sqlite_schema where type = 'index' and tbl_name = 't' and name = 'idx_b'`).get();
  assert.ok(row, "idx_b should still exist");
});

test("a trigger added by one branch is lost when an unrelated rebuild of the same table replays without knowing about it", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unrelated to the trigger
  const triggerSql = "create trigger trg_b after insert on t begin update t set b = b + 1 where id = new.id; end";

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([base, triggerSql])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_trg_b", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_add_trg_b.sql", "0003_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_a_nullable\.sql rebuilds table "t" without knowledge of trigger "trg_b" it already has/);
      assert.match(e.message, /A database that replays 0003_a_nullable\.sql loses that trigger and the behavior it maintains\./);
      return true;
    },
  );

  const row = live.prepare(`select name from sqlite_schema where type = 'trigger' and tbl_name = 't' and name = 'trg_b'`).get();
  assert.ok(row, "trg_b should still exist on the live database");
});

test("a Durable Object's runtime migrate() also refuses a rebuild that does not know about a trigger an unrelated migration added", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict";
  const triggerSql = "create trigger trg_b after insert on t begin update t set b = b + 1 where id = new.id; end";

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([base, triggerSql])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_trg_b", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_trg_b.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_trg_b.sql", sql: fileB.sql },
      { name: "0003_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "t" without knowledge of trigger "trg_b" it already has/);
      return true;
    },
  );

  const row = db.prepare(`select name from sqlite_schema where type = 'trigger' and tbl_name = 't' and name = 'trg_b'`).get();
  assert.ok(row, "trg_b should still exist");
});

test("a single rebuild that adds a table-level constraint, with no conflicting sibling, still replays", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const target = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const current = open([base]);
  const plan = diff(introspect(current), introspect(open([target])));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const file = render(2, "add_unique", plan.statements, plan.rebuilds ?? []);
  const db = applied([base + ";", file.sql], ["0001_base.sql", "0002_add_unique.sql"]);
  const row = db.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.match(row.sql, /unique\s*\(\s*a\s*,\s*b\s*\)/i);
});

test("a single rebuild that intentionally drops a table-level constraint it saw at generation time still replays", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const target = "create table t (id text primary key not null, a integer not null, b integer not null) strict"; // drops the UNIQUE
  const current = open([base]);
  const plan = diff(introspect(current), introspect(open([target])));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const file = render(2, "drop_unique", plan.statements, plan.rebuilds ?? []);
  const db = applied([base + ";", file.sql], ["0001_base.sql", "0002_drop_unique.sql"]);
  const row = db.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.doesNotMatch(row.sql, /unique/i);
});

test("regenerating a rebuild against the merged schema replays cleanly and keeps both siblings' table-level constraints", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "add_unique", planB.statements, planB.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  // The developer's repair: delete the refused file (branch A's CHECK),
  // generate a new one against the schema as it now stands (UNIQUE already
  // present), keeping both siblings' table-level constraints.
  const mergedTarget = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b), check (a + b > 0)) strict";
  const regenerated = diff(introspect(live), introspect(open([mergedTarget])));
  assert.equal(regenerated.kind, "ok");
  if (regenerated.kind !== "ok") return;
  const fileC = render(3, "add_check", regenerated.statements, regenerated.rebuilds ?? []);
  for (const s of splitStatements(fileC.sql)) live.exec(s);

  const row = live.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.match(row.sql, /unique\s*\(\s*a\s*,\s*b\s*\)/i);
  assert.match(row.sql, /check\s*\(\s*a\s*\+\s*b\s*>\s*0\s*\)/i);

  const replayed = applied([base + ";", fileB.sql, fileC.sql], ["0001_base.sql", "0002_add_unique.sql", "0003_add_check.sql"]);
  const replayedRow = replayed.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.match(replayedRow.sql, /unique\s*\(\s*a\s*,\s*b\s*\)/i);
  assert.match(replayedRow.sql, /check\s*\(\s*a\s*\+\s*b\s*>\s*0\s*\)/i);
});

// A RebuildRecord's own recorded table name and the live table's actual
// name are the same SQLite identifier even when their case differs; the
// generator always keeps them in sync, so the two tests below hand-edit a
// generated file's header to construct the mismatch (a hand-edited or
// corrupted file is the only way it arises).

test("a Durable Object's runtime migrate() does not falsely refuse a rebuild whose RebuildRecord names its table in a different case than the live table, when nothing about the table actually changed", () => {
  const base = "create table t (id text primary key not null, a text not null) strict";
  const target = "create table t (id text primary key not null, a text) strict"; // drops NOT NULL on a
  const current = open([base]);
  const plan = diff(introspect(current), introspect(open([target])));
  if (plan.kind !== "ok") throw new Error("plan blocked");
  const file = render(2, "a_nullable", plan.statements, plan.rebuilds ?? []);
  const mismatched = file.sql.replace('"table":"t"', '"table":"T"');
  assert.notEqual(mismatched, file.sql, "the RebuildRecord's table name should have been rewritten to a different case");

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }]);
  migrate(db, [
    { name: "0001_base.sql", sql: base + ";" },
    { name: "0002_a_nullable.sql", sql: mismatched },
  ]);
  const row = db.prepare(`select "notnull" from pragma_table_xinfo(?) where name = ?`).get("t", "a") as { notnull: number };
  assert.equal(row.notnull, 0);
});

test("a Durable Object's runtime migrate() still refuses a rebuild that does not know about a column, when a same-named TEMP table shadows main's own", () => {
  const base = "create table customers (id text primary key not null, email text not null, name text not null) strict";
  const targetA = "create table customers (id text primary key not null, email text, name text not null) strict"; // branch A: drops NOT NULL on email, never heard of fax
  const targetB = "create table customers (id text primary key not null, email text not null, name text not null, fax text) strict"; // branch B: adds fax

  const currentDb = open([base]);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "email_nullable", planA.statements, planA.rebuilds ?? []);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_fax", planB.statements, planB.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_fax.sql", sql: fileB.sql }]);
  db.exec(`insert into customers (id, email, name) values ('c1', 'a@b.com', 'Alice')`);
  db.exec(`update customers set fax = '555-1234' where id = 'c1'`);

  // A TEMP table named "customers", with only the columns fileA's stale
  // RebuildRecord already knows about (no "fax"), shadows main's own table of
  // the same name for any unqualified lookup.
  db.exec("create temp table customers (id text primary key not null, email text, name text not null)");

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_fax.sql", sql: fileB.sql },
      { name: "0003_email_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      assert.match(e.message, /rebuilds table "customers" without knowledge of column "fax"/);
      return true;
    },
  );

  // The refusal ran before "0003_email_nullable.sql"'s own statements
  // executed; main's own row, and the value the TEMP table's shadow could
  // have hidden from the check, are unaffected. Read through main
  // explicitly: the TEMP table above still shadows an unqualified "customers".
  assert.deepEqual({ ...db.prepare("select fax from main.customers where id='c1'").get() }, { fax: "555-1234" });
});

test("a Durable Object's runtime migrate() still refuses a case-mismatched rebuild that does not know about an index an unrelated migration added", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unrelated to the index

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([base, "create index idx_b on t(b)"])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "add_idx_b", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);
  const mismatchedA = fileA.sql.replace('"table":"t"', '"table":"T"');
  assert.notEqual(mismatchedA, fileA.sql, "the RebuildRecord's table name should have been rewritten to a different case");

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_add_idx_b.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_add_idx_b.sql", sql: fileB.sql },
      { name: "0003_a_nullable.sql", sql: mismatchedA },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_LOSES_COLUMN");
      // The columns check (fixed above) finds the live table despite the
      // case mismatch and passes, since no column actually changed; the
      // refusal below can only come from the index check that follows it.
      assert.doesNotMatch(e.message, /stale declaration/);
      assert.match(e.message, /without knowledge of index "idx_b"/);
      return true;
    },
  );

  const row = db.prepare(`select name from sqlite_schema where type = 'index' and tbl_name = 't' and name = 'idx_b'`).get();
  assert.ok(row, "idx_b should still exist");
});
