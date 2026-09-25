// Responsibility: prove a declared column rename has one exact, data-safe
// mapping. Boundary: CLI file parsing is covered by cli.test.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { diff, introspect, open, shape } from "../src/build/migration.ts";
import { parseMigrationIntent } from "../src/build/migration-intent.ts";

const currentDdl = 'create table "order.lines" (id integer primary key, "old.value" text)';
const targetDdl = 'create table "order.lines" (id integer primary key, "new.value" text)';
const targetWithAddDdl = 'create table "order.lines" (id integer primary key, "new.value" text, added text)';
const rename = { table: "order.lines", from: "old.value", to: "new.value" };

test("a singleton rename repair is structured, shell-safe, and composes with an add", () => {
  const current = open([currentDdl]);
  const target = open([targetDdl]);
  const targetWithAdd = open([targetWithAddDdl]);
  try {
    const blocked = diff(introspect(current), introspect(target));
    assert.equal(blocked.kind, "blocked");
    if (blocked.kind !== "blocked") return;
    assert.deepEqual(blocked.renames, [rename]);
    assert.deepEqual(blocked.renameCandidates, [{ table: "order.lines", from: ["old.value"], to: ["new.value"] }]);
    // A rename plus a new nullable column is a safe composed migration.
    const plan = diff(introspect(current), introspect(targetWithAdd), [rename]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind === "ok") {
      assert.ok(plan.statements.includes('alter table "order.lines" rename column "old.value" to "new.value"'));
      assert.ok(plan.statements.includes('alter table "order.lines" add column added text'));
    }
  } finally {
    current.close();
    target.close();
    targetWithAdd.close();
  }
});

test("a two-column rename candidate has no exact mapping and both orders remain candidates", () => {
  const current = open(['create table "order.lines" (id integer primary key, "old.a" text, "old.b" text)']);
  const target = open(['create table "order.lines" (id integer primary key, "new.a" text, "new.b" text)']);
  try {
    const blocked = diff(introspect(current), introspect(target));
    assert.equal(blocked.kind, "blocked");
    if (blocked.kind !== "blocked") return;
    assert.equal(blocked.renames, undefined, "a two-column change must not offer an inferred mapping");
    assert.equal(blocked.renameCandidates?.length, 1);
    const candidate = blocked.renameCandidates![0]!;
    assert.equal(candidate.table, "order.lines");
    assert.deepEqual([...candidate.from].sort(), ["old.a", "old.b"]);
    assert.deepEqual([...candidate.to].sort(), ["new.a", "new.b"]);
  } finally {
    current.close();
    target.close();
  }
});

test("rename declarations reject malformed, unused, duplicate, chained, conflicting, and missing mappings", () => {
  assert.throws(() => parseMigrationIntent('{"version":1,"drops":[],"renames":[{"table":"t","from":"a","to":"b","extra":true}]}'), /Invalid migration intent/);
  const current = open(["create table t (a text, b text, c text)"]);
  const target = open(["create table t (x text, y text)"]);
  const unusedTarget = open(["create table t (a text, x text)"]);
  try {
    const cases = [
      [[{ table: "t", from: "a", to: "x" }, { table: "t", from: "a", to: "x" }], /repeats/],
      [[{ table: "t", from: "a", to: "x" }, { table: "t", from: "a", to: "y" }], /conflicts/],
      [[{ table: "t", from: "a", to: "b" }, { table: "t", from: "b", to: "x" }], /chains/],
      [[{ table: "t", from: "missing", to: "x" }], /missing source column/],
      [[{ table: "t", from: "b", to: "missing" }], /missing target column/],
    ] as const;
    for (const [renames, message] of cases) {
      const plan = diff(introspect(current), introspect(target), renames);
      assert.equal(plan.kind, "blocked");
      if (plan.kind === "blocked") assert.match(plan.reason, message);
    }
    const unused = diff(introspect(current), introspect(unusedTarget), [{ table: "t", from: "a", to: "x" }]);
    assert.equal(unused.kind, "blocked");
    if (unused.kind === "blocked") assert.match(unused.reason, /unused because its source remains/);
  } finally {
    current.close();
    target.close();
    unusedTarget.close();
  }
});

test("a rename intent that differs from the declared DDL only in case is rejected, not folded", () => {
  const current = open(["create table t (a text)"]);
  const target = open(["create table t (b text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t", from: "A", to: "b" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /missing source column.*case/i);
  } finally {
    current.close();
    target.close();
  }
});

test("a generated rename preserves populated values and row identifiers", () => {
  let cases = 0;
  hegel.test(tc => {
    cases++;
    const id = tc.draw(gs.integers({ minValue: -1_000_000, maxValue: 1_000_000 }));
    const value = tc.draw(gs.text({ maxSize: 80 }));
    const current = open(["create table items (id integer primary key, old_value text)"]);
    const target = open(["create table items (id integer primary key, new_value text)"]);
    try {
      current.prepare("insert into items (id, old_value) values (?, ?)").run(id, value);
      const blocked = diff(introspect(current), introspect(target));
      assert.equal(blocked.kind, "blocked");
      if (blocked.kind !== "blocked") return;
      const plan = diff(introspect(current), introspect(target), blocked.renames!);
      assert.equal(plan.kind, "ok");
      if (plan.kind !== "ok") return;
      for (const statement of plan.statements) current.exec(statement);
      assert.deepEqual({ ...current.prepare("select rowid as identity, id, new_value from items").get() }, { identity: id, id, new_value: value });
      assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
    } finally {
      current.close();
      target.close();
    }
  }, { testCases: 100 });
  console.log("rename preservation cases:", cases);
});

test("a rename, an exact column drop, and a safe add share one populated migration", () => {
  const current = open(["create table items (id integer primary key, old_value text, obsolete text)"]);
  const target = open(["create table items (id integer primary key, new_value text, added text)"]);
  try {
    current.prepare("insert into items (id, old_value, obsolete) values (42, 'kept', 'discarded')").run();
    const rename = { table: "items", from: "old_value", to: "new_value" };
    // The remaining removed column could be mistaken for a second rename
    // until the exact reviewed drop removes it from the candidate set.
    const withoutDrop = diff(introspect(current), introspect(target), [rename]);
    assert.equal(withoutDrop.kind, "blocked");
    if (withoutDrop.kind === "blocked") assert.match(withoutDrop.reason, /obsolete.*added/);
    const plan = diff(introspect(current), introspect(target), [rename], [{ kind: "column", table: "items", column: "obsolete" }]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.deepEqual(plan.statements, [
      'alter table "items" rename column "old_value" to "new_value"',
      'alter table "items" drop column "obsolete"',
      "alter table \"items\" add column added text",
    ]);
    for (const statement of plan.statements) current.exec(statement);
    assert.deepEqual({ ...current.prepare("select rowid as identity, id, new_value, added from items").get() }, { identity: 42, id: 42, new_value: "kept", added: null });
    assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
  } finally {
    current.close();
    target.close();
  }
});
