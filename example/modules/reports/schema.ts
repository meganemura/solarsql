// A report module owns no table. It reads every table (readsAll in the
// configuration) and exports queries and views.
import { view } from "../../../src/index.ts";

// The confirmed orders with the name of their customer, for the queries below.
export const confirmedOrders = view(`
  create view confirmed_orders as
  select o.id, o.customer_id, c.name as customer_name
  from orders o join customers c on c.id = o.customer_id
  where o.status = 'confirmed'
`);
