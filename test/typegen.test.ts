// The type generator turns engine facts into TypeScript text. These cases
// pin the text for the shapes the library supports, and the errors for the
// shapes it refuses.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
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
  `create table tags (id text primary key not null, line_id text not null references order_lines(id), name text not null) strict`,
  `create virtual table note_search using fts5(order_id unindexed, note)`,
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

  test("a multi-row VALUES insert types every row's parameters from the target columns", () => {
    const a = t.analyze(
      "insert into orders (id, customer_id, status) values (:id1, :cid1, :s1), (:id2, :cid2, :s2), (:id3, :cid3, :s3)",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [
      ["id1", "OrdersId"], ["cid1", "CustomersId"], ["s1", '"draft" | "confirmed"'],
      ["id2", "OrdersId"], ["cid2", "CustomersId"], ["s2", '"draft" | "confirmed"'],
      ["id3", "OrdersId"], ["cid3", "CustomersId"], ["s3", '"draft" | "confirmed"'],
    ]);
  });

  test("a multi-row VALUES insert with ON CONFLICT types every row's parameters, and leaves excluded.<column> untouched", () => {
    const a = t.analyze(
      "insert into orders (id, customer_id, status) values (:id1, :cid1, :s1), (:id2, :cid2, :s2) on conflict (id) do update set status = excluded.status",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [
      ["id1", "OrdersId"], ["cid1", "CustomersId"], ["s1", '"draft" | "confirmed"'],
      ["id2", "OrdersId"], ["cid2", "CustomersId"], ["s2", '"draft" | "confirmed"'],
    ]);
  });

  test("a multi-row VALUES insert with a mismatched row width is refused with SQLite's own message", () => {
    assert.throws(
      () => t.analyze("insert into orders (id, customer_id, status) values (:id1, :cid1, :s1), (:id2, :cid2)", "orders"),
      (e: unknown) => e instanceof BuildError && /all VALUES must have the same number of terms/.test(e.message),
    );
  });

  test("an update infers from SET and WHERE, nullable column allows null", () => {
    const a = t.analyze("update orders set note = :note where id = :id and status = :status", "orders");
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["id", "OrdersId"], ["status", '"draft" | "confirmed"']]);
  });

  test("a DML statement's own top-level WHERE parameter compared to an UPDATE ... FROM join's null-producing column allows null", () => {
    const a = t.analyze(
      "update orders set note = :note from order_lines l left join order_lines l2 on l2.order_id = l.order_id where orders.id = l.order_id and l2.qty = :q",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["q", "number | null"]]);
  });

  test("the same UPDATE ... FROM join parameter allows null with IS as well as with =", () => {
    const a = t.analyze(
      "update orders set note = :note from order_lines l left join order_lines l2 on l2.order_id = l.order_id where orders.id = l.order_id and l2.qty is :q",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["q", "number | null"]]);
  });

  test("an UPDATE ... FROM join parameter compared to the join's guaranteed side stays non-null", () => {
    const a = t.analyze(
      "update orders set note = :note from order_lines l left join order_lines l2 on l2.order_id = l.order_id where orders.id = l.order_id and l.qty = :q",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["q", "number"]]);
  });

  test("an UPDATE ... FROM row-value comparison against the join's null-producing column allows null", () => {
    const a = t.analyze(
      "update orders set note = :note from order_lines l left join order_lines l2 on l2.order_id = l.order_id where (orders.id, l2.qty) = (l.order_id, :q)",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["q", "number | null"]]);
  });

  test("an UPDATE ... FROM row-value comparison against the join's guaranteed column stays non-null", () => {
    const a = t.analyze(
      "update orders set note = :note from order_lines l left join order_lines l2 on l2.order_id = l.order_id where (orders.id, l.qty) = (l.order_id, :q)",
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["q", "number"]]);
  });

  test("an UPDATE with its own WITH clause resolves a real-table alias sharing a join with a CTE alias", () => {
    // The SET clause keeps a literal, not a parameter: this test targets the
    // `ofRef`/`sourceContext` path a WHERE parameter takes, not the `set`
    // parameter-site kind `updateTarget` resolves; that path has its own
    // coverage below.
    const a = t.analyze(
      `with x as (select id, order_id, qty from order_lines)
       update orders set note = 'unchanged'
       from x left join order_lines l2 on l2.order_id = x.order_id
       where orders.id = x.order_id and l2.qty = :q`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["q", "number | null"]]);
  });

  test("a parameter in a nested SET-clause subquery, correlated to an outer LEFT JOIN's null-producing alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = (select 1 from order_lines x where x.sku = 'a' and tg.name is :n)
       from order_lines ol left join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"]]);
  });

  test("a parameter in a nested WHERE-clause EXISTS subquery, correlated to an outer LEFT JOIN's null-producing alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = 'unchanged'
       from order_lines ol left join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id
         and exists (select 1 from order_lines x where x.sku = 'a' and tg.name is :n)`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"]]);
  });

  test("a parameter in a nested SET-clause subquery, correlated to an outer RIGHT JOIN's null-producing alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = (select 1 from order_lines x where x.sku = 'a' and ol.sku is :s)
       from order_lines ol right join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["s", "string | null"]]);
  });

  test("a parameter in a nested WHERE-clause EXISTS subquery, correlated to an outer RIGHT JOIN's null-producing alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = 'unchanged'
       from order_lines ol right join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id
         and exists (select 1 from order_lines x where x.sku = 'a' and ol.sku is :s)`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["s", "string | null"]]);
  });

  test("a parameter in a nested SET-clause subquery, correlated to an outer FULL JOIN's alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = (select 1 from order_lines x where x.sku = 'a' and tg.name is :n)
       from order_lines ol full join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"]]);
  });

  test("a parameter in a nested WHERE-clause EXISTS subquery, correlated to an outer FULL JOIN's alias, allows null", () => {
    const a = t.analyze(
      `update orders set note = 'unchanged'
       from order_lines ol full join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id
         and exists (select 1 from order_lines x where x.sku = 'a' and tg.name is :n)`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"]]);
  });

  test("a parameter in a nested subquery, correlated to a join's guaranteed alias, stays non-null", () => {
    const a = t.analyze(
      `update orders set note = (select 1 from order_lines x where x.sku = 'a' and ol.sku is :s)
       from order_lines ol left join tags tg on tg.line_id = ol.id
       where orders.id = ol.order_id`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["s", "string"]]);
  });

  test("a parameter in a nested subquery correlated to a join alias inside an INSERT ... SELECT is unaffected: its enclosing SELECT scope already resolves it", () => {
    const a = t.analyze(
      `insert into orders (id, customer_id, status, note)
       select ol.id, ol.order_id, 'draft', (select 1 from order_lines x where x.sku = 'a' and tg.name is :n)
       from order_lines ol left join tags tg on tg.line_id = ol.id`,
      "orders",
    );
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"]]);
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

  test("a one-to-many inside a one-to-many: json((select json_group_array(...))) inside json_object", () => {
    const a = t.analyze(
      "select o.id, coalesce(json_group_array(json_object('id', l.id, 'tags', json((select json_group_array(g.name) from tags g where g.line_id = l.id)))) filter (where l.id is not null), '[]') as lines from orders o left join order_lines l on l.order_id = o.id where o.id = :id group by o.id",
      "orders",
    );
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "lines", type: 'Array<{ "id": OrderLinesId; "tags": Array<string> }>', json: true },
    ]);
    // A json_object subquery may find no row, so it allows null.
    const b = t.analyze("select json_object('first', json((select json_object('id', l.id, 'sku', l.sku) from order_lines l where l.order_id = o.id order by l.id limit 1))) as summary from orders o where o.id = :id", "orders");
    assert.deepEqual(b.columns, [{ name: "summary", type: '{ "first": { "id": OrderLinesId; "sku": string } | null }', json: true }]);
    // Without json() the subquery nests as a string, and the build says so.
    assert.throws(
      () => t.analyze("select json_object('id', o.id, 'tags', (select json_group_array(g.name) from tags g where g.line_id = o.id)) as x from orders o", "orders"),
      (e: unknown) => e instanceof BuildError && /Wrap it in json\(\.\.\.\)/.test(e.message),
    );
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

  test("a cast around a bare NOT NULL column reference on the outer side of a join stays nullable", () => {
    const a = t.analyze("select cast(l.sku as text) as t from orders o left join order_lines l on l.order_id = o.id", "orders");
    assert.deepEqual(a.columns, [{ name: "t", type: "string | null", json: false }]);
  });

  test("a cast around coalesce whose last argument is on the outer side of a join stays nullable", () => {
    const a = t.analyze("select cast(coalesce(o.note, l.sku) as text) as t from orders o left join order_lines l on l.order_id = o.id", "orders");
    assert.deepEqual(a.columns, [{ name: "t", type: "string | null", json: false }]);
  });

  test("a cast around ifnull whose last argument is on the outer side of a join stays nullable", () => {
    const a = t.analyze("select cast(ifnull(o.note, l.sku) as text) as t from orders o left join order_lines l on l.order_id = o.id", "orders");
    assert.deepEqual(a.columns, [{ name: "t", type: "string | null", json: false }]);
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

  test("a full-text search table: text columns, a numeric rank, and a string match parameter", () => {
    // The WHERE clause's unconditional "note_search match :q" conjunct makes
    // rank non-null (a MATCH is required for every row this query returns).
    const a = t.analyze("select order_id, note, rank, cast(bm25(note_search) as real) as score from note_search where note_search match :q order by rank", "orders");
    assert.deepEqual(a.columns.map((c) => [c.name, c.type]), [["order_id", "string | null"], ["note", "string | null"], ["rank", "number"], ["score", "number | null"]]);
    assert.deepEqual(a.params, [{ name: "q", type: "string", encode: false }]);
    assert.deepEqual(a.scans, []);
    const b = t.analyze("insert into note_search (order_id, note) values (:id, :note)", "orders");
    assert.deepEqual(b.params.map((p) => [p.name, p.type]), [["id", "string | null"], ["note", "string | null"]]);
  });

  test("returning gives rows with brands", () => {
    const a = t.analyze("insert into customers (id, name) values (:id, :name) returning id, name", "customers");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.columns, [{ name: "id", type: "CustomersId", json: false }, { name: "name", type: "string", json: false }]);
  });

  test("a bare RETURNING column stays non-null when a nested json() subquery has its own alias of the same column name", () => {
    // order_lines and orders (via its own alias o2) both have an "id" column,
    // but those aliases live inside the nested subquery's own scope. The
    // outer statement's own "id" still resolves to orders.id alone. The
    // FILTER clause satisfies the library's own outer-join rule (ADR 0111,
    // pinned elsewhere in this file): "l" sits on the nullable side of the
    // RIGHT JOIN, so json_group_array needs it regardless of this test's
    // subject, which is the alias leakage into the outer "id" reference.
    const a = t.analyze(
      `update orders set note = note where id = :id
       returning id, json_object('lines', json((select json_group_array(json_object('sku', l.sku)) filter (where l.id is not null)
         from order_lines l right join orders o2 on l.order_id = o2.id where o2.id = orders.id))) as data`,
      "orders",
    );
    assert.equal(a.columns.find((c) => c.name === "id")?.type, "OrdersId");
  });

  test("a bare RETURNING column stays non-null with a nested subquery of the same name and no join at all", () => {
    const a = t.analyze(
      `update orders set note = note where id = :id
       returning id, json_object('lines', json((select json_group_array(json_object('sku', l.sku))
         from order_lines l where l.order_id = orders.id))) as data`,
      "orders",
    );
    assert.equal(a.columns.find((c) => c.name === "id")?.type, "OrdersId");
  });

  test("returning id alone still types the bare column non-null (regression guard)", () => {
    const a = t.analyze("update orders set note = note where id = :id returning id", "orders");
    assert.deepEqual(a.columns, [{ name: "id", type: "OrdersId", json: false }]);
  });

  // The bare-column branch resolves against the RETURNING target table alone
  // (the tests above). The CAST branch and the json_object branch used to
  // resolve their own bare column references a different way, against the
  // whole SQL text's aliases, so a nested subquery's own alias of the same
  // column name (here, order_lines' own "id", inside the json() value) made
  // the outer "id" reference look ambiguous or unresolvable to them, even
  // though only one alias of "id" exists in the RETURNING clause's own scope.
  test("a RETURNING CAST branch types a bare NOT NULL column non-null, even when a nested json() subquery has its own alias of the same column name", () => {
    const a = t.analyze(
      `update orders set note = note where id = :id
       returning cast(id as text) as t,
         json_object('lines', json((select json_group_array(json_object('sku', l.sku))
           from order_lines l where l.order_id = orders.id))) as data`,
      "orders",
    );
    assert.equal(a.columns.find((c) => c.name === "t")?.type, "string");
  });

  test("a RETURNING CAST branch types a bare NOT NULL column non-null with no nested subquery involved", () => {
    const a = t.analyze("update orders set note = note where id = :id returning cast(id as text) as t", "orders");
    assert.equal(a.columns.find((c) => c.name === "t")?.type, "string");
  });

  test("a RETURNING json_object branch resolves a bare column, even when a nested json() subquery has its own alias of the same column name", () => {
    const a = t.analyze(
      `update orders set note = note where id = :id
       returning json_object('id', id,
         'lines', json((select json_group_array(json_object('sku', l.sku))
           from order_lines l where l.order_id = orders.id))) as data`,
      "orders",
    );
    const dataColumn = a.columns.find((c) => c.name === "data");
    assert.equal(dataColumn?.json, true);
    assert.equal(dataColumn?.type, '{ "id": OrdersId; "lines": Array<{ "sku": string }> }');
  });

  test("a RETURNING json_object branch resolves a bare column with no nested subquery involved", () => {
    const a = t.analyze("update orders set note = note where id = :id returning json_object('id', id) as data", "orders");
    const dataColumn = a.columns.find((c) => c.name === "data");
    assert.equal(dataColumn?.json, true);
    assert.equal(dataColumn?.type, '{ "id": OrdersId }');
  });

  // The DML statement's own WHERE clause has no enclosing SELECT scope, so
  // its bare column references used to fall back to a statement-wide alias
  // map that also carried a nested subquery's own aliases. A same-named
  // column there (order_lines also has "id") made an otherwise-unambiguous
  // "id" look ambiguous, collapsing the parameter's type to SqlValue.
  test("a top-level WHERE parameter is not confused by a nested SET-clause scalar subquery's own alias of the same column name", () => {
    const a = t.analyze(
      `update orders set note = (select l.sku from order_lines l where l.order_id = orders.id limit 1) where id = :id`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
  });

  test("a top-level WHERE parameter is not confused by a nested EXISTS subquery's own alias of the same column name", () => {
    const a = t.analyze(
      `delete from orders where id = :id and exists (select 1 from order_lines l where l.order_id = orders.id)`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
  });

  test("a top-level IN-list json_each parameter keeps its array type despite a nested RETURNING subquery's own alias of the same column name", () => {
    const a = t.analyze(
      `update orders set note = note where id in (select value from json_each(:ids))
       returning id, json_object('lines', json((select json_group_array(json_object('sku', l.sku))
         from order_lines l where l.order_id = orders.id))) as data`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "ids", type: "readonly OrdersId[]", encode: true }]);
  });

  // Control: a parameter inside a nested subquery's own WHERE clause has an
  // enclosing SELECT scope (context is set) and must keep resolving through
  // scopedReference, unaffected by the top-level fallback change above.
  test("a parameter inside a nested subquery's own WHERE clause still resolves through that subquery's own scope", () => {
    const a = t.analyze(
      `delete from orders where id = :id and exists (select 1 from order_lines l where l.order_id = orders.id and l.sku = :sku)`,
      "orders",
    );
    // Assert :sku alone: :id here also exercises this fix's own path (the
    // statement collides on "id" the same way the tests above do), so
    // asserting the whole array would make this control fail for either
    // regression, not only the one it names.
    assert.equal(a.params.find((p) => p.name === "sku")?.type, "string");
  });
});

