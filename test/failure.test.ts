// The adapter turns an engine error into a value. The message formats are
// fixed strings on node:sqlite, D1, and a Durable Object, so a message built
// from a kind, a table, and columns must parse back to the same value.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { assertFailure, constraintFailure } from "../src/runtime/plan.ts";

const ident = gs.fromRegex("[a-z_][a-z0-9_]{0,8}");
const wrap = gs.sampledFrom<(m: string, code: string) => string>([
  (m) => m,
  (m, code) => `${m}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${code})`,
  (m, code) => `D1_ERROR: ${m}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${code})`,
]);

describe("constraintFailure", () => {
  test("unique, not null, and datatype messages round-trip through the three engine formats", () => {
    hegel.test((tc) => {
      const table = tc.draw(ident);
      const columns = tc.draw(gs.arrays(ident, { minSize: 1, maxSize: 3 }));
      const w = tc.draw(wrap);
      assert.deepEqual(constraintFailure(new Error(w(`UNIQUE constraint failed: ${columns.map((c) => `${table}.${c}`).join(", ")}`, "UNIQUE"))), { kind: "unique", table, columns });
      assert.deepEqual(constraintFailure(new Error(w(`NOT NULL constraint failed: ${table}.${columns[0]}`, "NOTNULL"))), { kind: "not_null", table, column: columns[0] });
      assert.deepEqual(constraintFailure(new Error(w(`cannot store TEXT value in INTEGER column ${table}.${columns[0]}`, "DATATYPE"))), {
        kind: "datatype",
        table,
        column: columns[0],
        stored: "TEXT",
        declared: "INTEGER",
      });
    });
  });

  test("check, foreign key, and the D1 cause", () => {
    assert.deepEqual(constraintFailure(new Error("CHECK constraint failed: status_ok")), { kind: "check", constraint: "status_ok" });
    assert.deepEqual(constraintFailure(new Error("D1_ERROR: CHECK constraint failed: n > 0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)")), { kind: "check", constraint: "n > 0" });
    assert.deepEqual(constraintFailure(new Error("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)")), { kind: "foreign_key" });
    const withCause = new Error("D1_ERROR: UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)", { cause: new Error("UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)") });
    assert.deepEqual(constraintFailure(withCause), { kind: "unique", table: "t", columns: ["id"] });
  });

  test("an assert is not a constraint, and an unknown error is neither", () => {
    const assertError = new Error("D1_ERROR: was_draft: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)");
    assert.equal(assertFailure(assertError, ["was_draft"]), "was_draft");
    assert.equal(constraintFailure(assertError), null);
    assert.equal(constraintFailure(new Error("D1_ERROR: too many SQL variables at offset 230: SQLITE_ERROR")), null);
  });
});
