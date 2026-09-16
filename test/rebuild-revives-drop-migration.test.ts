// Responsibility: a table rebuild whose recorded shape still names a
// table-level constraint, an index, or a trigger that a sibling migration
// has since dropped, and whose own target schema still declares it, refuses
// to replay instead of silently restoring what the sibling meant to remove
// (the mirror direction of ADR 0099/0101/0102's own checks; see ADR 0116).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { parseRebuildRecords, redeclaredByFile, splitStatements } from "../src/build/scan.ts";
import { BuildError } from "../src/build/typegen.ts";
import { migrate, MigrationHistoryError } from "../src/node.ts";

// --- Positive: a sibling's drop is revived by a rebuild that never heard of it ---

test("applied() refuses a rebuild that would restore a table-level constraint a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null) strict"; // branch B: drops the UNIQUE
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b), check (a + b > 0)) strict"; // branch A: unaware of B, adds an unrelated CHECK, still declares the UNIQUE

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "drop_unique", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "add_check", planA.statements, planA.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_drop_unique.sql", "0003_add_check.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0003_add_check\.sql rebuilds table "t" and would restore a table-level constraint an earlier migration already removed/);
      assert.match(e.message, /unique\(a,b\)/);
      assert.match(e.message, /run `solarsql migration` again/);
      return true;
    },
  );

  // The refusal does not touch `live`; B's drop is still there.
  const row = live.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.doesNotMatch(row.sql, /unique/i);
});

test("a Durable Object's runtime migrate() also refuses a rebuild that would restore a table-level constraint a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b), check (a + b > 0)) strict";

  const currentDb = open([base]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "drop_unique", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "add_check", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [{ name: "0001_base.sql", sql: base + ";" }, { name: "0002_drop_unique.sql", sql: fileB.sql }]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_drop_unique.sql", sql: fileB.sql },
      { name: "0003_add_check.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_REVIVES_DECLARATION");
      assert.match(e.message, /rebuilds table "t" and would restore a table-level constraint an earlier migration already removed/);
      assert.match(e.message, /unique\(a,b\)/);
      return true;
    },
  );

  const row = db.prepare(`select sql from sqlite_schema where type = 'table' and name = 't'`).get() as { sql: string };
  assert.doesNotMatch(row.sql, /unique/i);
});

test("applied() refuses a rebuild that would restore an index a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const baseIndex = "create index idx1 on t(b)";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unaware of B, still declares idx1

  const currentDb = open([base, baseIndex]);
  const planB = diff(introspect(currentDb), introspect(open([base])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "drop_idx1", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA, baseIndex])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  live.exec(baseIndex);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", baseIndex + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_base_index.sql", "0003_drop_idx1.sql", "0004_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0004_a_nullable\.sql rebuilds table "t" and would restore index "idx1", which an earlier migration already removed/);
      return true;
    },
  );

  const row = live.prepare(`select name from sqlite_schema where type = 'index' and tbl_name = 't' and name = 'idx1'`).get();
  assert.equal(row, undefined, "idx1 should still be gone on the live database");
});

test("a Durable Object's runtime migrate() also refuses a rebuild that would restore an index a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const baseIndex = "create index idx1 on t(b)";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict";

  const currentDb = open([base, baseIndex]);
  const planB = diff(introspect(currentDb), introspect(open([base])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "drop_idx1", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA, baseIndex])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [
    { name: "0001_base.sql", sql: base + ";" },
    { name: "0002_base_index.sql", sql: baseIndex + ";" },
    { name: "0003_drop_idx1.sql", sql: fileB.sql },
  ]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_base_index.sql", sql: baseIndex + ";" },
      { name: "0003_drop_idx1.sql", sql: fileB.sql },
      { name: "0004_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_REVIVES_DECLARATION");
      assert.match(e.message, /rebuilds table "t" and would restore index "idx1", which an earlier migration already removed/);
      return true;
    },
  );

  const row = db.prepare(`select name from sqlite_schema where type = 'index' and tbl_name = 't' and name = 'idx1'`).get();
  assert.equal(row, undefined, "idx1 should still be gone");
});