// `updateTarget` names the table an UPDATE, or an INSERT/REPLACE ... ON
// CONFLICT DO UPDATE, changes, so the `set` parameter-site kind can look up
// the target column's declared type. A statement that opens with its own
// WITH clause must resolve to the same table and the same SET parameter
// type as the same statement without the WITH clause.
describe("updateTarget follows a target table across the statement's own leading WITH clause", () => {
  test("a WITH-prefixed UPDATE types its SET parameter from the target column, and its WHERE parameter is unaffected", () => {
    const engine = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
    ]);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("with x as (select id from orders) update orders set note = :note where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a WITH-prefixed UPDATE on a NOT NULL integer column types its SET parameter as number", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
      "create table order_lines (id text primary key not null, order_id text not null, qty integer not null) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      const a = t.analyze("with x as (select id from orders) update order_lines set qty = :qty where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["qty", "number"], ["id", "string"]]);
    } finally { other.close(); }
  });

  // Each pair holds a statement and the same statement with a leading WITH
  // clause spliced in front: the WITH clause must never change the SET
  // parameter's type, or the type of an unrelated INSERT-site parameter
  // sharing the same statement.
  const pairs: readonly (readonly [string, string])[] = [
    [
      "update orders set note = :note where id = :id",
      "with x as (select id from orders) update orders set note = :note where id = :id",
    ],
    [
      "update order_lines set qty = :qty where id = :id",
      "with x as (select id from orders) update order_lines set qty = :qty where id = :id",
    ],
    [
      "insert into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
      "with x as (select id from orders) insert into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
    ],
    [
      "update or ignore orders set note = :note where id = :id",
      "with x as (select id from orders) update or ignore orders set note = :note where id = :id",
    ],
    [
      "replace into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
      "with x as (select id from orders) replace into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
    ],
    [
      "insert or replace into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
      "with x as (select id from orders) insert or replace into orders (id, customer_id) values (:id, :cid) on conflict (id) do update set note = :note",
    ],
  ];

  test("a leading WITH clause never changes an UPDATE's or an upsert's SET or INSERT parameter types, across the OR-modifier forms", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
      "create table order_lines (id text primary key not null, order_id text not null, qty integer not null) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      hegel.test((tc) => {
        const [bareSql, withSql] = tc.draw(gs.sampledFrom(pairs));
        const bare = t.analyze(bareSql, "m").params.map((p) => [p.name, p.type]);
        const withParams = t.analyze(withSql, "m").params.map((p) => [p.name, p.type]);
        assert.deepEqual(withParams, bare);
      });
    } finally { other.close(); }
  });

  test("a WITH-prefixed insert ... on conflict do update types its SET parameter, matching the same statement without WITH", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      const a = t.analyze(pairs[2]![1], "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "string"], ["cid", "string"], ["note", "string | null"]]);
    } finally { other.close(); }
  });

  test("a WITH-prefixed UPDATE OR IGNORE types its SET parameter, matching the same statement without WITH", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      const a = t.analyze(pairs[3]![1], "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["id", "string"]]);
    } finally { other.close(); }
  });

  test("a WITH-prefixed REPLACE INTO ... ON CONFLICT DO UPDATE types its SET parameter, matching the same statement without WITH", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      const a = t.analyze(pairs[4]![1], "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "string"], ["cid", "string"], ["note", "string | null"]]);
    } finally { other.close(); }
  });

  test("a WITH-prefixed INSERT OR REPLACE ... ON CONFLICT DO UPDATE types its SET parameter, matching the same statement without WITH", () => {
    const other = new Engine([
      "create table orders (id text primary key not null, customer_id text not null, note text) strict",
    ]);
    try {
      const t = new Typer(other, new Map());
      const a = t.analyze(pairs[5]![1], "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "string"], ["cid", "string"], ["note", "string | null"]]);
    } finally { other.close(); }
  });
});

