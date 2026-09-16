// A generated migration file must run on D1 the way wrangler runs it locally:
// split into statements and sent as one batch. (Remotely D1 splits the file
// on its own server side; ADR 0036 records what that changed.) This file generates two migrations
// from declared DDL with node:sqlite, applies them to the local D1 engine, and
// checks the shape, the rows, and the constraints after a table rebuild.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { D1Harness, type WorkerError, type WorkerOk } from "./d1.ts";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";
import { constraintFailure } from "../src/runtime/plan.ts";

const v1 = [
  `create table customers (id text primary key not null, name text not null)`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed'))
  )`,
  `create table order_lines (
    id text primary key not null,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0)
  )`,
  `create index order_lines_order_id on order_lines (order_id)`,
];

const v2 = [
  v1[0]!,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed', 'shipped')),
    note text
  )`,
  `create table order_lines (
    id text primary key not null,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0),
    price real not null default 0
  )`,
  `create unique index order_lines_order_id_sku on order_lines (order_id, sku)`,
];

function generate(files: string[], declared: string[], sequence: number, name: string): string {
  const plan = diff(introspect(applied(files)), introspect(open(declared)));
  assert.equal(plan.kind, "ok", JSON.stringify(plan));
  if (plan.kind !== "ok") throw new Error("unreachable");
  return render(sequence, name, plan.statements).sql;
}

function rows(reply: WorkerOk): Record<string, unknown>[] {
  return (reply.results as { results: Record<string, unknown>[] }).results;
}

