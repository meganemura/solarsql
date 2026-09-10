// Every statement of the generated file names the tables it reads (ADR
// 0041): the tables of the schema, reached directly, through a view or a
// trigger, or by a foreign key check; a view, json_each, pragma_*, and the
// guard table are not tables. The property: a FROM list over any tables of
// the schema reads exactly those tables, sorted, once each.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { Typer } from "../src/build/typegen.ts";
import { GUARD_DDL, assertStatement } from "../src/runtime/plan.ts";

const tables = ["audit", "customers", "orders"];
const ddl = [
  "create table customers (id text primary key not null, name text not null) strict",
  "create table orders (id text primary key not null, customer_id text not null references customers(id), status text not null) strict",
  "create table audit (id text primary key not null, note text) strict",
  "create view order_names as select o.id, c.name from orders o join customers c on c.id = o.customer_id",
  "create trigger orders_audit after insert on orders begin insert into audit (id, note) values (new.id, (select name from customers where id = new.customer_id)); end",
  "create virtual table order_search using fts5(status)",
  ...GUARD_DDL,
];
const typer = new Typer(new Engine(ddl), new Map());
const reads = (sql: string) => typer.analyze(sql, "m").reads;

describe("reads", () => {
  test("a select names its tables, sorted, once each", () => {
    assert.deepEqual(reads("select o.id, c.name from orders o join customers c on c.id = o.customer_id where o.status = :status"), ["customers", "orders"]);
    assert.deepEqual(reads("select cast(1 as integer) as x"), []);
  });

  test("a read through a view names the tables under the view, and not the view", () => {
    assert.deepEqual(reads("select id, name from order_names where id = :id"), ["customers", "orders"]);
  });

  test("json_each, a pragma function, and the guard table are not tables", () => {
    assert.deepEqual(reads("select id from orders where id in (select value from json_each(:ids))"), ["orders"]);
    assert.deepEqual(reads("select cast(name as text) as name from pragma_table_info('orders')"), []);
    assert.deepEqual(reads(assertStatement("has_orders", "select count(*) > 0 from orders")), ["orders"]);
  });

  test("a write names what the engine reads for it: a foreign key check and a trigger body", () => {
    assert.deepEqual(reads("insert into orders (id, customer_id, status) values (:id, :customer_id, 'new')"), ["customers", "orders"]);
    assert.deepEqual(reads("delete from customers where id = :id"), ["customers", "orders"]);
    assert.deepEqual(reads("insert into audit (id, note) values (:id, :note)"), []);
  });

  test("a search table is a table", () => {
    assert.deepEqual(reads("select status from order_search where order_search match :q"), ["order_search"]);
  });

  test("a FROM list over any tables reads exactly those tables, sorted, once each", () => {
    const list = gs.arrays(gs.sampledFrom(tables), { minSize: 1, maxSize: 5 });
    hegel.test((tc) => {
      const from = tc.draw(list);
      const sql = `select cast(1 as integer) as x from ${from.map((t, i) => `${t} a${i}`).join(", ")}`;
      assert.deepEqual(reads(sql), [...new Set(from)].sort());
    });
  });
});
