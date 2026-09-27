// Responsibility: applied()'s wrapped replay error names which statement of
// a multi-statement migration file failed, not only the file.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { applied } from "../src/build/migration.ts";
import { REBUILD_HEADER } from "../src/build/scan.ts";
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

test("applied() without names uses the default per-file label, numbered from 1, in a rebuild-refusal error", () => {
  const base = "create table t (id text primary key not null, a text not null) strict";
  const addB = "alter table t add column b text";
  // A hand-crafted rebuild header, not one from render(): the record knows
  // about "id" and "a" only, so "b" (added by the second file) is unknown.
  const stale = `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "" }, { name: "a", def: "" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(() => applied([base + ";", addB + ";", stale]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /migration file 3 of 3 rebuilds table "t" without knowledge of column "b", added by migration file 2 of 3/);
    return true;
  });
});

test("a rebuild record naming a table that does not exist yet is ignored, not treated as an error", () => {
  const file = `${REBUILD_HEADER}${JSON.stringify([{ table: "ghost", columns: [], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  const db = applied([file]);
  assert.ok(db instanceof DatabaseSync);
});

// SQLite stores an index or a trigger name declared as a string literal
// (single-quoted) verbatim, as a string literal, not as a double-quoted or
// bare identifier: `create index 'qi' on t(a)` reads back from
// sqlite_schema as `CREATE INDEX 'qi' on t(a)`. tokenize() therefore reads
// 'qi' as a string token, not an identifier, so created() -- which only
// names an identifier token -- returns null for it. A rebuild-refusal
// error must still name the index or the trigger, using the declaration's
// own text as a fallback.
test("a rebuild-refusal error still names an index whose declared name is a string-literal-quoted identifier", () => {
  const file1 = "create table t (id integer primary key not null, a integer) strict; create index 'qi' on t(a);";
  const file2 = `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "id integer primary key not null" }, { name: "a", def: "a integer" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(() => applied([file1, file2], ["0001_base.sql", "0002_stale.sql"]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /0002_stale\.sql rebuilds table "t" without knowledge of index "create index 'qi' on t\(a\)" it already has/);
    return true;
  });
});

test("a rebuild-refusal error still names a trigger whose declared name is a string-literal-quoted identifier", () => {
  const file1 = "create table t (id integer primary key not null, a integer) strict; "
    + "create trigger 'qt' after insert on t begin select 1; end;";
  const file2 = `${REBUILD_HEADER}${JSON.stringify([{ table: "t", columns: [{ name: "id", def: "id integer primary key not null" }, { name: "a", def: "a integer" }], constraints: [], indexes: [], triggers: [] }])}\nselect 1;`;
  assert.throws(() => applied([file1, file2], ["0001_base.sql", "0002_stale.sql"]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.match(e.message, /0002_stale\.sql rebuilds table "t" without knowledge of trigger "create trigger 'qt' after insert on t begin select 1; end" it already has/);
    return true;
  });
});

test("a replay failure at commit itself (a deferred foreign key, not mid-statement) is named without a statement ordinal", () => {
  const file = [
    "pragma foreign_keys = on",
    "create table p (id integer primary key not null) strict",
    "create table c (id integer primary key not null, p_id integer references p(id)) strict",
    "pragma defer_foreign_keys = on",
    "insert into c (id, p_id) values (1, 99)",
  ].join(";\n") + ";";
  assert.throws(() => applied([file], ["0001_bad.sql"]), (e: unknown) => {
    assert.ok(e instanceof BuildError, String(e));
    assert.equal(e.message, "migration 0001_bad.sql: FOREIGN KEY constraint failed");
    return true;
  });
});