// SQLite's row-value SET assignment, `set (c1, c2) = (:p1, :p2)`, puts each
// parameter right after "(" or ",", never after "=" the way `set c = :p`
// does, so it needs its own scan in scan.ts rather than an extension of
// that match. Each test below uses its own Engine and Typer, matching the
// column set the fix's own repro cases used, so every expected type here
// transcribes directly from those measurements.
describe("a row-value SET assignment pairs each parameter with the column at the same position", () => {
  const rowValueDdl = [
    "create table orders (id text primary key not null, customer_id text not null, status text not null check (status in ('draft', 'confirmed')), note text) strict",
  ];

  test("a plain multi-column SET, the control case this fix must leave unchanged", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set note = :n, status = :s where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"], ["s", '"draft" | "confirmed"'], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value SET types each parameter from its column, instead of SqlValue", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (note, status) = (:n, :s) where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"], ["s", '"draft" | "confirmed"'], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a literal in one row-value slot leaves that slot with no parameter site", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (note, status) = (:n, 'draft') where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value group and a plain assignment in the same SET clause both type correctly", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (note, status) = (:n, :s), customer_id = :c where id = :id", "m");
      assert.deepEqual(
        a.params.map((p) => [p.name, p.type]),
        [["n", "string | null"], ["s", '"draft" | "confirmed"'], ["c", "string"], ["id", "string"]],
      );
    } finally { engine.close(); }
  });

  test("an upsert's DO UPDATE SET row-value assignment types from the target column", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze(
        "insert into orders (id, customer_id, status) values (:id, :cid, :s0) on conflict (id) do update set (note, status) = (:n, :s)",
        "m",
      );
      assert.deepEqual(
        a.params.map((p) => [p.name, p.type]),
        [["id", "string"], ["cid", "string"], ["s0", '"draft" | "confirmed"'], ["n", "string | null"], ["s", '"draft" | "confirmed"']],
      );
    } finally { engine.close(); }
  });

  test("column order reversed from declaration order still pairs by position, not by name", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (status, note) = (:s, :n) where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["s", '"draft" | "confirmed"'], ["n", "string | null"], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a single-column row-value assignment, the shape most likely to hide an off-by-one pairing bug", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (note) = (:n) where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "string | null"], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value SET types the same as the same columns written as plain assignments, for any non-empty subset", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const columns = ["customer_id", "status", "note"];
      hegel.test((tc) => {
        const subset = tc.draw(gs.arrays(gs.sampledFrom(columns), { minSize: 1, maxSize: columns.length, unique: true }));
        const plain = `update orders set ${subset.map((c) => `${c} = :${c}`).join(", ")} where id = :id`;
        const rowValue = `update orders set (${subset.join(", ")}) = (${subset.map((c) => `:${c}`).join(", ")}) where id = :id`;
        const plainParams = t.analyze(plain, "m").params.map((p) => [p.name, p.type]);
        const rowValueParams = t.analyze(rowValue, "m").params.map((p) => [p.name, p.type]);
        assert.deepEqual(rowValueParams, plainParams);
      });
    } finally { engine.close(); }
  });

  test("a row-value SET slot that holds an expression, not a bare parameter, still types that expression's parameter from its column", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set (customer_id, status) = (:x, coalesce(:y, 'draft')) where id = :id", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["x", "string"], ["y", "SqlValue"], ["id", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value SET whose right-hand side is a subquery emits no parameter site for that clause", () => {
    const engine = new Engine(rowValueDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze(
        "update orders set (customer_id, status) = (select customer_id, status from orders limit 1) where id = :id",
        "m",
      );
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "string"]]);
    } finally { engine.close(); }
  });
});

