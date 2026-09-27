// Responsibility: exercise src/d1.ts's own branches that the shared D1
// fixtures in test/observe-meta.test.ts, test/observe-statements.test.ts,
// test/observe-at.test.ts, and test/assert-cleanup.test.ts do not reach:
// parameter-diagnostic text, the returns/returningIndex split, blob
// decoding, the catch path's three outcomes, and the changes sum's edge
// values.
// Boundary: the D1 adapter only, through the same D1Like fake those files
// already use.
import { test } from "vitest";
import assert from "node:assert/strict";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { assert as sqlAssert, commands, queries, read, type Meta, type Observed } from "../src/index.ts";

// A binding that answers every prepared statement with the same reply,
// regardless of the SQL text.
function uniformBinding(reply: { results?: unknown; meta?: unknown }): D1Like {
  const statement: D1StatementLike = { bind: () => statement, all: async () => reply };
  return { prepare: () => statement, batch: async (statements) => statements.map(() => reply) };
}

// A binding that looks up its reply by the exact SQL text a prepare() call
// carries, the way distinct real D1 replies would differ by statement.
function taggedBinding(repliesFor: (sql: string) => { results?: unknown; meta?: unknown }): D1Like {
  return {
    prepare(sql: string) {
      const reply = repliesFor(sql);
      const statement: D1StatementLike = { bind: () => statement, all: async () => reply };
      return statement;
    },
    batch: (statements) => Promise.all(statements.map((s) => s.all())),
  };
}

const insertT = "insert into t (id, n) values (:id, :n)";
const selectById = "select id, n from t where id = :id";
const gInsertSelect: Meta<{
  [insertT]: { params: { id: string; n: number }; row: {} };
  [selectById]: { params: { id: string }; row: { id: string; n: number; blob?: Uint8Array } };
}> = {
  [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
  [selectById]: { params: ["id"], encode: [], json: [], reads: ["t"] },
};

test("all() validates against the query's own meta and names the query in the missing-parameter message", async () => {
  const q = queries(gInsertSelect, { byId: selectById });
  const db = d1(uniformBinding({ results: [] }));
  await assert.rejects(db.all(q.byId, {} as never), (e: unknown) => {
    assert.equal((e as Error).message, 'missing parameter: "id" (query byId declares: id)');
    return true;
  });
});

test("all() decodes a raw D1 byte array into a Uint8Array", async () => {
  const q = queries(gInsertSelect, { byId: selectById });
  const binding = uniformBinding({ results: [{ id: "row", n: 1, blob: [1, 2, 3] }], meta: {} });
  const db = d1(binding);
  const rows = await db.all(q.byId, { id: "row" } as never);
  assert.ok(rows[0]!.blob instanceof Uint8Array);
  assert.deepEqual(Array.from(rows[0]!.blob as Uint8Array), [1, 2, 3]);
});

test("all() and batch() report outcome \"ok\" and a batch event name joined with \"+\"", async () => {
  const q = queries(gInsertSelect, { byId: selectById });
  const events: Observed[] = [];
  const db = d1(uniformBinding({ results: [], meta: {} }), { observe: (e) => events.push(e) });
  await db.all(q.byId, { id: "row" } as never);
  await db.batch([read(q.byId, { id: "a" } as never), read(q.byId, { id: "b" } as never)]);
  assert.deepEqual(events.map((e) => [e.kind, e.outcome, e.name]), [
    ["query", "ok", "byId"],
    ["batch", "ok", "byId+byId"],
  ]);
});

test("batch() validates each read against its own query's meta and names that query", async () => {
  const q = queries(gInsertSelect, { byId: selectById });
  const db = d1(uniformBinding({ results: [], meta: {} }));
  await assert.rejects(db.batch([read(q.byId, {} as never)]), (e: unknown) => {
    assert.equal((e as Error).message, 'missing parameter: "id" (query byId declares: id)');
    return true;
  });
});

test("first() returns null with no rows and the first row otherwise", async () => {
  const q = queries(gInsertSelect, { byId: selectById });
  const empty = d1(uniformBinding({ results: [], meta: {} }));
  assert.equal(await empty.first(q.byId, { id: "row" } as never), null);
  const withRow = d1(uniformBinding({ results: [{ id: "row", n: 1 }], meta: {} }));
  assert.deepEqual(await withRow.first(q.byId, { id: "row" } as never), { id: "row", n: 1 });
});

test("run() names the command and the plan's own missing parameter in the message", async () => {
  const cmd = commands(gInsertSelect, { seedThenRead: { plan: [insertT], returns: selectById } });
  const db = d1(uniformBinding({ results: [], meta: {} }));
  await assert.rejects(db.run(cmd.seedThenRead, { n: 1 } as never), (e: unknown) => {
    assert.equal((e as Error).message, 'missing parameter: "id" (command seedThenRead declares: id, n)');
    return true;
  });
});

// The plan's own statement takes no parameters, so a param the returns
// clause alone declares is only accepted if validateParams() sees the
// returns clause's own meta too; with no returns clause seen, that param
// would fail as unexpected instead.
const insertFixed = "insert into t (id, n) values ('row', 0)";
const selectWithExtra = "select id, n from t where id = :id and n >= :min";
const gReturnsOnlyParam: Meta<{
  [insertFixed]: { params: {}; row: {} };
  [selectWithExtra]: { params: { id: string; min: number }; row: { id: string; n: number } };
}> = {
  [insertFixed]: { params: [], encode: [], json: [], reads: ["t"] },
  [selectWithExtra]: { params: ["id", "min"], encode: [], json: [], reads: ["t"] },
};

test("run() validates a call against a param only the returns clause declares", async () => {
  const cmd = commands(gReturnsOnlyParam, { seedThenRead: { plan: [insertFixed], returns: selectWithExtra } });
  const binding = uniformBinding({ results: [], meta: { changes: 1, rows_read: 0, rows_written: 1 } });
  const db = d1(binding);
  const result = await db.run(cmd.seedThenRead, { id: "row", min: 5 } as never);
  assert.equal(result.ok, true);
});

test("run() with no returns clause: a valid call succeeds with the plan's own changes and no rows", async () => {
  const cmd = commands(gInsertSelect, { seed: { plan: [insertT] } });
  const db = d1(uniformBinding({ results: [], meta: { changes: 1, rows_read: 0, rows_written: 1 } }));
  const result = await db.run(cmd.seed, { id: "row", n: 1 } as never);
  assert.deepEqual(result, { ok: true, rows: [], changes: 1 });
});

test("run() with a returns clause decodes a raw D1 byte array in the returned rows", async () => {
  const cmd = commands(gInsertSelect, { seedThenRead: { plan: [insertT], returns: selectById } });
  const binding = taggedBinding((sql) =>
    sql.startsWith("insert")
      ? { results: [], meta: { changes: 1, rows_read: 0, rows_written: 1 } }
      : { results: [{ id: "row", n: 1, blob: [9, 9, 9] }], meta: { changes: 0, rows_read: 1, rows_written: 0 } },
  );
  const db = d1(binding);
  const result = await db.run(cmd.seedThenRead, { id: "row", n: 1 } as never);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.rows[0]!.blob instanceof Uint8Array);
  assert.deepEqual(Array.from(result.rows[0]!.blob as Uint8Array), [9, 9, 9]);
});

