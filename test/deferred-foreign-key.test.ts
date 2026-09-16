// Responsibility: pin what run() (src/d1.ts, src/durable.ts) does today
// against a DEFERRABLE INITIALLY DEFERRED foreign key -- the shape
// src/build/build.ts now refuses at build time, so a project
// built through solarsql can never declare it, but this pins the underlying
// adapter behavior the refusal exists to keep a caller away from.
// Boundary: local Miniflare evidence only, the same evidence the refusal's
// message and the ADR 0114 addendum cite. No proactive scan is added to
// run() here (that option was rejected: see the addendum), so this test
// documents a limit, not a fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { constraintFailure } from "../src/runtime/plan.ts";
import { workerMiniflare } from "./worker.ts";

const root = resolve(import.meta.dirname, "..");

type ProbeReply = { threw: boolean; result?: { ok: boolean; kind?: string }; name?: string; message?: string };

test("on a Durable Object, run() classifies an immediate foreign-key violation, but a deferred one is a false success the caller never sees: the platform's own reset response replaces it", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/deferred-foreign-key.worker.ts"), root, { durableObjects: { PROBE: "DeferredForeignKeyProbe" } });
  t.after(() => mf.dispose());
  const send = (instance: string, body: { variant: "immediate" | "deferred"; id: string; parentId: string }) =>
    mf.dispatchFetch("http://localhost/do", { method: "POST", body: JSON.stringify({ ...body, instance }) });

  // The immediate case: run()'s own catch classifies the exception
  // transactionSync throws synchronously, and the caller gets it back as a
  // normal 200 response with a structured result -- this is what a
  // deferred foreign key would also look like, if run() could observe it.
  const immediate = await send("do-immediate", { variant: "immediate", id: "immediate-1", parentId: "missing" });
  assert.equal(immediate.status, 200);
  assert.deepEqual(await immediate.json(), { ok: false, kind: "foreign_key" });

  // The deferred case: transactionSync's own RELEASE does not raise the
  // exception. run() returns a value from storage.transactionSync as if the
  // write succeeded. The violation surfaces only later, at the request's
  // own implicit commit, which the platform -- not run() -- fails,
  // discarding whatever run() resolved to and resetting the object. The 500
  // below is not run()'s response: run() already returned one that never
  // reaches this test.
  const deferred = await send("do-deferred", { variant: "deferred", id: "deferred-1", parentId: "missing" });
  assert.equal(deferred.status, 500);
  const text = await deferred.text();
  assert.match(text, /Durable Object was reset and rolled back to its last known good state/);
  assert.match(text, /FOREIGN KEY constraint failed/);
});

test("on D1, run() classifies an immediate foreign-key violation, but falls through to an unclassified throw for a deferred one", async (t) => {
  const mf = workerMiniflare(resolve(root, "test/deferred-foreign-key.worker.ts"), root, {});
  t.after(() => mf.dispose());
  const send = async (body: { variant: "immediate" | "deferred"; id: string; parentId: string }): Promise<ProbeReply> => {
    const response = await mf.dispatchFetch("http://localhost/d1", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json()) as ProbeReply;
  };

  const immediate = await send({ variant: "immediate", id: "d1-immediate-1", parentId: "missing" });
  assert.deepEqual(immediate, { threw: false, result: { ok: false, kind: "foreign_key" } });

  // D1's batch() rejects at its own implicit commit, the same as the
  // Durable Object case above, but D1 does not discard the rejection the
  // way the platform reset above does: run()'s catch sees it, cannot match
  // it to a known constraint message, and falls through to `throw e`
  // (src/d1.ts), so the worker's own try/catch around db.run observes it
  // directly, unlike the Durable Object case.
  const deferred = await send({ variant: "deferred", id: "d1-deferred-1", parentId: "missing" });
  assert.equal(deferred.threw, true);
  assert.match(deferred.message ?? "", /FOREIGN KEY constraint failed/);
  // Proof that this is the P3 diagnostics-only cost the ticket named, not a
  // silent misclassification: constraintFailure (src/runtime/plan.ts) does
  // not recognize this message as a foreign_key failure either.
  assert.equal(constraintFailure(new Error(deferred.message ?? "")), null);
});
