// Responsibility: shape()'s own return value -- not only its use to compare
// two schemas for equality (column-order-migration.test.ts and others), but
// the actual name/table/sql fields it reports for indexes, triggers, and
// views, and the alphabetical order it sorts each kind into. A test that
// only compares shape(a) to shape(b) cannot tell a correct shape() from one
// that always returns the same placeholder for both sides.
import { test } from "vitest";
import assert from "node:assert/strict";
import { introspect, open, shape } from "../src/build/migration.ts";
import { normalize } from "../src/build/scan.ts";

test("shape() reports each table, index, trigger, and view's own fields, sorted by name", () => {
  const db = open([
    "create table z (id integer primary key not null) strict",
    "create table a (id integer primary key not null) strict",
    "create table t (id integer primary key not null, a integer, b integer) strict",
    "create index idx_b on t(b)",
    "create index idx_a on t(a)",
    "create trigger trg_b after insert on t begin update t set b = b + 1 where id = new.id; end",
    "create trigger trg_a after insert on t begin update t set a = a + 1 where id = new.id; end",
    "create view view_b as select b from t",
    "create view view_a as select a from t",
  ]);
  try {
    const s = shape(introspect(db)) as {
      tables: { name: string }[];
      indexes: { name: string; table: string; sql: string }[];
      triggers: { name: string; table: string; sql: string }[];
      views: { name: string; sql: string }[];
    };

    assert.deepEqual(s.tables.map((t) => t.name), ["a", "t", "z"]);

    assert.deepEqual(s.indexes, [
      { name: "idx_a", table: "t", sql: normalize("create index idx_a on t(a)") },
      { name: "idx_b", table: "t", sql: normalize("create index idx_b on t(b)") },
    ]);

    assert.deepEqual(s.triggers, [
      {
        name: "trg_a",
        table: "t",
        sql: normalize("create trigger trg_a after insert on t begin update t set a = a + 1 where id = new.id; end"),
      },
      {
        name: "trg_b",
        table: "t",
        sql: normalize("create trigger trg_b after insert on t begin update t set b = b + 1 where id = new.id; end"),
      },
    ]);

    assert.deepEqual(s.views, [
      { name: "view_a", sql: normalize("create view view_a as select a from t") },
      { name: "view_b", sql: normalize("create view view_b as select b from t") },
    ]);
  } finally {
    db.close();
  }
});

// shape() is exported and accepts any Schema, not only one built by
// introspect() (whose own SQL query happens to read rows already ordered by
// name): its own .sort(byName) calls are load-bearing on their own, so this
// test builds a Schema whose Maps are populated in the opposite order and
// checks that shape() still reports every kind alphabetically.
test("shape() sorts each kind by name even when the underlying Schema arrives in reverse order", () => {
  const db = open([
    "create table t (id integer primary key not null, a integer, b integer) strict",
    "create table z (id integer primary key not null) strict",
    "create index idx_b on t(b)",
    "create index idx_a on t(a)",
    "create trigger trg_b after insert on t begin update t set b = b + 1 where id = new.id; end",
    "create trigger trg_a after insert on t begin update t set a = a + 1 where id = new.id; end",
    "create view view_b as select b from t",
    "create view view_a as select a from t",
  ]);
  try {
    const forward = introspect(db);
    const reversed = {
      tables: new Map([...forward.tables].reverse()),
      indexes: new Map([...forward.indexes].reverse()),
      triggers: new Map([...forward.triggers].reverse()),
      views: new Map([...forward.views].reverse()),
      virtuals: new Map([...forward.virtuals].reverse()),
    };
    assert.deepEqual(shape(reversed), shape(forward));
  } finally {
    db.close();
  }
});
