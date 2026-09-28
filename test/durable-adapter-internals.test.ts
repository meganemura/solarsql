// Responsibility: durable()'s own read-path accounting -- cursorMeta()'s and
// statementRows()'s both-required, summed-vs-per-statement counters, and the
// `included` range a command's own `at` event carries for a plan item that
// sits inside an included sub-command.
// Boundary: a hand-built StorageLike whose cursors report exactly the
// rowsRead/rowsWritten shape src/durable.ts's own CursorLike comment
// documents; no real engine involved.
import { test } from "vitest";
import assert from "node:assert/strict";
import { commands, queries, read, type Meta, type Observed } from "../src/index.ts";
import { durable, type StorageLike } from "../src/durable.ts";

type FakeCursor = { toArray(): Record<string, unknown>[]; rowsRead?: number; rowsWritten?: number };
function cursor(rows: Record<string, unknown>[], rowsRead: number | undefined, rowsWritten: number | undefined): FakeCursor {
  return { toArray: () => rows, ...(rowsRead !== undefined ? { rowsRead } : {}), ...(rowsWritten !== undefined ? { rowsWritten } : {}) };
}

// Hands out the given cursors in order, one per storage.sql.exec() call,
// ignoring the statement text (these tests care only about the accounting,
// not the data).
function queueStorage(cursors: readonly FakeCursor[]): StorageLike {
  let i = 0;
  return {
    sql: { exec: () => { const c = cursors[i]; i++; if (!c) throw new Error(`exec called more than the ${cursors.length} cursors queued`); return c; } },
    transactionSync: (closure) => closure(),
  };
}

const q1 = "select 1 as n";
const q2 = "select 2 as n";
const generated = {
  [q1]: { params: [], encode: [], json: [], reads: [] },
  [q2]: { params: [], encode: [], json: [], reads: [] },
} as never;
const q = queries(generated, { one: q1, two: q2 });

test("a query's own single cursor, with both counters, reports that cursor's own reads and writes", async () => {
  const events: Observed[] = [];
  const db = durable(queueStorage([cursor([{ n: 1 }], 3, 1)]), { observe: (e) => events.push(e) });
  await db.all(q.one);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.meta, { rows_read: 3, rows_written: 1 });
});

test("a batch sums rowsRead and rowsWritten across its own cursors, and keeps one StatementRow per cursor", async () => {
  const events: Observed[] = [];
  const db = durable(queueStorage([cursor([{ n: 1 }], 3, 1), cursor([{ n: 2 }], 5, 2)]), { observe: (e) => events.push(e) });
  await db.batch([read(q.one), read(q.two)]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.meta, { rows_read: 8, rows_written: 3 });
  assert.deepEqual(events[0]!.statements, [{ rows_read: 3, rows_written: 1 }, { rows_read: 5, rows_written: 2 }]);
});

test("a cursor missing one counter is left out of the summed meta, and blanks the whole per-statement list", async () => {
  const events: Observed[] = [];
  // The second cursor has rowsRead but no rowsWritten: cursorMeta()'s
  // both-required rule skips it entirely (the sum below reflects only the
  // first cursor), and statementRows()'s own both-required rule drops the
  // whole per-statement list, not just this one entry.
  const db = durable(queueStorage([cursor([{ n: 1 }], 3, 1), cursor([{ n: 2 }], 5, undefined)]), { observe: (e) => events.push(e) });
  await db.batch([read(q.one), read(q.two)]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.meta, { rows_read: 3, rows_written: 1 });
  assert.equal("statements" in events[0]!, false);
});

