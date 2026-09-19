// ADR 0127's own claim: a plan item may be another module's exported
// command, and the two run atomically. customers.remove includes orders'
// deleteByCustomer ahead of its own delete from customers (example/modules/
// customers/module.ts). This file runs that command for real, on D1 and on
// a Durable Object, and proves three things a single-batch shape gives for
// free: the happy path removes everything; a failure inside the included
// part leaves the customer row in place; a failure in the including
// module's own part leaves the included part's rows in place too (the
// mirror case), because the whole plan is one transaction.
// Boundary: local Miniflare evidence, the same as test/miniflare/example.test.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "../../src/build/build.ts";
import { splitStatements } from "../../src/build/scan.ts";
import { fixtureDir } from "../fixture-dir.ts";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

type Reply = { ok: true; value: unknown } | { ok: false; message: string; cause: string | null };
type Send = (body: Record<string, unknown>) => Promise<Reply>;

// fixtureDir() keeps the copy on the repository's own drive, the reason
// test/fixture-dir.ts gives: a relative specifier between the copy and
// src/ only resolves for both Node and tsc when the two sit on the same
// drive, which os.tmpdir() does not guarantee.
function copyExample(): string {
  const dir = realpathSync(fixtureDir("solarsql-include-rollback-"));
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  return dir;
}

// A failure inside deleteByCustomer's own statements: an assert that a
// seeded confirmed order violates. Only this copy's orders/module.ts carries
// it -- the committed shape (docs/adr/0127, "## Shape") has no assert here.
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

// A failure after customers.remove's own delete: an assert independent of
// the removed customer's own data, so it fails regardless of which id was
// passed -- the seed step below creates the row it checks for.
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

async function forEachTarget(dir: string, run: (send: Send, target: "d1" | "do") => Promise<void>): Promise<void> {
  for (const target of ["d1", "do"] as const) {
    // modulesRoot is the filesystem root, not `dir`: workerd's own sandbox
    // failed to start ("internal error", no further detail) against a
    // modulesRoot under the repository's .scratch/ directory, the same
    // workaround test/miniflare/adapter-values.test.ts uses for its own
    // fixture worker (measured while writing this test).
    const mf = workerMiniflare(join(dir, "example/worker.ts"), resolve("/"), { durableObjects: { STORE: "Store" } });
    try {
      if (target === "d1") {
        const migrationsDir = join(dir, "example/migrations");
        const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
        const db = await mf.getD1Database("DB");
        for (const f of files) await db.batch(splitStatements(readFileSync(join(migrationsDir, f), "utf8")).map((s) => db.prepare(s)));
      }
      const send: Send = async (body) => {
        const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`, { method: "POST", body: JSON.stringify(body) });
        return (await response.json()) as Reply;
      };
      await run(send, target);
    } finally {
      await mf.dispose();
    }
  }
}

function value(reply: Reply): unknown {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return (reply as { value: unknown }).value;
}

describe("ADR 0127: customers.remove includes orders.deleteByCustomer", () => {
  test("the happy path removes the customer, its orders, lines, and search rows", async () => {
    const dir = copyExample();
    try {
      await forEachTarget(dir, async (send) => {
        assert.deepEqual(value(await send({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" })), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }], changes: 1 });
        assert.equal((value(await send({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] })) as { ok: boolean }).ok, true);
        // changes: 7, not 4 -- fts5's own shadow-table bookkeeping for
        // order_search counts alongside the four statements' own deleted
        // rows (measured; also 7 on node:sqlite, test/include-command-rollback.test.ts).
        assert.deepEqual(value(await send({ step: "removeCustomer", id: "c1" })), { ok: true, rows: [], changes: 7 });
        assert.deepEqual(value(await send({ step: "customers" })), []);
        assert.deepEqual(value(await send({ step: "ordersOf", customer_id: "c1" })), []);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failure inside the included command leaves the customer row in place", async () => {
    const dir = copyExample();
    addIncludedFailure(dir);
    await build(join(dir, "example/solarsql.config.ts"));
    try {
      await forEachTarget(dir, async (send) => {
        assert.deepEqual(value(await send({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" })), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }], changes: 1 });
        assert.equal((value(await send({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] })) as { ok: boolean }).ok, true);
        // changes: 2, not 1 -- orders_touch (an AFTER UPDATE trigger) counts
        // alongside the command's own UPDATE (pinned the same way in
        // test/example-steps.ts's own "a plan can assert" case).
        assert.deepEqual(value(await send({ step: "confirm", id: "o1" })), { ok: true, rows: [{ id: "o1", customer_id: "c1", status: "confirmed", note: null }], changes: 2 });
        assert.deepEqual(value(await send({ step: "removeCustomer", id: "c1" })), { ok: false, kind: "assert", assert: "no_confirmed_orders" });
        // Rolled back: the customer, and its order, are still there.
        assert.deepEqual(value(await send({ step: "customers" })), [{ id: "c1", name: "Ann", email: "ann@example.com" }]);
        assert.deepEqual(value(await send({ step: "ordersOf", customer_id: "c1" })), [{ id: "o1", status: "confirmed" }]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failure in the including module's own part leaves the included part's rows in place too", async () => {
    const dir = copyExample();
    addOuterFailure(dir);
    await build(join(dir, "example/solarsql.config.ts"));
    try {
      await forEachTarget(dir, async (send) => {
        assert.deepEqual(value(await send({ step: "createCustomer", id: "reserved", name: "Reserved", email: "reserved@example.com" })), { ok: true, rows: [{ id: "reserved", name: "Reserved", email: "reserved@example.com" }], changes: 1 });
        assert.deepEqual(value(await send({ step: "createCustomer", id: "c1", name: "Ann", email: "ann@example.com" })), { ok: true, rows: [{ id: "c1", name: "Ann", email: "ann@example.com" }], changes: 1 });
        assert.equal((value(await send({ step: "placeOrder", id: "o1", customer_id: "c1", lines: [{ id: "l1", sku: "A", qty: 1, price: 1 }] })) as { ok: boolean }).ok, true);
        assert.deepEqual(value(await send({ step: "removeCustomer", id: "c1" })), { ok: false, kind: "assert", assert: "no_reserved_customer" });
        // Rolled back: the included command's deletes are undone too, even
        // though they ran, and reported no failure, before the outer assert.
        assert.deepEqual(value(await send({ step: "customers" })), [{ id: "c1", name: "Ann", email: "ann@example.com" }, { id: "reserved", name: "Reserved", email: "reserved@example.com" }]);
        assert.deepEqual(value(await send({ step: "ordersOf", customer_id: "c1" })), [{ id: "o1", status: "draft" }]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
