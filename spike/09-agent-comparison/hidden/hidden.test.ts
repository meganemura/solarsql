// The hidden tests of the cancel step. Copied into test/ after the agent is
// done, and never shown to it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyMigrations, workerMiniflare } from "./harness.ts";

const root = resolve(import.meta.dirname, "..");

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

describe("cancel", () => {
  const mf = workerMiniflare(resolve(root, "worker.ts"), root);
  const value = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) });
    const reply = (await response.json()) as Reply;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return (reply as { value: unknown }).value;
  };

  before(async () => {
    await applyMigrations(await mf.getD1Database("DB"), resolve(root, "migrations"));
    await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
    await value({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 2 }] });
    await value({ step: "confirm", id: "o1" });
    await value({ step: "placeOrder", id: "o2", customer_id: "c1", lines: [{ id: "l2", sku: "B", qty: 1, price: 3 }] });
  });
  after(async () => {
    await mf.dispose();
  });

  test("1 a confirmed order cancels, and the reply is the order", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o1" }), { id: "o1", customer_id: "c1", status: "cancelled", note: null });
    assert.deepEqual(await value({ step: "order", id: "o1" }), { id: "o1", status: "cancelled", lines: [{ id: "l1", sku: "A", qty: 1, price: 2 }] });
  });

  test("2 a cancelled order is refused the second time", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o1" }), { refused: "not_confirmed" });
    assert.deepEqual(await value({ step: "order", id: "o1" }), { id: "o1", status: "cancelled", lines: [{ id: "l1", sku: "A", qty: 1, price: 2 }] });
  });

  test("3 a draft order is refused and stays draft", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o2" }), { refused: "not_confirmed" });
    assert.deepEqual(await value({ step: "order", id: "o2" }), { id: "o2", status: "draft", lines: [{ id: "l2", sku: "B", qty: 1, price: 3 }] });
  });

  test("4 an unknown order is refused", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "nope" }), { refused: "not_confirmed" });
  });

  test("5 a cancelled order cannot be confirmed", async () => {
    assert.deepEqual(await value({ step: "confirm", id: "o1" }), { refused: "was_draft" });
  });

  test("6 the note survives the cancel", async () => {
    await value({ step: "placeOrder", id: "o3", customer_id: "c1", lines: [{ id: "l3", sku: "C", qty: 2, price: 1 }] });
    await value({ step: "confirm", id: "o3" });
    await value({ step: "annotate", id: "o3", note: "gift" });
    assert.deepEqual(await value({ step: "cancel", id: "o3" }), { id: "o3", customer_id: "c1", status: "cancelled", note: "gift" });
  });
});
