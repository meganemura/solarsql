// Spike runner: declared DDL versus applied migrations, three rounds.
//   v1: initial schema -> 0001 (all CREATE)
//   v2: add a column (cheap ALTER), widen a CHECK (rebuild), change an index
//   v3: rename a column without a declaration (blocked), then with one
// Each round applies the generated file to the "applied" database with rows
// in it and compares the resulting shape to the declared shape.
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render, shape, splitStatements, type Rename } from "./migration.ts";

const v1 = [
  `create table customers (
    id text primary key not null,
    name text not null
  )`,
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

const v3 = [
  v2[0]!,
  v2[1]!.replace("note text", "memo text"),
  v2[2]!,
  v2[3]!,
];

const files: string[] = [];
let sequence = 0;

function round(label: string, declared: string[], renames: Rename[] = []) {
  console.log(`\n## ${label}`);
  const current = introspect(applied(files));
  const targetDb = open(declared);
  const target = introspect(targetDb);
  const plan = diff(current, target, renames);
  if (plan.kind === "blocked") {
    console.log("  BLOCKED:", plan.reason);
    return;
  }
  const file = render(++sequence, label.split(" ")[0]!, plan.statements);
  console.log(`  ${file.filename}`);
  console.log(file.sql.split("\n").map((l) => "    " + l).join("\n"));
  files.push(file.sql);

  // Round trip: applied files -> same shape as the declaration.
  const after = introspect(applied(files));
  const same = JSON.stringify(shape(after)) === JSON.stringify(shape(target));
  console.log(`  round trip equal: ${same}`);
  if (!same) {
    console.log("  applied:", JSON.stringify(shape(after), null, 1));
    console.log("  target: ", JSON.stringify(shape(target), null, 1));
  }
  assert.equal(same, true);
  // Idempotence: a second diff is empty.
  const again = diff(after, target, []);
  assert.deepEqual(again, { kind: "ok", statements: [] });
  console.log(`  second diff empty: true`);
  console.log(`  statements when split as wrangler does: ${splitStatements(file.sql).length}`);
}

round("v1 initial", v1);

// Rows must survive the rebuild in v2, so the applied database gets data
// through the same file list plus a data file.
const seed = `insert into customers values ('c1', 'Ann');
insert into orders values ('o1', 'c1', 'draft'), ('o2', 'c1', 'confirmed');
insert into order_lines values ('l1', 'o1', 'A', 1), ('l2', 'o2', 'B', 2);`;
files.push(seed);

round("v2 add-column-and-widen-check", v2);
{
  const db = applied(files);
  const orders = db.prepare("select * from orders order by id").all();
  const lines = db.prepare("select * from order_lines order by id").all();
  console.log("  rows after rebuild:", JSON.stringify(orders), JSON.stringify(lines));
  assert.equal(orders.length, 2);
  assert.equal(lines.length, 2);
  assert.throws(() => db.exec("insert into order_lines values ('l9', 'nope', 'Z', 1, 0)"), /FOREIGN KEY/);
  db.exec("update orders set status = 'shipped' where id = 'o1'");
  assert.throws(() => db.exec("update orders set status = 'lost' where id = 'o1'"), /CHECK/);
  console.log("  foreign keys and the new CHECK hold after the rebuild: true");
}

round("v3 rename-without-declaration", v3);
round("v3 rename-declared", v3, [{ table: "orders", from: "note", to: "memo" }]);
