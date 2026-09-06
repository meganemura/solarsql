// A report module owns no table. It reads every table (readsAll in the
// configuration) and exports queries and views.
import { queries, view } from "../../../src/index.ts";
import { generated } from "./solarsql.generated.ts";

// The confirmed orders with the name of their customer, for the queries below.
export const confirmedOrders = view(`
  create view confirmed_orders as
  select o.id, o.customer_id, c.name as customer_name
  from orders o join customers c on c.id = o.customer_id
  where o.status = 'confirmed'
`);

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
  confirmedOrders: `
    -- Every confirmed order with its customer's name, through the view.
    select id, customer_id, customer_name from confirmed_orders order by id`,
});
