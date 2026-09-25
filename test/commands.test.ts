// Responsibility: ADR 0136, a DELETE plan item's RETURNING rows as a
// command's rows when the command has no `returns`. Hand-built `Meta` and
// `Command` values (the pattern test/node.test.ts:903 and
// test/or-rollback.worker.ts already use), run through the real node()
// adapter (which durable() backs, ADR 0032), so this exercises the same
// runtime path a Durable Object and D1 use.
// Boundary: this file owns the runtime shape (src/index.ts's commands(),
// src/durable.ts, src/node.ts). The build-time marking and refusals that
// produce this shape are pinned in test/statement-contract.test.ts, and the
// type-level PlanRows selection is asserted at compile time below, both
// against a hand-authored `Generated` map since the build's own emit is
// Agent-owned elsewhere in this wave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GUARD_DDL } from "../src/runtime/plan.ts";
import { assert as sqlAssert, commands, type Meta, type PlanRows, type PlanShape } from "../src/index.ts";
import { node } from "../src/node.ts";

// --- type-level: PlanRows picks `returns`, then a marked item, then never[] ---

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;

type TG = {
  "select id from tokens": { params: {}; row: { id: string } };
  "delete from tokens where id = :id returning payload": { params: { id: string }; row: { payload: string }; returning: true };
  "insert into tokens (id, payload) values (:id, :payload)": { params: { id: string; payload: string }; row: {} };
};

type NoSource = PlanShape<TG> & { plan: readonly ["insert into tokens (id, payload) values (:id, :payload)"] };
type ReturnsWins = PlanShape<TG> & { plan: readonly ["delete from tokens where id = :id returning payload"]; returns: "select id from tokens" };
type ItemIsSource = PlanShape<TG> & { plan: readonly ["delete from tokens where id = :id returning payload"] };

type _noSource = AssertTrue<Equal<PlanRows<TG, NoSource>, never>>;
type _returnsWins = AssertTrue<Equal<PlanRows<TG, ReturnsWins>, { id: string }>>;
type _itemIsSource = AssertTrue<Equal<PlanRows<TG, ItemIsSource>, { payload: string }>>;

// --- runtime ---

const insertToken = "insert into tokens (id, payload) values (:id, :payload)";
const deleteReturning = "delete from tokens where id = :id returning payload";
const foundOnce = 'changes() = 1';
const insertLog = "insert into log (id) values (:id)";
const selectLog = "select id from log where id = :id";

type G = {
  [insertToken]: { params: { id: string; payload: string }; row: {} };
  [deleteReturning]: { params: { id: string }; row: { payload: string }; returning: true };
  [insertLog]: { params: { id: string }; row: {} };
  [selectLog]: { params: { id: string }; row: { id: string } };
  [foundOnce]: { params: {}; row: {} };
};
const meta: Meta<G> = {
  [insertToken]: { params: ["id", "payload"], encode: [], json: [], reads: ["tokens"] },
  [deleteReturning]: { params: ["id"], encode: [], json: ["payload"], reads: ["tokens"], returning: true },
  [insertLog]: { params: ["id"], encode: [], json: [], reads: ["log"] },
  [selectLog]: { params: ["id"], encode: [], json: [], reads: ["log"] },
  [foundOnce]: { params: [], encode: [], json: [], reads: [] },
};
const cmd = commands(meta, {
  seed: { plan: [insertToken] },
  consume: { plan: [deleteReturning, sqlAssert("found", foundOnce)] },
});
// consumeOnly has no assert, for the include tests below: an included
// command's own asserts join the including plan (ADR 0127), which is not
// what those tests are about.
const included = commands(meta, { consumeOnly: { plan: [deleteReturning] } });
const outerWithReturns = commands(meta, {
  consumeAndLog: { plan: [insertLog, included.consumeOnly], returns: selectLog },
});
const outerNoReturns = commands(meta, {
  consumeAndDrop: { plan: [included.consumeOnly] },
});

function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  raw.exec([...GUARD_DDL, "create table tokens (id text primary key not null, payload text not null) strict", "create table log (id text primary key not null) strict"].join(";\n"));
  return raw;
}

test("a DELETE ... RETURNING plan item with no `returns` is the command's row source", async () => {
  const raw = freshDb();
  try {
    const db = node(raw);
    await db.run(cmd.seed, { id: "t1", payload: JSON.stringify({ a: 1 }) });
    const first = await db.run(cmd.consume, { id: "t1" });
    assert.deepEqual(first, { ok: true, rows: [{ payload: { a: 1 } }], changes: 1 });
    const second = await db.run(cmd.consume, { id: "t1" });
    assert.deepEqual(second, { ok: false, kind: "assert", assert: "found" });
    // A failing assert after the item rolls back the delete: no token was
    // consumed twice, and the guard table is empty between commands (ADR 0093).
    assert.deepEqual(raw.prepare("select name from solarsql_assert").all(), []);
  } finally { raw.close(); }
});

test("an AFTER DELETE trigger's own rows count in changes(), but not in the RETURNING rows", async () => {
  const raw = freshDb();
  raw.exec("create trigger tokens_audit after delete on tokens begin insert into log (id) values (old.id || '-consumed'); end");
  try {
    const db = node(raw);
    await db.run(cmd.seed, { id: "t2", payload: '"p"' });
    const result = await db.run(cmd.consume, { id: "t2" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.rows, [{ payload: "p" }]);
      // 1 delete + 1 trigger insert.
      assert.equal(result.changes, 2);
    }
    assert.deepEqual(raw.prepare("select id from log").all().map((r) => ({ ...r })), [{ id: "t2-consumed" }]);
  } finally { raw.close(); }
});

test("an including command's own `returns` wins; the included row-source item still runs as a write", async () => {
  const raw = freshDb();
  try {
    const db = node(raw);
    await db.run(cmd.seed, { id: "t3", payload: '"x"' });
    const result = await db.run(outerWithReturns.consumeAndLog, { id: "t3" });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.rows, [{ id: "t3" }]);
    assert.deepEqual(raw.prepare("select id from tokens").all(), []);
  } finally { raw.close(); }
});

test("an including command with no `returns` drops an included row-source item's rows", async () => {
  const raw = freshDb();
  try {
    const db = node(raw);
    await db.run(cmd.seed, { id: "t4", payload: '"y"' });
    const result = await db.run(outerNoReturns.consumeAndDrop, { id: "t4" });
    assert.deepEqual(result, { ok: true, rows: [], changes: 1 });
    assert.deepEqual(raw.prepare("select id from tokens").all(), []);
  } finally { raw.close(); }
});
