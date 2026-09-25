// Responsibility: ADR 0138, a nested json_each -- one FROM item reading a
// bound array parameter, a second reading `.value` of the first's own
// element -- as an insert-select command's own parameter. Hand-built Meta
// and Command values (the pattern test/commands.test.ts already uses), run
// through the real node() adapter, so this exercises the same runtime path
// a Durable Object and D1 use.
// Boundary: this file owns the runtime shape and the type-level parameter
// type. scan.ts's own key-scoping is pinned in test/scan.test.ts, and the
// build's own success and refusal for this shape in test/typegen.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GUARD_DDL } from "../src/runtime/plan.ts";
import { commands, type Meta } from "../src/index.ts";
import { node } from "../src/node.ts";

const insertOrdersWithLines = `insert into order_lines (id, order_id, sku, qty, price)
  select l.value ->> 'id', o.value ->> 'id', l.value ->> 'sku', l.value ->> 'qty', l.value ->> 'price'
  from json_each(:orders) o, json_each(o.value -> 'lines') l`;

type OrderLine = { id: string; sku: string; qty: number; price: number | null };
type G = {
  [insertOrdersWithLines]: { params: { orders: readonly { id: string; lines: readonly OrderLine[] }[] }; row: {} };
};
const meta: Meta<G> = {
  [insertOrdersWithLines]: { params: ["orders"], encode: ["orders"], json: [], reads: ["order_lines"] },
};
const cmd = commands(meta, { insertLines: { plan: [insertOrdersWithLines] } });

test("a json_each chained off another json_each's own element inserts one row per element of the nested array, with no cast on the call", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec([
    ...GUARD_DDL,
    "create table orders (id text primary key not null) strict",
    "create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null, qty integer not null, price real) strict",
  ].join(";\n"));
  raw.exec("insert into orders values ('o1'), ('o2')");
  try {
    const db = node(raw);
    // No cast: the object literal below matches the parameter type
    // scan.ts's per-alias key scoping and typegen.ts's jsonKeyType give
    // `:orders` (id, and lines nested as an array of id/sku/qty/price).
    await db.run(cmd.insertLines, {
      orders: [
        { id: "o1", lines: [{ id: "l1", sku: "sku-1", qty: 2, price: 9.5 }, { id: "l2", sku: "sku-2", qty: 1, price: null }] },
        { id: "o2", lines: [{ id: "l3", sku: "sku-3", qty: 3, price: 4 }] },
      ],
    });
    const rows = raw.prepare("select id, order_id, sku, qty, price from order_lines order by id").all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: "l1", order_id: "o1", sku: "sku-1", qty: 2, price: 9.5 },
      { id: "l2", order_id: "o1", sku: "sku-2", qty: 1, price: null },
      { id: "l3", order_id: "o2", sku: "sku-3", qty: 3, price: 4 },
    ]);
  } finally { raw.close(); }
});
