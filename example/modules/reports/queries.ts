import { queries } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

export const reportQueries = queries(generated, {
  revenueByCustomer: `
    -- Confirmed revenue per customer, largest first.
    select c.id as customer_id, c.name,
      cast(sum(l.qty * l.price) as real) as revenue,
      cast(count(distinct o.id) as integer) as orders
    from customers c
    join orders o on o.customer_id = c.id and o.status = 'confirmed'
    join order_lines l on l.order_id = o.id
    group by c.id
    order by revenue desc`,
});
