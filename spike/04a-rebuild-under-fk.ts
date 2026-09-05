// Spike: which table-rebuild order survives COMMIT when the table is a
// foreign-key parent and the migration runs inside one transaction?
// A D1 batch is one transaction, so PRAGMA foreign_keys cannot change inside
// it. Only defer_foreign_keys is available there.
import { DatabaseSync } from "node:sqlite";

function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table orders (id text primary key not null, status text not null check (status in ('draft', 'confirmed')));
    create table order_lines (id text primary key not null, order_id text not null references orders(id), qty integer not null);
    insert into orders values ('o1', 'draft'), ('o2', 'confirmed');
    insert into order_lines values ('l1', 'o1', 1), ('l2', 'o1', 2), ('l3', 'o2', 3);
  `);
  return db;
}

const newDef = `create table "_solarsql_new_orders" (id text primary key not null, status text not null check (status in ('draft', 'confirmed', 'shipped')))`;

function attempt(label: string, statements: string[]) {
  const db = fresh();
  console.log(`\n[${label}]`);
  console.log("  foreign_keys =", (db.prepare("pragma foreign_keys").get() as { foreign_keys: number }).foreign_keys);
  try {
    db.exec("begin");
    for (const s of statements) db.exec(s);
    db.exec("commit");
    const shape = db.prepare("select sql from sqlite_schema where name = 'orders'").get() as { sql: string };
    const fk = db.prepare("select sql from sqlite_schema where name = 'order_lines'").get() as { sql: string };
    const check = db.prepare("pragma foreign_key_check").all();
    console.log("  commit ok; orders rows =", (db.prepare("select count(*) as n from orders").get() as { n: number }).n,
      "; lines rows =", (db.prepare("select count(*) as n from order_lines").get() as { n: number }).n);
    console.log("  orders sql:", JSON.stringify(shape.sql));
    console.log("  order_lines sql:", JSON.stringify(fk.sql));
    console.log("  foreign_key_check:", JSON.stringify(check));
    try { db.exec("insert into order_lines values ('l9', 'nope', 1)"); console.log("  FK still enforced? NO (orphan insert accepted)"); }
    catch (e) { console.log("  FK still enforced? yes:", (e as Error).message); }
  } catch (e) {
    console.log("  FAILED:", (e as Error).message);
    try { db.exec("rollback"); } catch { /* transaction already closed */ }
  }
}

attempt("A. create new, copy, drop old, rename (no pragma)", [
  newDef,
  `insert into "_solarsql_new_orders" (id, status) select id, status from orders`,
  `drop table orders`,
  `alter table "_solarsql_new_orders" rename to orders`,
]);

attempt("B. same as A under defer_foreign_keys = on", [
  `pragma defer_foreign_keys = on`,
  newDef,
  `insert into "_solarsql_new_orders" (id, status) select id, status from orders`,
  `drop table orders`,
  `alter table "_solarsql_new_orders" rename to orders`,
]);

attempt("C. defer, create new, copy to temp, drop old, rename, insert back from temp", [
  `pragma defer_foreign_keys = on`,
  newDef,
  `create temp table "_solarsql_copy_orders" as select id, status from orders`,
  `drop table orders`,
  `alter table "_solarsql_new_orders" rename to orders`,
  `insert into orders (id, status) select id, status from "_solarsql_copy_orders"`,
  `drop table "_solarsql_copy_orders"`,
]);

attempt("D. pragma foreign_keys = off inside the transaction (expected no-op), then A", [
  `pragma foreign_keys = off`,
  newDef,
  `insert into "_solarsql_new_orders" (id, status) select id, status from orders`,
  `drop table orders`,
  `alter table "_solarsql_new_orders" rename to orders`,
]);

attempt("E. rename old away first, create new under the real name, copy, drop old", [
  `pragma defer_foreign_keys = on`,
  `alter table orders rename to "_solarsql_old_orders"`,
  newDef.replace('"_solarsql_new_orders"', "orders"),
  `insert into orders (id, status) select id, status from "_solarsql_old_orders"`,
  `drop table "_solarsql_old_orders"`,
]);
