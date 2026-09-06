// A Worker that runs the modules on D1. The tests send one JSON request
// per step and read the reply.
import { d1 } from "solarsql/d1";
import type { Database } from "solarsql";
import { customerCommands, customerQueries } from "./modules/customers/public.ts";
import { orderCommands, orderQueries } from "./modules/orders/public.ts";
import { reportQueries } from "./modules/reports/public.ts";
import type { CustomersId } from "./modules/customers/public.ts";
import type { InventoryId, OrderLinesId, OrdersId } from "./modules/orders/public.ts";

type Step =
  | { step: "createCustomer"; id: string; name: string; email: string }
  | { step: "placeOrder"; id: string; customer_id: string; lines: { id: string; sku: string; qty: number; price: number }[] }
  | { step: "confirm"; id: string }
  | { step: "annotate"; id: string; note: string | null }
  | { step: "order"; id: string }
  | { step: "ordersOf"; customer_id: string }
  | { step: "setStock"; sku: string; qty: number }
  | { step: "stock"; sku: string }
  | { step: "revenue" }
  | { step: "customers" };

async function run(db: Database, s: Step): Promise<unknown> {
  switch (s.step) {
    case "createCustomer": {
      const r = await db.run(customerCommands.create, { id: s.id as CustomersId, name: s.name, email: s.email });
      if (r.ok) return r.rows[0];
      return { refused: r.kind === "unique" ? "email_taken" : r.kind };
    }
    case "placeOrder": {
      const r = await db.run(orderCommands.place, {
        id: s.id as OrdersId,
        customer_id: s.customer_id as CustomersId,
        lines: s.lines.map((l) => ({ ...l, id: l.id as OrderLinesId })),
      });
      if (r.ok) return r.rows[0];
      return { refused: r.kind };
    }
    case "confirm": {
      const r = await db.run(orderCommands.confirm, { id: s.id as OrdersId });
      if (r.ok) return r.rows[0];
      return { refused: r.kind === "assert" ? r.assert : r.kind };
    }
    case "annotate": {
      const r = await db.run(orderCommands.annotate, { id: s.id as OrdersId, note: s.note });
      if (r.ok) return r.rows[0] ?? null;
      return { refused: r.kind };
    }
    case "setStock": {
      const r = await db.run(orderCommands.setStock, { sku: s.sku as InventoryId, qty: s.qty });
      if (r.ok) return r.rows[0];
      return { refused: r.kind };
    }
    case "stock":
      return db.first(orderQueries.stockBySku, { sku: s.sku as InventoryId });
    case "order":
      return db.first(orderQueries.withLines, { id: s.id as OrdersId });
    case "ordersOf":
      return db.all(orderQueries.byCustomer, { customer_id: s.customer_id as CustomersId });
    case "revenue":
      return db.all(reportQueries.revenueByCustomer);
    case "customers":
      return db.all(customerQueries.all);
  }
}

type Env = { DB: D1Database };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return Response.json({ ok: true, value: await run(d1(env.DB), (await request.json()) as Step) });
    } catch (e) {
      const err = e as Error & { cause?: Error };
      return Response.json({ ok: false, message: err.message, cause: err.cause?.message ?? null });
    }
  },
};
