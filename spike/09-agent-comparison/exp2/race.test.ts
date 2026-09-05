// A post-hoc test, written after the six runs of experiment 2 were read:
// three cancel requests for one order at the same time. One must succeed
// and the stock must gain the lines once. A cancel that reads the order
// in JavaScript before it writes can restock twice. RACE_ROUNDS sets how
// many times the race is tried on a fresh database.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { applyMigrations, workerMiniflare } from "./harness.ts";

const root = resolve(import.meta.dirname, "..");
const rounds = Number(process.env.RACE_ROUNDS ?? "5");

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

describe("three cancels at once", () => {
  const instances: ReturnType<typeof workerMiniflare>[] = [];
  after(async () => {
    for (const mf of instances) await mf.dispose();
  });

  for (let round = 1; round <= rounds; round++) {
    test(`round ${round}: the stock gains the lines once, and one cancel succeeds`, async () => {
      const mf = workerMiniflare(resolve(root, "worker.ts"), root);
      instances.push(mf);
      const send = async (body: Record<string, unknown>): Promise<Reply> => {
        const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) });
        return (await response.json()) as Reply;
      };
      const value = async (body: Record<string, unknown>): Promise<unknown> => {
        const reply = await send(body);
        assert.equal(reply.ok, true, JSON.stringify(reply));
        return (reply as { value: unknown }).value;
      };
      await applyMigrations(await mf.getD1Database("DB"), resolve(root, "migrations"));
      await value({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" });
      await value({ step: "setStock", sku: "A", qty: 10 });
      await value({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 2, price: 1 }] });
      await value({ step: "confirm", id: "o1" });

      const replies = await Promise.all([1, 2, 3].map(() => send({ step: "cancel", id: "o1" })));
      const successes = replies.filter((r) => r.ok && (r.value as { status?: string } | null)?.status === "cancelled").length;
      const stock = await value({ step: "stock", sku: "A" });
      assert.deepEqual({ successes, stock }, { successes: 1, stock: { sku: "A", qty: 12 } }, JSON.stringify(replies));
    });
  }
});