// SQLite's row-value comparison, `where (c1, c2) = (:p1, :p2)`, puts each
// parameter right after "(" or ",", never after a comparison operator the
// way `where c = :p` does, so it needs the same kind of dedicated scan the
// row-value SET assignment above needed. Unlike SET, either side of the
// comparison may hold the columns, and the site this scan produces must
// carry a resolved alias (`compare`, not `set`) so a comparison against a
// LEFT/RIGHT/FULL JOIN's null-producing side types the same as the
// equivalent AND-chain already does.
describe("a row-value comparison pairs each parameter with the column at the same position, join-nullability included", () => {
  const compareDdl = [
    "create table orders (id text primary key not null, customer_id text not null, status text not null check (status in ('draft', 'confirmed')), note text) strict",
    "create table order_lines (id text primary key not null, order_id text not null references orders(id), qty integer not null) strict",
  ];

  test("a row-value WHERE in a SELECT types each parameter from its column, instead of SqlValue", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (customer_id, status) = (:c, :s)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"], ["s", '"draft" | "confirmed"']]);
    } finally { engine.close(); }
  });

  test("the same row-value form types the same in a DML statement's own top-level WHERE", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("update orders set note = 'x' where (customer_id, status) = (:c, :s)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"], ["s", '"draft" | "confirmed"']]);
    } finally { engine.close(); }
  });

  test("the same row-value form types the same in a DELETE", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("delete from orders where (customer_id, status) = (:c, :s)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"], ["s", '"draft" | "confirmed"']]);
    } finally { engine.close(); }
  });

  test("an alias-qualified left-hand side types the same as the unqualified form", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders o where (o.customer_id, o.status) = (:c, :s)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"], ["s", '"draft" | "confirmed"']]);
    } finally { engine.close(); }
  });

  test("a row-value comparison against a LEFT JOIN's null-producing side allows null, matching the same columns compared with AND", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const rowValue = t.analyze(
        "select l.id from order_lines l left join orders o on o.id = l.order_id where (o.customer_id, o.status) = (:c, :s)",
        "m",
      );
      const andChain = t.analyze(
        "select l.id from order_lines l left join orders o on o.id = l.order_id where o.customer_id = :c and o.status = :s",
        "m",
      );
      const expected = [["c", "string | null"], ["s", '"draft" | "confirmed" | null']];
      assert.deepEqual(rowValue.params.map((p) => [p.name, p.type]), expected);
      assert.deepEqual(andChain.params.map((p) => [p.name, p.type]), expected);
      // The join's guaranteed side (order_lines, the left side of the LEFT
      // JOIN) stays non-null, the control this pair of tests depends on.
      const guaranteed = t.analyze(
        "select l.id from order_lines l left join orders o on o.id = l.order_id where (l.order_id) = (:oid)",
        "m",
      );
      assert.deepEqual(guaranteed.params.map((p) => [p.name, p.type]), [["oid", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value comparison against a RIGHT JOIN's null-producing side allows null, matching the same columns compared with AND; a RIGHT JOIN's null-producing side is its left table, order_lines, not the right one", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      // orders (o) is the right side of "order_lines l right join orders o",
      // so RIGHT JOIN keeps every one of its rows: it is the guaranteed side.
      const guaranteedRowValue = t.analyze(
        "select l.id from order_lines l right join orders o on o.id = l.order_id where (o.customer_id, o.status) = (:c, :s)",
        "m",
      );
      const guaranteedAndChain = t.analyze(
        "select l.id from order_lines l right join orders o on o.id = l.order_id where o.customer_id = :c and o.status = :s",
        "m",
      );
      const guaranteedExpected = [["c", "string"], ["s", '"draft" | "confirmed"']];
      assert.deepEqual(guaranteedRowValue.params.map((p) => [p.name, p.type]), guaranteedExpected);
      assert.deepEqual(guaranteedAndChain.params.map((p) => [p.name, p.type]), guaranteedExpected);
      // order_lines (l) is the left side of the same RIGHT JOIN, so it is
      // the side RIGHT JOIN may leave unmatched: the null-producing side,
      // even though it is written on the left of the join keyword.
      const nullRowValue = t.analyze(
        "select l.id from order_lines l right join orders o on o.id = l.order_id where (l.order_id, l.qty) = (:oid, :q)",
        "m",
      );
      const nullAndChain = t.analyze(
        "select l.id from order_lines l right join orders o on o.id = l.order_id where l.order_id = :oid and l.qty = :q",
        "m",
      );
      const nullExpected = [["oid", "string | null"], ["q", "number | null"]];
      assert.deepEqual(nullRowValue.params.map((p) => [p.name, p.type]), nullExpected);
      assert.deepEqual(nullAndChain.params.map((p) => [p.name, p.type]), nullExpected);
    } finally { engine.close(); }
  });

  test("a row-value comparison against a FULL JOIN's side allows null, matching the same columns compared with AND", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const rowValue = t.analyze(
        "select l.id from order_lines l full join orders o on o.id = l.order_id where (o.customer_id, o.status) = (:c, :s)",
        "m",
      );
      const andChain = t.analyze(
        "select l.id from order_lines l full join orders o on o.id = l.order_id where o.customer_id = :c and o.status = :s",
        "m",
      );
      const expected = [["c", "string | null"], ["s", '"draft" | "confirmed" | null']];
      assert.deepEqual(rowValue.params.map((p) => [p.name, p.type]), expected);
      assert.deepEqual(andChain.params.map((p) => [p.name, p.type]), expected);
    } finally { engine.close(); }
  });

  test("the `<` and `is` operators type a row-value comparison the same as `=` does", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const expected = [["c", "string"], ["s", '"draft" | "confirmed"']];
      assert.deepEqual(t.analyze("select id from orders where (customer_id, status) < (:c, :s)", "m").params.map((p) => [p.name, p.type]), expected);
      assert.deepEqual(t.analyze("select id from orders where (customer_id, status) is (:c, :s)", "m").params.map((p) => [p.name, p.type]), expected);
    } finally { engine.close(); }
  });

  test("the operands reversed, parameters on the left and columns on the right, type the same as the unreversed form", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (:c, :s) = (customer_id, status)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"], ["s", '"draft" | "confirmed"']]);
    } finally { engine.close(); }
  });

  test("a mixed row value, one position with the column on the left and the other with the column on the right, types each parameter from its own position's column", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (customer_id, :s) = (:c, status)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["s", '"draft" | "confirmed"'], ["c", "string"]]);
    } finally { engine.close(); }
  });

  test("a row-value tuple inside an IN list keeps every parameter typed as SqlValue, unlike a row-value comparison with = or <", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (customer_id, status) in ((:c, :s))", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "SqlValue"], ["s", "SqlValue"]]);
    } finally { engine.close(); }
  });

  test("a literal in one row-value slot leaves that slot with no parameter site", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (customer_id, status) = (:c, 'draft')", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "string"]]);
    } finally { engine.close(); }
  });

  test("column order reversed from declaration order still pairs by position, and a single-column row value pairs the same way", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const swapped = t.analyze("select id from orders where (status, customer_id) = (:s, :c)", "m");
      assert.deepEqual(swapped.params.map((p) => [p.name, p.type]), [["s", '"draft" | "confirmed"'], ["c", "string"]]);
      const single = t.analyze("select id from orders where (customer_id) = (:c)", "m");
      assert.deepEqual(single.params.map((p) => [p.name, p.type]), [["c", "string"]]);
    } finally { engine.close(); }
  });

  test("a function call's own argument list is never mistaken for a row-value tuple", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const length = t.analyze("select id from orders where length(customer_id) = (:n)", "m");
      assert.deepEqual(length.params.map((p) => [p.name, p.type]), [["n", "SqlValue"]]);
      const coalesce = t.analyze("select id from orders where coalesce(customer_id, status) = (:n)", "m");
      assert.deepEqual(coalesce.params.map((p) => [p.name, p.type]), [["n", "SqlValue"]]);
    } finally { engine.close(); }
  });

  test("a scalar subquery on the left-hand side leaves the parameter with no site, since the left side is not a column reference", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const a = t.analyze("select id from orders where (select count(*) from orders) = (:n)", "m");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["n", "SqlValue"]]);
    } finally { engine.close(); }
  });

  test("a row-value comparison types the same as the same columns written as an AND chain, for any non-empty subset, on a plain table", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const columns = ["customer_id", "status", "note"];
      hegel.test((tc) => {
        const subset = tc.draw(gs.arrays(gs.sampledFrom(columns), { minSize: 1, maxSize: columns.length, unique: true }));
        const andChain = `select id from orders where ${subset.map((c) => `${c} = :${c}`).join(" and ")}`;
        const rowValue = `select id from orders where (${subset.join(", ")}) = (${subset.map((c) => `:${c}`).join(", ")})`;
        const andChainParams = t.analyze(andChain, "m").params.map((p) => [p.name, p.type]);
        const rowValueParams = t.analyze(rowValue, "m").params.map((p) => [p.name, p.type]);
        assert.deepEqual(rowValueParams, andChainParams);
      });
    } finally { engine.close(); }
  });

  test("a row-value comparison types the same as the same columns written as an AND chain, for any non-empty subset, on a LEFT, RIGHT, or FULL JOIN's null-producing side", () => {
    const engine = new Engine(compareDdl);
    try {
      const t = new Typer(engine, new Map());
      const columns = ["customer_id", "status", "note"];
      // Each FROM clause below keeps `o` (orders) on the join's
      // null-producing side: the right side of LEFT, the left side of
      // RIGHT (since RIGHT keeps every row of its right-hand table), and
      // either side of FULL.
      const froms = [
        "from order_lines l left join orders o on o.id = l.order_id",
        "from orders o right join order_lines l on o.id = l.order_id",
        "from order_lines l full join orders o on o.id = l.order_id",
      ];
      hegel.test((tc) => {
        const subset = tc.draw(gs.arrays(gs.sampledFrom(columns), { minSize: 1, maxSize: columns.length, unique: true }));
        const from = tc.draw(gs.sampledFrom(froms));
        const andChain = `select l.id ${from} where ${subset.map((c) => `o.${c} = :${c}`).join(" and ")}`;
        const rowValue = `select l.id ${from} where (${subset.map((c) => `o.${c}`).join(", ")}) = (${subset.map((c) => `:${c}`).join(", ")})`;
        const andChainParams = t.analyze(andChain, "m").params.map((p) => [p.name, p.type]);
        const rowValueParams = t.analyze(rowValue, "m").params.map((p) => [p.name, p.type]);
        assert.deepEqual(rowValueParams, andChainParams);
      });
    } finally { engine.close(); }
  });
});

// D1 and a Durable Object's own storage refuse a function call outside
// workerd's own allowlist at prepare (ADR 0113). Engine.prepare() mirrors
// that refusal, so the build catches it instead of only the real deploy
// targets.
describe("a function call D1 and Durable Object storage would refuse at prepare", () => {
  const t = typer();

  test("sqlite_version(), cast to a type, is refused by name", () => {
    assert.throws(
      () => t.analyze("select cast(sqlite_version() as text) as v from orders", "orders"),
      (e: unknown) => e instanceof BuildError && /not authorized to use function: sqlite_version/.test(e.message),
    );
  });

  test("sqlite_source_id(), cast to a type, is refused by name", () => {
    assert.throws(
      () => t.analyze("select cast(sqlite_source_id() as text) as v from orders", "orders"),
      (e: unknown) => e instanceof BuildError && /not authorized to use function: sqlite_source_id/.test(e.message),
    );
  });

  test("a bare sqlite_version(), with no cast, is refused by the authorizer's own message, not the cast rule's", () => {
    // Engine.prepare() runs before Typer.analyze() reaches the "expression
    // with no type" check, so the authorizer's message wins here.
    assert.throws(
      () => t.analyze("select sqlite_version() as v from orders", "orders"),
      (e: unknown) => e instanceof BuildError && /not authorized to use function: sqlite_version/.test(e.message) && !/Wrap it in cast/.test(e.message),
    );
  });

  test("a scalar function on the allowlist still builds", () => {
    const a = t.analyze("select cast(random() as integer) as v from orders", "orders");
    assert.equal(a.columns[0]!.name, "v");
  });

  test("a JSON function on the allowlist still builds", () => {
    const a = t.analyze(`select cast(json_extract('{"a":1}', '$.a') as integer) as v from orders`, "orders");
    assert.equal(a.columns[0]!.name, "v");
  });

  test("an aggregate function on the allowlist still builds", () => {
    const a = t.analyze("select cast(count(*) as integer) as v from orders", "orders");
    assert.equal(a.columns[0]!.name, "v");
  });

  test("a window function on the allowlist still builds", () => {
    const a = t.analyze("select cast(row_number() over (order by id) as integer) as v from orders", "orders");
    assert.equal(a.columns[0]!.name, "v");
  });

  test("a math function on the allowlist still builds", () => {
    const a = t.analyze("select cast(abs(-1) as integer) as v from orders", "orders");
    assert.equal(a.columns[0]!.name, "v");
  });

  test("a date function on the allowlist still builds", () => {
    const a = t.analyze("select cast(strftime('%Y', 'now') as text) as v from orders", "orders");
    assert.equal(a.columns[0]!.name, "v");
  });
});