test("a Durable Object storage with no inTransaction() still migrates cleanly", async () => {
  const { migrate: migrateStorage } = await import("../src/durable.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { storageOf } = await import("../src/node.ts");
  const raw = new DatabaseSync(":memory:");
  try {
    const base = storageOf(raw);
    // A real Durable Object's storage carries no inTransaction() at all
    // (the comment on StorageLike above): a plain object literal without
    // that property, not merely one whose method returns false, matches
    // that shape.
    const noInTransaction: StorageLike = { sql: base.sql, transactionSync: base.transactionSync };
    assert.equal("inTransaction" in noInTransaction, false);
    const applied = migrateStorage(noInTransaction, [{ name: "0001_t.sql", sql: "create table t (id text primary key not null) strict;" }]);
    assert.deepEqual(applied, ["0001_t.sql"]);
  } finally { raw.close(); }
});

test("a plan item's at names the included sub-command only for the items inside its own range, not the item just before or just after it", async () => {
  const insertMid1 = "insert into t (id, n) values (:idm1, 1)";
  const insertMid2 = "insert into t (id, n) values (:idm2, 2)";
  const failA = "update t set n = json_extract(:doca, '$.n') where id = :ida";
  const failC = "update t set n = json_extract(:docc, '$.n') where id = :idc";
  const g: Meta<{
    [failA]: { params: { doca: string; ida: string }; row: {} };
    [insertMid1]: { params: { idm1: string }; row: {} };
    [insertMid2]: { params: { idm2: string }; row: {} };
    [failC]: { params: { docc: string; idc: string }; row: {} };
  }> = {
    [failA]: { params: ["doca", "ida"], encode: [], json: [], reads: ["t"] },
    [insertMid1]: { params: ["idm1"], encode: [], json: [], reads: ["t"] },
    [insertMid2]: { params: ["idm2"], encode: [], json: [], reads: ["t"] },
    [failC]: { params: ["docc", "idc"], encode: [], json: [], reads: ["t"] },
  };
  const mid = commands(g, { mid: { plan: [insertMid1, insertMid2] } });
  const outer = commands(g, { flow: { plan: [failA, mid.mid, failC] } });

  const { node } = await import("../src/node.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { GUARD_DDL } = await import("../src/runtime/plan.ts");
  // failA and failC only evaluate their own json_extract() for a row their
  // own WHERE clause actually matches (SQLite skips the SET expression
  // entirely for an UPDATE that matches no row), so both "a" and "c" need a
  // row present before either can fail on malformed JSON.
  function freshDb() {
    const raw = new DatabaseSync(":memory:");
    raw.exec([...GUARD_DDL, "create table t (id text primary key not null, n integer not null default 0) strict"].join(";\n"));
    raw.exec("insert into t (id, n) values ('a', 0), ('c', 0)");
    return raw;
  }
  const okParams = { doca: '{"n":1}', ida: "a", idm1: "m1", idm2: "m2", docc: '{"n":1}', idc: "c" };

  // Failing the item before the included range: no `included` on `at`.
  {
    const raw = freshDb();
    try {
      const events: Observed[] = [];
      const db = node(raw, { observe: (e) => events.push(e) });
      await assert.rejects(db.run(outer.flow, { ...okParams, doca: "{not json" } as never));
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.at, { position: 1, of: 4, sql: failA });
    } finally { raw.close(); }
  }

  // Failing the first item inside the included range (i === r.from): names it.
  {
    const raw = freshDb();
    raw.exec("insert into t (id, n) values ('m1', 0)"); // duplicate primary key fails insertMid1
    try {
      const events: Observed[] = [];
      const db = node(raw, { observe: (e) => events.push(e) });
      await db.run(outer.flow, okParams as never);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.at, { position: 2, of: 4, sql: insertMid1, included: "mid" });
    } finally { raw.close(); }
  }

  // Failing the item right after the range (i === r.to, index 3): no
  // `included`, even though it is the plan item immediately following one.
  {
    const raw = freshDb();
    try {
      const events: Observed[] = [];
      const db = node(raw, { observe: (e) => events.push(e) });
      await assert.rejects(db.run(outer.flow, { ...okParams, docc: "{not json" } as never));
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.at, { position: 4, of: 4, sql: failC });
    } finally { raw.close(); }
  }
});