// A DELETE ... RETURNING plan item with no `returns` clause (ADR 0136):
// the adapter reads rows from that item's own reply instead.
const deleteReturning = "delete from t where id = :id returning id, n, blob";
const gDeleteReturning: Meta<{ [deleteReturning]: { params: { id: string }; row: { id: string; n: number; blob: Uint8Array }; returning: true } }> = {
  [deleteReturning]: { params: ["id"], encode: [], json: [], reads: ["t"], returning: true },
};

test("run() with a DELETE ... RETURNING plan item and no returns clause reads rows from that item's own reply, byte arrays included", async () => {
  const cmd = commands(gDeleteReturning, { removeAndReturn: { plan: [deleteReturning] } });
  assert.equal(cmd.removeAndReturn.returningIndex, 0);
  const binding = uniformBinding({ results: [{ id: "row", n: 5, blob: [1, 2, 3] }], meta: { changes: 1, rows_read: 1, rows_written: 1 } });
  const db = d1(binding);
  const result = await db.run(cmd.removeAndReturn, { id: "row" } as never);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changes, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.id, "row");
  assert.equal(result.rows[0]!.n, 5);
  assert.ok(result.rows[0]!.blob instanceof Uint8Array);
  assert.deepEqual(Array.from(result.rows[0]!.blob), [1, 2, 3]);
});

test("a failing D1 batch that trips the guard trigger returns the assert result, not a thrown error", async () => {
  const predicate = "changes() = 1";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} }; [predicate]: { params: {}; row: {} } }> = {
    [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
    [predicate]: { params: [], encode: [], json: [], reads: [] },
  };
  const cmd = commands(g, { seedThenCheck: { plan: [insertT, sqlAssert("was_once", predicate)] } });
  const bound: { sql: string; values: unknown[] }[] = [];
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = {
        bind: (...values: unknown[]) => { bound.push({ sql, values }); return statement; },
        all: async () => ({ results: [], meta: {} }),
      };
      return statement;
    },
    batch: async () => {
      const guardInsert = bound.find((b) => b.sql.includes("insert into solarsql_assert"));
      const token = guardInsert!.values.at(-1);
      throw new Error(`D1_ERROR: solarsql:assert:${token}:was_once: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`);
    },
  };
  const db = d1(binding);
  const result = await db.run(cmd.seedThenCheck, { id: "row", n: 1 } as never);
  assert.deepEqual(result, { ok: false, kind: "assert", assert: "was_once" });
});

test("a failing D1 batch that reports a unique-constraint violation returns the constraint result, not a thrown error", async () => {
  const cmd = commands(gInsertSelect, { seed: { plan: [insertT] } });
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = { bind: () => statement, all: async () => ({ results: [], meta: {} }) };
      return statement;
    },
    batch: async () => { throw new Error("D1_ERROR: UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"); },
  };
  const db = d1(binding);
  const result = await db.run(cmd.seed, { id: "row", n: 1 } as never);
  assert.deepEqual(result, { ok: false, kind: "unique", table: "t", columns: ["id"] });
});

