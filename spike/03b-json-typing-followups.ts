// Spike follow-ups for JSON typing:
//   a. Does CAST give expression columns a declared type through CTAS?
//   b. Is a TEXT PRIMARY KEY nullable in SQLite's eyes (table_xinfo.notnull)?
//   c. Does EXPLAIN QUERY PLAN tag the right alias in a self-join?
//   d. End to end: derive a TypeScript type string for the JSON column.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  create table customers (id text primary key, name text not null);
  create table orders (
    id text primary key,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  );
  create table order_lines (
    id text primary key,
    order_id text not null references orders(id),
    qty integer not null,
    price real
  );
  create table tags (id text primary key not null, label text not null) without rowid;
  create table tags2 (id text primary key, label text not null) without rowid;
`);

console.log("## a. CAST as the type annotation for expression columns (CTAS affinity)");
db.exec(`create temp table probe_cast as
  select cast(count(l.id) as integer) as n, cast(sum(l.qty * l.price) as real) as total,
         cast(o.status || '!' as text) as s, cast(coalesce(o.note, '') as text) as note2,
         cast(l.id is not null as integer) as has_line, count(l.id) as n_raw
  from orders o left join order_lines l on l.order_id = o.id group by o.id limit 0`);
for (const r of db.prepare("pragma table_xinfo(probe_cast)").all()) {
  const row = r as { name: string; type: string };
  console.log(`  ${row.name.padEnd(9)} type=${JSON.stringify(row.type)}`);
}
console.log("  columns() of the same select:");
for (const c of db.prepare(`select cast(count(l.id) as integer) as n, cast(l.price as text) as p from orders o left join order_lines l on l.order_id = o.id`).columns()) {
  console.log("  " + JSON.stringify(c));
}

console.log("\n## b. notnull of primary key columns");
for (const t of ["orders", "tags", "tags2"]) {
  const row = db.prepare(`select name, type, "notnull" as nn, pk from pragma_table_xinfo(?) where pk = 1`).get(t);
  console.log(`  ${t.padEnd(7)} ${JSON.stringify(row)}`);
}
try { db.exec(`insert into orders (id, customer_id, status) values (null, 'c', 'draft')`); console.log("  insert null into orders.id (rowid table, text pk): accepted"); }
catch (e) { console.log("  insert null into orders.id: " + (e as Error).message); }
try { db.exec(`insert into tags2 (id, label) values (null, 'x')`); console.log("  insert null into tags2.id (without rowid): accepted"); }
catch (e) { console.log("  insert null into tags2.id (without rowid): " + (e as Error).message); }

console.log("\n## c. EXPLAIN QUERY PLAN with a self-join (orders o left join orders p)");
const selfJoin = `select o.id, p.id as parent, p.status as parent_status, l.qty
  from orders o left join orders p on p.id = o.parent_id join order_lines l on l.order_id = o.id`;
for (const r of db.prepare(`explain query plan ${selfJoin}`).all()) console.log("  " + JSON.stringify((r as { detail: string }).detail));
console.log("  columns():");
for (const c of db.prepare(selfJoin).columns()) console.log("  " + JSON.stringify(c));

// Alias map from a lexer-level scan of FROM/JOIN clauses: `<table> [as] <alias>`.
function aliasMap(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  const keywords = new Set(["on", "where", "group", "order", "left", "inner", "join", "cross", "natural", "using", "limit"]);
  for (const m of sql.matchAll(re)) {
    const table = m[1]!;
    const alias = m[2] && !keywords.has(m[2].toLowerCase()) ? m[2] : table;
    map.set(alias, table);
  }
  return map;
}
function nullableAliases(sql: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare(`explain query plan ${sql}`).all()) {
    const d = (r as { detail: string }).detail;
    const m = /^(?:SCAN|SEARCH)\s+([A-Za-z_][A-Za-z0-9_]*)\b.*\bLEFT-JOIN\b/.exec(d);
    if (m) out.add(m[1]!);
  }
  return out;
}
console.log("  alias map:", JSON.stringify([...aliasMap(selfJoin)]));
console.log("  nullable aliases from EQP:", JSON.stringify([...nullableAliases(selfJoin)]));

console.log("\n## d. end to end: a TypeScript type for one query, from engine facts only");
const query = `
  select o.id, o.status, o.note, p.status as parent_status,
    coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty, 'price', l.price, 'total', cast(l.qty * l.price as real)))
      filter (where l.id is not null), '[]') as lines
  from orders o
  left join orders p on p.id = o.parent_id
  left join order_lines l on l.order_id = o.id
  group by o.id`;

type Fact = { name: string; table: string | null; column: string | null; type: string | null };
function declared(table: string, column: string): { type: string; notnull: boolean; check: string | null } {
  const row = db.prepare(`select type, "notnull" as nn from pragma_table_xinfo(?) where name = ?`).get(table, column) as { type: string; nn: number };
  const ddl = (db.prepare(`select sql from sqlite_schema where name = ?`).get(table) as { sql: string }).sql;
  // CHECK (col in (...)) on the same column: a lexer-level scan of the CREATE TABLE text.
  const re = new RegExp(`\\b${column}\\b[^,]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, "i");
  const m = re.exec(ddl);
  return { type: row.type, notnull: row.nn === 1, check: m ? m[1]! : null };
}
function tsScalar(sqlType: string): string {
  const t = sqlType.toUpperCase();
  if (t.includes("INT")) return "number";
  if (t.includes("CHAR") || t.includes("TEXT") || t.includes("CLOB")) return "string";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "number";
  if (t.includes("BLOB")) return "Uint8Array";
  return "unknown";
}
function tsForColumn(fact: Fact, alias: string | null, nullable: Set<string>, inFilter: boolean): string {
  if (fact.table && fact.column) {
    const d = declared(fact.table, fact.column);
    let t = d.check ? d.check.split(",").map((s) => s.trim().replace(/^'(.*)'$/, '"$1"')).join(" | ") : tsScalar(d.type);
    const joinNull = alias !== null && nullable.has(alias) && !inFilter;
    if (!d.notnull || joinNull) t += " | null";
    return t;
  }
  return fact.type ? tsScalar(fact.type) : "unknown";
}
function aliasOf(expr: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$/.exec(expr.trim());
  return m ? m[1]! : null;
}
const nullable = nullableAliases(query);
console.log("  nullable aliases:", JSON.stringify([...nullable]));
const cols = db.prepare(query).columns() as Fact[];
const fields: string[] = [];
// columns() is positional, so select-list item i (split at top-level commas)
// belongs to column i. The alias comes from the item text, `<alias>.<column>`.
const selectList = query.slice(query.search(/select\s/i) + 7, query.search(/\sfrom\s/i));
const items = selectList.split(/,(?![^(]*\))/).map((s) => s.trim());
for (const [i, c] of cols.entries()) {
  if (c.name === "lines") continue;
  fields.push(`${c.name}: ${tsForColumn(c, aliasOf(items[i]!.replace(/\s+as\s+\w+$/i, "")), nullable, false)}`);
}
// JSON column: probe each json_object value expression as a top-level column.
const inner = /json_object\(([^)]*\)[^)]*)\)/.exec(query)!;
const args = inner[1]!.split(/,(?![^(]*\))/).map((s) => s.trim());
const pairs: { key: string; value: string }[] = [];
for (let i = 0; i + 1 < args.length; i += 2) pairs.push({ key: args[i]!.replace(/^'|'$/g, ""), value: args[i + 1]! });
const probe = `select ${pairs.map((p, i) => `${p.value} as __v${i}`).join(", ")} from orders o left join orders p on p.id = o.parent_id left join order_lines l on l.order_id = o.id`;
const probeCols = db.prepare(probe).columns() as Fact[];
db.exec(`create temp table probe_json as ${probe} limit 0`);
const affinity = new Map((db.prepare("pragma table_xinfo(probe_json)").all() as { name: string; type: string }[]).map((r) => [r.name, r.type]));
const jsonFields = pairs.map((p, i) => {
  const c = probeCols[i]!;
  const aff = affinity.get(`__v${i}`) ?? "";
  const t = c.table ? tsForColumn(c, aliasOf(p.value), nullable, true) : aff ? tsScalar(aff) + " | null" : "unknown";
  return `${p.key}: ${t}`;
});
fields.push(`lines: Array<{ ${jsonFields.join("; ")} }>`);
console.log(`  type Row = { ${fields.join("; ")} }`);