describe("a full-text search table's own match-operand column refuses to be selected", () => {
  const engine = new Engine([`create table other (id text primary key not null)`, `create virtual table f using fts5(body)`]);
  const t = new Typer(engine, new Map());

  test("selecting the hidden column bare, or aliased, refuses with a message naming the column, the table, and the alternatives", () => {
    for (const sql of ["select f from f", "select f as x from f"]) {
      assert.throws(() => t.analyze(sql, "m"), (e: unknown) =>
        e instanceof BuildError
        && /match operand/.test(e.message)
        && e.message.includes('"f"')
        && /highlight|snippet|bm25/.test(e.message));
    }
  });

  test("a table-qualified reference to the hidden column also refuses", () => {
    assert.throws(() => t.analyze("select f.f from f", "m"), (e: unknown) =>
      e instanceof BuildError && /match operand/.test(e.message));
  });

  test("the hidden column on the outer side of a LEFT JOIN still refuses, without | null in the message", () => {
    assert.throws(() => t.analyze("select f.f from other left join f on f match :q", "m"), (e: unknown) =>
      e instanceof BuildError && /match operand/.test(e.message) && !e.message.includes("| null"));
  });

  test("RETURNING the hidden column also refuses (the outputColumn() path)", () => {
    assert.throws(() => t.analyze("insert into f (body) values (:b) returning f", "m"), (e: unknown) =>
      e instanceof BuildError && /match operand/.test(e.message));
  });

  test("a MATCH condition's parameter is untouched: still a non-null string", () => {
    const a = t.analyze("select body from f where f match :q", "m");
    assert.deepEqual(a.params, [{ name: "q", type: "string", encode: false }]);
  });

  test("highlight(...) selected as an expression still refuses with its own, unrelated error", () => {
    assert.throws(
      () => t.analyze("select highlight(f, 0, '<', '>') as h from f where f match :q", "m"),
      (e: unknown) => e instanceof BuildError && /expression with no type. Wrap it in cast/.test(e.message),
    );
  });

  test("select * does not expand the hidden column, so it is not refused", () => {
    const a = t.analyze("select * from f", "m");
    assert.ok(!a.columns.some((c) => c.name === "f"));
  });
});

describe("a full-text search table's rank column types as non-null when a WHERE conjunct guarantees a MATCH", () => {
  const engine = new Engine([`create virtual table f using fts5(body)`]);
  const t = new Typer(engine, new Map());

  test("a single MATCH conjunct makes rank non-null", () => {
    const a = t.analyze("select rank from f where f match :q", "m");
    assert.deepEqual(a.columns, [{ name: "rank", type: "number", json: false }]);
  });

  test("a MATCH conjunct alongside another AND-ed conjunct still makes rank non-null", () => {
    const a = t.analyze("select rank from f where f match :q and body <> ''", "m");
    assert.deepEqual(a.columns, [{ name: "rank", type: "number", json: false }]);
  });

  test("no WHERE clause at all leaves rank nullable (regression guard)", () => {
    const a = t.analyze("select rank from f", "m");
    assert.deepEqual(a.columns, [{ name: "rank", type: "number | null", json: false }]);
  });

  test("a MATCH ORed with another condition leaves rank nullable: depth 0 alone does not prove every row matched", () => {
    // SQLite prepares and executes this query, returning a row where the
    // match did not hold (rowid = 2, f match 'alpha' false) with rank null.
    // A rule that only checked "does MATCH appear at depth 0" would wrongly
    // call this non-null.
    const a = t.analyze("select rank from f where rowid = 2 or f match :q", "m");
    assert.deepEqual(a.columns, [{ name: "rank", type: "number | null", json: false }]);
  });

  test("MATCH in a LEFT JOIN's ON clause leaves the outer rank nullable: only the WHERE clause is examined", () => {
    const other = new Engine([`create table t (id text primary key not null)`, `create virtual table f using fts5(body)`]);
    try {
      const ot = new Typer(other, new Map());
      const a = ot.analyze("select f.rank from t left join f on f match :q", "m");
      assert.deepEqual(a.columns, [{ name: "rank", type: "number | null", json: false }]);
    } finally {
      other.close();
    }
  });
});

