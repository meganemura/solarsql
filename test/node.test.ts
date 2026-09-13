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
    assert.deepEqual(await db.run(customerCommands.create, { id: c1, name: "Ann", email: "ann@example.com" }), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }], changes: 1 });
    assert.deepEqual(await db.run(customerCommands.create, { id: "c2" as CustomersId, name: "Bob", email: "ann@example.com" }), { ok: false, kind: "unique", table: "customers", columns: ["email"] });
  });

  test("a plan with JSON rows, a JSON aggregation read back, and an assert that fails on the second run", async () => {
    const lines = [{ id: "l1" as OrderLinesId, sku: "A", qty: 2, price: 1.5 }, { id: "l2" as OrderLinesId, sku: "B", qty: 1, price: 4 }];
    const placed = await db.run(orderCommands.place, { id: o1, customer_id: c1, lines });
    assert.equal(placed.ok, true);
    if (placed.ok) assert.equal(placed.changes, 7);
    assert.deepEqual(await db.first(orderQueries.withLines, { id: o1 }), { id: "o1", status: "draft", lines: [{ id: "l1", sku: "A", qty: 2, price: 1.5 }, { id: "l2", sku: "B", qty: 1, price: 4 }] });
    const confirmed = await db.run(orderCommands.confirm, { id: o1 });
    assert.equal(confirmed.ok, true);
    if (confirmed.ok) assert.equal(confirmed.changes, 2);
    assert.deepEqual(await db.run(orderCommands.confirm, { id: o1 }), { ok: false, kind: "assert", assert: "was_draft" });
  });

  test("a bulk update from JSON rows, the trigger's stamp, and a report through the view", async () => {
    const repriced = await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "l1" as OrderLinesId, price: 2 }] });
    assert.equal(repriced.ok, true);
    if (repriced.ok) assert.equal(repriced.changes, 1);
    assert.deepEqual(await db.run(orderCommands.reprice, { id: o1, lines: [{ id: "nope" as OrderLinesId, price: 2 }] }), { ok: false, kind: "assert", assert: "all_lines_known" });
    const noted = await db.run(orderCommands.annotate, { id: o1, note: "rush" });
    assert.equal(noted.ok, true);
    if (noted.ok) {
      assert.equal(noted.changes, 8);
      assert.match(noted.rows[0]!.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }
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

  test("a repeated clear reports zero after it removes all rows", async () => {
    const first = await db.run(orderCommands.clear);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.changes, 6);
    assert.deepEqual(await db.run(orderCommands.clear), { ok: true, rows: [], changes: 0 });
  });
});

test("SQLite scalar values survive the Node adapter", async () => {
  const { testAsync } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  const raw = new DatabaseSync(':memory:');
  raw.exec('create table values_test(n integer, text_value text, data blob, anything any) strict');
  const db = node(raw);
  try {
    await testAsync(async tc => {
      const n = tc.draw(gs.integers());
      const text = tc.draw(gs.text());
      const bytes = Uint8Array.from(tc.draw(gs.binary()));
      const anything = tc.draw(gs.sampledFrom([null, n, text]));
      raw.exec('delete from values_test');
      raw.prepare('insert into values_test values (?, ?, ?, ?)').run(n, text, bytes, anything);
      const query = { kind: 'query' as const, name: 'values', sql: 'select * from values_test', meta: { params: [], encode: [], json: [], reads: ['values_test'] } };
      assert.deepEqual(await db.all(query), [{ n, text_value: text, data: bytes, anything }]);
    });
  } finally { raw.close(); }
});

test("Node rejects an integer read outside the safe number range", async () => {
  const raw = new DatabaseSync(':memory:');
  try {
    const query = { kind: 'query' as const, name: 'large', sql: 'select 9223372036854775807 as n', meta: { params: [], encode: [], json: [], reads: [] } };
    await assert.rejects(node(raw).all(query), /too large|safely|range/i);
  } finally { raw.close(); }
});
