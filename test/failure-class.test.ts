// One example per rule, in the exact text the cited Cloudflare pages
// quote, plus the two prefixes bareMessage() strips before a rule ever
// sees the text. A Hegel property covers what the example cases cannot:
// that failureClass() never throws, and that a match it reports is real.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { failureClass } from "../src/runtime/failure.ts";

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

  test("the D1_ERROR prefix strip ahead of the reset-wrapper check tolerates zero whitespace after the colon", () => {
    // The strip at the reset-wrapper check is `/^D1_ERROR:\s*/` -- zero or
    // more whitespace. The boundary is 0 characters: no space at all
    // between the colon and the wrapper text. A message with exactly one
    // space passes even if the strip required one space, took non-space
    // characters, or replaced the prefix instead of removing it.
    const message = 'D1_ERROR:Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: something the parser does not recognize';
    assert.deepEqual(failureClass(new Error(message)), { kind: "permanent", reason: "unresolved_constraint" });
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
