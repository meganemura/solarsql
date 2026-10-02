// Responsibility: prove migrate()'s view-trigger record checks (src/durable.ts)
// on a real Durable Object under workerd (Miniflare): a file that drops a view
// refuses to drop a trigger a sibling migration added to that view, and
// refuses to restore one a sibling removed.
// Boundary: local Miniflare evidence; Node's storageOf() side is in
// test/view-migration.test.ts.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { diff, introspect, open, render } from "../../src/build/migration.ts";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");
const orders = `create table orders (id text primary key not null, status text not null) strict`;
const logTable = `create table order_log (id text primary key not null) strict`;
const openOrders = `create view open_orders as select id, status from orders`;
const logOpen = `create trigger open_orders_log instead of insert on open_orders begin insert into order_log values (new.id); end`;
const rebuiltOrders = `create table orders (id text primary key not null, status text not null check (status in ('open', 'done'))) strict`;
const changedView = `create view open_orders as select id, status, 1 as one from orders`;

function generated(from: string[], to: string[]) {
  const plan = diff(introspect(open(from)), introspect(open(to)));
  if (plan.kind !== "ok") throw new Error(plan.reason);
  return render(3, "generated", plan.statements, plan.rebuilds ?? [], 4, plan.views ?? []);
}

test("migrate() on a Durable Object refuses a file that would drop or restore a view trigger it did not see", async () => {
  const mf = workerMiniflare(resolve(root, "test/migrate-durable-object.worker.ts"), root, { durableObjects: { PROBE: "MigrateProbe" } });
  onTestFinished(() => mf.dispose());
  const send = async (instance: string, files: { filename: string; sql: string }[]) => {
    const response = await mf.dispatchFetch(`http://localhost/${instance}`, { method: "POST", body: JSON.stringify(files.map((f) => ({ name: f.filename, sql: f.sql }))) });
    return await response.json() as { ok: boolean; message: string | null; isMigrationHistoryError: boolean };
  };
  for (const [path, target] of [["rebuild", rebuiltOrders], ["changed-view", changedView]] as const) {
    const toTables = (extra: string[]) => path === "rebuild" ? [target, logTable, openOrders, ...extra] : [orders, logTable, target, ...extra];
    const base = [orders, logTable, openOrders];
    const added = await send(`${path}-added`, [render(1, "base", base), render(2, "sibling", [logOpen]), generated(base, toTables([]))]);
    assert.equal(added.ok, false, path);
    assert.equal(added.isMigrationHistoryError, true, path);
    assert.match(added.message ?? "", /drops view "open_orders" without knowledge of trigger "open_orders_log" it already has/, path);

    const withTrigger = [...base, logOpen];
    const removed = await send(`${path}-removed`, [render(1, "base", withTrigger), render(2, "sibling", [`drop trigger open_orders_log`]), generated(withTrigger, toTables([logOpen]))]);
    assert.equal(removed.ok, false, path);
    assert.equal(removed.isMigrationHistoryError, true, path);
    assert.match(removed.message ?? "", /drops view "open_orders" and would restore trigger "open_orders_log", which an earlier migration already removed/, path);

    const control = await send(`${path}-control`, [render(1, "base", withTrigger), generated(withTrigger, toTables([logOpen]))]);
    assert.equal(control.ok, true, `${path}: ${control.message}`);
  }
});