test("a failing D1 batch that is neither an assert nor a constraint rejects with the original error", async () => {
  const cmd = commands(gInsertSelect, { seed: { plan: [insertT] } });
  const original = new Error("D1 DB is overloaded. Requests queued for too long.");
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = { bind: () => statement, all: async () => ({ results: [], meta: {} }) };
      return statement;
    },
    batch: async () => { throw original; },
  };
  const db = d1(binding);
  await assert.rejects(db.run(cmd.seed, { id: "row", n: 1 } as never), (e: unknown) => e === original);
});

test("run() reports outcome \"ok\", \"unique\", and \"assert:<name>\" to the observer", async () => {
  const cmd = commands(gInsertSelect, { seed: { plan: [insertT] } });
  const okEvents: Observed[] = [];
  const okDb = d1(uniformBinding({ results: [], meta: { changes: 1, rows_read: 0, rows_written: 1 } }), { observe: (e) => okEvents.push(e) });
  await okDb.run(cmd.seed, { id: "row", n: 1 } as never);
  assert.equal(okEvents[0]!.outcome, "ok");

  const uniqueEvents: Observed[] = [];
  const uniqueBinding: D1Like = {
    prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], meta: {} }) }) as D1StatementLike,
    batch: async () => { throw new Error("D1_ERROR: UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"); },
  };
  const uniqueDb = d1(uniqueBinding, { observe: (e) => uniqueEvents.push(e) });
  await uniqueDb.run(cmd.seed, { id: "row", n: 1 } as never);
  assert.equal(uniqueEvents[0]!.outcome, "unique");

  const predicate = "changes() = 1";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} }; [predicate]: { params: {}; row: {} } }> = {
    [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
    [predicate]: { params: [], encode: [], json: [], reads: [] },
  };
  const assertCmd = commands(g, { seedThenCheck: { plan: [insertT, sqlAssert("was_once", predicate)] } });
  const bound: { sql: string; values: unknown[] }[] = [];
  const assertBinding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = {
        bind: (...values: unknown[]) => { bound.push({ sql, values }); return statement; },
        all: async () => ({ results: [], meta: {} }),
      };
      return statement;
    },
    batch: async () => {
      const guardInsert = bound.find((b) => b.sql.includes("insert into solarsql_assert"));
      const token = guardInsert!.values.at(-1);
      throw new Error(`D1_ERROR: solarsql:assert:${token}:was_once: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`);
    },
  };
  const assertEvents: Observed[] = [];
  const assertDb = d1(assertBinding, { observe: (e) => assertEvents.push(e) });
  await assertDb.run(assertCmd.seedThenCheck, { id: "row", n: 1 } as never);
  assert.equal(assertEvents[0]!.outcome, "assert:was_once");
});

test("statements reported for a command with an assert and no returns clause exclude the guard-cleanup reply", async () => {
  const predicate = "changes() = 1";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} }; [predicate]: { params: {}; row: {} } }> = {
    [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
    [predicate]: { params: [], encode: [], json: [], reads: [] },
  };
  const cmd = commands(g, { seedThenCheck: { plan: [insertT, sqlAssert("was_once", predicate)] } });
  // Every reply, including the guard-cleanup delete's, carries both
  // counters, the same as a real D1 batch reply does.
  const binding = taggedBinding((sql) => {
    if (sql.startsWith("delete from solarsql_assert")) return { results: [], meta: { rows_read: 0, rows_written: 2 } };
    if (sql.includes("insert into solarsql_assert")) return { results: [], meta: { rows_read: 0, rows_written: 1 } };
    return { results: [], meta: { rows_read: 0, rows_written: 1 } };
  });
  const events: Observed[] = [];
  const db = d1(binding, { observe: (e) => events.push(e) });
  const result = await db.run(cmd.seedThenCheck, { id: "row", n: 1 } as never);
  assert.equal(result.ok, true);
  assert.equal(events[0]!.statements!.length, 2);
});

test("changes sums only finite numbers, treating a missing or non-finite meta.changes as 0", async () => {
  const cmd = commands(gInsertSelect, { seed: { plan: [insertT] } });

  const missing = d1(uniformBinding({ results: [], meta: {} }));
  assert.equal((await missing.run(cmd.seed, { id: "row", n: 1 } as never) as { changes: number }).changes, 0);

  const nonNumber = d1(uniformBinding({ results: [], meta: { changes: "1" } }));
  assert.equal((await nonNumber.run(cmd.seed, { id: "row", n: 1 } as never) as { changes: number }).changes, 0);

  const infinite = d1(uniformBinding({ results: [], meta: { changes: Infinity } }));
  assert.equal((await infinite.run(cmd.seed, { id: "row", n: 1 } as never) as { changes: number }).changes, 0);

  const finite = d1(uniformBinding({ results: [], meta: { changes: 3 } }));
  assert.equal((await finite.run(cmd.seed, { id: "row", n: 1 } as never) as { changes: number }).changes, 3);
});
