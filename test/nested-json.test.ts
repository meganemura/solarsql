// A nested JSON aggregation arrives parsed at every level: the adapter
// parses the column once, and json() made the inner array nest as JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { queries, type Meta } from "../src/index.ts";
import { node } from "../src/node.ts";
import { Engine } from "../src/build/facts.ts";
import { Typer, BuildError } from "../src/build/typegen.ts";

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
// empty array for the same empty child set.
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

// Two one-to-many arrays on one parent, each its own correlated subquery:
// a single LEFT JOIN per child would multiply rows once a second
// child joins in, so the top-level, non-null spelling is
// `json((select json_group_array(...) ...))` for each array, per ADR 0132.
test("two sibling one-to-many arrays on one parent decode empty arrays, not null, for a parent with no children", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table orders (id text primary key not null) strict;
    create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null) strict;
    create table order_events (id text primary key not null, order_id text not null references orders(id), kind text not null) strict;
    insert into orders values ('o1'), ('o2');
    insert into order_lines values ('l1', 'o1', 'sku-1'), ('l2', 'o1', 'sku-2');
    insert into order_events values ('e1', 'o1', 'created'), ('e2', 'o1', 'shipped'), ('e3', 'o1', 'delivered');
  `);
  const sql =
    "select o.id, json((select json_group_array(json_object('id', l.id, 'sku', l.sku)) from order_lines l where l.order_id = o.id)) as lines, json((select json_group_array(json_object('id', e.id, 'kind', e.kind)) from order_events e where e.order_id = o.id)) as events from orders o where o.id = :id";
  const generated = { [sql]: { params: ["id"], encode: [], json: ["lines", "events"], reads: ["orders"] } } as unknown as Meta<{
    [sql]: { params: { id: string }; row: { id: string; lines: { id: string; sku: string }[]; events: { id: string; kind: string }[] } };
  }>;
  const q = queries(generated, { withSiblings: sql });
  assert.deepEqual(await node(raw).first(q.withSiblings, { id: "o1" }), {
    id: "o1",
    lines: [{ id: "l1", sku: "sku-1" }, { id: "l2", sku: "sku-2" }],
    events: [{ id: "e1", kind: "created" }, { id: "e2", kind: "shipped" }, { id: "e3", kind: "delivered" }],
  });
  assert.deepEqual(await node(raw).first(q.withSiblings, { id: "o2" }), { id: "o2", lines: [], events: [] });
});

// The build refuses the join-based spelling of the same two sibling arrays
// (ADR 0136): two LEFT JOINs on one order, one per FILTER-guarded
// json_group_array, multiply each array by the other's own row count. This
// measures the actual duplication the refusal above prevents an agent from
// shipping.
test("the join-based spelling of two sibling arrays is refused; run directly, it duplicates each array by the other's row count", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table orders (id text primary key not null) strict;
    create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null) strict;
    create table order_events (id text primary key not null, order_id text not null references orders(id), kind text not null) strict;
    insert into orders values ('o1');
    insert into order_lines values ('l1', 'o1', 'sku-1'), ('l2', 'o1', 'sku-2');
    insert into order_events values ('e1', 'o1', 'created'), ('e2', 'o1', 'shipped'), ('e3', 'o1', 'delivered');
  `);
  const sql =
    "select o.id, json_group_array(json_object('id', l.id, 'sku', l.sku)) filter (where l.id is not null) as lines, json_group_array(json_object('id', e.id, 'kind', e.kind)) filter (where e.id is not null) as events from orders o left join order_lines l on l.order_id = o.id left join order_events e on e.order_id = o.id where o.id = :id group by o.id";
  const engine = new Engine(["create table orders (id text primary key not null)", "create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null)", "create table order_events (id text primary key not null, order_id text not null references orders(id), kind text not null)"]);
  try {
    assert.throws(() => new Typer(engine, new Map()).analyze(sql, "m"), BuildError);
  } finally { engine.close(); }
  const row = raw.prepare(sql).get({ ":id": "o1" }) as { lines: string; events: string };
  // 2 lines x 3 events: each array's own rows repeat once per the other
  // join's row count, exactly the duplication the build's refusal names.
  assert.equal(JSON.parse(row.lines).length, 6);
  assert.equal(JSON.parse(row.events).length, 6);
});
