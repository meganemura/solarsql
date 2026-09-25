// Pins commands.md's "Bulk writes" recipe: an idempotent bulk upsert
// (`where true` before `on conflict`), chunked past one statement, with a
// retried chunk giving changes 0 and no duplicate rows.
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GUARD_DDL } from "../src/runtime/plan.ts";
import { commands, type Meta } from "../src/index.ts";
import { node } from "../src/node.ts";

// The chunk-retry rule (commands.md, "Chunk rows past the per-statement
// ceiling") uses `on conflict (id) do nothing`, not `do update`: a chunk
// retry must be a no-op (changes 0), and `do update` would report every
// retried row as changed even when its values did not change, since
// SQLite's own `changes()` counts a row UPDATE touched, not a row whose
// value actually differed.
const upsertRows = `
  insert into rows_table (id, note, qty)
  select value ->> 'id', value ->> 'note', value ->> 'qty'
  from json_each(:rows)
  where true
  on conflict (id) do nothing`;

type G = {
  [upsertRows]: { params: { rows: { id: string; note: string; qty: number }[] }; row: {} };
};
const meta: Meta<G> = {
  [upsertRows]: { params: ["rows"], encode: ["rows"], json: [], reads: ["rows_table"] },
};
const cmd = commands(meta, { upsert: { plan: [upsertRows] } });

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("create table rows_table (id text primary key not null, note text not null, qty integer not null) strict");
  for (const s of GUARD_DDL) db.exec(s);
  return db;
}

test("bulk upsert: chunking past one statement, a retried chunk gives changes 0 and no duplicates", async () => {
  const db = makeDb();
  const adapter = node(db);

  const N = 3000;
  const chunkSize = 1000;
  const rows = Array.from({ length: N }, (_, i) => ({ id: `r${i}`, note: `note-${i}`, qty: i }));
  const chunks = [rows.slice(0, 1000), rows.slice(1000, 2000), rows.slice(2000, 3000)];
  assert.equal(chunks.length, N / chunkSize);

  for (const chunk of chunks) {
    const result = await adapter.run(cmd.upsert, { rows: chunk });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.changes, 1000);
  }

  const countAfterFirstPass = (db.prepare("select count(*) as n from rows_table").get() as { n: number }).n;
  assert.equal(countAfterFirstPass, N);

  // Retry chunk 2 (idempotent: same ids, same values) -- changes 0, no duplicate rows.
  const retry = await adapter.run(cmd.upsert, { rows: chunks[1]! });
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.changes, 0);

  const countAfterRetry = (db.prepare("select count(*) as n from rows_table").get() as { n: number }).n;
  assert.equal(countAfterRetry, N);
});