test("applied() refuses a rebuild that would restore a trigger a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const baseTrigger = "create trigger trg1 after insert on t begin update t set b = b + 1 where id = new.id; end";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unaware of B, still declares trg1

  const currentDb = open([base, baseTrigger]);
  const planB = diff(introspect(currentDb), introspect(open([base])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "drop_trg1", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA, baseTrigger])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const live = new DatabaseSync(":memory:");
  live.exec(base);
  live.exec(baseTrigger);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([base + ";", baseTrigger + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_base_trigger.sql", "0003_drop_trg1.sql", "0004_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0004_a_nullable\.sql rebuilds table "t" and would restore trigger "trg1", which an earlier migration already removed/);
      return true;
    },
  );

  const row = live.prepare(`select name from sqlite_schema where type = 'trigger' and tbl_name = 't' and name = 'trg1'`).get();
  assert.equal(row, undefined, "trg1 should still be gone on the live database");
});

test("a Durable Object's runtime migrate() also refuses a rebuild that would restore a trigger a sibling migration dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const baseTrigger = "create trigger trg1 after insert on t begin update t set b = b + 1 where id = new.id; end";
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict";

  const currentDb = open([base, baseTrigger]);
  const planB = diff(introspect(currentDb), introspect(open([base])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "drop_trg1", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA, baseTrigger])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [
    { name: "0001_base.sql", sql: base + ";" },
    { name: "0002_base_trigger.sql", sql: baseTrigger + ";" },
    { name: "0003_drop_trg1.sql", sql: fileB.sql },
  ]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: base + ";" },
      { name: "0002_base_trigger.sql", sql: baseTrigger + ";" },
      { name: "0003_drop_trg1.sql", sql: fileB.sql },
      { name: "0004_a_nullable.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_REVIVES_DECLARATION");
      assert.match(e.message, /rebuilds table "t" and would restore trigger "trg1", which an earlier migration already removed/);
      return true;
    },
  );

  const row = db.prepare(`select name from sqlite_schema where type = 'trigger' and tbl_name = 't' and name = 'trg1'`).get();
  assert.equal(row, undefined, "trg1 should still be gone");
});

// --- Negative 1: both siblings intentionally drop the same declarations; neither refuses ---

test("applied() does not refuse a rebuild that intentionally drops the same constraint, index, and trigger a sibling migration already dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const baseIndex = "create index idx1 on t(b)";
  const baseTrigger = "create trigger trg1 after insert on t begin update t set b = b + 1 where id = new.id; end";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null) strict"; // branch B drops all three
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null) strict"; // branch A, generated from the same shared base, also drops all three on its own

  const currentDb = open([base, baseIndex, baseTrigger]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "drop_all_b", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "drop_all_a", planA.statements, planA.rebuilds ?? []);

  assert.doesNotThrow(() => applied([base + ";", baseIndex + ";", baseTrigger + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_base_index.sql", "0003_base_trigger.sql", "0004_drop_all_b.sql", "0005_drop_all_a.sql"]));
});

test("a Durable Object's runtime migrate() does not refuse a rebuild that intentionally drops the same constraint, index, and trigger a sibling migration already dropped", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null, unique (a, b)) strict";
  const baseIndex = "create index idx1 on t(b)";
  const baseTrigger = "create trigger trg1 after insert on t begin update t set b = b + 1 where id = new.id; end";
  const targetB = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const targetA = "create table t (id text primary key not null, a integer not null, b integer not null) strict";

  const currentDb = open([base, baseIndex, baseTrigger]);
  const planB = diff(introspect(currentDb), introspect(open([targetB])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "drop_all_b", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetA])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "drop_all_a", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [
    { name: "0001_base.sql", sql: base + ";" },
    { name: "0002_base_index.sql", sql: baseIndex + ";" },
    { name: "0003_base_trigger.sql", sql: baseTrigger + ";" },
  ]);
  assert.doesNotThrow(() => migrate(db, [
    { name: "0001_base.sql", sql: base + ";" },
    { name: "0002_base_index.sql", sql: baseIndex + ";" },
    { name: "0003_base_trigger.sql", sql: baseTrigger + ";" },
    { name: "0004_drop_all_b.sql", sql: fileB.sql },
    { name: "0005_drop_all_a.sql", sql: fileA.sql },
  ]));
});

// --- The name-vs-text decisive case: a sibling drops an index outright; the rebuild that revives it changed the index's own definition since it was recorded ---