describe("row type soundness", () => {
  test("compound JSON decoding requires compatible branch values", () => {
    const engine = new Engine(["create table a(id text primary key, n integer not null) strict"]);
    try {
      const t = new Typer(engine, new Map());
      assert.throws(() => t.analyze("select json_object('n', n) as value from a union all select 'text'", "m"), /mixes decoded JSON/);
      assert.deepEqual(t.analyze("select cast(json_object('n', n) as text) as value from a union all select 'text'", "m").columns, [{ name: "value", type: "string | null", json: false }]);
      assert.doesNotThrow(() => t.analyze("select cast('union right join' as text) as value from a /* full join */", "m"));
      assert.doesNotThrow(() => t.analyze('select n as "union" from a', "m"));
      assert.throws(() => t.analyze("with recursive x(n) as (select 1 union all select n+1 from x where n<3) select n from x", "m"), /expression with no type/);
    } finally { engine.close(); }
  });

  test("a UNION ALL branch's CHECK-narrowed literal type does not survive next to the other branch's bare scalar type", () => {
    const engine = new Engine([
      `create table a (tool text not null) strict`,
      `create table b (kind text not null check (kind in ('formula', 'cask'))) strict`,
    ]);
    try {
      const t = new Typer(engine, new Map());
      assert.deepEqual(
        t.analyze(`select cast('tool' as text) as kind from a union all select kind from b`, "m").columns,
        [{ name: "kind", type: "string | null", json: false }],
      );
    } finally { engine.close(); }
  });

  // INTERSECT and EXCEPT return only the left branch's rows, so their result
  // type is the left branch's type, unchanged. UNION returns rows from either
  // branch, so both branches' types merge, and a nullable branch makes the
  // result nullable.
  test("an INTERSECT keeps the left branch's NOT NULL type, unmerged with the right branch's nullable type", () => {
    const engine = new Engine([
      `create table a (x text not null) strict`,
      `create table b (x text) strict`,
    ]);
    try {
      const t = new Typer(engine, new Map());
      assert.deepEqual(
        t.analyze(`select x from a intersect select x from b`, "m").columns,
        [{ name: "x", type: "string", json: false }],
      );
      // Confirms b.x is really nullable: the same branches under UNION merge
      // to nullable, so INTERSECT's non-null result above is not a fluke.
      assert.deepEqual(
        t.analyze(`select x from a union select x from b`, "m").columns,
        [{ name: "x", type: "string | null", json: false }],
      );
    } finally { engine.close(); }
  });

  test("an EXCEPT keeps the left branch's NOT NULL type, unmerged with the right branch's nullable type", () => {
    const engine = new Engine([
      `create table a (x text not null) strict`,
      `create table b (x text) strict`,
    ]);
    try {
      const t = new Typer(engine, new Map());
      assert.deepEqual(
        t.analyze(`select x from a except select x from b`, "m").columns,
        [{ name: "x", type: "string", json: false }],
      );
      // Confirms b.x is really nullable: the same branches under UNION merge
      // to nullable, so EXCEPT's non-null result above is not a fluke.
      assert.deepEqual(
        t.analyze(`select x from a union select x from b`, "m").columns,
        [{ name: "x", type: "string | null", json: false }],
      );
    } finally { engine.close(); }
  });

  test("JSON filters narrow only the outer alias whose NULL rows they exclude", () => {
    const engine = new Engine([
      "create table a(id text primary key, n integer not null) strict",
      "create table b(id text primary key, n integer not null) strict",
      "create table c(id text primary key, n integer not null) strict",
    ]);
    try {
      engine.db.exec("insert into a values ('a',1); insert into b values ('a',2)");
      const t = new Typer(engine, new Map());
      for (const predicate of ["a.id is not null", "b.id is not null or 1", "b.n is null"]) {
        const sql = `select json_group_array(json_object('n', c.n)) filter(where ${predicate}) as value from a left join b on a.id=b.id left join c on a.id=c.id`;
        assert.equal(t.analyze(sql, "m").columns[0]!.type, 'Array<{ "n": number | null }>');
        assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string), predicate === "b.n is null" ? [] : [{ n: null }]);
      }
      const sql = "select json_group_array(json_object('bn', b.n, 'cn', c.n)) filter(where b.id is not null) as value from a left join b on a.id=b.id left join c on a.id=c.id";
      assert.equal(t.analyze(sql, "m").columns[0]!.type, 'Array<{ "bn": number; "cn": number | null }>');
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string), [{ bn: 2, cn: null }]);
    } finally {
      engine.close();
    }
  });

  test("INDEXED BY and NOT INDEXED do not widen a branded or CHECK-narrowed parameter type", () => {
    const engine = new Engine([
      "create table orders (id text primary key not null, status text not null check (status in ('draft', 'confirmed'))) strict",
      "create index orders_status_idx on orders(status)",
    ]);
    try {
      const t = new Typer(engine, new Map([["orders", { table: "orders", column: "id", typeName: "OrdersId", module: "m" }]]));
      const shapes: [string, string, string][] = [
        ["select", "select id, status from orders {HINT} where orders.id = :id and orders.status = :status", "select id, status from orders where orders.id = :id and orders.status = :status"],
        ["update", "update orders {HINT} set status = 'confirmed' where orders.id = :id and orders.status = :status", "update orders set status = 'confirmed' where orders.id = :id and orders.status = :status"],
        ["delete", "delete from orders {HINT} where orders.id = :id and orders.status = :status", "delete from orders where orders.id = :id and orders.status = :status"],
      ];
      for (const [label, withHintTemplate, without] of shapes) {
        const baseline = t.analyze(without, "m").params;
        for (const hint of ["indexed by orders_status_idx", "not indexed"]) {
          const withHint = withHintTemplate.replace("{HINT}", hint);
          assert.deepEqual(t.analyze(withHint, "m").params, baseline, `${label} / ${hint}`);
        }
      }
    } finally { engine.close(); }
  });

  test("a RETURNING expression on INSERT, UPDATE, and DELETE types the same way a SELECT's item would", () => {
    const engine = new Engine([
      // Mixed-case column to also exercise refNullable's sqliteName fix below.
      "create table orders (id text primary key not null, Qty integer not null, price real not null) strict",
    ]);
    try {
      const t = new Typer(engine, new Map());
      const shapes: [string, string][] = [
        ["insert", "insert into orders (id, Qty, price) values (:id, :qty, :price) returning id, Qty, cast(Qty as text) as qty_text, json_object('id', id, 'qty', Qty) as payload"],
        ["update", "update orders set Qty = Qty + 1 where id = :id returning id, Qty, cast(Qty as text) as qty_text, json_object('id', id, 'qty', Qty) as payload"],
        ["delete", "delete from orders where id = :id returning id, Qty, cast(Qty as text) as qty_text, json_object('id', id, 'qty', Qty) as payload"],
      ];
      for (const [label, sql] of shapes) {
        const columns = t.analyze(sql, "m").columns;
        assert.deepEqual(columns.map(c => c.name), ["id", "Qty", "qty_text", "payload"], label);
        assert.equal(columns[0]!.type, "string", `${label} id`);
        assert.equal(columns[1]!.type, "number", `${label} Qty`);
        assert.equal(columns[2]!.type, "string", `${label} qty_text (a CAST around a bare NOT NULL column now narrows, the same as it does in a SELECT)`);
        assert.equal(columns[3]!.json, true, `${label} payload`);
        assert.match(columns[3]!.type, /"id":\s*string/, `${label} payload id field`);
        assert.match(columns[3]!.type, /"qty":\s*number/, `${label} payload qty field`);
      }
    } finally { engine.close(); }
  });

  test("a RETURNING reference whose case differs from the declared column still narrows to non-null when the column is NOT NULL", () => {
    const engine = new Engine([
      "create table orders (id text primary key not null, Qty integer not null) strict",
    ]);
    try {
      const t = new Typer(engine, new Map());
      // coalesce's last argument is one of two castNeverNull shapes that
      // call columnNullable(ref) with a bare reference; the other is a
      // plain cast(col as ...) around nothing but the reference itself,
      // covered by a dedicated test below.
      const columns = t.analyze("update orders set Qty = Qty + 1 where id = :id returning cast(coalesce(qty, qty) as integer) as x", "m").columns;
      assert.equal(columns[0]!.type, "number", "a NOT NULL column referenced with different case, inside coalesce's last argument, must not widen to nullable");
    } finally { engine.close(); }
  });

  test("a CAST wrapping a bare column reference is non-null exactly when the column is", () => {
    const engine = new Engine([
      "create table orders (id text primary key not null, Qty integer not null, price real) strict",
    ]);
    try {
      const t2 = new Typer(engine, new Map());
      const a = t2.analyze("select cast(Qty as text) as t from orders", "m");
      assert.equal(a.columns[0]!.type, "string", "Qty is declared NOT NULL");
      const b = t2.analyze("select cast(qty as text) as t from orders", "m");
      assert.equal(b.columns[0]!.type, "string", "qty resolves to the declared Qty column via sqliteName(), and Qty is NOT NULL");
      const c = t2.analyze("select cast(price as text) as t from orders", "m");
      assert.equal(c.columns[0]!.type, "string | null", "price has no NOT NULL declaration");
      const d = t2.analyze("select cast(:p as text) as t from orders", "m");
      assert.equal(d.columns[0]!.type, "string | null", "a parameter is not a column reference; columnRef(':p') is null, so this must stay nullable");
    } finally { engine.close(); }
  });

  test("a bare * in RETURNING expands to the target table's own columns", () => {
    const engine = new Engine([
      "create table orders (id text primary key not null, Qty integer not null) strict",
    ]);
    try {
      const t = new Typer(engine, new Map());
      const columns = t.analyze("update orders set Qty = Qty + 1 where id = :id returning *", "m").columns;
      assert.deepEqual(columns.map(c => ({name: c.name, type: c.type})), [{name: "id", type: "string"}, {name: "Qty", type: "number"}]);
    } finally { engine.close(); }
  });

  test("INSERT with an explicit column list still resolves a bare RETURNING column to its declared, non-null type", () => {
    // Regression guard for the aliasMap prerequisite fix: before it, this
    // exact shape (a column list immediately after the target table name)
    // made aliasMap discard the table entirely, widening every bare RETURNING
    // column here to nullable.
    const engine = new Engine([
      "create table orders (id text primary key not null, Qty integer not null) strict",
    ]);
    try {
      const t = new Typer(engine, new Map());
      const columns = t.analyze("insert into orders (id, Qty) values (:id, :qty) returning id, Qty", "m").columns;
      assert.deepEqual(columns.map(c => c.type), ["string", "number"]);
    } finally { engine.close(); }
  });
});

// RETURNING reaches nestedJsonType's "detached" branch (no ScopeContext),
// the one path ADR 0111 covers: before its fix, this branch resolved outer
// joins by matching EXPLAIN QUERY PLAN's text for "LEFT-JOIN" alone, so it
// silently missed RIGHT and FULL. A plain SELECT with the same nested shape
// already reached the correct refusal and the correct nullable type through
// Typer.sourceContext's syntactic join walk; these cases confirm RETURNING
// now agrees with it for all three join kinds, including a parent row with
// no matching child row.
describe("RETURNING + a nested one-to-many JSON value, across LEFT, RIGHT, and FULL joins (ADR 0111)", () => {
  const engine = new Engine([
    "create table parents (id text primary key not null) strict",
    "create table children (id text primary key not null, parent_id text not null references parents(id), value text not null) strict",
  ]);
  // p1 has one child row; p2 is the orphan parent, with no child row.
  engine.db.exec(`insert into parents values ('p1'), ('p2'); insert into children values ('c1', 'p1', 'v1')`);
  const t = new Typer(engine, new Map());

  // children sits on the nullable side of each join: the right side of
  // LEFT, the left side of RIGHT, and either side of FULL.
  const clauses: [string, string][] = [
    ["left", "from parents p2 left join children c on c.parent_id = p2.id where p2.id = parents.id"],
    ["right", "from children c right join parents p2 on c.parent_id = p2.id where p2.id = parents.id"],
    ["full", "from children c full join parents p2 on c.parent_id = p2.id where p2.id = parents.id"],
  ];

  for (const [join, clause] of clauses) {
    test(`${join} join: a filter-less json_group_array over the child alias is refused, the same as a plain SELECT already refuses it`, () => {
      const sql = `update parents set id = id where id = 'p1'
        returning id, json_object('lines', json((select json_group_array(json_object('value', c.value)) ${clause}))) as data`;
      assert.throws(() => t.analyze(sql, "m"), (e: unknown) => e instanceof BuildError && /needs a filter/.test(e.message));
    });

    test(`${join} join: filtered, the generated type agrees with the real RETURNING output, for a parent with a child and an orphan parent`, () => {
      const sqlTemplate = `update parents set id = id where id = :pid
        returning id, json_object('lines', json((select json_group_array(json_object('value', c.value)) filter (where c.id is not null) ${clause}))) as data`;
      const analysis = t.analyze(sqlTemplate, "m");
      const dataColumn = analysis.columns.find((c) => c.name === "data")!;
      // The filter removes the join's null placeholder row, so the element
      // type carries no "| null": the same type the scoped SELECT path
      // already gives an equivalent query (test above, around line 111).
      assert.equal(dataColumn.type, '{ "lines": Array<{ "value": string }> }', join);
      // fits()/verify() (test/scope.test.ts) understand a scalar union, not
      // an Array<{...}> shape, so this checks the JSON array directly: parse
      // the real row's JSON text and confirm every element carries a string
      // value, never null, matching the type above.
      for (const [pid, expected] of [["p1", [{ value: "v1" }]], ["p2", []]] as const) {
        const row = engine.db.prepare(sqlTemplate.replace(":pid", `'${pid}'`)).get() as { data: string };
        const parsed = JSON.parse(row.data) as { lines: { value: unknown }[] };
        assert.deepEqual(parsed.lines, expected, `${join} join, parent ${pid}`);
        for (const element of parsed.lines) assert.equal(typeof element.value, "string", `${join} join, parent ${pid}: an element the filter admits must carry a string value, never null`);
      }
    });
  }

  test("right join: a filter on the join's OTHER alias does not narrow the referenced alias's nullability (ADR 0047)", () => {
    const clause = clauses.find(([join]) => join === "right")![1];
    const sqlTemplate = `update parents set id = id where id = :pid
      returning id, json_object('lines', json((select json_group_array(json_object('value', c.value)) filter (where p2.id is not null) ${clause}))) as data`;
    const analysis = t.analyze(sqlTemplate, "m");
    // This block's Typer carries no brand map (see above), so :pid types as
    // plain string, not a branded id. Before the alias-scoping fix, the bare
    // id in "where id = :pid" was ambiguous across three same-named-column
    // aliases (the outer parents target, plus the subquery's own c and p2),
    // so aliasOfBareColumn returned null and :pid collapsed to SqlValue.
    assert.deepEqual(analysis.params, [{ name: "pid", type: "string", encode: false }]);
    const dataColumn = analysis.columns.find((c) => c.name === "data")!;
    // The FILTER predicate narrows p2 (always non-null, the preserved side
    // of this RIGHT JOIN), not c (the nullable side c.value comes from). ADR
    // 0047: filtering one alias does not remove another alias's nullability,
    // so "| null" must survive here, unlike the c.id filter tested above.
    assert.equal(dataColumn.type, '{ "lines": Array<{ "value": string | null }> }');
    for (const [pid, expected] of [["p1", [{ value: "v1" }]], ["p2", [{ value: null }]]] as const) {
      const row = engine.db.prepare(sqlTemplate.replace(":pid", `'${pid}'`)).get() as { data: string };
      const parsed = JSON.parse(row.data) as { lines: { value: unknown }[] };
      assert.deepEqual(parsed.lines, expected, `parent ${pid}`);
    }
  });
});

