// A Worker that runs the data layer on D1. The tests send one JSON request
// per step and read the reply.
import { and, desc, eq, exists, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { customers, orderLines, orders } from "./schema.ts";

type Step =
  | { step: "createCustomer"; id: string; name: string; email: string }
  | { step: "placeOrder"; id: string; customer_id: string; lines: { id: string; sku: string; qty: number; price: number }[] }
  | { step: "confirm"; id: string }
  | { step: "annotate"; id: string; note: string | null }
  | { step: "order"; id: string }
  | { step: "ordersOf"; customer_id: string }
  | { step: "revenue" }
  | { step: "customers" };

type Db = DrizzleD1Database;

const orderColumns = { id: orders.id, customer_id: orders.customer_id, status: orders.status, note: orders.note };

async function run(db: Db, s: Step): Promise<unknown> {
  switch (s.step) {
    case "createCustomer": {
      try {
        const [row] = await db.insert(customers).values({ id: s.id, name: s.name, email: s.email }).returning();
        return row;
      } catch (e) {
        // Drizzle wraps the engine error; the D1 message is the cause.
        const cause = (e as Error & { cause?: Error }).cause;
        if (cause?.message.includes("UNIQUE constraint failed")) return { refused: "email_taken" };
        throw e;
      }
    }
    case "placeOrder": {
      const insertOrder = db.insert(orders).values({ id: s.id, customer_id: s.customer_id, status: "draft" }).returning(orderColumns);
      if (s.lines.length === 0) {
        const [row] = await insertOrder;
        return row;
      }
      // One batch is one transaction on D1: the order and its lines land together.
      const [rows] = await db.batch([insertOrder, db.insert(orderLines).values(s.lines.map((l) => ({ ...l, order_id: s.id })))]);
      return rows[0];
    }
    case "confirm": {
      // The rules sit in the WHERE clause, so the update itself decides.
      const hasLines = exists(db.select({ one: sql`1` }).from(orderLines).where(eq(orderLines.order_id, orders.id)));
      const [row] = await db
        .update(orders)
        .set({ status: "confirmed" })
        .where(and(eq(orders.id, s.id), eq(orders.status, "draft"), hasLines))
        .returning(orderColumns);
      if (row) return row;
      const current = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, s.id)).get();
      return { refused: current?.status === "draft" ? "has_lines" : "was_draft" };
    }
    case "annotate": {
      const [row] = await db.update(orders).set({ note: s.note }).where(eq(orders.id, s.id)).returning(orderColumns);
      return row ?? null;
    }
    case "order": {
      const order = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, s.id)).get();
      if (!order) return null;
      const lines = await db
        .select({ id: orderLines.id, sku: orderLines.sku, qty: orderLines.qty, price: orderLines.price })
        .from(orderLines)
        .where(eq(orderLines.order_id, s.id))
        .orderBy(orderLines.id);
      return { ...order, lines };
    }
    case "ordersOf":
      return db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.customer_id, s.customer_id)).orderBy(desc(orders.id));
    case "revenue":
      return db
        .select({
          customer_id: customers.id,
          name: customers.name,
          revenue: sql<number>`cast(sum(${orderLines.qty} * ${orderLines.price}) as real)`.as("revenue"),
          orders: sql<number>`cast(count(distinct ${orders.id}) as integer)`.as("orders"),
        })
        .from(customers)
        .innerJoin(orders, and(eq(orders.customer_id, customers.id), eq(orders.status, "confirmed")))
        .innerJoin(orderLines, eq(orderLines.order_id, orders.id))
        .groupBy(customers.id)
        .orderBy(desc(sql`revenue`));
    case "customers":
      return db.select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).orderBy(customers.name);
  }
}

type Env = { DB: D1Database };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return Response.json({ ok: true, value: await run(drizzle(env.DB), (await request.json()) as Step) });
    } catch (e) {
      const err = e as Error & { cause?: Error };
      return Response.json({ ok: false, message: err.message, cause: err.cause?.message ?? null });
    }
  },
};
