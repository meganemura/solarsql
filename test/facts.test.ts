// The engine answers questions about SQL by preparing it. These tests pin
// the answers the type generator and the boundary check rely on.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/build/facts.ts";

const ddl = [
  `create table customers (id text primary key not null, name text not null)`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), qty integer not null, price real)`,
];

describe("Engine", () => {
  const engine = new Engine(ddl);

  test("table facts: pk, notnull, oneOf, foreign keys", () => {
    const orders = engine.table("orders");
    assert.deepEqual(orders.columns.map((c) => [c.name, c.type, c.notnull, c.pk, c.oneOf]), [
      ["id", "TEXT", true, 1, null],
      ["customer_id", "TEXT", true, 0, null],
      ["parent_id", "TEXT", false, 0, null],
      ["status", "TEXT", true, 0, ["draft", "confirmed"]],
      ["note", "TEXT", false, 0, null],
    ]);
    assert.deepEqual(orders.foreignKeys, [
      { table: "orders", from: "parent_id", to: "id" },
      { table: "customers", from: "customer_id", to: "id" },
    ]);
    assert.equal(orders.withoutRowid, false);
  });

  test("columns: origins through aliases and views, null for expressions", () => {
    const cols = engine.columns("select o.id as order_id, c.name, count(*) as n from orders o join customers c on c.id = o.customer_id group by o.id");
    assert.deepEqual(cols, [
      { name: "order_id", table: "orders", column: "id", type: "TEXT" },
      { name: "name", table: "customers", column: "name", type: "TEXT" },
      { name: "n", table: null, column: null, type: null },
    ]);
  });

  test("nullableAliases: the LEFT-JOIN mark, dropped when WHERE excludes null", () => {
    assert.deepEqual([...engine.nullableAliases("select o.id, p.status from orders o left join order_lines l on l.order_id = o.id left join orders p on p.id = o.parent_id")], ["l", "p"]);
    // The engine drops a LEFT JOIN that no column uses, so the alias is absent.
    assert.deepEqual([...engine.nullableAliases("select o.id from orders o left join order_lines l on l.order_id = o.id left join orders p on p.id = o.parent_id")], ["l"]);
    assert.deepEqual([...engine.nullableAliases("select o.id from orders o left join order_lines l on l.order_id = o.id where l.qty > 0")], []);
  });

  test("affinities: only a column reference or a CAST has a type", () => {
    const a = engine.affinities("select o.id, count(*) as n, cast(count(*) as integer) as m, cast(sum(l.price) as real) as total, o.status || '!' as s from orders o left join order_lines l on l.order_id = o.id group by o.id");
    assert.deepEqual([...a], [["id", "TEXT"], ["n", ""], ["m", "INT"], ["total", "REAL"], ["s", ""]]);
  });

  test("accesses: every column read, the tables written, the foreign key parent read", () => {
    const reads = engine.accesses("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')");
    assert.deepEqual(reads.filter((a) => a.action !== "function").map((a) => `${a.action} ${a.table}.${a.column}`).sort(), [
      "insert orders.null",
      "read customers.id",
      "read orders.id",
    ]);
    const select = engine.accesses("select o.id, c.name from orders o join customers c on c.id = o.customer_id");
    assert.deepEqual(select.filter((a) => a.action === "read").map((a) => `${a.table}.${a.column}`).sort(), ["customers.id", "customers.name", "orders.customer_id", "orders.id"]);
  });

  test("prepare rejects an unknown column with the engine's message", () => {
    assert.throws(() => engine.prepare("select nope from orders"), /no such column: nope/);
  });
});
