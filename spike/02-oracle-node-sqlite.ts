// Spike: can node:sqlite serve as the oracle for column origin (types) and
// table access (module boundaries)? StatementSync.columns() answers the first
// question. setAuthorizer() answers the second at prepare time.
import { DatabaseSync, constants } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  create table customers (
    id text primary key,
    name text not null
  );
  create table orders (
    id text primary key,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  );
  create table order_lines (
    id text primary key,
    order_id text not null references orders(id),
    qty integer not null check (qty > 0),
    price real
  );
  create view confirmed_orders as select id, customer_id from orders where status = 'confirmed';
  create table solarsql_assert (name text not null, ok integer not null);
  create trigger solarsql_assert_check before insert on solarsql_assert
    when new.ok = 0 begin select raise(abort, new.name); end;
`);

function section(title: string) {
  console.log(`\n## ${title}`);
}

function showColumns(label: string, sql: string) {
  console.log(`\n[${label}] ${sql.replace(/\s+/g, " ").trim()}`);
  try {
    const cols = db.prepare(sql).columns();
    for (const c of cols) console.log("  " + JSON.stringify(c));
  } catch (e) {
    console.log("  prepare failed: " + (e as Error).message);
  }
}

section("columns(): join across tables");
showColumns("join", `
  select o.id, o.status, c.name, o.note, o.id as order_id
  from orders o join customers c on c.id = o.customer_id`);

section("columns(): expression columns");
showColumns("expr", `
  select o.id, count(l.id) as n, sum(l.qty * l.price) as total,
         o.status || '!' as s, coalesce(o.note, '') as note2, upper(c.name) as uname,
         l.qty + 1 as qty1, l.qty as qty_plain, 42 as answer, ? as param
  from orders o join customers c on c.id = o.customer_id
  left join order_lines l on l.order_id = o.id
  group by o.id`);

section("columns(): left join (nullability is invisible here)");
showColumns("left join", `
  select o.id, l.id as line_id, l.qty
  from orders o left join order_lines l on l.order_id = o.id`);

section("columns(): json aggregation");
showColumns("json", `
  select o.id,
    coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty, 'price', l.price))
      filter (where l.id is not null), '[]') as lines
  from orders o left join order_lines l on l.order_id = o.id
  group by o.id`);

section("columns(): select * and CTE and view");
showColumns("star", `select * from order_lines`);
showColumns("cte", `with x as (select id, qty from order_lines) select x.id, x.qty, x.qty * 2 as d from x`);
showColumns("subquery", `select s.id, s.n from (select o.id, count(*) as n from orders o group by o.id) s`);
showColumns("view", `select id, customer_id from confirmed_orders`);
showColumns("returning", `insert into orders (id, customer_id, status) values (?, ?, 'draft') returning id, status, note`);
showColumns("union", `select id from orders union all select id from customers`);

section("pragma: declared facts per table");
for (const t of ["orders", "order_lines"]) {
  console.log(`\n[table_xinfo ${t}]`);
  for (const r of db.prepare(`pragma table_xinfo(${t})`).all()) console.log("  " + JSON.stringify(r));
  console.log(`[foreign_key_list ${t}]`);
  for (const r of db.prepare(`pragma foreign_key_list(${t})`).all()) console.log("  " + JSON.stringify(r));
}
console.log(`[sqlite_schema orders]`);
console.log("  " + JSON.stringify(db.prepare("select sql from sqlite_schema where name = 'orders'").get()));

section("setAuthorizer(): what prepare reports");
const codeName = new Map<number, string>();
for (const [k, v] of Object.entries(constants)) {
  if (/^SQLITE_(SELECT|READ|INSERT|UPDATE|DELETE|FUNCTION|CREATE_\w+|DROP_\w+|TRANSACTION|PRAGMA|RECURSIVE|SAVEPOINT|REINDEX|ANALYZE|ATTACH|DETACH|ALTER_TABLE|COPY)$/.test(k)) {
    codeName.set(v as number, k);
  }
}
console.log("known action codes:", [...codeName.values()].join(" "));

let log: string[] = [];
db.setAuthorizer((code: number, arg1: string | null, arg2: string | null, dbName: string | null, trigger: string | null) => {
  log.push(`${codeName.get(code) ?? code}(${[arg1, arg2, dbName, trigger].map((x) => JSON.stringify(x)).join(", ")})`);
  return constants.SQLITE_OK;
});

function showAuth(label: string, sql: string) {
  log = [];
  console.log(`\n[${label}] ${sql.replace(/\s+/g, " ").trim()}`);
  try {
    db.prepare(sql);
    for (const l of log) console.log("  " + l);
  } catch (e) {
    console.log("  prepare failed: " + (e as Error).message);
    for (const l of log) console.log("  " + l);
  }
}

showAuth("select join", `select o.id, c.name from orders o join customers c on c.id = o.customer_id where o.status = ?`);
showAuth("count(*)", `select count(*) from orders`);
showAuth("subquery other table", `select id from orders where customer_id in (select id from customers where name like ?)`);
showAuth("view", `select id from confirmed_orders`);
showAuth("insert", `insert into orders (id, customer_id, status) values (?, ?, 'draft')`);
showAuth("update", `update orders set status = 'confirmed', note = ? where id = ?`);
showAuth("delete", `delete from order_lines where order_id = ?`);
showAuth("assert insert (trigger body)", `insert into solarsql_assert (name, ok) select 'x', exists (select 1 from order_lines where order_id = ?)`);
showAuth("json aggregation", `select o.id, json_group_array(json_object('id', l.id)) as lines from orders o left join order_lines l on l.order_id = o.id group by o.id`);
showAuth("pragma", `pragma table_info(orders)`);
showAuth("create table (DDL)", `create table t2 (id integer primary key)`);

section("setAuthorizer(): deny a table read at prepare time");
db.setAuthorizer((code: number, arg1: string | null) => {
  if (code === constants.SQLITE_READ && arg1 === "customers") return constants.SQLITE_DENY;
  return constants.SQLITE_OK;
});
for (const sql of [
  `select o.id from orders o`,
  `select o.id, c.name from orders o join customers c on c.id = o.customer_id`,
  `select id from orders where customer_id in (select id from customers)`,
]) {
  try {
    db.prepare(sql);
    console.log(`  allowed: ${sql}`);
  } catch (e) {
    console.log(`  denied:  ${sql}\n           -> ${(e as Error).message}`);
  }
}

section("setAuthorizer(): prepare only, no execution");
let fired = 0;
db.setAuthorizer(() => { fired++; return constants.SQLITE_OK; });
const st = db.prepare(`select id from orders where id = ?`);
console.log(`  callbacks during prepare: ${fired}`);
fired = 0;
st.all("x");
console.log(`  callbacks during run of the prepared statement: ${fired}`);
db.setAuthorizer(null);