test("origin columns retain NULL from views, query scopes, scalar subqueries, and wildcard joins", () => {
  const engine = new Engine([
    "create table a(id integer primary key not null) strict",
    "create table b(id integer primary key not null) strict",
    "create view v as select b.id from a left join b on a.id=b.id",
  ]);
  try {
    engine.db.exec("insert into a values (1)");
    const t = new Typer(engine, new Map());
    for (const sql of [
      "select v.id from v", "select id from v",
      "select x.id from (select b.id from a left join b on a.id=b.id) x",
      "with x as (select b.id from a left join b on a.id=b.id) select x.id from x",
      "with b as (select inner_b.id from a left join main.b inner_b on a.id=inner_b.id) select b.id from b",
      "select b.* from a left join b on a.id=b.id",
      "select (select id from b) as id",
    ]) {
      assert.equal(engine.db.prepare(sql).get()!.id, null, sql);
      assert.equal(t.analyze(sql, "m").columns[0]!.type, "number | null", sql);
    }
    assert.throws(() => t.analyze("select * from a left join b on a.id=b.id", "m"), /duplicate output column.*id/);
    assert.throws(() => t.analyze("select a.id, b.id from a left join b on a.id=b.id", "m"), /duplicate output column.*id/);
  } finally { engine.close(); }
});

test('CHECK literals describe stored classes only when the complete predicate proves them', () => {
  for (const [definition, input, expected] of [
    ['text not null check(value in (1))', 1, 'string'],
    ["integer not null check(value in ('1'))", '1', 'number'],
    ['real not null check(value in (1))', 1, '1'],
    ["any not null check(value in ('1'))", '1', '"1"'],
    ["text not null check(value in ('a') or value='b')", 'b', 'string'],
    ["text check(value in ('a','b') or value is null)", null, '"a" | "b" | null'],
    ["text check(value in ('a','b') or value is null)", 'a', '"a" | "b" | null'],
    ["text check(value is null or value in ('a','b'))", 'b', '"a" | "b" | null'],
    ["text check(value in ('a') or value is not null)", null, 'string | null'],
    ["text collate nocase not null check(value in ('a'))", 'A', 'string'],
    ["text collate rtrim not null check(value in ('a'))", 'a ', 'string'],
    ["text collate binary not null check(value in ('A'))", 'A', '"A"'],
    ["text not null check(value in ('x)y''z'))", "x)y'z", '"x)y\'z"'],
    ["text not null check(value in ('\r'))", '\r', '"\\r"'],
    ['integer not null check(value in (-1, +2))', -1, '-1 | 2'],
    ['real not null check(value in (1e999))', Infinity, 'number'],
    ["text check(value in ('a'))", null, '"a" | null'],
  ] as const) {
    const engine = new Engine([`create table t(value ${definition}) strict`]);
    try {
      const literal = typeof input === 'string' ? `'${input.replaceAll("'","''")}'` : input === null ? 'null' : Number.isFinite(input) ? String(input) : '1e999';
      engine.db.exec(`insert into t values (${literal})`);
      assert.equal(new Typer(engine,new Map()).analyze('select value from t','t').columns[0]!.type,expected,definition);
      const actual = engine.db.prepare('select value from t').get()!.value;
      if (expected === 'string' || expected === 'number') assert.equal(typeof actual,expected);
      else assert.deepEqual(actual,input);
    } finally {engine.close();}
  }
});

test('CHECK types admit the values SQLite stores after affinity conversion', async () => {
  const {test:property} = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const storage = tc.draw(gs.sampledFrom(['text','integer','real','any']));
    const n = tc.draw(gs.integers({minValue:-1_000_000,maxValue:1_000_000}));
    let value: string | number = tc.draw(gs.booleans()) ? n : String(n);
    if ((storage === 'text' || storage === 'any') && tc.draw(gs.booleans())) {
      // NUL cannot appear in SQL source. It is not a valid DDL string literal.
      value = tc.draw(gs.text({maxSize:50})).replaceAll('\0','');
    }
    const literal = typeof value === 'string' ? `'${value.replaceAll("'","''")}'` : String(value);
    const engine = new Engine([`create table t(value ${storage} not null check(value in (${literal}))) strict`]);
    try {
      // Use the same SQL literal class; Node number parameters bind as REAL.
      engine.db.exec(`insert into t values (${literal})`);
      const actual = engine.db.prepare('select value from t').get()!.value;
      const type = new Typer(engine,new Map()).analyze('select value from t','t').columns[0]!.type;
      if (type === 'string' || type === 'number') assert.equal(typeof actual,type);
      else assert.deepEqual(actual,JSON.parse(type));
    } finally {engine.close();}
  });
});

test('conflicting parameter types identify the generated qualified key', () => {
  const engine=new Engine(['create table items(id integer not null,value text not null) strict']);
  try {
    const typer=new Typer(engine,new Map());
    assert.throws(()=>typer.analyze('select id from items where id=:id or value=:id or id=@id',''), /parameter ":id" is used with two different types/);
  }finally{engine.close();}
});

test('JSON constructors describe decoded JSONB and flexible storage values', () => {
  for (const storage of ['blob', 'any']) {
    const engine=new Engine([`create table payload(value ${storage}) strict`]);
    try {
      const typer=new Typer(engine,new Map());
      assert.equal(typer.analyze("select json_object('data',value) as result from payload",'').columns[0]!.type,'{ "data": JsonValue }');
      assert.equal(typer.analyze('select json_group_array(value) as result from payload','').columns[0]!.type,'Array<JsonValue>');
      for (const value of [{nested:[true,null,3]},[1,'a'],true,null,17,'text']) {
        engine.db.prepare('insert into payload values(jsonb(?))').run(JSON.stringify(value));
        assert.deepEqual(JSON.parse(engine.db.prepare("select json_object('data',value) as result from payload").get()!.result as string),{data:value});
        engine.db.exec('delete from payload');
      }
      engine.db.exec("insert into payload values(x'00ff')");
      assert.throws(()=>engine.db.prepare("select json_object('data',value) from payload").get(),/JSON/);
      if(storage==='blob') assert.equal(typer.analyze('select value from payload','').columns[0]!.type,'Uint8Array | null');
      assert.equal(typer.analyze("select json_object('data',cast(value as text)) as result from payload",'').columns[0]!.type,'{ "data": string | null }');
      assert.equal(typer.analyze("select json_object('data',null,'count',3) as result",'').columns[0]!.type,'{ "data": null; "count": number }');
    }finally{engine.close();}
  }
});

test('JSONB constructor values round-trip nested generated JSON', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine(['create table payload(value blob not null) strict']);
  try {
    const insert=engine.db.prepare('insert into payload values(jsonb(?))');
    const read=engine.db.prepare("select json_object('data',value) as result from payload");
    property(tc=>{
      const value={items:tc.draw(gs.arrays(gs.integers({minValue:-100000,maxValue:100000}))),text:tc.draw(gs.text()),nested:{flag:tc.draw(gs.booleans()),empty:null}};
      engine.db.exec('delete from payload');
      insert.run(JSON.stringify(value));
      assert.deepEqual(JSON.parse(read.get()!.result as string),{data:value});
      assert.equal(new Typer(engine,new Map()).analyze("select json_object('data',value) as result from payload",'').columns[0]!.type,'{ "data": JsonValue }');
    },{testCases:1000});
  }finally{engine.close();}
});