test("applied() refuses a revived index matched by name, even though the file's own redeclaration changed the index's definition", () => {
  const baseTable = "create table t (id text primary key not null, c text, a text not null) strict";
  const baseIndex = "create index idx1 on t(c)";
  const targetBTable = "create table t (id text primary key not null, c text, a text not null) strict"; // branch B: drops idx1 entirely
  const targetATable = "create table t (id text primary key not null, c text not null, a text not null) strict"; // branch A: tightens c to NOT NULL (forces a rebuild), unaware of B
  const targetAIndex = "create index idx1 on t(c, a)"; // ...and, independently, redefines idx1's own columns

  const currentDb = open([baseTable, baseIndex]);
  const planB = diff(introspect(currentDb), introspect(open([targetBTable])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "drop_idx1", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetATable, targetAIndex])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "c_not_null", planA.statements, planA.rebuilds ?? []);

  // Confirm the file's own redeclaration really does carry the new
  // definition, not the recorded one, so this test exercises the name-based
  // match rather than an accidental text match.
  const recorded = parseRebuildRecords(fileA.sql)[0]!;
  assert.deepEqual(recorded.indexes, ["create index idx1 on t(c)"]);
  const redeclared = redeclaredByFile(fileA.sql, "t");
  assert.deepEqual(redeclared.indexes, ["create index idx1 on t(c,a)"]);

  const live = new DatabaseSync(":memory:");
  live.exec(baseTable);
  live.exec(baseIndex);
  for (const s of splitStatements(fileB.sql)) live.exec(s);

  assert.throws(
    () => applied([baseTable + ";", baseIndex + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_base_index.sql", "0003_drop_idx1.sql", "0004_c_not_null.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      assert.match(e.message, /0004_c_not_null\.sql rebuilds table "t" and would restore index "idx1", which an earlier migration already removed/);
      return true;
    },
  );
});

test("a Durable Object's runtime migrate() also refuses a revived index matched by name, even though the file's own redeclaration changed the index's definition", () => {
  const baseTable = "create table t (id text primary key not null, c text, a text not null) strict";
  const baseIndex = "create index idx1 on t(c)";
  const targetBTable = "create table t (id text primary key not null, c text, a text not null) strict";
  const targetATable = "create table t (id text primary key not null, c text not null, a text not null) strict";
  const targetAIndex = "create index idx1 on t(c, a)";

  const currentDb = open([baseTable, baseIndex]);
  const planB = diff(introspect(currentDb), introspect(open([targetBTable])));
  if (planB.kind !== "ok") throw new Error("planB blocked");
  const fileB = render(2, "drop_idx1", planB.statements, planB.rebuilds ?? []);
  const planA = diff(introspect(currentDb), introspect(open([targetATable, targetAIndex])));
  if (planA.kind !== "ok") throw new Error("planA blocked");
  const fileA = render(3, "c_not_null", planA.statements, planA.rebuilds ?? []);

  const db = new DatabaseSync(":memory:");
  migrate(db, [
    { name: "0001_base.sql", sql: baseTable + ";" },
    { name: "0002_base_index.sql", sql: baseIndex + ";" },
    { name: "0003_drop_idx1.sql", sql: fileB.sql },
  ]);

  assert.throws(
    () => migrate(db, [
      { name: "0001_base.sql", sql: baseTable + ";" },
      { name: "0002_base_index.sql", sql: baseIndex + ";" },
      { name: "0003_drop_idx1.sql", sql: fileB.sql },
      { name: "0004_c_not_null.sql", sql: fileA.sql },
    ]),
    (e: unknown) => {
      assert.ok(e instanceof MigrationHistoryError, String(e));
      assert.equal(e.code, "REBUILD_REVIVES_DECLARATION");
      assert.match(e.message, /rebuilds table "t" and would restore index "idx1", which an earlier migration already removed/);
      return true;
    },
  );
});

// --- Attribution: two confusingly named tables rebuilt in one file must not cross-attribute each other's declarations ---

test("redeclaredByFile attributes each table's own index only to that table, even when \"t\" and \"tt\" rebuild together in one file", () => {
  const baseT = "create table t (id text primary key not null, x text not null) strict";
  const baseTT = "create table tt (id text primary key not null, y text not null) strict";
  const indexT = "create index idx_t on t(x)";
  const indexTT = "create index idx_tt on tt(y)";

  const currentDb = open([baseT, baseTT, indexT, indexTT]);
  // Force both tables to rebuild in the same file, each for an unrelated
  // reason (a new table-level CHECK), each keeping its own index unchanged.
  const targetT = "create table t (id text primary key not null, x text not null, check (x <> '')) strict";
  const targetTT = "create table tt (id text primary key not null, y text not null, check (y <> '')) strict";
  const target = open([targetT, targetTT, indexT, indexTT]);

  const plan = diff(introspect(currentDb), introspect(target));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.equal(plan.rebuilds?.length, 2, "both t and tt should be rebuilt in this one file");
  const file = render(2, "tighten_both", plan.statements, plan.rebuilds ?? []);

  const redeclaredT = redeclaredByFile(file.sql, "t");
  const redeclaredTT = redeclaredByFile(file.sql, "tt");
  assert.deepEqual(redeclaredT.indexes, ["create index idx_t on t(x)"]);
  assert.deepEqual(redeclaredTT.indexes, ["create index idx_tt on tt(y)"]);
});

