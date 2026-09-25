// Responsibility: a table rebuild that never knew about a column the table
// actually has, at replay time, refuses instead of silently losing the
// column or its data (ADR 0099).
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";
import { BuildError } from "../src/build/typegen.ts";
import { migrate, MigrationHistoryError } from "../src/node.ts";

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
