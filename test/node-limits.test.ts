// Responsibility: pins NODE_TEST_LIMITS's own two boundaries (LIKE/GLOB
// pattern length, trigger recursion depth) against node:sqlite's
// DatabaseSync `limits` option, the run-time gate no build-time check can
// see (ADR 0032). test/miniflare/node-limits.test.ts pins the same two
// boundaries against D1 and a Durable Object.
// Boundary: node:sqlite only. No Miniflare here.
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NODE_TEST_LIMITS } from "../src/runtime/node-limits.ts";

test("a 51-byte LIKE pattern is refused with the workerd message", () => {
  const db = new DatabaseSync(":memory:", { limits: NODE_TEST_LIMITS });
  assert.throws(() => db.prepare("select 'x' like ?").get("x".repeat(51)), /LIKE or GLOB pattern too complex/);
});

test("a 50-byte LIKE pattern passes under NODE_TEST_LIMITS", () => {
  const db = new DatabaseSync(":memory:", { limits: NODE_TEST_LIMITS });
  assert.doesNotThrow(() => db.prepare("select 'x' like ?").get("x".repeat(50)));
});

// `depth` counts the recursive inserts the trigger causes; the first,
// manual insert does not itself count as a level of recursion. Measured
// against triggerDepth 10: `new.n < depth - 1` recurses `depth` times in
// total; a workerd-measured recursion of 10 passes and 11 fails.
function recurse(depth: number): void {
  const db = new DatabaseSync(":memory:", { limits: NODE_TEST_LIMITS });
  db.exec("pragma recursive_triggers = on");
  db.exec("create table t (n integer)");
  db.exec(`create trigger r after insert on t when new.n < ${depth - 1} begin insert into t (n) values (new.n + 1); end`);
  db.exec("insert into t (n) values (0)");
}

test("an 11-deep recursive trigger fails under NODE_TEST_LIMITS", () => {
  assert.throws(() => recurse(11), /too many levels of trigger recursion/);
});

test("a 10-deep recursive trigger passes under NODE_TEST_LIMITS", () => {
  assert.doesNotThrow(() => recurse(10));
});
