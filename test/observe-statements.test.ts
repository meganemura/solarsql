// Responsibility: ADR 0039's 2026-09-25 section, the observe event's
// `statements` field -- one entry per plan item (and one for `returns`)
// with the rows D1's own reply or a Durable Object's own cursor reports
// for that one statement, not summed.
// Boundary: D1 and a Durable Object fake, and node (which must report no
// field, node:sqlite having no per-statement counters). The summed `meta`
// field's own contract stays test/observe-meta.test.ts's; this file only
// checks that it is unchanged alongside the new field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { node } from "../src/node.ts";
import { DatabaseSync } from "node:sqlite";
import { commands, read, type Meta, type Observed } from "../src/index.ts";
import { GUARD_DDL } from "../src/runtime/plan.ts";

const insertT = "insert into t (id, n) values (:id, :n)";
const updateT = "update t set n = :n where id = :id";
const selectT = "select id, n from t where id = :id";
const g: Meta<{
  [insertT]: { params: { id: string; n: number }; row: {} };
  [updateT]: { params: { id: string; n: number }; row: {} };
  [selectT]: { params: { id: string }; row: { id: string; n: number } };
}> = {
  [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
  [updateT]: { params: ["n", "id"], encode: [], json: [], reads: ["t"] },
  [selectT]: { params: ["id"], encode: [], json: [], reads: ["t"] },
};
const cmd = commands(g, { seedThenUpdate: { plan: [insertT, updateT], returns: selectT } });

test("D1: a command with plan (insert, update) and a returns query gives 3 entries; the guard-cleanup reply is dropped", async () => {
  const replies = new Map([
    [insertT, { results: [], meta: { changes: 1, rows_read: 0, rows_written: 1, duration: 0.1 } }],
    [updateT, { results: [], meta: { changes: 1, rows_read: 1, rows_written: 1, duration: 0.2 } }],
    [selectT, { results: [{ id: "row", n: 2 }], meta: { changes: 0, rows_read: 1, rows_written: 0, duration: 0.05 } }],
  ]);
  const binding: D1Like = {
    prepare(sql: string) {
      const found = sql.startsWith("insert") ? replies.get(insertT) : sql.startsWith("update") ? replies.get(updateT) : sql.startsWith("select") ? replies.get(selectT) : { results: [], meta: {} };
      const statement: D1StatementLike = { bind: () => statement, all: async () => found! };
      return statement;
    },
    batch: (statements) => Promise.all(statements.map((s) => s.all())),
  };
  const events: Observed[] = [];
  const db = d1(binding, { observe: (e) => events.push(e) });
  const result = await db.run(cmd.seedThenUpdate, { id: "row", n: 2 } as never);
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.statements, [
    { rows_read: 0, rows_written: 1, duration: 0.1 },
    { rows_read: 1, rows_written: 1, duration: 0.2 },
    { rows_read: 1, rows_written: 0, duration: 0.05 },
  ]);
  // The summed meta stays what test/observe-meta.test.ts already pins.
  assert.deepEqual(events[0]!.meta!.rows_read, 2);
  assert.deepEqual(events[0]!.meta!.rows_written, 2);
  assert.ok(Math.abs(events[0]!.meta!.duration! - 0.35) < 1e-9);
});

test("D1: a fake binding whose replies lack meta gives no statements field", async () => {
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = { bind: () => statement, all: async () => ({ results: sql.startsWith("select") ? [{ id: "row", n: 1 }] : [] }) };
      return statement;
    },
    batch: (statements) => Promise.all(statements.map((s) => s.all())),
  };
  const events: Observed[] = [];
  const db = d1(binding, { observe: (e) => events.push(e) });
  await db.run(cmd.seedThenUpdate, { id: "row", n: 2 } as never);
  assert.equal(events.length, 1);
  assert.equal("statements" in events[0]!, false);
});

