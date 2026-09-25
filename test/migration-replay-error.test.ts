// Responsibility: applied()'s wrapped replay error names which statement of
// a multi-statement migration file failed, not only the file.
import assert from "node:assert/strict";
import { test } from "vitest";
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

// A migration file already on disk is never run through the Engine
// constructor's own check against the current declared schema (facts.ts),
// so this replay is the only place a CHECK constraint's function call in an
// already-generated file is caught before a real deploy would refuse it
// (ADR 0114).
test("a CHECK constraint calling a denied function in a migration file is refused, named by statement", () => {
  const file = "create table t (id text primary key not null, a text, check (a != sqlite_version())) strict;";
  assert.throws(() => applied([file], ["0001_check.sql"]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /migration 0001_check\.sql, statement 1 of 1: not authorized to use function: sqlite_version/);
    return true;
  });
});
