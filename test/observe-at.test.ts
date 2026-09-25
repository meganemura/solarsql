// Responsibility: ADR 0137, the observe event's `at` field -- which plan
// item, the returns clause, or a batch read was running when an
// unclassified error or a constraint failure happened.
// Boundary: node (through durable()) and a hand-built StorageLike for the
// one shape node cannot reach (a commit failing after the closure itself
// succeeds), plus one D1 fake proving `at` is absent on a D1 failure too.
// test/miniflare/observe-plan-item.test.ts is this file's Miniflare
// evidence, on real D1 and a real Durable Object.
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { commands, read, type Meta, type Observed } from "../src/index.ts";
import { GUARD_DDL } from "../src/runtime/plan.ts";
import { node } from "../src/node.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { testAsync } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  raw.exec([...GUARD_DDL, "create table t (id text primary key not null, n integer not null) strict"].join(";\n"));
  raw.exec("insert into t (id, n) values ('row', 0)");
  return raw;
}

// A plan of n `update` items, each keyed by its own doc parameter, so
// exactly one item's own value can be malformed while the rest succeed.
function planOf(n: number): { sql: string[]; meta: Meta<Record<string, { params: Record<string, unknown>; row: {} }>> } {
  const sql = Array.from({ length: n }, (_, i) => `update t set n = json_extract(:doc${i}, '$.n') where id = :id`);
  // Declared in the SQL text's own first-appearance order (ADR 0071):
  // node.ts's exec() zips node:sqlite's own named-slot order (from the
  // text) against this array position by position.
  const meta = Object.fromEntries(sql.map((s, i) => [s, { params: [`doc${i}`, "id"], encode: [], json: [], reads: ["t"] }]));
  return { sql, meta: meta as never };
}

test("a Hegel property: a malformed-JSON parameter at plan position k names that position, that many total, and leaks no sentinel", async () => {
  await testAsync(async (tc) => {
    const n = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
    const k = tc.draw(gs.integers({ minValue: 1, maxValue: n }));
    const sentinel = `sentinel-${tc.draw(gs.text({ minSize: 8, maxSize: 8, alphabet: "abcdefghijklmnopqrstuvwxyz" }))}`;
    const { sql, meta } = planOf(n);
    const cmd = commands(meta, { run: { plan: sql } });
    const params: Record<string, string> = { id: "row" };
    for (let i = 0; i < n; i++) params[`doc${i}`] = i === k - 1 ? `{not json ${sentinel}` : '{"n":1}';

    const raw = freshDb();
    const raw2 = new DatabaseSync(":memory:");
    raw2.exec([...GUARD_DDL, "create table t (id text primary key not null, n integer not null) strict"].join(";\n"));
    raw2.exec("insert into t (id, n) values ('row', 0)");
    try {
      let rawError: unknown;
      try { raw2.prepare(sql[k - 1]!).run({ id: "row", [`doc${k - 1}`]: `{not json ${sentinel}` }); }
      catch (e) { rawError = e; }
      assert.ok(rawError, "the raw statement should itself throw for a malformed JSON parameter");

      const events: Observed[] = [];
      const db = node(raw, { observe: (e) => events.push(e) });
      await assert.rejects(db.run(cmd.run, params as never), (e: unknown) => {
        assert.equal((e as Error).message, (rawError as Error).message);
        const ownNames = (o: object) => Object.getOwnPropertyNames(o).sort();
        assert.deepEqual(ownNames(e as object), ownNames(rawError as object));
        return true;
      });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.at, { position: k, of: n, sql: sql[k - 1] });
      assert.equal(JSON.stringify(events[0]).includes(sentinel), false);
    } finally { raw.close(); raw2.close(); }
  }, { testCases: 30 });
});

