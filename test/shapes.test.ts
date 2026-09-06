// The SQL shapes the type generator supports, one line each, with the
// exact parameter and row types pinned. A change to scan.ts or typegen.ts
// that moves one of these lines is a change to the public contract.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/build/facts.ts";
import { Typer, brandName, type Brand } from "../src/build/typegen.ts";
import { GUARD_DDL } from "../src/runtime/plan.ts";

const ddl = [
  `create table customers (id text primary key not null, name text not null) strict`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) strict`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null, qty integer not null, price real not null) strict`,
  `create table tags (id text primary key not null, line_id text not null references order_lines(id), name text not null) strict`,
  `create table files (id text primary key not null, data blob not null, size integer not null, flag integer not null check (flag in (0, 1)), meta any, total integer not null as (size * 2) stored) strict`,
  `create view confirmed as select id, customer_id from orders where status = 'confirmed'`,
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

// [label, sql, params, row]. `row` is "-" for a statement that returns no rows.
const shapes: [string, string, string, string][] = [
  ["select *", "select * from orders where id = :id", "id: OrdersId", "id: OrdersId; customer_id: CustomersId; parent_id: OrdersId | null; status: \"draft\" | \"confirmed\"; note: string | null; created_at: string"],
  ["self join with o.*, the outer side nullable", "select o.*, p.status as parent_status from orders o left join orders p on p.id = o.parent_id where o.id = :id", "id: OrdersId", "id: OrdersId; customer_id: CustomersId | null; parent_id: OrdersId | null; status: \"draft\" | \"confirmed\"; note: string | null; created_at: string; parent_status: \"draft\" | \"confirmed\""],
  ["union all, a parameter in each branch", "select id, status from orders where status = :a union all select id, status from orders where customer_id = :b", "a: \"draft\" | \"confirmed\"; b: CustomersId", "id: OrdersId; status: \"draft\" | \"confirmed\""],
  ["a CTE", "with recent as (select id, status from orders where customer_id = :customer_id) select id, status from recent order by id", "customer_id: CustomersId", "id: OrdersId; status: \"draft\" | \"confirmed\""],
  ["upsert with excluded", "insert into order_lines (id, order_id, sku, qty, price) values (:id, :order_id, :sku, :qty, :price) on conflict (id) do update set qty = excluded.qty", "id: OrderLinesId; order_id: OrdersId; sku: string; qty: number; price: number", "-"],
  ["upsert with a parameter in the update", "insert into order_lines (id, order_id, sku, qty, price) values (:id, :order_id, :sku, :qty, :price) on conflict (id) do update set qty = :qty2", "id: OrderLinesId; order_id: OrdersId; sku: string; qty: number; price: number; qty2: number", "-"],
  ["delete returning", "delete from orders where id = :id returning id, status", "id: OrdersId", "id: OrdersId; status: \"draft\" | \"confirmed\""],
  ["update returning", "update orders set note = :note where id = :id returning id, note", "note: string | null; id: OrdersId", "id: OrdersId; note: string | null"],
  ["insert returning *", "insert into customers (id, name) values (:id, :name) returning *", "id: CustomersId; name: string", "id: CustomersId; name: string"],
  ["blob and any columns", "select id, data, size, meta from files where id = :id", "id: FilesId", "id: FilesId; data: Uint8Array; size: number; meta: SqlValue | null"],
  ["insert a blob", "insert into files (id, data, size, flag) values (:id, :data, :size, :flag)", "id: FilesId; data: Uint8Array; size: number; flag: 0 | 1", "-"],
  ["a json_object column", "select json_object('id', id, 'status', status) as o from orders where id = :id", "id: OrdersId", "o: { \"id\": OrdersId; \"status\": \"draft\" | \"confirmed\" } (json)"],
  ["a json array of scalars", "select coalesce(json_group_array(name) filter (where name is not null), '[]') as names from customers", "", "names: Array<string> (json)"],
  // A view hides the origin of its columns from the parameter typing.
  ["a read through a view", "select id, customer_id from confirmed where customer_id = :c", "c: SqlValue", "id: OrdersId; customer_id: CustomersId"],
  ["a LIKE pattern", "select id from orders where note like :pattern", "pattern: string | null", "id: OrdersId"],
  ["an insert that leaves a default out", "insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')", "id: OrdersId; customer_id: CustomersId", "-"],
  ["an IN list through json_each", "select id from orders where id in (select value from json_each(:ids))", "ids: readonly OrdersId[] (json)", "id: OrdersId"],
  ["rows through json_each", "insert into tags (id, line_id, name) select value ->> 'id', :line_id, value ->> 'name' from json_each(:tags)", "line_id: OrderLinesId; tags: readonly { \"id\": TagsId; \"name\": string }[] (json)", "-"],
  ["a subquery column with a cast", "select id, cast((select count(*) from order_lines l where l.order_id = o.id) as integer) as line_count from orders o", "", "id: OrdersId; line_count: number | null"],
  ["a window function with a cast", "select id, cast(row_number() over (order by id) as integer) as rn from orders", "", "id: OrdersId; rn: number"],
  ["a CASE expression with a cast", "select id, cast(case when status = 'draft' then 0 else 1 end as integer) as done from orders", "", "id: OrdersId; done: number | null"],
  ["a compare against a text column with a default", "select id from orders where created_at < :before", "before: string", "id: OrdersId"],
  ["insert or ignore", "insert or ignore into customers (id, name) values (:id, :name)", "id: CustomersId; name: string", "-"],
  ["replace into", "replace into customers (id, name) values (:id, :name)", "id: CustomersId; name: string", "-"],
  ["a bulk update from JSON rows", "update order_lines set price = (select value ->> 'price' from json_each(:lines) where value ->> 'id' = order_lines.id) where order_id = :id and id in (select value ->> 'id' from json_each(:lines))", "lines: readonly { \"price\": number; \"id\": OrderLinesId }[] (json); id: OrdersId", "-"],
  ["one parameter on a nullable and a not-null column", "select id from orders where id = :id or parent_id = :id", "id: OrdersId", "id: OrdersId"],
  ["one parameter in two CASE lists", "select id from orders order by case :dir when 'asc' then id end asc, case :dir when 'desc' then id end desc", "dir: \"asc\" | \"desc\"", "id: OrdersId"],
  ["a sum with a cast stays nullable", "select cast(sum(qty) as integer) as total from order_lines where order_id = :order_id", "order_id: OrdersId", "total: number | null"],
  ["coalesce with a literal is not null", "select cast(coalesce(sum(qty), 0) as integer) as total from order_lines where order_id = :order_id", "order_id: OrdersId", "total: number"],
  ["exists with a cast is not null", "select cast(exists (select 1 from orders where id = :id) as integer) as found", "id: OrdersId", "found: number"],
  ["a generated column", "select id, total from files where id = :id", "id: FilesId", "id: FilesId; total: number"],
  ["a count with a cast", "select cast(count(*) as integer) as n from orders where customer_id = :customer_id", "customer_id: CustomersId", "n: number"],
];

describe("supported shapes", () => {
  const t = typer();
  for (const [label, sql, params, row] of shapes) {
    test(label, () => {
      const a = t.analyze(sql, "m");
      assert.equal(a.params.map((p) => `${p.name}: ${p.type}${p.encode ? " (json)" : ""}`).join("; "), params);
      assert.equal(a.returnsRows ? a.columns.map((c) => `${c.name}: ${c.type}${c.json ? " (json)" : ""}`).join("; ") : "-", row);
    });
  }
});
