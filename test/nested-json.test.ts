// A nested JSON aggregation arrives parsed at every level: the adapter
// parses the column once, and json() made the inner array nest as JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { queries, type Meta } from "../src/index.ts";
import { node } from "../src/node.ts";

const sql = "select o.id, coalesce(json_group_array(json_object('id', l.id, 'tags', json((select json_group_array(g.name) from tags g where g.line_id = l.id)))) filter (where l.id is not null), '[]') as lines from orders o left join order_lines l on l.order_id = o.id where o.id = :id group by o.id";

test("the inner array is an array, not a string", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table orders (id text primary key not null) strict;
    create table order_lines (id text primary key not null, order_id text not null references orders(id)) strict;
    create table tags (id text primary key not null, line_id text not null references order_lines(id), name text not null) strict;
    insert into orders values ('o1');
    insert into order_lines values ('l1', 'o1'), ('l2', 'o1');
    insert into tags values ('t1', 'l1', 'gift'), ('t2', 'l1', 'fragile');
  `);
  // The meta the build would write for this statement.
  const generated = { [sql]: { params: ["id"], encode: [], json: ["lines"], reads: ["orders"] } } as unknown as Meta<{ [sql]: { params: { id: string }; row: { id: string; lines: { id: string; tags: string[] }[] } } }>;
  const q = queries(generated, { withTags: sql });
  const row = await node(raw).first(q.withTags, { id: "o1" });
  assert.deepEqual(row, { id: "o1", lines: [{ id: "l1", tags: ["gift", "fragile"] }, { id: "l2", tags: [] }] });
});

// A GROUP BY inside the nested subquery types the array `| null`: an empty
// child set gives zero grouped rows, so no aggregate row at all. The plain
// form (no GROUP BY) keeps a guaranteed one row, so it stays a non-null
// empty array for the same empty child set (eki2.2).
test("a GROUP BY subquery decodes null for an empty child set; the plain form decodes an empty array", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table orders (id text primary key not null) strict;
    create table order_lines (id text primary key not null, order_id text not null references orders(id)) strict;
    insert into orders values ('o1'), ('o2');
    insert into order_lines values ('l1', 'o1');
  `);
  const plainSql =
    "select o.id, json_object('lines', json((select json_group_array(json_object('id', l.id)) from order_lines l where l.order_id = o.id))) as data from orders o where o.id = :id";
  const groupedSql =
    "select o.id, json_object('lines', json((select json_group_array(json_object('id', l.id)) from order_lines l where l.order_id = o.id group by l.order_id))) as data from orders o where o.id = :id";
  const generated = {
    [plainSql]: { params: ["id"], encode: [], json: ["data"], reads: ["orders"] },
    [groupedSql]: { params: ["id"], encode: [], json: ["data"], reads: ["orders"] },
  } as unknown as Meta<{
    [plainSql]: { params: { id: string }; row: { id: string; data: { lines: { id: string }[] } } };
    [groupedSql]: { params: { id: string }; row: { id: string; data: { lines: { id: string }[] | null } } };
  }>;
  const q = queries(generated, { plain: plainSql, grouped: groupedSql });
  assert.deepEqual((await node(raw).first(q.plain, { id: "o2" }))?.data, { lines: [] });
  assert.deepEqual((await node(raw).first(q.grouped, { id: "o2" }))?.data, { lines: null });
  assert.deepEqual((await node(raw).first(q.grouped, { id: "o1" }))?.data, { lines: [{ id: "l1" }] });
});

// The remedy the build's LIMIT/OFFSET refusal names: an IN-subquery over the
// child's own primary key, ordered and capped there, reached by an
// unconstrained outer json_group_array. It builds non-null and caps the
// children at n, while an empty child set still decodes an empty array.
test("the IN-subquery remedy for capping child rows returns at most n children and [] for an empty parent", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table orders (id text primary key not null) strict;
    create table order_lines (id text primary key not null, order_id text not null references orders(id)) strict;
    insert into orders values ('o1'), ('o2');
    insert into order_lines values ('l1', 'o1'), ('l2', 'o1'), ('l3', 'o1');
  `);
  const remedySql =
    "select o.id, json_object('lines', json((select json_group_array(json_object('id', l.id) order by l.id) from order_lines l where l.id in (select l2.id from order_lines l2 where l2.order_id = o.id order by l2.id limit :n)))) as data from orders o where o.id = :id";
  const generated = { [remedySql]: { params: ["n", "id"], encode: [], json: ["data"], reads: ["orders"] } } as unknown as Meta<{
    [remedySql]: { params: { id: string; n: number }; row: { id: string; data: { lines: { id: string }[] } } };
  }>;
  const q = queries(generated, { capped: remedySql });
  assert.deepEqual((await node(raw).first(q.capped, { id: "o1", n: 2 }))?.data, { lines: [{ id: "l1" }, { id: "l2" }] });
  assert.deepEqual((await node(raw).first(q.capped, { id: "o2", n: 2 }))?.data, { lines: [] });
});
