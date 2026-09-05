// The hidden tests of the cancel step with restock. Copied into test/ after
// the agent is done, and never shown to it. The tests run in order.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyMigrations, workerMiniflare } from "./harness.ts";

const root = resolve(import.meta.dirname, "..");

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

describe("cancel with restock", () => {
  const mf = workerMiniflare(resolve(root, "worker.ts"), root);
  const value = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) });
    const reply = (await response.json()) as Reply;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return (reply as { value: unknown }).value;
  };
  const stock = async (sku: string): Promise<unknown> => value({ step: "stock", sku });
  const status = async (id: string): Promise<unknown> => ((await value({ step: "order", id })) as { status: string } | null)?.status ?? null;

  before(async () => {
    await applyMigrations(await mf.getD1Database("DB"), resolve(root, "migrations"));
    await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
    for (const [sku, qty] of [["A", 10], ["B", 10], ["C", 99]] as const) await value({ step: "setStock", sku, qty });
    await value({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 2, price: 1 }, { id: "l2", sku: "B", qty: 1, price: 1 }] });
    await value({ step: "confirm", id: "o1" });
    await value({ step: "placeOrder", id: "o2", customer_id: "c1", lines: [{ id: "l3", sku: "A", qty: 1, price: 1 }] });
    await value({ step: "placeOrder", id: "o3", customer_id: "c1", lines: [{ id: "l4", sku: "C", qty: 5, price: 1 }] });
    await value({ step: "confirm", id: "o3" });
  });
  after(async () => {
    await mf.dispose();
  });

  test("1 a confirmed order cancels, and its lines go back to stock", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o1" }), { id: "o1", customer_id: "c1", status: "cancelled", note: null });
    assert.deepEqual(await stock("A"), { sku: "A", qty: 12 });
    assert.deepEqual(await stock("B"), { sku: "B", qty: 11 });
  });

  test("2 a second cancel is refused and restocks nothing", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o1" }), { refused: "not_confirmed" });
    assert.deepEqual(await stock("A"), { sku: "A", qty: 12 });
    assert.deepEqual(await stock("B"), { sku: "B", qty: 11 });
  });

  test("3 a draft order is refused, stays draft, and restocks nothing", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o2" }), { refused: "not_confirmed" });
    assert.equal(await status("o2"), "draft");
    assert.deepEqual(await stock("A"), { sku: "A", qty: 12 });
  });

  test("4 an unknown order is refused", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "nope" }), { refused: "not_confirmed" });
  });

  test("5 a restock over the cap is refused, and the order stays confirmed", async () => {
    assert.deepEqual(await value({ step: "cancel", id: "o3" }), { refused: "restock_failed" });
    assert.equal(await status("o3"), "confirmed");
    assert.deepEqual(await stock("C"), { sku: "C", qty: 99 });
  });

  test("6 the same order cancels once the shelf has room", async () => {
    await value({ step: "setStock", sku: "C", qty: 90 });
    assert.deepEqual(await value({ step: "cancel", id: "o3" }), { id: "o3", customer_id: "c1", status: "cancelled", note: null });
    assert.deepEqual(await stock("C"), { sku: "C", qty: 95 });
  });
});
