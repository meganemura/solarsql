// Responsibility: verify catalog statement boundaries against SQLite.
// Boundary: statement role and type analysis have separate build tests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogStatement, refuseTransactionEndingSchemaConflict } from "../src/build/statements.ts";

test("a trailing line comment after a semicolon remains part of one catalog statement", () => {
  const sql = "select 1; --";
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(catalogStatement(sql, "read"), "select 1");
    assert.equal(db.prepare(sql).get()!["1"], 1);
  } finally { db.close(); }
});

test("minus tokens after a semicolon remain a second statement", () => {
  const sql = "select 1; -/**/-";
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => db.exec(sql));
    assert.throws(() => catalogStatement(sql, "read"), /exactly one SQL statement/);
  } finally { db.close(); }
});

test("schema conflict checks apply only to their declared schema kind", () => {
  assert.doesNotThrow(() => refuseTransactionEndingSchemaConflict("create table t(id integer unique on conflict rollback)", "trigger"));
  assert.doesNotThrow(() => refuseTransactionEndingSchemaConflict("create trigger g after insert on t begin select raise(rollback, 'stop'); end", "table"));
  assert.doesNotThrow(() => refuseTransactionEndingSchemaConflict("create table t(raise text, rollback text)", "trigger"));
});

test("trigger rollback checks require the complete SQLite forms", () => {
  for (const sql of [
    "create trigger g after insert on t begin select raise; end",
    "create trigger g after insert on t begin select raise(rollback); end",
    "create trigger g after insert on t begin select raise(abort, 'stop'); end",
    "create trigger g after insert on t begin select 'or rollback'; end",
    "select nope(rollback, 'stop')",
    "raise nope rollback ,",
    "raise",
    "raise ( rollback",
  ]) assert.doesNotThrow(() => refuseTransactionEndingSchemaConflict(sql, "trigger"), sql);
  assert.throws(
    () => refuseTransactionEndingSchemaConflict("create trigger g after insert on t begin select raise(rollback, 'stop'); end", "trigger"),
    /RAISE\(ROLLBACK/,
  );
  assert.throws(
    () => refuseTransactionEndingSchemaConflict("create trigger g after insert on t begin update or rollback t set id = 1; end", "trigger"),
    /trigger body cannot use OR ROLLBACK/,
  );
  assert.doesNotThrow(() => refuseTransactionEndingSchemaConflict("select 1 or rollback", "table"));
});

test("catalog statements reject every non-comment token after their terminator", () => {
  for (const sql of ["select 1; select 2", "select 1;; select 2", "select 1; - 2"]) {
    assert.throws(() => catalogStatement(sql, "read"), /exactly one SQL statement/, sql);
  }
  assert.equal(catalogStatement("select ';' as value; /* ; */", "read"), "select ';' as value");
  assert.equal(catalogStatement("select 1;;; -- trailing", "read"), "select 1");
});

test("catalog statements preserve each supported CTE prefix", () => {
  const statements = [
    "with x as (select 1) select * from x",
    "with recursive x(n) as (values(1) union all select n + 1 from x where n < 2) select * from x",
    "with x(a, b) as not materialized (select 1, 2), y as materialized (select a from x) select * from y",
  ];
  for (const sql of statements) assert.equal(catalogStatement(`${sql}; -- trailing`, "read"), sql, sql);
});

test("malformed CTE prefixes do not advance to a later apparent verb", () => {
  for (const sql of [
    "with",
    "with recursive",
    "with select 1",
    "with x as",
    "with x as , select 1",
    "with x as (select 1",
    "with x as (select 1), select 2",
    "with x(a as (select 1) select 2",
  ]) assert.throws(() => catalogStatement(sql, "read"), /query or returns must be SELECT or VALUES/, sql);
  for (const sql of ["with x select 1", "with x as select 1"]) {
    assert.equal(catalogStatement(sql, "read"), sql);
  }
});

test("catalog roles distinguish read statements from every plan verb", () => {
  for (const sql of ["select 1", "values (1)"]) {
    assert.equal(catalogStatement(sql, "read"), sql);
    assert.equal(catalogStatement(sql, "plan"), sql);
  }
  for (const sql of [
    "insert into t values (1)",
    "update t set id = 1",
    "delete from t",
    "replace into t values (1)",
  ]) {
    assert.throws(() => catalogStatement(sql, "read"), /query or returns must be SELECT or VALUES/, sql);
    assert.equal(catalogStatement(sql, "plan"), sql);
  }
  assert.throws(() => catalogStatement("pragma user_version", "plan"), /plan item must be SELECT, VALUES, INSERT, UPDATE, DELETE, or REPLACE/);
});

test("plan rollback checks require a write verb followed immediately by OR ROLLBACK", () => {
  for (const sql of [
    "insert or rollback into t values (1)",
    "update or rollback t set id = 1",
    "with recursive x as not materialized (select 1) insert or rollback into t select * from x",
  ]) assert.throws(() => catalogStatement(sql, "plan"), /plan item cannot use OR ROLLBACK/, sql);
  for (const sql of [
    "insert or ignore into t values (1)",
    "update or replace t set id = 1",
    "select 'insert or rollback'",
  ]) assert.equal(catalogStatement(sql, "plan"), sql);
  assert.equal(catalogStatement("select or rollback", "plan"), "select or rollback");
  assert.throws(
    () => catalogStatement("insert or rollback into t values (1)", "read"),
    /query or returns must be SELECT or VALUES/,
  );
});
