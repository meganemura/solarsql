// A D1 batch is one transaction. A command needs a way to make the whole
// batch fail when a precondition is false, because the statements are sent
// before any result comes back. This file measures one mechanism: a guard
// table with one BEFORE INSERT trigger that calls raise(abort, name).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { D1Harness, type WorkerOk } from "./d1.ts";

// D1 exec() splits its input on newlines, so a multi-line CREATE cannot go
// through it. The schema goes through batch() as one statement per entry.
const ddl = [
  `create table orders (
    id text primary key,
    status text not null check (status in ('draft', 'confirmed'))
  )`,
  `create table order_lines (
    id text primary key,
    order_id text not null references orders(id),
    qty integer not null check (qty > 0)
  )`,
  `create table solarsql_assert (name text not null, ok integer not null)`,
  `create trigger solarsql_assert_check before insert on solarsql_assert
    when new.ok = 0
  begin
    select raise(abort, new.name);
  end`,
];

function rows(reply: WorkerOk): Record<string, unknown>[] {
  return (reply.results as { results: Record<string, unknown>[] }).results;
}

describe("D1 batch with a guard table", () => {
  const d1 = new D1Harness();

  before(async () => {
    const reply = await d1.batch(ddl.map((sql) => ({ sql })));
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  after(async () => {
    await d1.dispose();
  });

  test("a false precondition rolls back the whole batch", async () => {
    const reply = await d1.batch([
      { sql: "insert into orders (id, status) values ('o1', 'draft')" },
      {
        sql: "insert into solarsql_assert (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = ?)",
        params: ["o1"],
      },
      { sql: "update orders set status = 'confirmed' where id = 'o1'" },
    ]);
    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.match(reply.message, /not_confirmable/);

    const count = await d1.first("select count(*) as n from orders");
    assert.equal(count.ok, true);
    assert.deepEqual((count as WorkerOk).results, { n: 0 });
  });

  test("a true precondition lets the batch commit", async () => {
    const reply = await d1.batch([
      { sql: "insert into orders (id, status) values ('o2', 'draft')" },
      { sql: "insert into order_lines (id, order_id, qty) values ('l1', 'o2', 2)" },
      {
        sql: "insert into solarsql_assert (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = ?)",
        params: ["o2"],
      },
      { sql: "update orders set status = 'confirmed' where id = 'o2'" },
    ]);
    assert.equal(reply.ok, true, JSON.stringify(reply));

    const status = await d1.first("select status from orders where id = 'o2'");
    assert.deepEqual((status as WorkerOk).results, { status: "confirmed" });
  });

  test("a statement reads the write of the statement before it", async () => {
    const reply = await d1.batch([
      { sql: "insert into orders (id, status) values ('o3', 'draft')" },
      {
        sql: "insert into solarsql_assert (name, ok) select 'order_visible', exists (select 1 from orders where id = 'o3')",
      },
    ]);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  test("changes() of the previous statement feeds an assert", async () => {
    const first = await d1.batch([
      { sql: "insert into orders (id, status) values ('o4', 'draft')" },
      { sql: "update orders set status = 'confirmed' where id = 'o4' and status = 'draft'" },
      { sql: "insert into solarsql_assert (name, ok) select 'one_row_updated', changes() = 1" },
    ]);
    assert.equal(first.ok, true, JSON.stringify(first));

    const second = await d1.batch([
      { sql: "update orders set status = 'confirmed' where id = 'o4' and status = 'draft'" },
      { sql: "insert into solarsql_assert (name, ok) select 'one_row_updated', changes() = 1" },
    ]);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.match(second.message, /one_row_updated/);
  });

  test("the same batch through getD1Database() also rolls back", async () => {
    const db = await d1.mf.getD1Database("DB");
    await assert.rejects(
      db.batch([
        db.prepare("insert into orders (id, status) values ('o5', 'draft')"),
        db
          .prepare(
            "insert into solarsql_assert (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = ?)",
          )
          .bind("o5"),
      ]),
      (e: unknown) => {
        return /not_confirmable/.test((e as Error).message);
      },
    );
    const row = await db.prepare("select count(*) as n from orders where id = 'o5'").first<{ n: number }>();
    assert.deepEqual(row, { n: 0 });
  });
});
