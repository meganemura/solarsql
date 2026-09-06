import { assert, commands, index, queries, search, table, trigger } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

export const orders = table(`
  -- An order placed by one customer.
  create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text,
    updated_at text
  ) strict
`);

// Full-text search over the notes. The two triggers below keep it in step
// with orders; a search joins back to orders by order_id.
export const orderSearch = search(`create virtual table order_search using fts5(order_id unindexed, note)`);

export const orderSearchInsert = trigger(`
  create trigger order_search_insert after insert on orders
  begin
    insert into order_search (order_id, note) values (new.id, new.note);
  end
`);

export const orderSearchUpdate = trigger(`
  create trigger order_search_update after update of note on orders
  begin
    delete from order_search where order_id = new.id;
    insert into order_search (order_id, note) values (new.id, new.note);
  end
`);

// The engine stamps the time of the last change, so no command has to.
export const ordersTouch = trigger(`
  create trigger orders_touch after update on orders
  begin
    update orders set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = new.id;
  end
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

export const ordersByCustomer = index(`create index orders_customer_id on orders (customer_id)`);
export const orderLinesByOrder = index(`create index order_lines_order_id on order_lines (order_id)`);

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
  byIds: `
    -- The orders with the given ids. One parameter carries the whole list,
    -- so the list can be longer than the 100 bound values D1 allows.
    select id, status from orders where id in (select value from json_each(:ids)) order by id`,
  search: `
    -- Orders of one customer, with an optional status and a chosen order.
    select id, status, note from orders
    where customer_id = :customer_id and (:status is null or status = :status)
    order by case :sort when 'id' then id when 'status' then status end
    limit :limit offset :offset`,
  byNote: `
    -- Orders whose note matches a pattern. No index serves LIKE, so this
    -- reads the table in full, and the build reports it.
    select id, status, note from orders where note like :pattern order by id`,
  searchNotes: `
    -- Orders whose note matches a full-text query, best match first.
    select o.id, o.status, o.note, cast(bm25(order_search) as real) as score
    from order_search join orders o on o.id = order_search.order_id
    where order_search match :query
    order by rank`,
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
    returns: "select id, note, updated_at from orders where id = :id",
  },
  reprice: {
    // The price of several lines of one order from one JSON array. Every id
    // must belong to the order, or the whole command rolls back.
    plan: [
      `update order_lines
       set price = (select value ->> 'price' from json_each(:lines) where value ->> 'id' = order_lines.id)
       where order_id = :id and id in (select value ->> 'id' from json_each(:lines))`,
      assert("all_lines_known", "changes() = json_array_length(:lines)"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
});
