// A view takes part in the migration diff, and a table rebuild under a view
// drops the view first and creates it again after: RENAME refuses to run
// while a view names a table that is gone.
import { test } from "vitest";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render, requireReplayReachesTarget, shapeDifferences } from "../src/build/migration.ts";
import { BuildError } from "../src/build/build-error.ts";
import { DatabaseSync } from "node:sqlite";
import { migrate as migrateNode } from "../src/node.ts";
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
  // A dropped view is recorded even with no triggers, so a trigger a sibling
  // migration adds to it later is still caught at replay.
  assert.deepEqual(removed, { kind: "ok", statements: [`drop view main."open_orders"`], views: [{ view: "open_orders", triggers: [] }] });
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

// A generated file records the triggers of each view it drops. A sibling
// migration merged ahead of it can add or remove a trigger on that view;
// a replay then refuses the file instead of dropping or reviving it.
const logTable = `create table order_log (id text primary key not null) strict`;
const logOpen = `create trigger open_orders_log instead of insert on open_orders begin insert into order_log values (new.id); end`;

function generated(from: string[], to: string[]) {
  const plan = diff(introspect(open(from)), introspect(open(to)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") throw new Error("blocked");
  return render(3, "generated", plan.statements, plan.rebuilds ?? [], 4, plan.views ?? []).sql;
}

function replays(files: string[]): { applied: string | null; migrated: string | null; code: string | null } {
  const names = files.map((_, i) => `000${i + 1}_file.sql`);
  const caught = (run: () => void) => { try { run(); return null; } catch (e) { return e as Error & { code?: string }; } };
  const fromApplied = caught(() => { applied(files, names); });
  const fromMigrate = caught(() => { migrateNode(new DatabaseSync(":memory:"), files.map((sql, i) => ({ name: names[i]!, sql }))); });
  return { applied: fromApplied?.message ?? null, migrated: fromMigrate?.message ?? null, code: fromMigrate?.code ?? null };
}

for (const [path, target] of [
  ["a rebuild of the view's base table", (extra: string[]) => [rebuiltOrders, logTable, openOrders, ...extra]],
  ["a changed view", (extra: string[]) => [orders, logTable, `create view open_orders as select id, status, 1 as one from orders`, ...extra]],
] as const) {
  test(`a file that drops a view through ${path} refuses a trigger a sibling added to that view`, () => {
    const base = [orders, logTable, openOrders];
    const file = generated(base, target([]));
    const sibling = render(2, "sibling", [logOpen]).sql;
    assert.deepEqual(replays([render(1, "base", base).sql, file]), { applied: null, migrated: null, code: null });
    const refused = replays([render(1, "base", base).sql, sibling, file]);
    assert.match(refused.applied ?? "", /drops view "open_orders" without knowledge of trigger "open_orders_log" it already has/);
    assert.match(refused.migrated ?? "", /drops view "open_orders" without knowledge of trigger "open_orders_log" it already has/);
    assert.equal(refused.code, "REBUILD_LOSES_COLUMN");
  });

  test(`a file that drops a view through ${path} refuses to restore a trigger a sibling removed`, () => {
    const base = [orders, logTable, openOrders, logOpen];
    const file = generated(base, target([logOpen]));
    const sibling = render(2, "sibling", [`drop trigger open_orders_log`]).sql;
    assert.deepEqual(replays([render(1, "base", base).sql, file]), { applied: null, migrated: null, code: null });
    const refused = replays([render(1, "base", base).sql, sibling, file]);
    assert.match(refused.applied ?? "", /drops view "open_orders" and would restore trigger "open_orders_log", which an earlier migration already removed/);
    assert.match(refused.migrated ?? "", /drops view "open_orders" and would restore trigger "open_orders_log", which an earlier migration already removed/);
    assert.equal(refused.code, "REBUILD_REVIVES_DECLARATION");
  });
}
