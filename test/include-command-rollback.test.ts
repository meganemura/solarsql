// ADR 0127's own claim, on node:sqlite: customers.remove includes orders'
// deleteByCustomer ahead of its own delete from customers, and the whole
// plan runs as one transaction. test/miniflare/include-command-rollback.
// test.ts proves the same three cases on D1 and on a Durable Object; this
// file is the fast, in-process version test/node.test.ts's own header
// describes as "the loop a module's own tests run in".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { node, migrate } from "../src/node.ts";
import { fixtureDir } from "./fixture-dir.ts";

const root = resolve(import.meta.dirname, "..");

// A child process, not the in-process build() other tests in this
// repository use: module.ts holds a static `import { generated } from
// "./solarsql.generated.ts"`, and Node caches an ES module by its resolved
// URL for the rest of the process, with no cache-busting query on a
// relative import. A build that rewrites solarsql.generated.ts and then, in
// the same process, imports it for the first time still gets that write --
// but this test needs the module.ts *edit* built before db.run() below
// imports orders/public.ts for the first time in *this* process, and the
// build and the import cannot both be the "first time" in the same
// process. Building in a child process sidesteps it (measured while
// writing this test).
function buildInChildProcess(configPath: string): void {
  const result = spawnSync(process.execPath, [join(root, "src/build/cli.ts"), "build", configPath], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

// Fresh copies, not the checked-in example: the included-failure and
// outer-failure cases each need one extra assert that the committed shape
// (docs/adr/0127, "## Shape") does not carry.
function copyExample(): string {
  const dir = fixtureDir("solarsql-include-rollback-node-");
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  return dir;
}

function addIncludedFailure(dir: string): void {
  const file = join(dir, "example/modules/orders/module.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace(
    `  deleteByCustomer: {
    plan: [`,
    `  deleteByCustomer: {
    plan: [
      assert("no_confirmed_orders", "not exists (select 1 from orders where customer_id = :customer_id and status = 'confirmed')"),`,
  ));
}

function addOuterFailure(dir: string): void {
  const file = join(dir, "example/modules/customers/module.ts");
  const text = readFileSync(file, "utf8")
    .replace(`import { commands, queries, table }`, `import { assert, commands, queries, table }`)
    .replace(
      `plan: [orderCommands.deleteByCustomer, "delete from customers where id = :customer_id"],`,
      `plan: [orderCommands.deleteByCustomer, "delete from customers where id = :customer_id", assert("no_reserved_customer", "not exists (select 1 from customers where email = 'reserved@example.com')")],`,
    );
  writeFileSync(file, text);
}

// A fresh in-process database for one copy, migrated the way node.test.ts's
// own describe block does, with the copy's own module files imported by
// absolute path (a cache-busting query, since three copies run in one
// process).
async function open(dir: string): Promise<{ db: ReturnType<typeof node>; customerCommands: any; orderCommands: any }> {
  const { migrations } = (await import(`${join(dir, "example/migrations/index.ts")}?t=${Date.now()}-${Math.random()}`)) as { migrations: never };
  const raw = new DatabaseSync(":memory:");
  migrate(raw, migrations);
  const db = node(raw);
  const { customerCommands } = (await import(`${join(dir, "example/modules/customers/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never;
  const { orderCommands } = (await import(`${join(dir, "example/modules/orders/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never;
  return { db, customerCommands, orderCommands };
}

describe("ADR 0127: customers.remove includes orders.deleteByCustomer, on node:sqlite", () => {
  test("the happy path removes the customer, its orders, lines, and search rows", async (t) => {
    const dir = copyExample();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { db, customerCommands, orderCommands } = await open(dir);
    const { customerQueries } = (await import(`${join(dir, "example/modules/customers/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { customerQueries: any };
    const { orderQueries } = (await import(`${join(dir, "example/modules/orders/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { orderQueries: any };
    await db.run(customerCommands.create, { id: "c1", name: "Ann", email: "ann@example.com" } as never);
    await db.run(orderCommands.place, { id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] } as never);
    const removed = await db.run(customerCommands.remove, { customer_id: "c1" } as never);
    // changes: 7, not 4 -- fts5's own shadow-table bookkeeping for
    // order_search counts alongside the four statements' own deleted rows.
    assert.deepEqual(removed, { ok: true, rows: [], changes: 7 });
    assert.deepEqual(await db.all(customerQueries.all), []);
    assert.deepEqual(await db.all(orderQueries.byCustomer, { customer_id: "c1" } as never), []);
  });

  test("a failure inside the included command leaves the customer row in place", async (t) => {
    const dir = copyExample();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    addIncludedFailure(dir);
    buildInChildProcess(join(dir, "example/solarsql.config.ts"));
    const { db, customerCommands, orderCommands } = await open(dir);
    const { customerQueries } = (await import(`${join(dir, "example/modules/customers/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { customerQueries: any };
    const { orderQueries } = (await import(`${join(dir, "example/modules/orders/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { orderQueries: any };
    await db.run(customerCommands.create, { id: "c1", name: "Ann", email: "ann@example.com" } as never);
    await db.run(orderCommands.place, { id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] } as never);
    await db.run(orderCommands.confirm, { id: "o1" } as never);
    const removed = await db.run(customerCommands.remove, { customer_id: "c1" } as never);
    assert.deepEqual(removed, { ok: false, kind: "assert", assert: "no_confirmed_orders" });
    assert.deepEqual(await db.all(customerQueries.all), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
    assert.deepEqual(await db.all(orderQueries.byCustomer, { customer_id: "c1" } as never), [{ id: "o1", status: "confirmed" }]);
  });

  test("a failure in the including module's own part leaves the included part's rows in place too", async (t) => {
    const dir = copyExample();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    addOuterFailure(dir);
    buildInChildProcess(join(dir, "example/solarsql.config.ts"));
    const { db, customerCommands, orderCommands } = await open(dir);
    const { customerQueries } = (await import(`${join(dir, "example/modules/customers/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { customerQueries: any };
    const { orderQueries } = (await import(`${join(dir, "example/modules/orders/public.ts")}?t=${Date.now()}-${Math.random()}`)) as never as { orderQueries: any };
    await db.run(customerCommands.create, { id: "reserved", name: "Reserved", email: "reserved@example.com" } as never);
    await db.run(customerCommands.create, { id: "c1", name: "Ann", email: "ann@example.com" } as never);
    await db.run(orderCommands.place, { id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] } as never);
    const removed = await db.run(customerCommands.remove, { customer_id: "c1" } as never);
    assert.deepEqual(removed, { ok: false, kind: "assert", assert: "no_reserved_customer" });
    // Rolled back: the included command's deletes are undone too.
    assert.deepEqual(await db.all(customerQueries.all), [{ id: "c1", name: "Ann", email: "ann@example.com" }, { id: "reserved", name: "Reserved", email: "reserved@example.com" }]);
    assert.deepEqual(await db.all(orderQueries.byCustomer, { customer_id: "c1" } as never), [{ id: "o1", status: "draft" }]);
  });
});
