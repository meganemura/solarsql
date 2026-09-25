// A keyset walk (where id > :after order by id limit :limit) is the
// paging recipe queries.md teaches instead of OFFSET (docs/adr/0131-
// keyset-paging-for-fixed-keys.md). For any row count and page size, the
// walk must read every row exactly once, in the same order a single
// unpaged read gives; and a row deleted between two pages, before its own
// page is fetched, must not stop the walk from reaching every row that was
// never deleted.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

const rowCount = gs.integers({ minValue: 0, maxValue: 60 });
const pageSize = gs.integers({ minValue: 1, maxValue: 10 });
// One boolean per row, drawn against the largest row count this property
// tries; only the entries at indices the walk has not yet delivered in its
// first page are read (see below).
const deletePlan = gs.arrays(gs.booleans(), { minSize: 0, maxSize: 60 });

function seeded(n: number): { db: DatabaseSync; ids: string[] } {
  const db = new DatabaseSync(":memory:");
  db.exec("create table t (id text primary key not null) strict");
  const insert = db.prepare("insert into t (id) values (?)");
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(4, "0");
    insert.run(id);
    ids.push(id);
  }
  return { db, ids };
}

function keysetWalk(db: DatabaseSync, limit: number): string[] {
  const out: string[] = [];
  const first = db.prepare("select id from t order by id limit ?");
  const next = db.prepare("select id from t where id > ? order by id limit ?");
  let after: string | null = null;
  for (;;) {
    const rows = (after === null ? first.all(limit) : next.all(after, limit)) as { id: string }[];
    if (rows.length === 0) break;
    const page = rows.map((r) => r.id);
    out.push(...page);
    after = page[page.length - 1]!;
  }
  return out;
}

describe("keyset paging on node:sqlite", () => {
  test("a keyset walk reads every row once, in the order a single unpaged read gives", () => {
    hegel.test((tc) => {
      const n = tc.draw(rowCount);
      const limit = tc.draw(pageSize);
      const { db, ids } = seeded(n);
      try {
        assert.deepEqual(keysetWalk(db, limit), ids);
      } finally {
        db.close();
      }
    });
  });

  test("a row deleted before its own page is fetched still lets the walk return every row never deleted", () => {
    hegel.test((tc) => {
      const n = tc.draw(rowCount);
      const limit = tc.draw(pageSize);
      const plan = tc.draw(deletePlan);
      const { db, ids } = seeded(n);
      try {
        // The first page is already fixed by the time any caller could
        // delete a row: it reads whatever is in the table right now. Only
        // rows past the first page can be "deleted before their own page",
        // and deleting them here, before the walk starts, gives the same
        // walked() result a delete between any two later pages would (the
        // walk never revisits a row an earlier page already returned).
        const firstPageCount = Math.min(limit, n);
        const deleteStmt = db.prepare("delete from t where id = ?");
        for (let i = firstPageCount; i < n; i++) if (plan[i] === true) deleteStmt.run(ids[i]!);

        const walked = keysetWalk(db, limit);
        const expected = ids.filter((_, i) => i < firstPageCount || plan[i] !== true);
        assert.deepEqual(walked, expected);
      } finally {
        db.close();
      }
    });
  });
});
