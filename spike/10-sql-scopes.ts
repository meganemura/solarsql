// Responsibility: demonstrate SQL scope typing against populated SQLite tables.
// Boundary: this experiment prints evidence; the end-to-end test checks emitted types.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Engine } from "../src/build/facts.ts";
import { Typer } from "../src/build/typegen.ts";

export const stockSchema = {
  expected: "create table expected_stock (sku text primary key not null, qty integer not null) strict",
  actual: "create table actual_stock (sku text primary key not null, qty integer not null) strict",
  notes: "create table stock_notes (sku text primary key not null, note text not null) strict",
} as const;

export const stockSql = {
  filtered: `with stock(quantity) as (select qty from expected_stock) select quantity from stock where quantity >= :minimum`,
  literals: `values (1), ('counted'), (null)`,
  values: `select value from json_each('[1,"counted",null]')`,
  cte: `with expected(sku, qty) as (select sku, qty from expected_stock)
select sku, qty from expected order by sku`,
  reconciliation: `with expected as (select sku, qty from expected_stock),
actual as (select sku, qty from actual_stock)
select e.sku as expected_sku, e.qty as expected_qty,
       a.sku as actual_sku, a.qty as actual_qty
from expected e full outer join actual a on e.sku = a.sku
order by coalesce(e.sku, a.sku)`,
  observations: `select qty as observation from expected_stock
union all select note as observation from stock_notes`,
  details: `select e.sku,
  (select json_object('qty', a.qty) from actual_stock a where a.sku = e.sku) as actual
from expected_stock e order by e.sku`,
} as const;

export function populateStock(db: DatabaseSync): void {
  db.exec(`insert into expected_stock values ('A', 10), ('B', 20);
insert into actual_stock values ('A', 9), ('C', 30);
insert into stock_notes values ('A', 'counted');`);
}

export function demonstrateStockScopes(): void {
  const engine = new Engine(Object.values(stockSchema));
  try {
    populateStock(engine.db);
    const typer = new Typer(engine, new Map());
    for (const [name, sql] of Object.entries(stockSql)) {
      console.log(JSON.stringify({ name, sql, columns: typer.analyze(sql, "stock").columns, rows: engine.db.prepare(sql).all(name === "filtered" ? { minimum: 10 } : {}) }, null, 2));
    }
  } finally {
    engine.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) demonstrateStockScopes();
