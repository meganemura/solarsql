// Spike: can the four dynamic-SQL needs be one static statement each, and
// what does the engine do with them? Optional filters, IN lists through
// json_each, a sort column chosen by a parameter, and paging.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  create table orders (id text primary key not null, customer_id text not null, status text not null, created_at integer not null);
  create index orders_customer on orders (customer_id);
  create index orders_status on orders (status);
`);
const insert = db.prepare("insert into orders values (?, ?, ?, ?)");
for (let i = 0; i < 5000; i++) insert.run(`o${i}`, `c${i % 50}`, i % 3 === 0 ? "draft" : "confirmed", i);

function plan(label: string, sql: string) {
  console.log(`\n[${label}]`);
  for (const r of db.prepare(`explain query plan ${sql}`).all()) console.log("  " + (r as { detail: string }).detail);
}

plan("optional filter, OR form", `select id from orders where (:customer is null or customer_id = :customer) and (:status is null or status = :status)`);
plan("optional filter, COALESCE form", `select id from orders where customer_id = coalesce(:customer, customer_id) and status = coalesce(:status, status)`);
plan("two static queries instead (customer only)", `select id from orders where customer_id = :customer`);
plan("IN list through json_each", `select id from orders where id in (select value from json_each(:ids))`);
plan("sort column by parameter", `select id from orders order by case :sort when 'created' then created_at when 'status' then status end`);
plan("paging", `select id from orders where customer_id = :customer order by created_at limit :limit offset :offset`);

console.log("\n[timing: 5000 rows, 1000 runs each]");
function time(label: string, sql: string, ...params: unknown[]) {
  const st = db.prepare(sql);
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 1000; i++) n += st.all(...(params as [])).length;
  console.log(`  ${label.padEnd(36)} ${((performance.now() - t0) / 1000).toFixed(3)} ms/run, rows=${n / 1000}`);
}
time("OR form, customer given", `select id from orders where (? is null or customer_id = ?) and (? is null or status = ?)`, "c7", "c7", null, null);
time("COALESCE form, customer given", `select id from orders where customer_id = coalesce(?, customer_id) and status = coalesce(?, status)`, "c7", null);
time("static query, customer given", `select id from orders where customer_id = ?`, "c7");
const ids = JSON.stringify(Array.from({ length: 200 }, (_, i) => `o${i * 7}`));
time("IN via json_each, 200 ids", `select id from orders where id in (select value from json_each(?))`, ids);
time("IN via 200 placeholders", `select id from orders where id in (${Array(200).fill("?").join(",")})`, ...Array.from({ length: 200 }, (_, i) => `o${i * 7}`));
