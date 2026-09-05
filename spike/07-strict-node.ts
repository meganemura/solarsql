// Spike: what does a STRICT table guarantee, what does a plain table let
// through, and what does a runtime check of one row cost?
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  create table plain (id text primary key not null, n integer not null, r real, t text);
  create table strict_t (id text primary key not null, n integer not null, r real, t text) strict;
`);
function attempt(label: string, sql: string, ...params: unknown[]) {
  try {
    db.prepare(sql).run(...(params as []));
    const row = db.prepare(`select * from ${sql.includes("strict_t") ? "strict_t" : "plain"} order by rowid desc limit 1`).get();
    console.log(`  ${label.padEnd(42)} accepted -> ${JSON.stringify(row)} (typeof n = ${typeof (row as { n: unknown }).n})`);
  } catch (e) {
    console.log(`  ${label.padEnd(42)} rejected: ${(e as Error).message}`);
  }
}
console.log("## plain table");
attempt("text into integer column", "insert into plain values ('a', 'twelve', 1.5, 'x')", );
attempt("numeric text into integer column", "insert into plain values ('b', '12', 1.5, 'x')");
attempt("float into integer column", "insert into plain values ('c', 1.5, 1.5, 'x')");
attempt("integer into text column", "insert into plain values ('d', 1, 1.5, 42)");
attempt("blob into real column", "insert into plain values ('e', 1, x'00', 'x')");
console.log("## strict table");
attempt("text into integer column", "insert into strict_t values ('a', 'twelve', 1.5, 'x')");
attempt("numeric text into integer column", "insert into strict_t values ('b', '12', 1.5, 'x')");
attempt("float into integer column", "insert into strict_t values ('c', 1.5, 1.5, 'x')");
attempt("integer into text column", "insert into strict_t values ('d', 1, 1.5, 42)");
attempt("blob into real column", "insert into strict_t values ('e', 1, x'00', 'x')");
attempt("unknown declared type", "create table strict_bad (id text primary key not null, v varchar(10)) strict");
attempt("json text into text column", "insert into strict_t values ('f', 1, null, '{\"a\":1}')");

console.log("## cost of a runtime check per row (node, 100k rows)");
const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: `o${i}`, n: i, r: i / 2, t: i % 2 ? "x" : null }));
const shape: Record<string, "string" | "number" | "string?" | "number?"> = { id: "string", n: "number", r: "number?", t: "string?" };
function check(row: Record<string, unknown>): string | null {
  for (const [k, kind] of Object.entries(shape)) {
    const v = row[k];
    const optional = kind.endsWith("?");
    const base = optional ? kind.slice(0, -1) : kind;
    if (v === null || v === undefined) {
      if (!optional) return `${k} is null`;
      continue;
    }
    if (typeof v !== base) return `${k} is ${typeof v}, expected ${base}`;
  }
  return null;
}
let t0 = performance.now();
let bad = 0;
for (const r of rows) if (check(r)) bad++;
console.log(`  ${((performance.now() - t0) / rows.length * 1000).toFixed(1)} ns/row, bad=${bad}`);
