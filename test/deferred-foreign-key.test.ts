// Responsibility: pin what run() (src/d1.ts, src/durable.ts) does today
// against a DEFERRABLE INITIALLY DEFERRED foreign key -- the shape
// src/build/build.ts now refuses at build time, so a project
// built through solarsql can never declare it, but this pins the underlying
// adapter behavior the refusal exists to keep a caller away from.
// Boundary: local Miniflare evidence only, the same evidence the refusal's
// message and the ADR 0114 addendum cite. No proactive scan is added to
// run() here (that option was rejected: see the addendum), so this test
// documents the Durable Object false success as a limit that stands, and
// on D1 the classification bareMessage() now gives the same underlying
// failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
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

test("on D1, run() classifies both an immediate and a deferred foreign-key violation", async (t) => {
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
  // way the platform reset above does: run()'s catch sees it. bareMessage()
  // (src/runtime/plan.ts) strips D1's reset-text prefix, so constraintFailure()
  // now matches SQLite's own "FOREIGN KEY constraint failed" text underneath
  // it, and run() resolves the same structured result the immediate case
  // gets, instead of falling through to `throw e`.
  const deferred = await send({ variant: "deferred", id: "d1-deferred-1", parentId: "missing" });
  assert.deepEqual(deferred, { threw: false, result: { ok: false, kind: "foreign_key" } });
});

// D1's reset prefix carries no information about which constraint failed --
// it wraps SQLite's own constraint text unchanged. bareMessage() strips the
// prefix without inspecting what follows it, so constraintFailure() should
// classify a prefixed message exactly the way it classifies the bare one,
// for every constraint kind it recognizes, not only FOREIGN KEY.
const resetPrefix = "Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: ";

test("D1's reset prefix does not change what constraintFailure() sees, for any constraint kind", () => {
  hegel.test((tc) => {
    const text = tc.draw(gs.sampledFrom([
      "FOREIGN KEY constraint failed",
      "UNIQUE constraint failed: t.c",
      "CHECK constraint failed: k",
      "NOT NULL constraint failed: t.c",
    ]));
    const suffix = tc.draw(gs.sampledFrom(["", ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)"]));
    const bare = constraintFailure(new Error(text + suffix));
    assert.notEqual(bare, null);
    const prefixed = constraintFailure(new Error(resetPrefix + text + suffix));
    assert.deepEqual(prefixed, bare);
  });
});
