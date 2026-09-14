// Responsibility: applied()'s wrapped replay error names which statement of
// a multi-statement migration file failed, not only the file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applied } from "../src/build/migration.ts";
import { BuildError } from "../src/build/typegen.ts";

test("applied()'s wrapped error names the failing statement's ordinal within the file", () => {
  const duplicate = "create table t (id text primary key not null); create table t (id text primary key not null);";
  assert.throws(() => applied([duplicate], ["0001_two.sql"]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /migration 0001_two\.sql, statement 2 of 2: table t already exists/);
    return true;
  });
});
