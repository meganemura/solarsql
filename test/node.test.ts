// The example modules on node:sqlite, in-process: the migration files
// apply, and queries, commands, and failures as values behave as they do on
// D1 and on a Durable Object. This is the loop a module's own tests run in.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, node } from "../src/node.ts";
import { read, type Observed } from "../src/index.ts";
import { migrations } from "../example/migrations/index.ts";
import { customerCommands, type CustomersId } from "../example/modules/customers/public.ts";
import { orderCommands, orderQueries, type OrderLinesId, type OrdersId } from "../example/modules/orders/public.ts";
import { reportQueries } from "../example/modules/reports/public.ts";

describe("the example on node:sqlite", () => {
  const raw = new DatabaseSync(":memory:");
  const events: Observed[] = [];
  const db = node(raw, { observe: (e) => events.push(e) });
  const c1 = "c1" as CustomersId;
  const o1 = "o1" as OrdersId;

  test("the migration files apply once, in name order", () => {
    assert.deepEqual(migrate(raw, migrations), ["0001_initial.sql", "0002_orders_customer_id.sql", "0003_views_and_triggers.sql", "0004_search.sql", "0005_customer_name_not_empty.sql"]);
    assert.deepEqual(migrate(raw, migrations), []);
  });

  test("a command with returns, then a unique failure as a value", async () => {
    assert.deepEqual(await db.run(customerCommands.create, { id: c1, name: "Ann", email: "ann@example.com" }), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }] });
    assert.deepEqual(await db.run(customerCommands.create, { id: "c2" as CustomersId, name: "Bob", email: "ann@example.com" }), { ok: false, kind: "unique", table: "customers", columns: ["email"] });
  });

  test("a plan with JSON rows, a JSON aggregation read back, and an assert that fails on the second run", async () => {
    const lines = [{ id: "l1" as OrderLinesId, sku: "A", qty: 2, price: 1.5 }, { id: "l2" as OrderLinesId, sku: "B", qty: 1, price: 4 }];
    assert.equal((await db.run(orderCommands.place, { id: o1, customer_id: c1, lines })).ok, true);
    assert.deepEqual(await db.first(orderQueries.withLines, { id: o1 }), { id: "o1", status: "draft", lines: [{ id: "l1", sku: "A", qty: 2, price: 1.5 }, { id: "l2", sku: "B", qty: 1, price: 4 }] });
    assert.equal((await db.run(orderCommands.confirm, { id: o1 })).ok, true);
    assert.deepEqual(await db.run(orderCommands.confirm, { id: o1 }), { ok: false, kind: "assert", assert: "was_draft" });
  });

  test("a bulk update from JSON rows, the trigger's stamp, and a report through the view", async () => {
    assert.equal((await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "l1" as OrderLinesId, price: 2 }] })).ok, true);
    assert.deepEqual(await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "nope" as OrderLinesId, price: 2 }] }), { ok: false, kind: "assert", assert: "all_lines_known" });
    const noted = await db.run(orderCommands.annotate, { id: o1, note: "rush" });
    assert.equal(noted.ok, true);
    if (noted.ok) assert.match(noted.rows[0]!.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await db.all(reportQueries.confirmedOrders), [{ id: "o1", customer_id: "c1", customer_name: "Ann" }]);
    const hits = await db.all(orderQueries.searchNotes, { query: "rush" });
    assert.deepEqual(hits.map((h) => [h.id, h.note]), [["o1", "rush"]]);
    const [orders, lines] = await db.batch([read(orderQueries.byId, { id: o1 }), read(orderQueries.withLines, { id: o1 })]);
    assert.deepEqual(orders.map((o) => o.status), ["confirmed"]);
    assert.deepEqual(lines[0]!.lines.map((l) => l.id), ["l1", "l2"]);
    assert.deepEqual(await db.all(reportQueries.revenueByCustomer), [{ customer_id: "c1", name: "Ann", revenue: 8, orders: 1 }]);
  });

  test("the observe hook saw the calls", () => {
    const outcomes = events.map((e) => `${e.kind} ${e.name} ${e.outcome}`);
    assert.ok(outcomes.includes("command create unique"), outcomes.join("\n"));
    assert.ok(outcomes.includes("command confirm assert:was_draft"));
    assert.ok(outcomes.includes("query withLines ok"));
    assert.ok(events.every((e) => !("meta" in e)), "node:sqlite reports no engine meta");
  });
});