test('BLOB literal types preserve engine values across query scopes', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const bytes=Uint8Array.from(tc.draw(gs.binary()));
      const hex=Buffer.from(bytes).toString('hex');
      const literal=tc.draw(gs.booleans()) ? `x'${hex}'` : `X'${hex.toUpperCase()}'`;
      for(const sql of [`select ${literal}`,`values (${literal})`,`with data as (select ${literal} as value) select value from data`,`select value from (select (${literal}) as value)`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.equal(analysis.sql,sql);
        assert.equal(analysis.columns[0]!.type,'Uint8Array');
        const statement=engine.db.prepare(sql);
        assert.equal(analysis.columns[0]!.name,statement.columns()[0]!.name);
        assert.deepEqual(statement.get()![analysis.columns[0]!.name],bytes);
      }
    },{testCases:1000});
    for(const literal of ["x'0'","x'gg'","x'00"]) assert.throws(()=>new Typer(engine,new Map()).analyze(`select ${literal}`,''));
    assert.equal(new Typer(engine,new Map()).analyze("values (x''),(null)",'').columns[0]!.type,'Uint8Array | null');
    const jsonb=engine.db.prepare("select hex(jsonb('{\"data\":[true,null]}')) as value").get()!.value;
    const sql=`select json_object('value',x'${jsonb}') as result`;
    assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "value": JsonValue }');
    assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),{value:{data:[true,null]}});
  }finally{engine.close();}
});

test('JSON decoding follows the complete expression and explicit scalar casts', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {parseJson}=await import('../src/runtime/plan.ts');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const n=tc.draw(gs.integers({minValue:-100000,maxValue:100000}));
      const json=`json_object('value',${n})`;
      const [expr,type]=tc.draw(gs.sampledFrom([
        [`length(${json})`,'integer'],[`${json} = '{}'`,'integer'],[`${json} || 'suffix'`,'text'],
        [`substr(${json},1,2)`,'text'],[`case when 1 then ${json} else '{}' end`,'text'],
      ]));
      const sql=`select ${expr} as value`;
      engine.db.prepare(sql).get();
      assert.throws(()=>new Typer(engine,new Map()).analyze(sql,''),/cast/);
      assert.throws(()=>new Typer(engine,new Map()).analyze(`select json_group_array(${expr}) as value`,''),/cast/);
      const cast=`select cast(${expr} as ${type}) as value`;
      const analysis=new Typer(engine,new Map()).analyze(cast,'');
      assert.deepEqual(analysis.columns,[{name:'value',type:type==='integer'?'number | null':'string | null',json:false}]);
      const actual=engine.db.prepare(cast).get()!;
      assert.deepEqual(parseJson([actual],analysis.columns.filter(c=>c.json).map(c=>c.name),'native'),[{...actual}]);
    },{testCases:1000});
    for(const expr of ["json_group_array(json_object('value',1)) filter(where 1) over ()","coalesce(json_group_array(json_object('value',1)) filter(where 1), '[]')","(json_group_array(json_object('value',1)))"]) {
      const sql=`select ${expr} as value`;
      assert.deepEqual(new Typer(engine,new Map()).analyze(sql,'').columns,[{name:'value',type:'Array<{ "value": number }>',json:true}]);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),[{value:1}]);
    }
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',json((select json_group_array(1))) || 'x')",''),/cast/);
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',json((select length(json_group_array(1)))))",''),/cast/);
  }finally{engine.close();}
});

test('complete BLOB casts retain binary values through SQL trivia and scopes', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const bytes=Uint8Array.from(tc.draw(gs.binary()));
      const literal=`x'${Buffer.from(bytes).toString('hex')}'`;
      const gap=tc.draw(gs.sampledFrom([' ','\n',' /* conversion */ ']));
      const cast=`(cast${gap}(${literal}${gap}as${gap}BLOB))`;
      for(const sql of [`select ${cast} as value`,`with data as (select ${cast} as value) select value from data`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.deepEqual(analysis.columns,[{name:'value',type:'Uint8Array | null',json:false}]);
        assert.equal(analysis.sql,sql);
        assert.deepEqual(engine.db.prepare(sql).get()!.value,bytes);
      }
    },{testCases:1000});
    for(const target of ['integer','real','text','blob']) {
      const sql=`select json_object('value',(cast /* note */ (null AS /* note */ ${target}))) as value`;
      const type=target==='blob'?'JsonValue':target==='text'?'string | null':'number | null';
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,`{ "value": ${type} }`);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{value:null});
    }
    for(const inner of ['exists(select 1) + null','not exists(select 1) + null']) {
      const sql=`select cast /* why */ (${inner} as integer) as value`;
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'number | null');
      assert.equal(engine.db.prepare(sql).get()!.value,null);
    }
    assert.equal(new Typer(engine,new Map()).analyze('select cast /* why */ (count(*) as integer) as value','').columns[0]!.type,'number');
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',length(cast('x' as text)))",''),/cast/);
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',cast(1 as integer) + 2)",''),/cast/);
  }finally{engine.close();}
});

test('decoded JSON object keys use the last value contract', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      // SQLite source literals cannot contain NUL; every other drawn character remains.
      const key=tc.draw(gs.text()).replaceAll('\0','');
      const literal=`'${key.replaceAll("'","''")}'`;
      const sql=`select json_object(${literal},length('overwritten'),/* last */ (${literal}), 'last') as value`;
      const analysis=new Typer(engine,new Map()).analyze(sql,'');
      assert.equal(analysis.sql,sql);
      assert.equal(analysis.columns[0]!.type,`{ ${JSON.stringify(key)}: string }`);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{[key]:'last'});
    },{testCases:1000});
    const sql="select json_object('data',1,'data',json_object('nested',null),'__proto__','safe') as value";
    assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "data": { "nested": null }; "__proto__": string }');
    assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{data:{nested:null},['__proto__']:'safe'});
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object(cast('key' as text),1)",''),/key must be a string literal/);
  }finally{engine.close();}
});

test('ordered JSON aggregates retain value types and SQLite ordering', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine(['create table items(value integer) strict']);
  try {
    const insert=engine.db.prepare('insert into items values(?)');
    property(tc=>{
      const values:(number|null)[]=tc.draw(gs.arrays(gs.integers({minValue:-10000,maxValue:10000})));
      if(tc.draw(gs.booleans())) values.push(null);
      const distinct=tc.draw(gs.booleans());
      const desc=tc.draw(gs.booleans());
      engine.db.exec('delete from items');for(const value of values) insert.run(value);
      const sql=`select json_group_array(${distinct?'distinct ':''}value order by value ${desc?'desc':'asc'}) as result from items`;
      const analysis=new Typer(engine,new Map()).analyze(sql,'');
      assert.deepEqual(analysis.columns,[{name:'result',type:'Array<number | null>',json:true}]);
      assert.equal(analysis.sql,sql);
      const expected=(distinct?[...new Set(values)]:[...values]).sort((a,b)=>{const cmp=a===b?0:a===null?-1:b===null?1:a-b;return desc?-cmp:cmp;});
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),expected);
    },{testCases:1000});
    engine.db.exec('delete from items;insert into items values(1),(2),(null)');
    for(const sql of [
      "select json_group_array(json_object('n',value) order by coalesce(value,0) desc, cast(value as text) collate binary) filter(where value is not null) as result from items",
      "select json_group_array(distinct json_object('n',value) order by value desc) filter(where value is not null) as result from items",
    ]) {
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'Array<{ "n": number | null }>');
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),[{n:2},{n:1}]);
    }
    assert.throws(()=>new Typer(engine,new Map()).analyze('select json_group_array(value order by) from items',''));
  }finally{engine.close();}
});

test('numeric literal spellings retain their engine type and source', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {tokenize}=await import('../src/build/scan.ts');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const n=tc.draw(gs.integers({minValue:0,maxValue:Number.MAX_SAFE_INTEGER}));
      const hex=tc.draw(gs.booleans());
      const digits=n.toString(hex?16:10);
      const separated=tc.draw(gs.booleans())?digits.split('').join('_'):digits;
      const literal=hex?`${tc.draw(gs.booleans())?'0X':'0x'}${separated}`:separated;
      assert.deepEqual(tokenize(literal),[{type:'number',text:literal,start:0,end:literal.length,depth:0}]);
      for(const sql of [`select ${literal} as value`,`values (${literal})`,`with data as (select ${literal} as value) select value from data`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.equal(analysis.sql,sql);
        assert.equal(analysis.columns[0]!.type,'number');
        assert.equal(engine.db.prepare(sql).get()![analysis.columns[0]!.name],n);
      }
    },{testCases:1000});
    for(const literal of ['1.','1.e2','.1_2','1_2.3_4e+0_2','-0Xf_f','+1_000','0XFF']) {
      const sql=`select json_object('value',${literal}) as result`;
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "value": number }');
      const expected=/^[+-]?0x/i.test(literal)?(literal[0]==='-'?-1:1)*Number(literal.replace(/^[+-]/,'').replaceAll('_','')):Number(literal.replaceAll('_',''));
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),{value:expected});
    }
    for(const literal of ['1__2','0X_FF','1_.0','1._0','1e_2']) assert.throws(()=>new Typer(engine,new Map()).analyze(`select ${literal} as value`,''));
    const sql="select 1_000 + :amount, '0XFF' as quoted";
    const tokens=tokenize(sql);
    assert.equal(tokens.map(t=>t.text).join(''),sql);
    assert.deepEqual(tokens.filter(t=>t.type==='param').map(t=>t.text),[':amount']);
    for(const token of tokens)assert.equal(sql.slice(token.start,token.end),token.text);
  }finally{engine.close();}
});
