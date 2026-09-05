// The Worker on the local D1 engine. Each test sends one JSON step to
// worker.ts and checks the reply.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyMigrations, workerMiniflare } from "./harness.ts";

const root = resolve(import.meta.dirname, "..");

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

describe("the Worker on D1", () => {
  const mf = workerMiniflare(resolve(root, "worker.ts"), root);
  const send = async (body: Record<string, unknown>): Promise<Reply> => {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) });
    return (await response.json()) as Reply;
  };
  const value = async (body: Record<string, unknown>): Promise<unknown> => {
    const reply = await send(body);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return (reply as { value: unknown }).value;
  };

  before(async () => {
    await applyMigrations(await mf.getD1Database("DB"), resolve(root, "migrations"));
  });
  after(async () => {
    await mf.dispose();
  });

  test("create a customer", async () => {
    assert.deepEqual(await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" }), { id: "c1", name: "Ann", email: "ann@example.com" });
  });

  test("a second customer with the same email is refused", async () => {
    assert.deepEqual(await value({ step: "createCustomer", id: "c2", name: "Bob", email: "ann@example.com" }), { refused: "email_taken" });
    assert.deepEqual(await value({ step: "customers" }), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
  });

  test("place an order with two lines", async () => {
    const placed = await value({
      step: "placeOrder",
      id: "o1",
      customer_id: "c1",
      lines: [
        { id: "l1", sku: "A", qty: 2, price: 1.5 },
        { id: "l2", sku: "B", qty: 1, price: 4 },
      ],
    });
    assert.deepEqual(placed, { id: "o1", customer_id: "c1", status: "draft", note: null });
  });

  test("read the order with its lines", async () => {
    assert.deepEqual(await value({ step: "order", id: "o1" }), {
      id: "o1",
      status: "draft",
      lines: [
        { id: "l1", sku: "A", qty: 2, price: 1.5 },
        { id: "l2", sku: "B", qty: 1, price: 4 },
      ],
    });
  });

  test("confirm the order, then confirm it again", async () => {
    assert.deepEqual(await value({ step: "confirm", id: "o1" }), { id: "o1", customer_id: "c1", status: "confirmed", note: null });
    assert.deepEqual(await value({ step: "confirm", id: "o1" }), { refused: "was_draft" });
  });

  test("an order without lines cannot be confirmed", async () => {
    await value({ step: "placeOrder", id: "o2", customer_id: "c1", lines: [] });
    assert.deepEqual(await value({ step: "confirm", id: "o2" }), { refused: "has_lines" });
    assert.deepEqual(await value({ step: "order", id: "o2" }), { id: "o2", status: "draft", lines: [] });
  });

  test("annotate an order, then clear the note", async () => {
    assert.deepEqual(await value({ step: "annotate", id: "o1", note: "rush" }), { id: "o1", customer_id: "c1", status: "confirmed", note: "rush" });
    assert.deepEqual(await value({ step: "annotate", id: "o1", note: null }), { id: "o1", customer_id: "c1", status: "confirmed", note: null });
  });

  test("the orders of a customer, newest id first", async () => {
    assert.deepEqual(await value({ step: "ordersOf", customer_id: "c1" }), [
      { id: "o2", status: "draft" },
      { id: "o1", status: "confirmed" },
    ]);
  });

  test("confirmed revenue per customer", async () => {
    assert.deepEqual(await value({ step: "revenue" }), [{ customer_id: "c1", name: "Ann", revenue: 7, orders: 1 }]);
  });

  test("an unknown order reads as null", async () => {
    assert.equal(await value({ step: "order", id: "nope" }), null);
  });

  test("set the stock of a sku, change it, and read it back", async () => {
    assert.deepEqual(await value({ step: "setStock", sku: "A", qty: 10 }), { sku: "A", qty: 10 });
    assert.deepEqual(await value({ step: "setStock", sku: "A", qty: 12 }), { sku: "A", qty: 12 });
    assert.deepEqual(await value({ step: "stock", sku: "A" }), { sku: "A", qty: 12 });
    assert.equal(await value({ step: "stock", sku: "B" }), null);
  });
});
