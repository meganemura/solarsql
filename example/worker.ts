// A Worker that runs the example modules on D1 and on a Durable Object.
// The tests send one JSON request per step and read the reply.
import { DurableObject } from "cloudflare:workers";
import { d1 } from "../src/d1.ts";
import { durable, migrate } from "../src/durable.ts";
import type { Database, Observed } from "../src/index.ts";
import { migrations } from "./migrations/index.ts";
import { customerCommands, customerQueries } from "./modules/customers/public.ts";
import { orderCommands, orderQueries } from "./modules/orders/public.ts";
import { reportQueries } from "./modules/reports/public.ts";
import type { CustomersId } from "./modules/customers/public.ts";
import type { OrderLinesId, OrdersId } from "./modules/orders/public.ts";

type Step =
  | { step: "createCustomer"; id: string; name: string; email: string }
  | { step: "placeOrder"; id: string; customer_id: string; lines: { id: string; sku: string; qty: number; price: number }[] }
  | { step: "ordersByIds"; ids: string[] }
  | { step: "search"; customer_id: string; status: "draft" | "confirmed" | null; sort: "id" | "status"; limit: number; offset: number }
  | { step: "byNote"; pattern: string }
  | { step: "confirm"; id: string }
  | { step: "annotate"; id: string; note: string | null }
  | { step: "reprice"; id: string; lines: { id: string; price: number }[] }
  | { step: "order"; id: string }
  | { step: "ordersOf"; customer_id: string }
  | { step: "revenue" }
  | { step: "confirmedOrders" }
  | { step: "customers" }
  | { step: "observed" };

// What the observe hook saw, per isolate, so a test can read it back.
const events: Observed[] = [];
const observe = (e: Observed): void => {
  events.push(e);
};

async function run(db: Database, s: Step): Promise<unknown> {
  switch (s.step) {
    case "createCustomer":
      return db.run(customerCommands.create, { id: s.id as CustomersId, name: s.name, email: s.email });
    case "placeOrder":
      return db.run(orderCommands.place, { id: s.id as OrdersId, customer_id: s.customer_id as CustomersId, lines: s.lines.map((l) => ({ ...l, id: l.id as OrderLinesId })) });
    case "confirm":
      return db.run(orderCommands.confirm, { id: s.id as OrdersId });
    case "annotate":
      return db.run(orderCommands.annotate, { id: s.id as OrdersId, note: s.note });
    case "reprice":
      return db.run(orderCommands.reprice, { id: s.id as OrdersId, lines: s.lines.map((l) => ({ id: l.id as OrderLinesId, price: l.price })) });
    case "order":
      return db.first(orderQueries.withLines, { id: s.id as OrdersId });
    case "ordersOf":
      return db.all(orderQueries.byCustomer, { customer_id: s.customer_id as CustomersId });
    case "ordersByIds":
      return db.all(orderQueries.byIds, { ids: s.ids as OrdersId[] });
    case "search":
      return db.all(orderQueries.search, { customer_id: s.customer_id as CustomersId, status: s.status, sort: s.sort, limit: s.limit, offset: s.offset });
    case "byNote":
      return db.all(orderQueries.byNote, { pattern: s.pattern });
    case "revenue":
      return db.all(reportQueries.revenueByCustomer);
    case "confirmedOrders":
      return db.all(reportQueries.confirmedOrders);
    case "customers":
      return db.all(customerQueries.all);
    case "observed":
      return events.splice(0).map((e) => ({ kind: e.kind, name: e.name, outcome: e.outcome, timed: e.ms >= 0 }));
  }
}

async function handle(db: Database, request: Request): Promise<Response> {
  try {
    return Response.json({ ok: true, value: await run(db, (await request.json()) as Step) });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return Response.json({ ok: false, message: err.message, cause: err.cause?.message ?? null });
  }
}

export class Store extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }
  override async fetch(request: Request): Promise<Response> {
    return handle(durable(this.ctx.storage, { observe }), request);
  }
}

type Env = { DB: Parameters<typeof d1>[0]; STORE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/do") {
      const id = env.STORE.idFromName("example");
      return env.STORE.get(id).fetch(new Request("http://do/", { method: "POST", body: await request.text() }));
    }
    return handle(d1(env.DB, { observe }), request);
  },
};
