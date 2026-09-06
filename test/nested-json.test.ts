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
  const generated = { [sql]: { params: ["id"], encode: [], json: ["lines"] } } as unknown as Meta<{ [sql]: { params: { id: string }; row: { id: string; lines: { id: string; tags: string[] }[] } } }>;
  const q = queries(generated, { withTags: sql });
  const row = await node(raw).first(q.withTags, { id: "o1" });
  assert.deepEqual(row, { id: "o1", lines: [{ id: "l1", tags: ["gift", "fragile"] }, { id: "l2", tags: [] }] });
});
