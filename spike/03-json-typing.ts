// Spike: how far can the engine type a JSON aggregation column with no AST?
// Three probes, all engine-driven:
//   a. CREATE TEMP TABLE ... AS <query> LIMIT 0 gives the affinity of expression columns.
//   b. EXPLAIN QUERY PLAN marks the nullable side of a LEFT JOIN.
//   c. A lexer-level scan finds json_object(key, value, ...) pairs; a probe query
//      selects each value expression as a top-level column and asks columns().
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  create table customers (id text primary key, name text not null);
  create table orders (
    id text primary key,
    customer_id text not null references customers(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text,
    placed_at integer not null
  );
  create table order_lines (
    id text primary key,
    order_id text not null references orders(id),
    sku text not null,
    qty integer not null check (qty > 0),
    price real
  );
`);

const query = `
  select o.id, o.status, c.name as customer_name,
    count(l.id) as line_count,
    coalesce(json_group_array(json_object('id', l.id, 'sku', l.sku, 'qty', l.qty, 'price', l.price, 'total', l.qty * l.price))
      filter (where l.id is not null), '[]') as lines
  from orders o
  join customers c on c.id = o.customer_id
  left join order_lines l on l.order_id = o.id
  where o.placed_at >= ?
  group by o.id`;

console.log("## a. affinity of expression columns via CREATE TEMP TABLE ... AS ... LIMIT 0");
const probeA = `
  select o.id, count(l.id) as n, sum(l.qty * l.price) as total, o.status || '!' as s,
    coalesce(o.note, '') as note2, upper(c.name) as uname, l.qty + 1 as qty1, l.qty * l.price as amount,
    42 as answer, 4.5 as ratio, 'x' as lit, cast(l.qty as text) as qty_text,
    json_object('id', l.id) as j, json_group_array(l.id) as ja, l.price as price_plain,
    max(o.placed_at) as latest, l.id is not null as has_line
  from orders o join customers c on c.id = o.customer_id
  left join order_lines l on l.order_id = o.id
  group by o.id`;
db.exec(`create temp table probe_a as ${probeA} limit 0`);
for (const r of db.prepare("pragma table_xinfo(probe_a)").all()) {
  const row = r as { name: string; type: string; notnull: number };
  console.log(`  ${row.name.padEnd(12)} type=${JSON.stringify(row.type)} notnull=${row.notnull}`);
}

console.log("\n## b. EXPLAIN QUERY PLAN on a left join");
for (const r of db.prepare(`explain query plan ${query}`).all()) console.log("  " + JSON.stringify(r));
console.log("  -- same query, inner join only:");
for (const r of db.prepare(`explain query plan select o.id from orders o join order_lines l on l.order_id = o.id`).all()) console.log("  " + JSON.stringify(r));
console.log("  -- left join with a where that forces the right side (l.qty > 0):");
for (const r of db.prepare(`explain query plan select o.id from orders o left join order_lines l on l.order_id = o.id where l.qty > 0`).all()) console.log("  " + JSON.stringify(r));

console.log("\n## c. lexer-level scan of json_object(...) and a probe query");

// Split SQL at top-level commas inside one parenthesised argument list.
// Handles string literals and nested parentheses. No AST.
function splitArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") { current += "'"; i++; } else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// Find `name(` and return the span of its argument list, respecting strings and nesting.
function findCall(sql: string, name: string, from = 0): { start: number; open: number; close: number } | null {
  const re = new RegExp(`\\b${name}\\s*\\(`, "gi");
  re.lastIndex = from;
  const m = re.exec(sql);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) { if (ch === "'" && sql[i + 1] !== "'") inString = false; else if (ch === "'") i++; continue; }
    if (ch === "'") { inString = true; continue; }
    if (ch === "(") depth++;
    if (ch === ")") { depth--; if (depth === 0) return { start: m.index, open, close: i }; }
  }
  return null;
}

// Find the select-list column that contains the aggregate: from the previous
// top-level comma (or SELECT) to the next top-level comma (or FROM).
function columnSpan(sql: string, at: number): { start: number; end: number } {
  let depth = 0; let inString = false; let start = 0; let end = sql.length;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) { if (ch === "'" && sql[i + 1] !== "'") inString = false; else if (ch === "'") i++; continue; }
    if (ch === "'") { inString = true; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth !== 0) continue;
    if (i < at) {
      if (ch === ",") start = i + 1;
      const m = /^select\s/i.exec(sql.slice(i));
      if (m) start = i + m[0].length;
    } else {
      if (ch === ",") { end = i; break; }
      if (/^from\s/i.test(sql.slice(i))) { end = i; break; }
    }
  }
  return { start, end };
}

const agg = findCall(query, "json_group_array")!;
const obj = findCall(query, "json_object", agg.open)!;
const args = splitArgs(query.slice(obj.open + 1, obj.close));
const pairs: { key: string; value: string }[] = [];
for (let i = 0; i + 1 < args.length; i += 2) {
  const k = /^'((?:[^']|'')*)'$/.exec(args[i]!);
  if (!k) throw new Error(`json_object key is not a string literal: ${args[i]}`);
  pairs.push({ key: k[1]!.replace(/''/g, "'"), value: args[i + 1]! });
}
console.log("  pairs:", JSON.stringify(pairs));

// Everything between json_group_array's close and the column end is the
// filter clause; the aggregate is wrapped in coalesce(..., '[]').
const column = columnSpan(query, agg.start);
const columnText = query.slice(column.start, column.end);
const filter = /filter\s*\(\s*where\s+(.+?)\s*\)/is.exec(columnText);
console.log("  column text:", JSON.stringify(columnText.replace(/\s+/g, " ").trim()));
console.log("  filter:", filter ? JSON.stringify(filter[1]) : "(none)");

const probeC = query.slice(0, column.start) + " " +
  pairs.map((p, i) => `${p.value} as __v${i}`).join(", ") + " " + query.slice(column.end);
console.log("  probe sql:", probeC.replace(/\s+/g, " ").trim());
const probeCols = db.prepare(probeC).columns();
for (const p of pairs) {
  const c = probeCols.find((x) => x.name === `__v${pairs.indexOf(p)}`)!;
  console.log(`  ${p.key.padEnd(8)} <- ${p.value.padEnd(18)} origin=${c.table}.${c.column} type=${c.type}`);
}
db.exec(`create temp table probe_c as ${probeC} limit 0`);
for (const r of db.prepare("pragma table_xinfo(probe_c)").all()) {
  const row = r as { name: string; type: string };
  if (row.name.startsWith("__v")) console.log(`  ${row.name} affinity=${JSON.stringify(row.type)}`);
}

console.log("\n## d. what json_object does with each SQLite type (runtime check)");
db.exec(`insert into customers values ('c1', 'Ann');
  insert into orders values ('o1', 'c1', 'draft', null, 100);
  insert into order_lines values ('l1', 'o1', 'A', 2, 1.5), ('l2', 'o1', 'B', 1, null);
  insert into orders values ('o2', 'c1', 'draft', null, 200);`);
for (const r of db.prepare(query).all(0)) console.log("  " + JSON.stringify(r));
console.log("  json types of one element:", JSON.stringify(db.prepare(
  `select json_type(j, '$.id') as id, json_type(j, '$.qty') as qty, json_type(j, '$.price') as price, json_type(j, '$.total') as total
   from (select json_object('id', l.id, 'qty', l.qty, 'price', l.price, 'total', l.qty * l.price) as j from order_lines l where id = 'l2')`).get()));
