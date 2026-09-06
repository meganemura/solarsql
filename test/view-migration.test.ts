// A view takes part in the migration diff, and a table rebuild under a view
// drops the view first and creates it again after: RENAME refuses to run
// while a view names a table that is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";

const before = [
  `create table orders (id text primary key not null, status text not null) strict`,
  `create view open_orders as select id from orders where status = 'open'`,
];
const after = [
  `create table orders (id text primary key not null, status text not null check (status in ('open', 'done'))) strict`,
  `create view open_orders as select id from orders where status = 'open'`,
];

test("a rebuild under a view drops the view first and creates it last", () => {
  const plan = diff(introspect(open(before)), introspect(open(after)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.match(plan.statements[1]!, /^drop view "open_orders"$/);
  assert.match(plan.statements[plan.statements.length - 1]!, /^create view open_orders/i);
  assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_orders")), plan.statements.join("\n"));

  const db = applied([render(1, "before", before).sql, "insert into orders values ('a', 'open');"]);
  db.exec("begin");
  for (const s of splitStatements(render(2, "check", plan.statements).sql)) db.exec(s);
  db.exec("commit");
  assert.deepEqual(db.prepare("select id from open_orders").all().map((r) => ({ ...r })), [{ id: "a" }]);
  assert.deepEqual(diff(introspect(db), introspect(open(after))), { kind: "ok", statements: [] });
});

test("a changed view is dropped and created; an unchanged one is left alone", () => {
  const changed = [before[0]!, `create view open_orders as select id, status from orders where status = 'open'`];
  const plan = diff(introspect(open(before)), introspect(open(changed)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  // The engine stores the CREATE text with its own casing of the keyword.
  assert.deepEqual(plan.statements.map((s) => s.toLowerCase()), [`drop view "open_orders"`, changed[1]!.toLowerCase()]);
  assert.deepEqual(diff(introspect(open(before)), introspect(open(before))), { kind: "ok", statements: [] });
  const removed = diff(introspect(open(before)), introspect(open([before[0]!])));
  assert.deepEqual(removed, { kind: "ok", statements: [`drop view "open_orders"`] });
});
