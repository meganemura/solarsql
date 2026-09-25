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
// against a hand-authored `Generated` map, so this file needs nothing from
// the build's own emit (src/build/build.ts, src/build/typegen.ts).
import { test } from "vitest";
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

// ADR 0086's 2026-09-25 amendment: an assert's SQL text is the same every
// run, and the invocation token binds as a value instead. Two runs of the
// example's own orders.confirm (two asserts) and orders.reprice (one
// assert, one array parameter) prove both: every statement's SQL text
// matches across runs, and each assert's own last bound value (the token)
// differs between runs and never appears in either run's SQL text.
test("orders.confirm and orders.reprice send byte-identical SQL text across runs on D1 and a Durable Object; the token differs and stays out of the text", async () => {
  const { orderCommands } = await import("../example/modules/orders/public.ts");
  const { d1 } = await import("../src/d1.ts");
  const { durable } = await import("../src/durable.ts");
  const hegel = await import("@hegeldev/hegel");
  const gs = await import("@hegeldev/hegel/generators");

  type Call = { sql: string; values: readonly unknown[] };

  function runOnD1(fn: (db: ReturnType<typeof d1>) => Promise<unknown>): Promise<Call[]> {
    const calls: Call[] = [];
    const binding = {
      prepare(sql: string) {
        // Recorded here, not only in bind(): the guard-cleanup statement
        // (GUARD_CLEANUP) is prepared but never bound, so a call array
        // built only from bind() would silently drop it.
        const call: Call = { sql, values: [] };
        calls.push(call);
        const statement = {
          bind(...values: unknown[]) { call.values = values; return statement; },
          all: async () => ({ results: [{ id: "o1", customer_id: "c1", status: "confirmed", note: null }], meta: { changes: 1 } }),
        };
        return statement;
      },
      batch: (statements: { all(): Promise<unknown> }[]) => Promise.all(statements.map((s) => s.all())),
    };
    return fn(d1(binding as never)).then(() => calls);
  }

  function runOnDurable(fn: (db: ReturnType<typeof durable>) => Promise<unknown>): Promise<Call[]> {
    const calls: Call[] = [];
    let n = 0;
    const storage = {
      sql: {
        exec(sql: string, ...values: unknown[]) {
          calls.push({ sql, values });
          if (sql.startsWith("select total_changes()")) { n += 1; return { toArray: () => [{ n }] }; }
          if (/^select /i.test(sql)) return { toArray: () => [{ id: "o1", customer_id: "c1", status: "confirmed", note: null }] };
          return { toArray: () => [] };
        },
      },
      transactionSync<T>(closure: () => T): T { return closure(); },
    };
    return fn(durable(storage as never)).then(() => calls);
  }

  const assertCalls = (calls: readonly Call[]): Call[] => calls.filter((c) => c.sql.includes("insert into solarsql_assert"));

  await hegel.testAsync(async (tc) => {
    const id = tc.draw(gs.sampledFrom(["o1", "o2", "order-3"]));
    const lines = tc.draw(gs.arrays(gs.sampledFrom(["l1", "l2"]), { minSize: 1, maxSize: 2 }));

    for (const [run, fn] of [
      ["d1", (db: ReturnType<typeof d1>) => db.run(orderCommands.confirm, { id } as never)] as const,
      ["durable", (db: ReturnType<typeof durable>) => db.run(orderCommands.confirm, { id } as never)] as const,
    ]) {
      const first = run === "d1" ? await runOnD1(fn as never) : await runOnDurable(fn as never);
      const second = run === "d1" ? await runOnD1(fn as never) : await runOnDurable(fn as never);
      assert.deepEqual(first.map((c) => c.sql), second.map((c) => c.sql));
      const a1 = assertCalls(first);
      const a2 = assertCalls(second);
      assert.equal(a1.length, 2);
      assert.equal(a2.length, 2);
      for (let i = 0; i < a1.length; i++) {
        const token1 = a1[i]!.values.at(-1);
        const token2 = a2[i]!.values.at(-1);
        assert.notEqual(token1, token2);
        assert.equal(a1[i]!.sql.includes(String(token1)), false);
        assert.equal(a2[i]!.sql.includes(String(token2)), false);
      }
    }

    for (const kind of ["d1", "durable"] as const) {
      const params = { id, lines: lines.map((l) => ({ id: l, price: 1 })) } as never;
      const run = kind === "d1"
        ? (db: ReturnType<typeof d1>) => db.run(orderCommands.reprice, params)
        : (db: ReturnType<typeof durable>) => db.run(orderCommands.reprice, params);
      const first = kind === "d1" ? await runOnD1(run as never) : await runOnDurable(run as never);
      const second = kind === "d1" ? await runOnD1(run as never) : await runOnDurable(run as never);
      assert.deepEqual(first.map((c) => c.sql), second.map((c) => c.sql));
      const a1 = assertCalls(first);
      const a2 = assertCalls(second);
      assert.equal(a1.length, 1);
      const token1 = a1[0]!.values.at(-1);
      const token2 = a2[0]!.values.at(-1);
      assert.notEqual(token1, token2);
      assert.equal(a1[0]!.sql.includes(String(token1)), false);
    }
  }, { testCases: 10 });
});

// node.ts's exec() shim binds a predicate's own named slots as one named
// object; the token, a trailing anonymous `?`, must still bind as its own
// value after that object, not as NULL under it (ADR 0086's 2026-09-25
// amendment).
test("on node, a false assert whose predicate has a named parameter still returns kind: 'assert'", async () => {
  const named = "insert into tokens (id, payload) values (:id, :payload)";
  const predicate = ":expected = 0";
  const g: Meta<{ [named]: { params: { id: string; payload: string }; row: {} }; [predicate]: { params: { expected: number }; row: {} } }> = {
    [named]: { params: ["id", "payload"], encode: [], json: [], reads: ["tokens"] },
    [predicate]: { params: ["expected"], encode: [], json: [], reads: [] },
  };
  const c = commands(g, { seedThenCheck: { plan: [named, sqlAssert("expects_zero", predicate)] } });
  const raw = freshDb();
  try {
    const db = node(raw);
    const result = await db.run(c.seedThenCheck, { id: "t9", payload: "{}", expected: 1 });
    assert.deepEqual(result, { ok: false, kind: "assert", assert: "expects_zero" });
    assert.deepEqual(raw.prepare("select id from tokens").all(), []);
  } finally { raw.close(); }
});

test("a validateParams error for a command with an assert names only user parameters, never the token", async () => {
  const raw = freshDb();
  try {
    const db = node(raw);
    await assert.rejects(db.run(cmd.consume, {} as never), (e: unknown) => {
      assert.match((e as Error).message, /^missing parameter: "id" \(command consume declares: id\)$/);
      return true;
    });
  } finally { raw.close(); }
});
