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