// --- Negative 2: the same branch drops an object, then a later file on that same branch intentionally re-adds it ---

test("applied() accepts a later file that intentionally re-adds an index its own generator never saw, alongside an unrelated rebuild", () => {
  const baseTable = "create table t (id text primary key not null, a text not null) strict";
  const baseIndex = "create index idx1 on t(a)";

  // file2: drops idx1 outright, no rebuild involved.
  const afterDrop = open([baseTable]);
  const plan2 = diff(introspect(open([baseTable, baseIndex])), introspect(afterDrop));
  assert.equal(plan2.kind, "ok");
  if (plan2.kind !== "ok") return;
  const file2 = render(2, "drop_idx1", plan2.statements, plan2.rebuilds ?? []);

  // file3: generated against the post-file2 schema (idx1 already gone), so
  // its own RebuildRecord for t never saw idx1. It rebuilds for an
  // unrelated reason and, independently, re-adds idx1.
  const targetTable3 = "create table t (id text primary key not null, a text) strict"; // drops NOT NULL on a
  const plan3 = diff(introspect(afterDrop), introspect(open([targetTable3, baseIndex])));
  assert.equal(plan3.kind, "ok");
  if (plan3.kind !== "ok") return;
  const file3 = render(3, "a_nullable_and_readd_idx1", plan3.statements, plan3.rebuilds ?? []);

  const recorded3 = parseRebuildRecords(file3.sql)[0]!;
  assert.deepEqual(recorded3.indexes, [], "file3's own generator never saw idx1, so nothing is recorded for it");

  assert.doesNotThrow(() => applied(
    [baseTable + ";", baseIndex + ";", file2.sql, file3.sql],
    ["0001_base.sql", "0002_base_index.sql", "0003_drop_idx1.sql", "0004_a_nullable_and_readd_idx1.sql"],
  ));
});

// --- The existing forward checks (ADR 0099/0101/0102) must keep refusing when a sibling changed, rather than dropped, a declaration ---

test("the existing forward check still refuses first when a sibling changed an index's definition, instead of dropping it, and this rebuild does not know", () => {
  const base = "create table t (id text primary key not null, a integer not null, b integer not null) strict";
  const baseIndex = "create index idx1 on t(b)";
  const changedIndex = "create index idx1 on t(b, a)"; // branch B changes idx1's definition, does not drop it
  const targetA = "create table t (id text primary key not null, a integer, b integer not null) strict"; // branch A: drops NOT NULL on a, unaware of B, still declares the old idx1

  const currentDb = open([base, baseIndex]);
  const planB = diff(introspect(currentDb), introspect(open([base, changedIndex])));
  assert.equal(planB.kind, "ok");
  if (planB.kind !== "ok") return;
  const fileB = render(2, "change_idx1", planB.statements, planB.rebuilds ?? []);

  const planA = diff(introspect(currentDb), introspect(open([targetA, baseIndex])));
  assert.equal(planA.kind, "ok");
  if (planA.kind !== "ok") return;
  const fileA = render(3, "a_nullable", planA.statements, planA.rebuilds ?? []);

  assert.throws(
    () => applied([base + ";", baseIndex + ";", fileB.sql, fileA.sql], ["0001_base.sql", "0002_base_index.sql", "0003_change_idx1.sql", "0004_a_nullable.sql"]),
    (e: unknown) => {
      assert.ok(e instanceof BuildError, String(e));
      // The existing forward (unknownDeclaration) message, not the new one:
      // B's changed idx1 is an object the live schema has that A's record
      // does not know about.
      assert.match(e.message, /without knowledge of index "idx1" it already has/);
      assert.doesNotMatch(e.message, /would restore/);
      return true;
    },
  );
});
