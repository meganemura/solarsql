// Pins today's run-time behavior of a hand-built plan whose second item is
// INSERT OR ROLLBACK (test/or-rollback.worker.ts). src/build/build.ts now
// refuses this shape (ADR 0131), so a built project can never ship it; this
// file is the evidence the refusal's message cites.
// Boundary: local Miniflare evidence only, the same pattern
// test/miniflare/deferred-foreign-key.test.ts uses for its own refused shape.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

test("on D1, run() rejects with an error constraintFailure() cannot classify, and no plan row remains", async () => {
  const mf = workerMiniflare(resolve(root, "test/or-rollback.worker.ts"), root, {});
  onTestFinished(() => mf.dispose());
  const response = await mf.dispatchFetch("http://localhost/d1", { method: "POST" });
  assert.equal(response.status, 200);
  const reply = (await response.json()) as { threw: boolean; name?: string; message?: string };
  assert.equal(reply.threw, true, JSON.stringify(reply));
  const database = await mf.getD1Database("DB");
  const rows = await database.prepare("select id from log").all();
  assert.deepEqual(rows.results, []);
});

test("on a Durable Object, the Worker boundary returns HTTP 500 and no plan row remains", async () => {
  const mf = workerMiniflare(resolve(root, "test/or-rollback.worker.ts"), root, { durableObjects: { PROBE: "OrRollbackProbe" } });
  onTestFinished(() => mf.dispose());
  const response = await mf.dispatchFetch("http://localhost/do", { method: "POST" });
  assert.equal(response.status, 500);
  const later = await mf.dispatchFetch("http://localhost/do?action=rows", { method: "POST" });
  assert.equal(later.status, 200);
  const reply = (await later.json()) as { rows: { id: string }[] };
  assert.deepEqual(reply.rows, []);
});
