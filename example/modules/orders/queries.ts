import { queries } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

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
});
