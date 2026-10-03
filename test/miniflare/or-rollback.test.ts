// Pins today's run-time behavior of a hand-built plan whose second item is
// INSERT OR ROLLBACK (test/or-rollback.worker.ts). src/build/build.ts now
// refuses this shape (ADR 0131), so a built project can never ship it; this
// file is the evidence the refusal's message cites.
// Boundary: local Miniflare evidence only, the same pattern
// test/miniflare/deferred-foreign-key.test.ts uses for its own refused shape.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

test("on D1, run() rejects with an error constraintFailure() cannot classify, and no plan row remains", async () => {
  // On some windows-latest VMs, workerd prints "There was an access
  // violation in the runtime" in this test, and the first instance then
  // resets the request (ECONNRESET) or refuses later connections
  // (ECONNREFUSED). On 2026-10-03 one VM printed it in 20 of 20 runs, and
  // another VM printed it in none. So the rows are read from a second
  // Miniflare over the same persisted storage.
  const persistTo = mkdtempSync(join(tmpdir(), "solarsql-or-rollback-"));
  onTestFinished(() => rmSync(persistTo, { recursive: true, force: true, maxRetries: 5 }));
  const mf = workerMiniflare(resolve(root, "test/or-rollback.worker.ts"), root, { persistTo });
  try {
    const response = await mf.dispatchFetch("http://localhost/d1", { method: "POST" });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { threw: boolean; name?: string; message?: string };
    assert.equal(reply.threw, true, JSON.stringify(reply));
  } catch (e) {
    // On Windows, a reset before the response means the threw check did
    // not run, and only the row check below applies. The warning makes
    // that visible in the CI log. Elsewhere a reset still fails the test.
    const cause = (e as { cause?: { code?: unknown } }).cause;
    if (!(process.platform === "win32" && e instanceof TypeError && e.message === "fetch failed" && cause?.code === "ECONNRESET")) throw e;
    console.warn("or-rollback D1: dispatchFetch reset; the threw check did not run");
  } finally {
    await mf.dispose().catch((e: unknown) => console.warn("or-rollback D1: dispose failed:", e));
  }
  const reader = workerMiniflare(resolve(root, "test/or-rollback.worker.ts"), root, { persistTo });
  onTestFinished(() => reader.dispose());
  const database = await reader.getD1Database("DB");
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
