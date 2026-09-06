// A search table (CREATE VIRTUAL TABLE ... USING fts5) is part of the
// migration diff: created after the tables, dropped and created again
// when its text changes, and its shadow tables are never named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";

const orders = `create table orders (id text primary key not null, note text) strict`;
const v1 = [orders, `create virtual table order_search using fts5(order_id unindexed, note)`];
const v2 = [orders, `create virtual table order_search using fts5(order_id unindexed, note, tokenize = 'unicode61')`, `create trigger order_search_insert after insert on orders begin insert into order_search (order_id, note) values (new.id, new.note); end`];

test("a new search table is created after the tables, and a second diff is empty", () => {
  const plan = diff(introspect(open([orders])), introspect(open(v1)));
  assert.deepEqual(plan, { kind: "ok", statements: [v1[1]!.replace(/^create virtual table/, "CREATE VIRTUAL TABLE")] });
  assert.deepEqual(diff(introspect(open(v1)), introspect(open(v1))), { kind: "ok", statements: [] });
});

test("a changed search table is dropped and created again, before the trigger that writes it, and the rows survive in orders", () => {
  const plan = diff(introspect(open(v1)), introspect(open(v2)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.deepEqual(plan.statements.map((s) => s.split("(")[0]!.trim().toLowerCase()), ["drop table \"order_search\"", "create virtual table order_search using fts5", "create trigger order_search_insert after insert on orders begin insert into order_search"]);
  const db = applied([render(1, "v1", v1).sql, "insert into orders values ('a', 'gift');", "insert into order_search values ('a', 'gift');"]);
  db.exec("begin");
  for (const s of splitStatements(render(2, "v2", plan.statements).sql)) db.exec(s);
  db.exec("commit");
  assert.deepEqual(diff(introspect(db), introspect(open(v2))), { kind: "ok", statements: [] });
  assert.deepEqual({ ...db.prepare("select count(*) as n from order_search").get() }, { n: 0 });
  db.exec("insert into orders values ('b', 'rush')");
  assert.deepEqual(db.prepare("select order_id from order_search where order_search match 'rush'").all().map((r) => ({ ...r })), [{ order_id: "b" }]);
});

test("a removed search table is dropped, and its shadow tables are never named", () => {
  const plan = diff(introspect(open(v1)), introspect(open([orders])));
  assert.deepEqual(plan, { kind: "ok", statements: [`drop table "order_search"`] });
  const s = introspect(open(v1));
  assert.deepEqual([...s.tables.keys()], ["orders"]);
  assert.deepEqual([...s.virtuals.keys()], ["order_search"]);
});
