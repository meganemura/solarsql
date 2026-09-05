// The example project runs on the local D1 engine and on a SQLite Durable
// Object, through the same module code. Each step below is one request to
// the Worker in example/worker.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitStatements } from "../src/build/scan.ts";
import { workerMiniflare } from "./worker.ts";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(resolve(root, "example/migrations/0001_initial.sql"), "utf8");

type Reply = { ok: true; value: unknown } | { ok: false; message: string; cause: string | null };

for (const target of ["d1", "do"] as const) {
  describe(`example on ${target}`, () => {
    const mf = workerMiniflare(resolve(root, "example/worker.ts"), root, { durableObjects: { STORE: "Store" } });
    const send = async (body: Record<string, unknown>): Promise<Reply> => {
      const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`, { method: "POST", body: JSON.stringify(body) });
      return (await response.json()) as Reply;
    };
    const value = async (body: Record<string, unknown>): Promise<unknown> => {
      const reply = await send(body);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return (reply as { value: unknown }).value;
    };

    before(async () => {
      if (target === "d1") {
        // wrangler applies a migration file as one batch. The test does the same.
        const db = await mf.getD1Database("DB");
        await db.batch(splitStatements(migration).map((s) => db.prepare(s)));
      }
    });
    after(async () => {
      await mf.dispose();
    });

    test("a command with returns gives typed rows", async () => {
      const created = await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
      assert.deepEqual(created, { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }] });
    });

    test("a plan inserts a parent and its children from JSON in one transaction", async () => {
      const placed = await value({
        step: "placeOrder",
        id: "o1",
        customer_id: "c1",
        lines: [
          { id: "l1", sku: "A", qty: 2, price: 1.5 },
          { id: "l2", sku: "B", qty: 1, price: 4 },
        ],
      });
      assert.deepEqual(placed, { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "draft", note: null }] });
    });

    test("a JSON aggregation arrives as an array", async () => {
      const order = await value({ step: "order", id: "o1" });
      assert.deepEqual(order, {
        id: "o1",
        status: "draft",
        lines: [
          { id: "l1", sku: "A", qty: 2, price: 1.5 },
          { id: "l2", sku: "B", qty: 1, price: 4 },
        ],
      });
    });

    test("asserts pass, then the second run names the failed assert", async () => {
      const first = await value({ step: "confirm", id: "o1" });
      assert.deepEqual(first, { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "confirmed", note: null }] });
      const second = await value({ step: "confirm", id: "o1" });
      assert.deepEqual(second, { ok: false, assert: "was_draft" });
    });

    test("an order without lines cannot be confirmed", async () => {
      await value({ step: "placeOrder", id: "o2", customer_id: "c1", lines: [] });
      const result = await value({ step: "confirm", id: "o2" });
      assert.deepEqual(result, { ok: false, assert: "has_lines" });
      const order = await value({ step: "order", id: "o2" });
      assert.deepEqual(order, { id: "o2", status: "draft", lines: [] });
    });

    test("a nullable parameter accepts null", async () => {
      assert.deepEqual(await value({ step: "annotate", id: "o1", note: "rush" }), { ok: true, rows: [] });
      assert.deepEqual(await value({ step: "annotate", id: "o1", note: null }), { ok: true, rows: [] });
    });

    test("a failed plan leaves no partial writes", async () => {
      // The second line repeats l1, so the unique primary key fails inside the plan.
      const reply = await send({ step: "placeOrder", id: "o3", customer_id: "c1", lines: [{ id: "l9", sku: "Z", qty: 1, price: 1 }, { id: "l1", sku: "A", qty: 1, price: 1 }] });
      assert.equal(reply.ok, false);
      assert.match((reply as { message: string }).message, /UNIQUE constraint failed/);
      const orders = await value({ step: "ordersOf", customer_id: "c1" });
      assert.deepEqual(orders, [{ id: "o2", status: "draft" }, { id: "o1", status: "confirmed" }]);
    });

    test("a report module reads across modules with casts", async () => {
      const revenue = await value({ step: "revenue" });
      assert.deepEqual(revenue, [{ customer_id: "c1", name: "Ann", revenue: 7, orders: 1 }]);
    });

    test("an IN list longer than D1's 100 bound values, through one json_each parameter", async () => {
      const ids = ["o1", "o2", ...Array.from({ length: 150 }, (_, i) => `missing${i}`)];
      assert.deepEqual(await value({ step: "ordersByIds", ids }), [{ id: "o1", status: "confirmed" }, { id: "o2", status: "draft" }]);
    });

    test("an optional filter, a sort chosen by a parameter, and paging in one static query", async () => {
      assert.deepEqual(await value({ step: "search", customer_id: "c1", status: null, sort: "id", limit: 10, offset: 0 }), [
        { id: "o1", status: "confirmed", note: null },
        { id: "o2", status: "draft", note: null },
      ]);
      assert.deepEqual(await value({ step: "search", customer_id: "c1", status: "draft", sort: "id", limit: 10, offset: 0 }), [{ id: "o2", status: "draft", note: null }]);
      assert.deepEqual(await value({ step: "search", customer_id: "c1", status: null, sort: "status", limit: 1, offset: 1 }), [{ id: "o2", status: "draft", note: null }]);
    });

    test("a query without parameters", async () => {
      assert.deepEqual(await value({ step: "customers" }), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
    });
  });
}
