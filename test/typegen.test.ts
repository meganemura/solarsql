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
  create table customers (id text primary key not null, name text not null) strict`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null, qty integer not null, price real)`,
  `create table files (id text primary key not null, size integer not null, flag integer not null check (flag in (0, 1)), total integer not null as (size * 2) stored, label text as (id || ':' || size) virtual) strict`,
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
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
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
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }, { name: "customer_id", type: "CustomersId", encode: false }]);
    assert.deepEqual([...a.brands].sort(), ["CustomersId", "OrdersId"]);
  });

  test("an update infers from SET and WHERE, nullable column allows null", () => {
    const a = t.analyze("update orders set note = :note where id = :id and status = :status", "orders");
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["id", "OrdersId"], ["status", '"draft" | "confirmed"']]);
  });

  test("a JSON aggregation over an outer join with a filter", () => {
    const a = t.analyze(
      `select o.id, c.name as customer_name,
        coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty, 'total', cast(l.qty * l.price as real))) filter (where l.id is not null), '[]') as lines
      from orders o join customers c on c.id = o.customer_id left join order_lines l on l.order_id = o.id
      where o.customer_id = :customer_id group by o.id`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "customer_id", type: "CustomersId", encode: false }]);
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
    assert.deepEqual(a.columns, [{ name: "n", type: "number", json: false }]);
  });

  test("a cast over count, exists, a ranking function, or coalesce with a literal is not null; other expressions are", () => {
    const types = (sql: string) => t.analyze(sql, "orders").columns.map((c) => c.type);
    assert.deepEqual(types("select cast(count(id) as integer) as a, cast(total(qty) as real) as b, cast(exists (select 1 from orders) as integer) as c from order_lines"), ["number", "number", "number"]);
    assert.deepEqual(types("select cast(row_number() over (order by id) as integer) as rn, cast(count(*) filter (where qty > 1) as integer) as big from order_lines"), ["number", "number"]);
    assert.deepEqual(types("select cast(coalesce(sum(qty), 0) as integer) as a, cast(ifnull(note, 'none') as text) as b from orders o join order_lines l on l.order_id = o.id"), ["number", "string"]);
    // sum can be null, a division can be null, and coalesce with a nullable column stays nullable.
    assert.deepEqual(types("select cast(sum(qty) as integer) as a, cast(count(*) / nullif(qty, 0) as integer) as b, cast(coalesce(sku, note) as text) as c from order_lines l join orders o on o.id = l.order_id"), ["number | null", "number | null", "string | null"]);
    // Inside json_object the same rule applies.
    assert.deepEqual(types("select json_object('n', cast(count(*) as integer), 's', cast(sum(qty) as integer)) as o from order_lines"), ['{ "n": number; "s": number | null }']);
  });

  test("one parameter at two sites: null only when every site allows it, and CASE lists union", () => {
    const a = t.analyze("select id from orders where id = :id or parent_id = :id", "orders");
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
    const b = t.analyze("select id from orders where note = :n or note = :n", "orders");
    assert.deepEqual(b.params, [{ name: "n", type: "string | null", encode: false }]);
    const c = t.analyze("select id from orders order by case :dir when 'asc' then id end asc, case :dir when 'desc' then id end desc", "orders");
    assert.deepEqual(c.params, [{ name: "dir", type: '"asc" | "desc"', encode: false }]);
  });

  test("insert or ignore, insert or replace, and replace into type their parameters", () => {
    for (const head of ["insert or ignore into", "insert or replace into", "replace into"]) {
      const a = t.analyze(`${head} customers (id, name) values (:id, :name)`, "customers");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "CustomersId"], ["name", "string"]], head);
    }
  });

  test("json_each anywhere: a bulk update from JSON rows is an encoded array of typed objects", () => {
    const a = t.analyze("update order_lines set qty = (select value ->> 'qty' from json_each(:lines) where value ->> 'id' = order_lines.id) where order_id = :order_id and id in (select value ->> 'id' from json_each(:lines))", "orders");
    assert.deepEqual(a.params, [
      { name: "lines", type: 'readonly { "qty": number; "id": OrderLinesId }[]', encode: true },
      { name: "order_id", type: "OrdersId", encode: false },
    ]);
    // A key with no column context is SqlValue; a bare use is an array of SqlValue.
    const b = t.analyze("select cast(value ->> 'x' as text) as x from json_each(:rows)", "orders");
    assert.deepEqual(b.params, [{ name: "rows", type: 'readonly { "x": SqlValue }[]', encode: true }]);
    const c = t.analyze("delete from order_lines where id in (select value from json_each(:ids)) and :ids is not null", "orders");
    assert.deepEqual(c.params, [{ name: "ids", type: "readonly OrderLinesId[] | null", encode: true }]);
    const d = t.analyze("insert into customers (id, name) select value, 'anon' from json_each(:ids)", "customers");
    assert.deepEqual(d.params, [{ name: "ids", type: "readonly CustomersId[]", encode: true }]);
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
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
  });

  test("insert ... select from json_each types the rows parameter from the column list", () => {
    const a = t.analyze("insert into order_lines (id, order_id, sku, qty) select value ->> 'id', :order_id, value ->> 'sku', value ->> 'qty' from json_each(:lines)", "orders");
    assert.deepEqual(a.params, [
      { name: "order_id", type: "OrdersId", encode: false },
      { name: "lines", type: 'readonly { "id": OrderLinesId; "sku": string; "qty": number }[]', encode: true },
    ]);
  });

  test("an IN list through json_each is an array of the column type", () => {
    const a = t.analyze("select id from orders o where o.id in (select value from json_each(:ids))", "orders");
    assert.deepEqual(a.params, [{ name: "ids", type: "readonly OrdersId[]", encode: true }]);
  });

  test("a sort chosen by a parameter is a union, and limit and offset are numbers", () => {
    const a = t.analyze("select id from orders where customer_id = :c order by case :sort when 'id' then id when 'status' then status end limit :limit offset :offset", "orders");
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "CustomersId"], ["sort", '"id" | "status"'], ["limit", "number"], ["offset", "number"]]);
  });

  test("an optional filter is reported as a full scan", () => {
    const a = t.analyze("select id from orders where (:status is null or status = :status)", "orders");
    assert.deepEqual(a.params, [{ name: "status", type: '"draft" | "confirmed" | null', encode: false }]);
    assert.deepEqual(a.scans, ["orders"]);
    assert.deepEqual(t.analyze("select id from orders where id = :id", "orders").scans, []);
  });

  test("a generated column is read with its type, and an integer check list is a union of numbers", () => {
    const a = t.analyze("select id, size, flag, total, label from files where flag = :flag", "files");
    assert.deepEqual(a.columns.map((c) => [c.name, c.type]), [["id", "FilesId"], ["size", "number"], ["flag", "0 | 1"], ["total", "number"], ["label", "string | null"]]);
    assert.deepEqual(a.params, [{ name: "flag", type: "0 | 1", encode: false }]);
    // The engine refuses a write to a generated column, with its own message.
    assert.throws(() => t.analyze("insert into files (id, size, flag, total) values (:id, :size, :flag, :total)", "files"), (e: unknown) => e instanceof BuildError && /generated column/.test(e.message));
  });

  test("returning gives rows with brands", () => {
    const a = t.analyze("insert into customers (id, name) values (:id, :name) returning id, name", "customers");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.columns, [{ name: "id", type: "CustomersId", json: false }, { name: "name", type: "string", json: false }]);
  });
});
