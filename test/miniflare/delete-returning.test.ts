// ADR 0136's consume-token command (test/delete-returning.worker.ts), run
// on D1 and on a Durable Object through Miniflare, gives the same result
// node:sqlite already gives in test/commands.test.ts.
// Boundary: local Miniflare evidence, the same pattern
// test/miniflare/or-rollback.test.ts uses for its own hand-built Command.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

type Reply = { ok: true; rows: { payload: string }[]; changes: number } | { ok: false; kind: string; assert?: string };

for (const target of ["d1", "do"] as const) {
  test(`on ${target}, a DELETE ... RETURNING plan item is the command's row source`, async () => {
    const mf = workerMiniflare(resolve(root, "test/delete-returning.worker.ts"), root, { durableObjects: { PROBE: "DeleteReturningProbe" } });
    onTestFinished(() => mf.dispose());
    const send = async (body: Record<string, unknown>): Promise<Reply> => {
      const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`, { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return (await response.json()) as Reply;
    };
    await send({ id: `${target}-1`, payload: JSON.stringify({ a: 1 }) });
    const first = await send({ id: `${target}-1` });
    assert.deepEqual(first, { ok: true, rows: [{ payload: { a: 1 } }], changes: 1 });
    const second = await send({ id: `${target}-1` });
    assert.deepEqual(second, { ok: false, kind: "assert", assert: "found" });
  });
}
