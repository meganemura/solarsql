// The type generator turns engine facts into TypeScript text. These cases
// pin the text for the shapes the library supports, and the errors for the
// shapes it refuses.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/build/facts.ts";
import { BuildError, Typer, brandName, type Brand } from "../src/build/typegen.ts";
import { GUARD_DDL, assertStatement } from "../src/runtime/plan.ts";

const ddl = [
  `-- A customer.
  create table customers (id text primary key not null, name text not null)`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null, qty integer not null, price real)`,
  ...GUARD_DDL,
];

function typer(): Typer {
  const engine = new Engine(ddl);
  const brands = new Map<string, Brand>();
  for (const t of engine.tables()) {
    const pk = t.columns.filter((c) => c.pk > 0);
    if (pk.length === 1) brands.set(t.name, { table: t.name, column: pk[0]!.name, typeName: brandName(t.name), module: "m" });
  }
  return new Typer(engine, brands);
}

describe("Typer.analyze", () => {
  const t = typer();

  test("a select with a parameter on the primary key", () => {
    const a = t.analyze("-- One order, or none.\nselect id, status, note from orders where id = :id", "orders");
    assert.equal(a.doc, "One order, or none.");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId" }]);
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "status", type: '"draft" | "confirmed"', json: false },
      { name: "note", type: "string | null", json: false },
    ]);
    assert.deepEqual([...a.brands], ["OrdersId"]);
  });

  test("an insert infers parameter types from the column list", () => {
    const a = t.analyze("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')", "orders");
    assert.equal(a.returnsRows, false);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId" }, { name: "customer_id", type: "CustomersId" }]);
    assert.deepEqual([...a.brands].sort(), ["CustomersId", "OrdersId"]);
  });

  test("an update infers from SET and WHERE, nullable column allows null", () => {
    const a = t.analyze("update orders set note = :note where id = :id and status = :status", "orders");
    assert.deepEqual(a.params, [{ name: "note", type: "string | null" }, { name: "id", type: "OrdersId" }, { name: "status", type: '"draft" | "confirmed"' }]);
  });

  test("a JSON aggregation over an outer join with a filter", () => {
    const a = t.analyze(
      `select o.id, c.name as customer_name,
        coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty, 'total', cast(l.qty * l.price as real))) filter (where l.id is not null), '[]') as lines
      from orders o join customers c on c.id = o.customer_id left join order_lines l on l.order_id = o.id
      where o.customer_id = :customer_id group by o.id`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "customer_id", type: "CustomersId" }]);
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "customer_name", type: "string", json: false },
      { name: "lines", type: 'Array<{ "id": OrderLinesId; "qty": number; "total": number | null }>', json: true },
    ]);
  });

  test("a JSON aggregation without a filter over an outer join is refused", () => {
    assert.throws(
      () => t.analyze("select o.id, json_group_array(json_object('id', l.id)) as lines from orders o left join order_lines l on l.order_id = o.id group by o.id", "orders"),
      (e: unknown) => e instanceof BuildError && /needs a filter/.test(e.message),
    );
  });

  test("a self join marks the outer side nullable", () => {
    const a = t.analyze("select o.id, p.status as parent_status from orders o left join orders p on p.id = o.parent_id", "orders");
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "parent_status", type: '"draft" | "confirmed" | null', json: false },
    ]);
  });

  test("an expression column needs a cast", () => {
    assert.throws(() => t.analyze("select count(*) as n from orders", "orders"), (e: unknown) => e instanceof BuildError && /cast\(\.\.\. as integer\)/.test(e.message));
    const a = t.analyze("select cast(count(*) as integer) as n from orders", "orders");
    assert.deepEqual(a.columns, [{ name: "n", type: "number | null", json: false }]);
  });

  test("an anonymous parameter is refused", () => {
    assert.throws(() => t.analyze("select id from orders where id = ?", "orders"), (e: unknown) => e instanceof BuildError && /named parameter/.test(e.message));
  });

  test("one parameter with two types is refused", () => {
    assert.throws(() => t.analyze("select id from orders where id = :x or customer_id = :x", "orders"), (e: unknown) => e instanceof BuildError && /two different types/.test(e.message));
  });

  test("the engine's message for an unknown column is kept", () => {
    assert.throws(() => t.analyze("select nope from orders", "orders"), (e: unknown) => e instanceof BuildError && /no such column: nope/.test(e.message));
  });

  test("an assert predicate as its composed statement", () => {
    const a = t.analyze(assertStatement("has_lines", "exists (select 1 from order_lines where order_id = :id)"), "orders");
    assert.equal(a.returnsRows, false);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId" }]);
  });

  test("insert ... select maps a parameter by position, and a table-valued function parameter has the plain value type", () => {
    const a = t.analyze("insert into order_lines (id, order_id, sku, qty) select value ->> 'id', :order_id, value ->> 'sku', value ->> 'qty' from json_each(:lines)", "orders");
    assert.deepEqual(a.params, [{ name: "order_id", type: "OrdersId" }, { name: "lines", type: "SqlValue" }]);
  });

  test("returning gives rows with brands", () => {
    const a = t.analyze("insert into customers (id, name) values (:id, :name) returning id, name", "customers");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.columns, [{ name: "id", type: "CustomersId", json: false }, { name: "name", type: "string", json: false }]);
  });
});
