// Responsibility: introspect() classifies each sqlite_schema row by its own
// `type`, not by looking up a name in `pragma_table_list` alone -- a trigger
// does not share a table's namespace the way an index or a view does
// (confirmed empirically: node:sqlite accepts a trigger with the exact name
// of an unrelated table or search table), so a name lookup by itself is not
// enough to tell a trigger row from that table's own row.
import { test } from "vitest";
import assert from "node:assert/strict";
import { introspect, open } from "../src/build/migration.ts";

test("introspect() classifies a trigger as a trigger, not a virtual table, even when it shares its name with an unrelated fts5 table", () => {
  const db = open([
    "create table t (id integer primary key not null) strict",
    "create virtual table docs using fts5(body)",
    "create trigger docs after insert on t begin select 1; end",
  ]);
  try {
    const schema = introspect(db);
    assert.ok(schema.triggers.has("docs"), 'the trigger named "docs" should be classified as a trigger');
    assert.ok(schema.virtuals.has("docs"), 'the virtual table named "docs" should still be classified as a virtual');
  } finally {
    db.close();
  }
});
