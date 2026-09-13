// A generated migration file must run on D1 the way wrangler runs it locally:
// split into statements and sent as one batch. (Remotely D1 splits the file
// on its own server side; ADR 0036 records what that changed.) This file generates two migrations
// from declared DDL with node:sqlite, applies them to the local D1 engine, and
// checks the shape, the rows, and the constraints after a table rebuild.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { D1Harness, type WorkerOk } from "./d1.ts";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";

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
