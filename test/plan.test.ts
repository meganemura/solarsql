// Responsibility: plan.ts's own pure functions, tested directly: the
// parameter-validation message's empty-catalog case, errorDetails()'s
// decline path for values an adapter never produces itself, and
// constraintFailure()'s parse against text node:sqlite actually raises.
// Boundary: no engine access beyond node:sqlite, used here only to obtain
// real constraint text.
import { test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { validateParams, errorDetails, engineMeta, d1StatementRows, outcomeOf, constraintFailure } from "../src/runtime/plan.ts";

// Runs one or more setup statements, then one statement expected to raise a
// constraint or CHECK violation, and returns the engine's own message text.
function engineFailureMessage(ddl: string, badInsert: string): string {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    let message: string | undefined;
    try {
      db.exec(badInsert);
    } catch (e) {
      message = (e as Error).message;
    }
    if (message === undefined) throw new Error("expected the statement to raise a constraint failure");
    return message;
  } finally {
    db.close();
  }
}

test("validateParams reports 'none' when no meta in the group declares a parameter", () => {
  assert.throws(
    () => validateParams([{ params: [], encode: [], json: [], reads: [] }], { x: 1 }, "query x"),
    { message: 'unexpected parameter: "x" (query x declares: none)' },
  );
});

test("errorDetails reads message and errcode off a thrown function, not just a thrown object", () => {
  const thrown = Object.assign(function boom() {}, { message: "boom", errcode: 2067 });
  assert.deepEqual(errorDetails(thrown), { message: "boom", errcode: 2067 });
});

test("errorDetails declines null, a primitive, and an AggregateError with an empty message and no errcode", () => {
  assert.deepEqual(errorDetails(null), { message: "" });
  assert.deepEqual(errorDetails(42), { message: "" });
  assert.deepEqual(errorDetails(new AggregateError([], "combined")), { message: "" });
});

test("errorDetails reports an empty message when the error's own message field is not a string", () => {
  assert.deepEqual(errorDetails({ message: 42 }), { message: "" });
});

test("errorDetails declines an error whose own field throws on access, instead of propagating", () => {
  const hostile = {};
  Object.defineProperty(hostile, "cause", {
    get() {
      throw new Error("reading cause failed");
    },
  });
  assert.deepEqual(errorDetails(hostile), { message: "" });
});

test("a UNIQUE failure on an expression index doubles an embedded quote in the real engine text, and constraintFailure() undoubles it", () => {
  const message = engineFailureMessage(
    `create table t (a text); create unique index "it's" on t(lower(a)); insert into t (a) values ('x')`,
    `insert into t (a) values ('X')`,
  );
  assert.deepEqual(constraintFailure(new Error(message)), { kind: "unique_index", index: "it's" });
});

test("a named CHECK failure reports the constraint name", () => {
  const message = engineFailureMessage(`create table t (a int, constraint pos check (a > 0))`, `insert into t (a) values (-1)`);
  assert.deepEqual(constraintFailure(new Error(message)), { kind: "check", constraint: "pos" });
});

test("the CHECK pattern only matches at the very start of the message: a hand-written boundary input", () => {
  const message = `unrelated prefix CHECK constraint failed: pos`;
  assert.equal(constraintFailure(new Error(message)), null);
});

test("an unnamed CHECK whose expression carries a line break in the DDL currently declines: the engine's own newline in the text breaks the single-line pattern", () => {
  // Checked directly against node:sqlite: a line break placed inside the
  // expression, not at either edge, survives into the raised message.
  const message = engineFailureMessage(`create table t (a int check (a >\n 0))`, `insert into t (a) values (-1)`);
  assert.equal(message, "CHECK constraint failed: a >\n 0");
  assert.equal(constraintFailure(new Error(message)), null);
});

test("a NOT NULL failure on multi-character table and column names splits them apart", () => {
  const message = engineFailureMessage(`create table mytable (mycolumn integer not null)`, `insert into mytable (mycolumn) values (null)`);
  assert.deepEqual(constraintFailure(new Error(message)), { kind: "not_null", table: "mytable", column: "mycolumn" });
});

test("the NOT NULL pattern only matches at the very start of the message: a hand-written boundary input", () => {
  const message = `junk NOT NULL constraint failed: mytable.mycolumn`;
  assert.equal(constraintFailure(new Error(message)), null);
});

test("a NOT NULL failure on a quoted table name with a dot declines: ADR 0087's ambiguous two-dot target", () => {
  const message = engineFailureMessage(`create table "a.b" (c integer not null)`, `insert into "a.b" (c) values (null)`);
  assert.equal(message, "NOT NULL constraint failed: a.b.c");
  assert.equal(constraintFailure(new Error(message)), null);
});

test("a FOREIGN KEY failure reports foreign_key with no further detail", () => {
  const message = engineFailureMessage(
    `pragma foreign_keys=on; create table parent (id integer primary key); create table child (id integer primary key, parent_id integer references parent(id))`,
    `insert into child (id, parent_id) values (1, 99)`,
  );
  assert.deepEqual(constraintFailure(new Error(message)), { kind: "foreign_key" });
});

test("the FOREIGN KEY pattern anchors at both ends: hand-written boundary inputs", () => {
  assert.equal(constraintFailure(new Error("junk FOREIGN KEY constraint failed")), null);
  assert.equal(constraintFailure(new Error("FOREIGN KEY constraint failed and more")), null);
});

test("a STRICT datatype failure on multi-character type, table, and column names splits every field", () => {
  const message = engineFailureMessage(`create table mytable (mycolumn integer) strict`, `insert into mytable (mycolumn) values ('notanumber')`);
  assert.deepEqual(constraintFailure(new Error(message)), { kind: "datatype", table: "mytable", column: "mycolumn", stored: "TEXT", declared: "INTEGER" });
});

test("the datatype pattern only matches at the very start of the message: a hand-written boundary input", () => {
  const message = `junk cannot store TEXT value in INTEGER column mytable.mycolumn`;
  assert.equal(constraintFailure(new Error(message)), null);
});

test("engineMeta requires both counters from a reply, else it is not summed", () => {
  assert.equal(engineMeta([{ meta: { rows_written: 1 } }]), undefined);
  assert.equal(engineMeta([{ meta: { rows_read: 1 } }]), undefined);
});

test("engineMeta defaults a missing duration to 0 and omits region and primary a reply never names", () => {
  assert.deepEqual(engineMeta([{ meta: { rows_read: 1, rows_written: 2 } }]), { rows_read: 1, rows_written: 2, duration: 0 });
});

test("d1StatementRows requires both counters from every reply, else the whole result is undefined", () => {
  assert.equal(d1StatementRows([{ meta: { rows_written: 1 } }]), undefined);
  assert.equal(d1StatementRows([{ meta: { rows_read: 1 } }]), undefined);
});

test("d1StatementRows omits duration a reply never names, per row", () => {
  assert.deepEqual(d1StatementRows([{ meta: { rows_read: 1, rows_written: 2 } }]), [{ rows_read: 1, rows_written: 2 }]);
});

test("outcomeOf reports 'error' for a failure that carries no kind", () => {
  assert.equal(outcomeOf({ ok: false }), "error");
});
