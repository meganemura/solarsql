// Responsibility: a migration runs on a live database with rows the
// generator never saw. A new NOT NULL column without a default has no value
// for those rows, so diff() refuses it outright -- except a STORED
// generated column, which computes its own value and needs no default even
// when declared NOT NULL.
import { test } from "vitest";
import assert from "node:assert/strict";
import { diff, introspect, open } from "../src/build/migration.ts";

test("a new NOT NULL column without a default is blocked, naming the column and the table", () => {
  const current = open(["create table t (id integer primary key not null) strict"]);
  const target = open(["create table t (id integer primary key not null, a integer not null) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "blocked");
    if (plan.kind !== "blocked") return;
    assert.equal(
      plan.reason,
      "table t: new column a is NOT NULL without a default. Existing rows have no value for it. Add a default or allow null.",
    );
  } finally {
    current.close();
    target.close();
  }
});

test("a new STORED generated column, even declared NOT NULL, needs no default and is not blocked", () => {
  const current = open(["create table t (id integer primary key not null, a integer not null) strict"]);
  const target = open(["create table t (id integer primary key not null, a integer not null, b integer generated always as (a * 2) stored not null) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
  } finally {
    current.close();
    target.close();
  }
});
