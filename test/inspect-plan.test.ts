// `solarsql inspect`'s per-operation query plan: EXPLAIN QUERY PLAN's own
// account of an index search, a full scan, or a temporary B-tree sort,
// summarized by summarizePlan() in build.ts. The example pins one case of
// each; the property below holds for any indexed column, not just the
// example's own.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { build, summarizePlan, type OperationInspection } from "../src/build/build.ts";
import { Engine } from "../src/build/facts.ts";
import { quoteIdent } from "../src/build/scan.ts";

const configPath = resolve(import.meta.dirname, "..", "example/solarsql.config.ts");

function findOperation(operations: readonly OperationInspection[], sqlPattern: RegExp): OperationInspection {
  const op = operations.find((o) => sqlPattern.test(o.sql));
  assert.ok(op, `no operation matching ${sqlPattern}`);
  return op!;
}

describe("inspect's query plan", () => {
  test("byCustomer's equality filter searches orders_customer_id, and scans nothing", async () => {
    const result = await build(configPath, { write: false, inspect: true });
    const op = findOperation(result.inspection!.operations, /customer_id = :customer_id order by id desc/);
    assert.deepEqual(op.plan!.searches, [{ table: "orders", index: "orders_customer_id" }]);
    assert.deepEqual(op.plan!.scans, []);
  });

  test("byNote's LIKE filter has no index to search, so the plan scans orders in full", async () => {
    const result = await build(configPath, { write: false, inspect: true });
    const op = findOperation(result.inspection!.operations, /note like :pattern/);
    assert.deepEqual(op.plan!.scans, ["orders"]);
    assert.deepEqual(op.plan!.searches, []);
  });

  test("an order by on a column with no index sorts with a temporary B-tree", async () => {
    const result = await build(configPath, { write: false, inspect: true });
    const op = findOperation(result.inspection!.operations, /order by name/);
    assert.equal(op.plan!.tempBtree, true);
  });

  test("an aliased table's SEARCH names the alias, not the table, unlike the build's own scan line", async () => {
    const result = await build(configPath, { write: false, inspect: true });
    const op = findOperation(result.inspection!.operations, /left join order_lines l on l\.order_id = o\.id/);
    assert.deepEqual(op.plan!.searches, [
      { table: "o", index: "sqlite_autoindex_orders_1" },
      { table: "l", index: "order_lines_order_id" },
    ]);
  });

  test("a write statement carries no plan", async () => {
    const result = await build(configPath, { write: false, inspect: true });
    const op = findOperation(result.inspection!.operations, /^\s*insert into customers/);
    assert.equal(op.plan, null);
  });
});

describe("summarizePlan", () => {
  test("an equality filter on an indexed column searches that index, and scans that table never", () => {
    hegel.test((tc) => {
      const column = tc.draw(gs.fromRegex("[a-z]{1,6}"));
      tc.assume(column !== "id");
      const engine = new Engine([
        `create table t (id integer primary key, ${quoteIdent(column)} integer not null) strict`,
        `create index t_by_column on t (${quoteIdent(column)})`,
      ]);
      try {
        const summary = summarizePlan(engine.plan(`select * from t where ${quoteIdent(column)} = :p`));
        assert.deepEqual(summary.searches, [{ table: "t", index: "t_by_column" }]);
        assert.deepEqual(summary.scans, []);
      } finally {
        engine.close();
      }
    });
  });
});
