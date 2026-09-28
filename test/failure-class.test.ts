// One example per rule, in the exact text the cited Cloudflare pages
// quote, plus the two prefixes bareMessage() strips before a rule ever
// sees the text. A Hegel property covers what the example cases cannot:
// that failureClass() never throws, and that a match it reports is real.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { failureClass } from "../src/runtime/failure.ts";
import { constraintFailure } from "../src/runtime/plan.ts";

describe("failureClass", () => {
  test("Durable Object is overloaded (four variants share this prefix)", () => {
    assert.deepEqual(failureClass(new Error("Durable Object is overloaded. Too many requests queued.")), { kind: "transient", outcome: "not_applied", reason: "do_overloaded" });
  });

  test("Durable Object account-wide load back-off", () => {
    assert.deepEqual(failureClass(new Error("Your account is generating too much load on Durable Objects. Please back off and try again later.")), { kind: "transient", outcome: "not_applied", reason: "do_account_overloaded" });
  });

  test("Durable Object storage concurrency back-off", () => {
    assert.deepEqual(failureClass(new Error("Your account is doing too many concurrent storage operations. Please back off and try again later.")), { kind: "transient", outcome: "not_applied", reason: "do_storage_concurrency" });
  });

  test("D1 DB is overloaded", () => {
    assert.deepEqual(failureClass(new Error("D1 DB is overloaded. Requests queued for too long.")), { kind: "transient", outcome: "not_applied", reason: "d1_overloaded" });
  });

  test("D1 cannot resolve the DB due to a transient remote issue", () => {
    assert.deepEqual(failureClass(new Error("Cannot resolve D1 DB due to transient issue on remote node.")), { kind: "transient", outcome: "not_applied", reason: "d1_remote_transient" });
  });

  test("network connection lost", () => {
    assert.deepEqual(failureClass(new Error("Network connection lost.")), { kind: "transient", outcome: "unknown", reason: "network_lost" });
  });

  test("D1 replica disconnected from primary", () => {
    assert.deepEqual(failureClass(new Error("Replica disconnected from primary.")), { kind: "transient", outcome: "unknown", reason: "d1_replica_disconnected" });
  });

  test("reset because its code was updated, on a Durable Object", () => {
    assert.deepEqual(failureClass(new Error("Durable Object reset because its code was updated.")), { kind: "transient", outcome: "unknown", reason: "reset_code_updated" });
  });

  test("reset because its code was updated, on D1", () => {
    assert.deepEqual(failureClass(new Error("D1 DB reset because its code was updated.")), { kind: "transient", outcome: "unknown", reason: "reset_code_updated" });
  });

  test("storage operation exceeded timeout and reset the object, on a Durable Object", () => {
    assert.deepEqual(failureClass(new Error("Durable Object storage operation exceeded timeout which caused object to be reset.")), { kind: "transient", outcome: "unknown", reason: "storage_timeout_reset" });
  });

  test("storage operation exceeded timeout and reset the object, on D1", () => {
    assert.deepEqual(failureClass(new Error("D1 DB storage operation exceeded timeout which caused object to be reset.")), { kind: "transient", outcome: "unknown", reason: "storage_timeout_reset" });
  });

  test("D1 internal error while starting up", () => {
    assert.deepEqual(failureClass(new Error("Internal error while starting up D1 DB storage caused object to be reset.")), { kind: "transient", outcome: "unknown", reason: "d1_internal_reset" });
  });

  test("D1 internal error mid-flight", () => {
    assert.deepEqual(failureClass(new Error("Internal error in D1 DB storage caused object to be reset.")), { kind: "transient", outcome: "unknown", reason: "d1_internal_reset" });
  });

  test("D1_EXEC_ERROR syntax error, the misspelled-keyword example", () => {
    const message = 'D1_EXEC_ERROR: Error in line 1: INSERTZ INTO my_table (name, employees) VALUES (): sql error: near "INSERTZ": syntax error in INSERTZ INTO my_table (name, employees) VALUES () at offset 0';
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "sql_syntax_error" });
  });

  test("a sql-syntax-error message with only the 'sql error: near' text, no D1_EXEC_ERROR prefix, still reports sql_syntax_error", () => {
    // sql_syntax_error's own test is an `||` of the two substrings; the
    // example above carries both, so it cannot tell an `||` from an `&&`.
    // This isolates the second operand.
    const message = 'Error in line 1: INSERTZ INTO t (a) VALUES (): sql error: near "INSERTZ": syntax error';
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "sql_syntax_error" });
  });

  test("D1_TYPE_ERROR", () => {
    assert.deepEqual(failureClass(new Error("D1_TYPE_ERROR: Type mismatch for value undefined")), { kind: "permanent", reason: "d1_type_error" });
  });

  test("D1_COLUMN_NOTFOUND", () => {
    assert.deepEqual(failureClass(new Error("D1_COLUMN_NOTFOUND: Column not found")), { kind: "permanent", reason: "d1_column_notfound" });
  });

  test("no such table", () => {
    assert.deepEqual(failureClass(new Error("no such table: widgets")), { kind: "permanent", reason: "sqlite_no_such" });
  });

  test("no such column", () => {
    assert.deepEqual(failureClass(new Error("no such column: price")), { kind: "permanent", reason: "sqlite_no_such" });
  });

  test("a SQLITE_ extended result code", () => {
    assert.deepEqual(failureClass(new Error("datatype mismatch: SQLITE_MISMATCH")), { kind: "permanent", reason: "sqlite_code" });
  });

  test("D1_ERROR prefix is stripped before a rule runs", () => {
    assert.deepEqual(failureClass(new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued.")), { kind: "transient", outcome: "not_applied", reason: "d1_overloaded" });
  });

  test("the Durable Object reset-and-rolled-back wrapper is stripped, resolved constraint underneath", () => {
    const message = "Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: UNIQUE constraint failed: users.email";
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "resolved_constraint" });
  });

  test("the reset-and-rolled-back wrapper with text underneath that is not a constraint message is permanent: the wrapper itself names the cause and the rollback", () => {
    const message = "Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: something the parser does not recognize";
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("a constraint-shaped message constraintFailure() cannot resolve is a permanent error, not unknown", () => {
    assert.deepEqual(failureClass(new Error("UNIQUE constraint failed")), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("a datatype-mismatch message with a table reference constraintFailure() cannot resolve is a permanent error", () => {
    // node:sqlite reports "cannot store TEXT value in INTEGER column
    // a.b.id" for a STRICT table created as "a.b" (checked directly
    // against node:sqlite). ADR 0087 requires exactly one dot in a table-column
    // target, so constraintFailure() declines this two-dot reference and
    // returns null; this module's own broader pattern is what catches it.
    const message = "cannot store TEXT value in INTEGER column a.b.id";
    assert.equal(constraintFailure(new Error(message)), null);
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("the datatype-mismatch pattern only matches at the very start of the message: a boundary input, not engine text", () => {
    // bareMessage() removes the D1_ERROR prefix and the trailing extended
    // result code before a rule ever sees the text (see the comment above
    // the RULES array), so a message reaching this point never carries an
    // arbitrary word before "cannot store"; this made-up prefix isolates
    // the ^ anchor.
    const message = "unrelated prefix cannot store TEXT value in INTEGER column a.b.id";
    assert.equal(constraintFailure(new Error(message)), null);
    assert.deepEqual(failureClass(new Error(message)), { kind: "unclassified" });
  });

  test("the D1_ERROR prefix strip ahead of the reset-wrapper check tolerates zero whitespace after the colon", () => {
    // The strip at the reset-wrapper check is `/^D1_ERROR:\s*/` -- zero or
    // more whitespace. The boundary is 0 characters: no space at all
    // between the colon and the wrapper text. A message with exactly one
    // space passes even if the strip required one space, took non-space
    // characters, or replaced the prefix instead of removing it.
    const message = 'D1_ERROR:Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: something the parser does not recognize';
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("the reset wrapper only matches at the very start of the message: a boundary input, not engine text", () => {
    // The reset wrapper feeds off `raw` with only the D1_ERROR prefix
    // stripped (see the RESET_WRAPPER check in failureClass()), so real
    // input never carries an arbitrary word before "Durable Object was
    // reset"; this made-up prefix isolates the ^ anchor.
    const message = "prefix noise Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: something the parser does not recognize";
    assert.deepEqual(failureClass(new Error(message)), { kind: "unclassified" });
  });

  test("the reset wrapper matches with zero characters between its colon and the text that follows", () => {
    // Boundary input: the wrapper's own trailing \s* accepts zero
    // whitespace characters between the colon and the text that follows.
    const message = "Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated:something the parser does not recognize";
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("the local D1_ERROR strip ahead of the reset-wrapper check only removes a prefix at the very start", () => {
    // Boundary input, not real engine text: "D1_ERROR: " sits after an
    // unrelated word, placed so that removing only that span would splice
    // the remaining text into the reset wrapper's own opening words. The
    // strip must leave the leading word in place, so the reset wrapper's
    // own ^ anchor still finds no match here.
    const message = "Durable D1_ERROR: Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: something the parser does not recognize";
    assert.deepEqual(failureClass(new Error(message)), { kind: "unclassified" });
  });

  test("a message that is empty on its first read is unclassified, even when a later read of the same error returns rule text", () => {
    // failureClass() reaches .message three times (errorDetails() reads it
    // once per call); a getter with side effects could answer differently
    // each time it is read.
    let reads = 0;
    const error = { get message() { reads += 1; return reads === 1 ? "" : "Network connection lost."; } };
    assert.deepEqual(failureClass(error), { kind: "unclassified" });
  });

  test("database is locked: transient, not_applied", () => {
    assert.deepEqual(failureClass(new Error("database is locked")), { kind: "transient", outcome: "not_applied", reason: "sqlite_busy" });
  });

  test("SQLITE_BUSY alone, with neither SQLITE_LOCKED nor 'database is locked' in the text, still reports sqlite_busy", () => {
    // sqlite_busy's test is `A || B || C`; the case above only ever
    // exercises C. This isolates A: without it, the message would fall
    // through to the sqlite_code catch-all.
    assert.deepEqual(failureClass(new Error("disk I/O error: SQLITE_BUSY")), { kind: "transient", outcome: "not_applied", reason: "sqlite_busy" });
  });

  test("an unresolved constraint message that also carries a trailing SQLITE_CONSTRAINT code reports unresolved_constraint, not sqlite_code", () => {
    // A comma, not the colon bareMessage()'s suffix strip requires, so the
    // SQLITE_ text survives into the rule loop: this is the case the
    // ordering fix (unresolved_constraint before sqlite_code) exists for.
    assert.deepEqual(failureClass(new Error("weird constraint failed, SQLITE_CONSTRAINT")), { kind: "permanent", reason: "unresolved_constraint" });
  });

  test("no rule matches", () => {
    assert.deepEqual(failureClass(new Error("some other engine message")), { kind: "unclassified" });
  });

  test("not an Error", () => {
    assert.deepEqual(failureClass("plain string"), { kind: "unclassified" });
    assert.deepEqual(failureClass(null), { kind: "unclassified" });
    assert.deepEqual(failureClass(undefined), { kind: "unclassified" });
    assert.deepEqual(failureClass(42), { kind: "unclassified" });
  });

  test("an exception thrown inside the rule loop is caught and reported as unclassified", () => {
    // errorDetails() already declines on an unreadable property (ADR
    // 0082) inside its own try/catch, so this instead breaks a plain
    // string method the rule loop calls on text errorDetails() already
    // read successfully, to reach the catch this function wraps around
    // its own body.
    const original = String.prototype.startsWith;
    const sentinel = "an unrelated message this test controls";
    let threw = false;
    String.prototype.startsWith = function (...args: Parameters<typeof original>) {
      if (this === sentinel) {
        threw = true;
        throw new Error("forced failure for this test");
      }
      return original.apply(this, args);
    };
    try {
      assert.deepEqual(failureClass(new Error(sentinel)), { kind: "unclassified" });
    } finally {
      String.prototype.startsWith = original;
    }
    assert.equal(threw, true);
  });

  test("never throws, and always returns a valid kind, for any thrown value", () => {
    const arbitraryError = gs.text({ maxSize: 40 }).map((m) => new Error(m));
    const arbitraryValue = gs.oneOf(
      gs.just(null),
      gs.just(undefined),
      gs.integers(),
      gs.text({ maxSize: 40 }),
      gs.just({}),
      arbitraryError,
    );
    hegel.test((tc) => {
      const value = tc.draw(arbitraryValue);
      const result = failureClass(value);
      assert.ok(["transient", "permanent", "unclassified"].includes(result.kind));
      if (result.kind === "transient") assert.ok(["not_applied", "unknown"].includes(result.outcome));
    });
  });

  test("for any random string wrapped as an Error, the result is unclassified or a rule that really matches", () => {
    const messages = gs.text({ maxSize: 60 });
    hegel.test((tc) => {
      const message = tc.draw(messages);
      const result = failureClass(new Error(message));
      if (result.kind === "unclassified") return;
      // Every non-unclassified result must be traceable to text the
      // random message actually contains, never a guess.
      const known = [
        "Durable Object is overloaded.",
        "Your account is generating too much load on Durable Objects. Please back off and try again later.",
        "Your account is doing too many concurrent storage operations. Please back off and try again later.",
        "D1 DB is overloaded.",
        "Cannot resolve D1 DB due to transient issue on remote node.",
        "Network connection lost",
        "Replica disconnected from primary.",
        "reset because its code was updated",
        "storage operation exceeded timeout which caused object to be reset",
        "Internal error while starting up D1 DB storage caused object to be reset.",
        "Internal error in D1 DB storage caused object to be reset.",
        "D1_EXEC_ERROR",
        "sql error: near \"",
        "D1_TYPE_ERROR",
        "D1_COLUMN_NOTFOUND",
        "no such table",
        "no such column",
        "SQLITE_",
        "constraint failed",
        "cannot store",
        "constraints were violated:",
        "database is locked",
      ];
      assert.ok(known.some((k) => message.includes(k)), `unexpected match for ${JSON.stringify(message)}: ${JSON.stringify(result)}`);
    });
  });
});