test("a failure in returns gives at.returns; a failure inside an included command's range gives at.included", async () => {
  const insertT = "insert into t (id, n) values (:id, :n)";
  const badReturns = "select json_extract(:doc, '$.n') as n from t where id = :id";
  const g: Meta<{
    [insertT]: { params: { id: string; n: number }; row: {} };
    [badReturns]: { params: { doc: string; id: string }; row: { n: number } };
  }> = {
    [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] },
    [badReturns]: { params: ["doc", "id"], encode: [], json: [], reads: ["t"] },
  };
  const included = commands(g, { seed: { plan: [insertT] } });
  const outer = commands(g, { seedThenRead: { plan: [included.seed], returns: badReturns } });

  const raw = freshDb();
  try {
    const events: Observed[] = [];
    const db = node(raw, { observe: (e) => events.push(e) });
    await assert.rejects(db.run(outer.seedThenRead, { id: "row2", n: 1, doc: "{not json" } as never));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.at, { returns: true, sql: badReturns });

    // The plan item itself sits inside included.seed's own range; failing
    // it (a duplicate primary key) should name that range.
    events.length = 0;
    await db.run(outer.seedThenRead, { id: "row", n: 1, doc: "{}" } as never);
    // seed t.id='row' already exists (freshDb()), so the insert fails a
    // primary-key uniqueness check -- a constraint, not an unclassified
    // error, and `at` must still carry the position inside the range.
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.at, { position: 1, of: 1, sql: insertT, included: "seed" });
  } finally { raw.close(); }
});

test("a unique-constraint result is unchanged and its event carries the insert's position", async () => {
  const raw = freshDb();
  const insertT = "insert into t (id, n) values (:id, :n)";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} } }> = { [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] } };
  const cmd = commands(g, { seed: { plan: [insertT] } });
  try {
    const events: Observed[] = [];
    const db = node(raw, { observe: (e) => events.push(e) });
    const result = await db.run(cmd.seed, { id: "row", n: 9 } as never);
    assert.deepEqual(result, { ok: false, kind: "unique", table: "t", columns: ["id"] });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.at, { position: 1, of: 1, sql: insertT });
  } finally { raw.close(); }
});

test("durable() with a fake StorageLike whose transactionSync throws after the closure gives an event with no at", async () => {
  const insertT = "insert into t (id, n) values (:id, :n)";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} } }> = { [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] } };
  const cmd = commands(g, { seed: { plan: [insertT] } });
  const storage: StorageLike = {
    sql: { exec: (sql: string, ...values: unknown[]) => {
      if (sql.startsWith("select total_changes()")) return { toArray: () => [{ n: 1 }] };
      return { toArray: () => [] };
    } },
    transactionSync<T>(closure: () => T): T {
      closure();
      throw new Error("commit failed");
    },
  };
  const events: Observed[] = [];
  const db = durable(storage, { observe: (e) => events.push(e) });
  await assert.rejects(db.run(cmd.seed, { id: "row", n: 1 } as never), /commit failed/);
  assert.equal(events.length, 1);
  assert.equal("at" in events[0]!, false);
});

test("a failing D1 batch gives no at and no statements", async () => {
  const insertT = "insert into t (id, n) values (:id, :n)";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} } }> = { [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] } };
  const cmd = commands(g, { seed: { plan: [insertT] } });
  const binding: D1Like = {
    prepare(sql: string) {
      const statement: D1StatementLike = { bind: () => statement, all: async () => { throw new Error(`D1_ERROR: malformed JSON: SQLITE_ERROR`); } };
      return statement;
    },
    batch: () => { throw new Error("D1_ERROR: malformed JSON: SQLITE_ERROR"); },
  };
  const events: Observed[] = [];
  const db = d1(binding, { observe: (e) => events.push(e) });
  await assert.rejects(db.run(cmd.seed, { id: "row", n: 1 } as never));
  assert.equal(events.length, 1);
  assert.equal("at" in events[0]!, false);
  assert.equal("statements" in events[0]!, false);
});

test("a failing Durable Object command gives no statements (at still names the item, per the tests above)", async () => {
  const insertT = "insert into t (id, n) values (:id, :n)";
  const g: Meta<{ [insertT]: { params: { id: string; n: number }; row: {} } }> = { [insertT]: { params: ["id", "n"], encode: [], json: [], reads: ["t"] } };
  const cmd = commands(g, { seed: { plan: [insertT] } });
  const storage: StorageLike = {
    sql: {
      exec(sql: string) {
        if (sql.startsWith("select total_changes()")) return { toArray: () => [{ n: 1 }] };
        if (sql.startsWith("insert")) throw new Error("malformed JSON");
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(closure: () => T): T { return closure(); },
  };
  const events: Observed[] = [];
  const db = durable(storage, { observe: (e) => events.push(e) });
  await assert.rejects(db.run(cmd.seed, { id: "row", n: 1 } as never), /malformed JSON/);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.at, { position: 1, of: 1, sql: insertT });
  assert.equal("statements" in events[0]!, false);
});
