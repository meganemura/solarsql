// A view takes part in the migration diff, and a table rebuild under a view
// drops the view first and creates it again after: RENAME refuses to run
// while a view names a table that is gone.
import { test } from "vitest";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render, requireReplayReachesTarget, shapeDifferences } from "../src/build/migration.ts";
import { BuildError } from "../src/build/build-error.ts";
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
  assert.match(plan.statements[1]!, /^drop view main\."open_orders"$/);
  assert.match(plan.statements[plan.statements.length - 1]!, /^create view main\.open_orders/i);
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
  assert.deepEqual(plan.statements.map((s) => s.toLowerCase()), [`drop view main."open_orders"`, changed[1]!.toLowerCase()]);
  assert.deepEqual(diff(introspect(open(before)), introspect(open(before))), { kind: "ok", statements: [] });
  const removed = diff(introspect(open(before)), introspect(open([before[0]!])));
  assert.deepEqual(removed, { kind: "ok", statements: [`drop view main."open_orders"`] });
});

// A trigger on a view goes with the view: DROP VIEW drops it, so a plan that
// drops a view must create its triggers again, and a changed or removed
// trigger on a kept view needs its own DROP TRIGGER.
const orders = `create table orders (id text primary key not null, status text not null) strict`;
const openOrders = `create view open_orders as select id, status from orders`;
const insertOpen = `create trigger open_orders_insert instead of insert on open_orders begin insert into orders values (new.id, 'open'); end`;
const insertDone = `create trigger open_orders_insert instead of insert on open_orders begin insert into orders values (new.id, 'done'); end`;
const rebuiltOrders = `create table orders (id text primary key not null, status text not null check (status in ('open', 'done'))) strict`;

function migrated(from: string[], to: string[]) {
  const plan = diff(introspect(open(from)), introspect(open(to)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") throw new Error("blocked");
  const db = applied([render(1, "before", from).sql, render(2, "plan", plan.statements, plan.rebuilds ?? []).sql]);
  assert.deepEqual(diff(introspect(db), introspect(open(to))), { kind: "ok", statements: [] });
  assert.deepEqual(shapeDifferences(introspect(db), introspect(open(to))), []);
  return { db, plan };
}

for (const [name, from, to] of [
  ["a rebuild under the view", [orders, openOrders, insertOpen], [rebuiltOrders, openOrders, insertOpen]],
  ["a changed view", [orders, openOrders, insertOpen], [orders, `create view open_orders as select id, status, 1 as one from orders`, insertOpen]],
  ["a trigger that names its view in another case", [orders, openOrders, insertOpen.replace("on open_orders", "on OPEN_ORDERS")], [rebuiltOrders, openOrders, insertOpen.replace("on open_orders", "on OPEN_ORDERS")]],
] as const) {
  test(`${name} keeps the INSTEAD OF trigger, so a write through the view still works`, () => {
    const { db } = migrated([...from], [...to]);
    db.exec("insert into open_orders (id) values ('a')");
    assert.deepEqual(db.prepare("select id, status from orders").all().map((r) => ({ ...r })), [{ id: "a", status: "open" }]);
  });
}

test("a changed trigger on an unchanged view is dropped and created again", () => {
  const { db, plan } = migrated([orders, openOrders, insertOpen], [orders, openOrders, insertDone]);
  assert.match(plan.statements[0]!, /^drop trigger main\."open_orders_insert"$/);
  db.exec("insert into open_orders (id) values ('a')");
  assert.deepEqual(db.prepare("select status from orders").all().map((r) => r.status), ["done"]);
});

test("a trigger removed from an unchanged view is dropped, and the view stops taking writes", () => {
  const { db, plan } = migrated([orders, openOrders, insertOpen], [orders, openOrders]);
  assert.deepEqual(plan.statements, [`drop trigger main."open_orders_insert"`]);
  assert.throws(() => db.exec("insert into open_orders (id) values ('a')"), /cannot modify open_orders because it is a view/);
});

test("the replay refuses a plan that misses a statement and names the object that differs", () => {
  const from = [orders, openOrders, insertOpen];
  const to = [rebuiltOrders, openOrders, insertOpen];
  const plan = diff(introspect(open(from)), introspect(open(to)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const missing = plan.statements.filter((s) => !/^create trigger/i.test(s));
  assert.equal(missing.length, plan.statements.length - 1);
  assert.throws(() => requireReplayReachesTarget([render(1, "before", from).sql], ["0001_before.sql"], missing, plan.rebuilds ?? [], introspect(open(to))), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /these objects differ after a replay: trigger open_orders_insert\. /);
    return true;
  });
  assert.doesNotThrow(() => requireReplayReachesTarget([render(1, "before", from).sql], ["0001_before.sql"], plan.statements, plan.rebuilds ?? [], introspect(open(to))));
});

test("the replay refuses an empty plan that leaves a view trigger behind", () => {
  assert.throws(() => requireReplayReachesTarget([render(1, "before", [orders, openOrders, insertOpen]).sql], ["0001_before.sql"], [], [], introspect(open([orders, openOrders]))),
    /these objects differ after a replay: trigger open_orders_insert\. /);
});

test("the replay names the generated statement that fails", () => {
  const from = [orders, openOrders, insertOpen];
  assert.throws(() => requireReplayReachesTarget([render(1, "before", from).sql], ["0001_before.sql"], [insertDone], [], introspect(open([orders, openOrders, insertDone]))), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /trigger open_orders_insert already exists/);
    assert.match(`${e.message} ${e.locations.join(" ")}`, /the generated migration/);
    assert.match(e.message, /statement 1 of 1/);
    return true;
  });
});

const logOrders = `create trigger orders_log after insert on orders begin select 1; end`;

test("a hand-written trigger whose ON spells its table or view in another case is current, and the replay accepts it", () => {
  for (const [history, declared] of [
    [[orders, logOrders.replace("on orders", "on Orders")], [orders, logOrders]],
    [[orders, openOrders, insertOpen.replace("on open_orders", "on OPEN_ORDERS")], [orders, openOrders, insertOpen]],
  ] as const) {
    const files = [render(1, "hand_written", [...history]).sql];
    assert.deepEqual(diff(introspect(applied(files)), introspect(open([...declared]))), { kind: "ok", statements: [] });
    assert.doesNotThrow(() => requireReplayReachesTarget(files, ["0001_hand_written.sql"], [], [], introspect(open([...declared]))));
  }
});

test("a rebuild keeps a table trigger whose ON spells the table in another case", () => {
  const trigger = logOrders.replace("on orders", "on ORDERS");
  const { db } = migrated([orders, trigger], [rebuiltOrders, trigger]);
  assert.deepEqual(db.prepare("select name from sqlite_schema where type = 'trigger'").all().map((r) => r.name), ["orders_log"]);
});
