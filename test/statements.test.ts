// Responsibility: verify catalog statement boundaries against SQLite.
// Boundary: statement role and type analysis have separate build tests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogStatement } from "../src/build/statements.ts";

test("a trailing line comment after a semicolon remains part of one catalog statement", () => {
  const sql = "select 1; --";
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(catalogStatement(sql, "read"), "select 1");
    assert.equal(db.prepare(sql).get()!["1"], 1);
  } finally { db.close(); }
});