describe("D1 applies generated migrations", () => {
  const d1 = new D1Harness();
  const file1 = generate([], v1, 1, "initial");
  const file2 = generate([file1], v2, 2, "add_note_and_price");

  before(async () => {
    const reply = await d1.batch(splitStatements(file1).map((sql) => ({ sql })));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const seed = await d1.batch([
      { sql: "insert into customers values ('c1', 'Ann')" },
      { sql: "insert into orders values ('o1', 'c1', 'draft'), ('o2', 'c1', 'confirmed')" },
      { sql: "insert into order_lines values ('l1', 'o1', 'A', 1), ('l2', 'o2', 'B', 2)" },
    ]);
    assert.equal(seed.ok, true, JSON.stringify(seed));
  });

  after(async () => {
    await d1.dispose();
  });

  test("the second file rebuilds orders inside one batch", async () => {
    const reply = await d1.batch(splitStatements(file2).map((sql) => ({ sql })));
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  test("the shape after the migration matches the declaration", async () => {
    const orders = await d1.all("pragma table_info(orders)");
    assert.equal(orders.ok, true, JSON.stringify(orders));
    const names = rows(orders as WorkerOk).map((r) => r.name);
    assert.deepEqual(names, ["id", "customer_id", "status", "note"]);

    const lines = await d1.all("pragma table_info(order_lines)");
    assert.deepEqual(rows(lines as WorkerOk).map((r) => r.name), ["id", "order_id", "sku", "qty", "price"]);

    const indexes = await d1.all("pragma index_list(order_lines)");
    if (indexes.ok) {
      assert.deepEqual(rows(indexes).filter((r) => r.origin === "c").map((r) => [r.name, r.unique]), [["order_lines_order_id_sku", 1]]);
    }
  });

  test("rows survive the rebuild", async () => {
    const orders = await d1.all("select * from orders order by id");
    assert.deepEqual(rows(orders as WorkerOk), [
      { id: "o1", customer_id: "c1", status: "draft", note: null },
      { id: "o2", customer_id: "c1", status: "confirmed", note: null },
    ]);
    const lines = await d1.all("select id, order_id, price from order_lines order by id");
    assert.deepEqual(rows(lines as WorkerOk), [
      { id: "l1", order_id: "o1", price: 0 },
      { id: "l2", order_id: "o2", price: 0 },
    ]);
  });

  test("foreign keys, the new CHECK, and the unique index hold after the rebuild", async () => {
    const orphan = await d1.run("insert into order_lines values ('l9', 'nope', 'Z', 1, 0)");
    assert.equal(orphan.ok, false);
    assert.match((orphan as { message: string }).message, /FOREIGN KEY/);

    const shipped = await d1.run("update orders set status = 'shipped' where id = 'o1'");
    assert.equal(shipped.ok, true, JSON.stringify(shipped));
    const lost = await d1.run("update orders set status = 'lost' where id = 'o1'");
    assert.equal(lost.ok, false);
    assert.match((lost as { message: string }).message, /CHECK/);

    const duplicate = await d1.run("insert into order_lines values ('l3', 'o1', 'A', 1, 0)");
    assert.equal(duplicate.ok, false);
    assert.match((duplicate as { message: string }).message, /UNIQUE/);
  });

  test("a third diff against the declaration is empty on the node:sqlite side", () => {
    const plan = diff(introspect(applied([file1, file2])), introspect(open(v2)));
    assert.deepEqual(plan, { kind: "ok", statements: [] });
  });
});

// Pinning test, not a regression test: it records what D1's own batch API
// does today with a rebuild that carries `pragma defer_foreign_keys = on`,
// so a future change in that behavior shows up here. The pragma defers the
// rebuild's own foreign-key check past the statements this test can send
// and inspect individually, to D1's own end-of-batch commit -- a platform
// commit the caller does not control, unlike a SQLite COMMIT. A violation
// surfacing there reaches the caller as an opaque platform message, not
// SQLite's own "FOREIGN KEY constraint failed" text, so constraintFailure()
// (src/runtime/plan.ts) cannot classify it. The pragma itself stays: it is
// correct SQLite and Node and a Durable Object both need it.
describe("D1's own end-of-batch commit turns a deferred foreign-key violation opaque", () => {
  const fkBefore = [
    `create table customers (id integer primary key)`,
    `create table orders (id text primary key not null, customer_id integer)`,
  ];
  const fkAfter = [
    `create table customers (id integer primary key)`,
    `create table orders (id text primary key not null, customer_id integer references customers(id))`,
  ];

  function generateFk(): string {
    const plan = diff(introspect(open(fkBefore)), introspect(open(fkAfter)));
    assert.equal(plan.kind, "ok", JSON.stringify(plan));
    if (plan.kind !== "ok") throw new Error("unreachable");
    return render(2, "add-customer-fk", plan.statements).sql;
  }

  test("with no orphaned row, the pragma-carrying rebuild applies cleanly", async (t) => {
    const d1 = new D1Harness();
    t.after(() => d1.dispose());
    const seed = await d1.batch(splitStatements(`${fkBefore.join(";\n")};`).map((sql) => ({ sql })));
    assert.equal(seed.ok, true, JSON.stringify(seed));
    const rows = await d1.batch([
      { sql: "insert into customers values (1)" },
      { sql: "insert into orders values ('a', 1)" },
    ]);
    assert.equal(rows.ok, true, JSON.stringify(rows));
    const reply = await d1.batch(splitStatements(generateFk()).map((sql) => ({ sql })));
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  test("with the pragma line removed, the same orphaned row classifies as a foreign-key failure", async (t) => {
    const d1 = new D1Harness();
    t.after(() => d1.dispose());
    const seed = await d1.batch(splitStatements(`${fkBefore.join(";\n")};`).map((sql) => ({ sql })));
    assert.equal(seed.ok, true, JSON.stringify(seed));
    const orphan = await d1.batch([{ sql: "insert into orders values ('a', 999)" }]);
    assert.equal(orphan.ok, true, JSON.stringify(orphan));
    const withoutPragma = splitStatements(generateFk()).filter((sql) => !sql.includes("defer_foreign_keys"));
    const reply = await d1.batch(withoutPragma.map((sql) => ({ sql })));
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.deepEqual(constraintFailure(reply), { kind: "foreign_key" });
  });

  test("with the pragma line in place, the same orphaned row rejects with an opaque platform message, and the batch rolls back", async (t) => {
    const d1 = new D1Harness();
    t.after(() => d1.dispose());
    const seed = await d1.batch(splitStatements(`${fkBefore.join(";\n")};`).map((sql) => ({ sql })));
    assert.equal(seed.ok, true, JSON.stringify(seed));
    const orphan = await d1.batch([{ sql: "insert into orders values ('a', 999)" }]);
    assert.equal(orphan.ok, true, JSON.stringify(orphan));
    const reply = await d1.batch(splitStatements(generateFk()).map((sql) => ({ sql })));
    assert.equal(reply.ok, false, JSON.stringify(reply));
    // Measured on Miniflare's D1 binding on 2026-09-17: reply.name is
    // "Error" (workerd's own JS Error, not a named D1 error class), and the
    // message is the platform's reset text prefixed onto SQLite's own
    // constraint text, not SQLite's text alone. constraintFailure() still
    // can't classify it: bareMessage() strips only a known `D1_ERROR:`
    // prefix, not this one. Cloudflare may rename or reword this; that
    // drift is what this assertion pins down. It is a supporting check,
    // not the main one below.
    assert.equal((reply as WorkerError).name, "Error");
    assert.match((reply as WorkerError).message, /Durable Object was reset and rolled back/);
    // The main assertion: constraintFailure() cannot classify this message,
    // so a caller sees an unclassified throw instead of the structured
    // { ok: false, kind: "foreign_key" } that the pragma-free case above
    // gets (src/d1.ts's run() falls back to `throw e` in exactly this case).
    assert.equal(constraintFailure(reply), null);

    const schema = await d1.all("select sql from sqlite_schema where name = 'orders'");
    assert.equal(schema.ok, true, JSON.stringify(schema));
    const stored = (rows(schema as WorkerOk)[0] as { sql: string }).sql;
    assert.equal(stored.toLowerCase(), fkBefore[1]!.toLowerCase());
  });
});

test('D1 rebuilds retain the AUTOINCREMENT history after a deleted maximum', async t => {
  const d1=new D1Harness();
  t.after(()=>d1.dispose());
  const ddl='create table identities(id integer primary key autoincrement,value text) strict';
  const db=open([ddl]),target=open([ddl.replace('value text','value text not null')]);
  try {
    const plan=diff(introspect(db),introspect(target));
    if(plan.kind!=='ok')throw new Error(plan.reason);
    const seed=await d1.batch([ddl,"insert into identities values(100,'removed')",'delete from identities',"insert into identities values(1,'kept')"].map(sql=>({sql})));
    assert.equal(seed.ok,true,JSON.stringify(seed));
    const changed=await d1.batch(plan.statements.map(sql=>({sql})));
    assert.equal(changed.ok,true,JSON.stringify(changed));
    const next=await d1.all("insert into identities(value) values('next') returning id");
    assert.equal(next.ok,true,JSON.stringify(next));
    assert.deepEqual(rows(next as WorkerOk),[{id:101}]);
  }finally{db.close();target.close();}
});

test('focused D1 execution exits without a runtime for skipped suites', () => {
  const child=spawnSync(process.execPath,['--test','--test-name-pattern=D1 rebuilds retain',import.meta.filename],{encoding:'utf8',timeout:20_000});
  assert.equal(child.status,0,child.stdout+child.stderr+String(child.error??''));
});

test('D1 harness disposal is idempotent before and after first use', async () => {
  const unused=new D1Harness();
  const first=unused.dispose();
  assert.equal(unused.dispose(),first);
  await first;
  assert.throws(()=>unused.mf,/disposed/);
  const used=new D1Harness();
  try {assert.equal((await used.all('select 1')).ok,true);}
  finally {const closed=used.dispose();assert.equal(used.dispose(),closed);await closed;}
  await assert.rejects(used.all('select 1'),/disposed/);
});
