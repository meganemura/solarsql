import { assert, commands } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

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
