-- Migration 0001_initial.sql. wrangler applies it; the tests apply it too.
CREATE TABLE customers (
    id text primary key not null,
    name text not null,
    email text not null unique
  ) strict;
CREATE TABLE orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed', 'cancelled')),
    note text
  ) strict;
CREATE TABLE order_lines (
    id text primary key not null,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0),
    price real not null
  ) strict;
CREATE INDEX order_lines_order_id on order_lines (order_id);
