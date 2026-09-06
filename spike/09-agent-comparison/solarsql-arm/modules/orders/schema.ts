import { index, table } from "solarsql";

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
  -- One line of an order: a product and a quantity.
  create table order_lines (
    id text primary key not null,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0),
    price real not null
  ) strict
`);

export const orderLinesByOrder = index(`create index order_lines_order_id on order_lines (order_id)`);