test("D1: a batch of reads gives one entry per read", async () => {
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = { bind: () => statement, all: async () => ({ results: [{ id: "row", n: 1 }], meta: { rows_read: 1, rows_written: 0, duration: 0.01 } }) };
      return statement;
    },
    batch: (statements) => Promise.all(statements.map((s) => s.all())),
  };
  const events: Observed[] = [];
  const db = d1(binding, { observe: (e) => events.push(e) });
  const { queries } = await import("../src/index.ts");
  const q = queries({ [selectT]: { params: ["id"], encode: [], json: [], reads: ["t"] } }, { byId: selectT });
  await db.batch([read(q.byId, { id: "row" } as never), read(q.byId, { id: "row" } as never)]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.statements, [{ rows_read: 1, rows_written: 0, duration: 0.01 }, { rows_read: 1, rows_written: 0, duration: 0.01 }]);
});

function fakeCursor(rowsRead: number, rowsWritten: number, data: Record<string, unknown>[] = []) {
  return { rowsRead, rowsWritten, toArray: () => data };
}

test("Durable Object: a command with plan (insert, update) and a returns query gives 3 entries, with no duration and none from a probe", async () => {
  const storage: StorageLike = {
    sql: {
      exec(sql: string) {
        if (sql.startsWith("select total_changes()")) return fakeCursor(0, 0, [{ n: 1 }]);
        if (sql.startsWith("insert")) return fakeCursor(0, 1);
        if (sql.startsWith("update")) return fakeCursor(1, 1);
        if (sql.startsWith("select")) return fakeCursor(1, 0, [{ id: "row", n: 2 }]);
        return fakeCursor(0, 0);
      },
    },
    transactionSync<T>(closure: () => T): T { return closure(); },
  };
  const events: Observed[] = [];
  const db = durable(storage, { observe: (e) => events.push(e) });
  const result = await db.run(cmd.seedThenUpdate, { id: "row", n: 2 } as never);
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.statements, [
    { rows_read: 0, rows_written: 1 },
    { rows_read: 1, rows_written: 1 },
    { rows_read: 1, rows_written: 0 },
  ]);
  assert.ok(events[0]!.statements!.every((s) => !("duration" in s)));
});

test("Durable Object: an assert has an entry at its own position; guard cleanup has none", async () => {
  const { assert: sqlAssert } = await import("../src/index.ts");
  const predicate = "changes() = 1";
  const g2: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} }; [predicate]: { params: {}; row: {} } }> = {
    [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
    [predicate]: { params: [], encode: [], json: [], reads: [] },
  };
  const cmdAssert = commands(g2, { seedThenCheck: { plan: [insertT, sqlAssert("was_once", predicate)] } });
  const storage: StorageLike = {
    sql: {
      exec(sql: string) {
        if (sql.startsWith("select total_changes()")) return fakeCursor(0, 0, [{ n: 1 }]);
        if (sql.startsWith("insert")) return fakeCursor(0, 1);
        if (sql.startsWith("insert into solarsql_assert")) return fakeCursor(0, 1);
        if (sql.startsWith("delete from solarsql_assert")) return fakeCursor(0, 1);
        return fakeCursor(0, 0);
      },
    },
    transactionSync<T>(closure: () => T): T { return closure(); },
  };
  const events: Observed[] = [];
  const db = durable(storage, { observe: (e) => events.push(e) });
  const result = await db.run(cmdAssert.seedThenCheck, { id: "row", n: 1 } as never);
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  // insert, then the assert's own guard insert; the guard delete (cleanup) has no entry.
  assert.equal(events[0]!.statements!.length, 2);
});

test("node gives no statements field; a failed call on any adapter gives no field", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec([...GUARD_DDL, "create table t (id text primary key not null, n integer not null) strict"].join(";\n"));
  try {
    const events: Observed[] = [];
    const db = node(raw, { observe: (e) => events.push(e) });
    await db.run(cmd.seedThenUpdate, { id: "row", n: 2 } as never);
    assert.equal(events.length, 1);
    assert.equal("statements" in events[0]!, false);

    // Same id twice: a unique-constraint result, not a throw -- a failed
    // call either way, and it must still carry no statements field.
    events.length = 0;
    const second = await db.run(cmd.seedThenUpdate, { id: "row", n: 2 } as never);
    assert.equal(second.ok, false);
    assert.equal(events.length, 1);
    assert.equal("statements" in events[0]!, false);
  } finally { raw.close(); }
});
