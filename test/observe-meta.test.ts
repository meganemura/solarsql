// The observe hook carries D1's meta: one reply for a query, the sum of the
// replies for a batch and for a command, the region from the first reply,
// and no field at all when the engine reports none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { read, type Observed } from "../src/index.ts";
import { customerCommands, customerQueries } from "../example/modules/customers/public.ts";
import { orderQueries } from "../example/modules/orders/public.ts";

// A binding that answers every statement with the same reply.
function binding(reply: { results?: unknown; meta?: unknown }): D1Like {
  const statement: D1StatementLike = { bind: () => statement, all: async () => reply };
  return { prepare: () => statement, batch: async (statements) => statements.map(() => reply) };
}

const meta = { rows_read: 3, rows_written: 1, duration: 0.25, served_by_region: "ENAM", served_by_primary: true, changes: 1 };

test("a query carries one meta, a batch and a command the sum", async () => {
  const events: Observed[] = [];
  const db = d1(binding({ results: [], meta }), { observe: (e) => events.push(e) });
  await db.all(customerQueries.all);
  await db.batch([read(customerQueries.all), read(orderQueries.byId, { id: "o1" as never })]);
  await db.run(customerCommands.create, { id: "c1" as never, name: "Ann", email: "a@x" });
  assert.deepEqual(events.map((e) => [e.kind, e.meta]), [
    ["query", { rows_read: 3, rows_written: 1, duration: 0.25, served_by_region: "ENAM", served_by_primary: true }],
    ["batch", { rows_read: 6, rows_written: 2, duration: 0.5, served_by_region: "ENAM", served_by_primary: true }],
    // create is one statement plus its returns.
    ["command", { rows_read: 6, rows_written: 2, duration: 0.5, served_by_region: "ENAM", served_by_primary: true }],
  ]);
});

test("an engine that reports no meta leaves the field out", async () => {
  const events: Observed[] = [];
  const db = d1(binding({ results: [] }), { observe: (e) => events.push(e) });
  await db.all(customerQueries.all);
  assert.equal(events.length, 1);
  assert.ok(!("meta" in events[0]!));
});
