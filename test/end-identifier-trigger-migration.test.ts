// Responsibility: an unquoted `end` identifier inside a trigger body must
// not break the paths that re-parse an already-written multi-statement SQL
// file: applied(), analyzeSchema(), and migrate().
// Boundary: splitStatements itself is unit-tested in scan.test.ts.
import assert from "node:assert/strict";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applied } from "../src/build/migration.ts";
import { analyzeSchema } from "../src/build/analyze.ts";
import { migrate } from "../src/node.ts";

// Shapes (1) an assignment to a column named end, (2) a new./old. reference
// to a column named end, and (3) a CASE...END expression beside a reference
// to end, combined in one trigger body.
const table = "create table t (id text primary key not null, y integer, end integer) strict";
const trigger = `create trigger t_touch after update on t begin
  update t set end = case when new.y is null then 1 else 2 end where id = new.id and old.end is not new.end;
end`;

// Shape (4): two sibling CASE...END expressions in one trigger body.
const table2 = "create table t3 (id text primary key not null, x integer, y integer, a integer, b integer) strict";
const trigger2 = `create trigger t3_touch after update on t3 begin
  update t3 set a = case when new.x > 0 then 1 else 2 end, b = case when new.y > 0 then 3 else 4 end where id = new.id;
end`;

test("an unquoted end identifier inside a trigger body does not break applied()", () => {
  const db = applied([table, trigger]);
  try {
    assert.deepEqual(db.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t_touch" }]);
  } finally {
    db.close();
  }
});

test("two sibling CASE expressions in a trigger body do not break applied()", () => {
  const db = applied([table2, trigger2]);
  try {
    assert.deepEqual(db.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t3_touch" }]);
  } finally {
    db.close();
  }
});

test("an unquoted end identifier inside a trigger body does not break analyzeSchema()", () => {
  const report = analyzeSchema(`${table}; ${trigger};`, {});
  assert.equal(report.contract.imports, false);
});

test("an unquoted end identifier inside a trigger body does not break migrate() through the node adapter", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const names = migrate(raw, [{ name: "0001_initial.sql", sql: `${table};\n${trigger};` }]);
    assert.deepEqual(names, ["0001_initial.sql"]);
    assert.deepEqual(raw.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t_touch" }]);
  } finally {
    raw.close();
  }
});

test("two sibling CASE expressions in a trigger body do not break migrate() through the node adapter", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const names = migrate(raw, [{ name: "0001_initial.sql", sql: `${table2};\n${trigger2};` }]);
    assert.deepEqual(names, ["0001_initial.sql"]);
    assert.deepEqual(raw.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t3_touch" }]);
  } finally {
    raw.close();
  }
});
