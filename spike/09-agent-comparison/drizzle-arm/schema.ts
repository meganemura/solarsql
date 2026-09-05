// The tables of this Worker, declared for Drizzle. migrations/ holds the
// SQL that creates them.
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
});

// An order placed by one customer.
export const orders = sqliteTable(
  "orders",
  {
    id: text().primaryKey(),
    customer_id: text()
      .notNull()
      .references(() => customers.id),
    status: text({ enum: ["draft", "confirmed", "cancelled"] }).notNull(),
    note: text(),
  },
  (t) => [check("orders_status", sql`${t.status} in ('draft', 'confirmed', 'cancelled')`)],
);

// One line of an order.
export const orderLines = sqliteTable(
  "order_lines",
  {
    id: text().primaryKey(),
    order_id: text()
      .notNull()
      .references(() => orders.id),
    sku: text().notNull(),
    qty: integer().notNull(),
    price: real().notNull(),
  },
  (t) => [index("order_lines_order_id").on(t.order_id), check("order_lines_qty", sql`${t.qty} > 0`)],
);
