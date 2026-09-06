import { assert, commands, index, queries, table } from "solarsql";
import { generated } from "./solarsql.generated.ts";

export const orders = table(`
  -- An order placed by one customer.
  create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed', 'cancelled')),
    note text
  ) strict
`);

export const orderLines = table(`
  -- One line of an order.
  create table order_lines (
    id text primary key not null,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0),
    price real not null
  ) strict
`);

export const orderLinesByOrder = index(`create index order_lines_order_id on order_lines (order_id)`);

export const inventory = table(`
  -- Stock per sku. The shelf holds 100 of one sku at most.
  create table inventory (
    sku text primary key not null,
    qty integer not null check (qty >= 0 and qty <= 100)
  ) strict
`);

export const orderQueries = queries(generated, {
  byId: `
    -- One order, or none.
    select id, customer_id, status, note from orders where id = :id`,
  withLines: `
    -- One order with its lines as an array. Empty when it has none.
    select o.id, o.status,
      coalesce(json_group_array(json_object('id', l.id, 'sku', l.sku, 'qty', l.qty, 'price', l.price))
        filter (where l.id is not null), '[]') as lines
    from orders o
    left join order_lines l on l.order_id = o.id
    where o.id = :id
    group by o.id`,
  byCustomer: `
    -- The orders of one customer, newest id first.
    select id, status from orders where customer_id = :customer_id order by id desc`,
  stockBySku: `
    -- The stock of one sku, or none.
    select sku, qty from inventory where sku = :sku`,
});

export const orderCommands = commands(generated, {
  place: {
    plan: [
      "insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')",
      `insert into order_lines (id, order_id, sku, qty, price)
       select value ->> 'id', :id, value ->> 'sku', value ->> 'qty', value ->> 'price' from json_each(:lines)`,
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  confirm: {
    plan: [
      assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),
      "update orders set status = 'confirmed' where id = :id and status = 'draft'",
      assert("was_draft", "changes() = 1"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  annotate: {
    plan: ["update orders set note = :note where id = :id"],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
  setStock: {
    plan: ["insert into inventory (sku, qty) values (:sku, :qty) on conflict (sku) do update set qty = excluded.qty"],
    returns: "select sku, qty from inventory where sku = :sku",
  },
});
