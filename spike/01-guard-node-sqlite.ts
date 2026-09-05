// Spike: can a guard row make a whole SQLite transaction fail on a false precondition?
// This runs on node:sqlite only. It settles the SQL mechanics before the same
// statements run inside a D1 batch in Miniflare.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const version = db.prepare("select sqlite_version() as v").get() as { v: string };
console.log("sqlite_version", version.v);

db.exec(`
  create table orders (
    id text primary key,
    status text not null check (status in ('draft', 'confirmed'))
  );
  create table order_lines (
    id text primary key,
    order_id text not null references orders(id),
    qty integer not null check (qty > 0)
  );
`);

function attempt(label: string, body: () => void) {
  try {
    body();
    console.log(`[${label}] no error`);
  } catch (e) {
    const err = e as Error & { code?: string; errcode?: number; errstr?: string };
    console.log(`[${label}] error message=${JSON.stringify(err.message)} code=${err.code} errcode=${err.errcode} errstr=${err.errstr}`);
  }
}

// A. Generic guard table with a trigger. Does raise() accept an expression (new.name)?
attempt("A.create trigger with raise(abort, new.name)", () => {
  db.exec(`
    create table assert_a (name text not null, ok integer not null);
    create trigger assert_a_check before insert on assert_a
      when new.ok = 0
    begin
      select raise(abort, new.name);
    end;
  `);
});

// A2. Same, but the message is a string literal (always accepted by the grammar).
attempt("A2.create trigger with raise(abort, 'literal')", () => {
  db.exec(`
    create table assert_a2 (name text not null, ok integer not null);
    create trigger assert_a2_check before insert on assert_a2
      when new.ok = 0
    begin
      select raise(abort, 'assert failed');
    end;
  `);
});

// B. Named CHECK constraint. Does the name appear in the error text?
attempt("B.create named check", () => {
  db.exec(`
    create table assert_b (name text not null, ok integer not null,
      constraint not_confirmable check (ok = 1));
  `);
});

// Transaction: insert order, then guard reads the just-inserted row through a subquery.
function runTransaction(label: string, statements: string[]) {
  db.exec("begin");
  try {
    for (const s of statements) db.prepare(s).run();
    db.exec("commit");
    console.log(`[${label}] committed`);
  } catch (e) {
    const err = e as Error & { code?: string; errcode?: number };
    console.log(`[${label}] error message=${JSON.stringify(err.message)} code=${err.code} errcode=${err.errcode}`);
    try { db.exec("rollback"); console.log(`[${label}] explicit rollback ok`); }
    catch (e2) { console.log(`[${label}] explicit rollback failed: ${(e2 as Error).message}`); }
  }
  const count = (db.prepare("select count(*) as n from orders").get() as { n: number }).n;
  console.log(`[${label}] orders rows after = ${count}`);
}

// A-path: trigger with expression message, precondition false (no lines) -> should abort.
if (db.prepare("select count(*) as n from sqlite_schema where name = 'assert_a'").get()!.n === 1) {
  runTransaction("A.false precondition", [
    "insert into orders (id, status) values ('o1', 'draft')",
    "insert into assert_a (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = 'o1')",
    "update orders set status = 'confirmed' where id = 'o1'",
  ]);
  // A-path: precondition true (a line exists) -> should commit.
  runTransaction("A.true precondition", [
    "insert into orders (id, status) values ('o1', 'draft')",
    "insert into order_lines (id, order_id, qty) values ('l1', 'o1', 2)",
    "insert into assert_a (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = 'o1')",
    "update orders set status = 'confirmed' where id = 'o1'",
  ]);
  db.exec("delete from order_lines; delete from orders; delete from assert_a;");
}

// A2-path: literal message.
runTransaction("A2.false precondition", [
  "insert into orders (id, status) values ('o2', 'draft')",
  "insert into assert_a2 (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = 'o2')",
]);

// B-path: named CHECK.
runTransaction("B.false precondition", [
  "insert into orders (id, status) values ('o3', 'draft')",
  "insert into assert_b (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = 'o3')",
]);

// C. raise(rollback, ...) instead of abort. Does the transaction end by itself?
attempt("C.create trigger with raise(rollback, new.name)", () => {
  db.exec(`
    create table assert_c (name text not null, ok integer not null);
    create trigger assert_c_check before insert on assert_c
      when new.ok = 0
    begin
      select raise(rollback, new.name);
    end;
  `);
});
runTransaction("C.false precondition (raise rollback)", [
  "insert into orders (id, status) values ('o4', 'draft')",
  "insert into assert_c (name, ok) select 'not_confirmable', exists (select 1 from order_lines where order_id = 'o4')",
]);

// D. Does a subquery in statement 2 see the write of statement 1 inside the same transaction?
runTransaction("D.read own write", [
  "insert into orders (id, status) values ('o5', 'draft')",
  "insert into assert_a2 (name, ok) select 'order_visible', exists (select 1 from orders where id = 'o5')",
]);
db.exec("delete from orders");

// E. Is `changes()` usable as an assert input in the next statement (rows affected by the previous update)?
db.exec("insert into orders (id, status) values ('o6', 'draft')");
runTransaction("E.changes() of previous statement", [
  "update orders set status = 'confirmed' where id = 'o6' and status = 'draft'",
  "insert into assert_a2 (name, ok) select 'one_row_updated', changes() = 1",
]);
runTransaction("E2.changes() when previous update matched nothing", [
  "update orders set status = 'confirmed' where id = 'o6' and status = 'draft'",
  "insert into assert_a2 (name, ok) select 'one_row_updated', changes() = 1",
]);
