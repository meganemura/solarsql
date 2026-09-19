// Responsibility: prove that a real Durable Object's SQL cursor reports
// rowsRead/rowsWritten through durable()'s observe hook (src/durable.ts),
// under Miniflare, not only Node's storageOf() shim. test/example.test.ts's
// shared exampleSteps() checks the same claim across the full example
// Worker; this fixture isolates it to one command and one batch, in the
// migrate-durable-object.test.ts style.
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here (see skills/solarsql/references/deploy.md's remote suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "./worker.ts";

const root = resolve(import.meta.dirname, "..");

type EventBody = { kind: string; name: string; outcome: string; meta: { rows_read: number; rows_written: number; duration?: number } | null };

test("a real Durable Object's cursor reports rows_written after a command and rows_read after a batch", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/durable-object-meta.worker.ts"), root, { durableObjects: { PROBE: "MetaProbe" } });
  t.after(() => mf.dispose());

  const response = await mf.dispatchFetch("http://localhost/");
  const events = (await response.json()) as EventBody[];

  const command = events.find((e) => e.kind === "command" && e.name === "create");
  assert.ok(command, JSON.stringify(events));
  assert.equal(command!.outcome, "ok");
  assert.ok(command!.meta !== null, JSON.stringify(command));
  assert.ok(command!.meta!.rows_written >= 1, JSON.stringify(command));
  // duration is D1's own server-side timing; a Durable Object has none to
  // report, so it stays absent rather than a fabricated 0 (ADR 0039).
  assert.equal(command!.meta!.duration, undefined);

  const batch = events.find((e) => e.kind === "batch");
  assert.ok(batch, JSON.stringify(events));
  assert.equal(batch!.outcome, "ok");
  assert.ok(batch!.meta !== null, JSON.stringify(batch));
  assert.ok(batch!.meta!.rows_read >= 1, JSON.stringify(batch));
});
