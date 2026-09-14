// Responsibility: a CASE expression inside a trigger body must not break
// the paths that re-parse an already-written multi-statement SQL file:
// applied(), analyzeSchema(), and migrate().
// Boundary: splitStatements itself is unit-tested in scan.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applied } from "../src/build/migration.ts";
import { analyzeSchema } from "../src/build/analyze.ts";
import { migrate } from "../src/node.ts";

const table = "create table t (id text primary key not null, y integer, x integer) strict";
const trigger = `create trigger t_touch after update on t begin
  update t set x = case when new.y is null then 1 else 2 end where id = new.id;
end`;

test("a CASE expression inside a trigger body does not break applied()", () => {
  const db = applied([table, trigger]);
  try {
    assert.deepEqual(db.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t_touch" }]);
  } finally {
    db.close();
  }
});

test("a CASE expression inside a trigger body does not break analyzeSchema()", () => {
  const report = analyzeSchema(`${table}; ${trigger};`, {});
  assert.equal(report.contract.imports, false);
});

test("a CASE expression inside a trigger body does not break migrate() through the node adapter", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const names = migrate(raw, [{ name: "0001_initial.sql", sql: `${table};\n${trigger};` }]);
    assert.deepEqual(names, ["0001_initial.sql"]);
    assert.deepEqual(raw.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => ({ ...r })), [{ name: "t_touch" }]);
  } finally {
    raw.close();
  }
});
