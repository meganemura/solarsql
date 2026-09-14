// Responsibility: verify that a command's guard-table cleanup (ADR 0093)
// does not change reported changes and reads the correct returns reply
// once a cleanup delete follows it in the same D1 batch.
// Boundary: the D1 adapter's statement assembly and reply indexing only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { orderCommands } from "../example/modules/orders/public.ts";

// Replies keyed by the exact SQL text a statement carries, so the fake can
// tell an assert insert, the update, the returns select, and the cleanup
// delete apart, the way distinct real D1 replies would be.
function trackedBinding(repliesFor: (sql: string) => { results?: unknown; meta?: unknown }): D1Like & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql);
      const reply = repliesFor(sql);
      const statement: D1StatementLike = { bind: () => statement, all: async () => reply };
      return statement;
    },
    batch: async (statements) => Promise.all(statements.map((s) => s.all())),
  };
}

test("a command with asserts and a returns clause reports only its own write in changes, and reads the returns reply even with a cleanup delete after it", async () => {
  const orderRow = { id: "o1", customer_id: "c1", status: "confirmed", note: null };
  const binding = trackedBinding((sql) => {
    if (sql.startsWith("delete from solarsql_assert")) return { results: [], meta: { changes: 2 } };
    if (sql.includes("insert into solarsql_assert")) return { results: [], meta: { changes: 1 } };
    if (sql.startsWith("update orders")) return { results: [], meta: { changes: 1 } };
    if (sql.startsWith("select id, customer_id, status, note from orders")) return { results: [orderRow], meta: { changes: 0 } };
    throw new Error(`unexpected statement: ${sql}`);
  });
  const db = d1(binding);
  const result = await db.run(orderCommands.confirm, { id: "o1" as never });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.changes, 1);
  assert.deepEqual(result.rows, [orderRow]);
  assert.equal(binding.calls.at(-1), "delete from solarsql_assert");
});
