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

// A declared rename names one table. renameRepairPlan() (the generator's own
// suggestion when a rename is missing) must not apply another table's rename
// to a table it was never declared for, even when the two tables' column
// changes happen to share the same "to" spelling.
test("a rename declared for one table does not repair an unrelated column change on another table", () => {
  const current = open([
    "create table t1 (id integer primary key not null, a text not null) strict",
    "create table t2 (id integer primary key not null, x text not null) strict",
  ]);
  const target = open([
    "create table t1 (id integer primary key not null, b text not null) strict",
    "create table t2 (id integer primary key not null, y text not null) strict",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t1", from: "a", to: "b" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind !== "blocked") return;
    // t1's own rename already explains its change: only t2 needs a repair.
    assert.deepEqual(plan.renameCandidates, [{ table: "t2", from: ["x"], to: ["y"] }]);
    assert.deepEqual(plan.renames, [{ table: "t2", from: "x", to: "y" }]);
  } finally {
    current.close();
    target.close();
  }
});

// A rename's own "to" column must count as already accounted for on its own
// table: renameRepairPlan()'s working copy of that table's columns adds the
// "to" name back in after removing the "from" name, so a sibling column
// change on the SAME table does not mistake the rename's own target for
// something still missing.
test("a rename's own target column does not leak into a sibling repair candidate for the same table", () => {
  const current = open(["create table t (id integer primary key not null, x text not null, y text not null) strict"]);
  const target = open(["create table t (id integer primary key not null, z text not null, w text not null) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t", from: "x", to: "z" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind !== "blocked") return;
    // The rename already explains x -> z: only y -> w needs a repair.
    assert.deepEqual(plan.renameCandidates, [{ table: "t", from: ["y"], to: ["w"] }]);
    assert.deepEqual(plan.renames, [{ table: "t", from: "y", to: "w" }]);
  } finally {
    current.close();
    target.close();
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

// A rename intent naming the same column as both its own source and target
// is rejected for not changing anything -- not mistaken for a chain (that
// check must skip comparing a rename against itself) and not mistaken for a
// conflict (the "does not change a column" check must run first).
test("a rename intent naming the same column on both sides is rejected for not changing it, not as a chain", () => {
  const current = open(["create table t (id integer primary key, a text)"]);
  const target = open(["create table t (id integer primary key, a text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t", from: "a", to: "a" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /does not change a column/);
  } finally {
    current.close();
    target.close();
  }
});

// The chain check compares a rename against every *other* declared rename,
// scoped to renames on the same table: two renames on different tables that
// coincidentally share a from/to spelling are not a chain.
test("renames on different tables do not chain merely by sharing a column spelling", () => {
  const current = open(["create table t1 (id integer primary key, a text)", "create table t2 (id integer primary key, shared text)"]);
  const target = open(["create table t1 (id integer primary key, shared text)", "create table t2 (id integer primary key, z text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t1", from: "a", to: "shared" }, { table: "t2", from: "shared", to: "z" }]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
  } finally {
    current.close();
    target.close();
  }
});

test("a rename naming a table absent from both schemas, or only from the target, is rejected the same way", () => {
  const current = open(["create table t (a text)", "create table onlycurrent (x text)"]);
  const target = open(["create table t (b text)"]);
  try {
    for (const rename of [{ table: "nonexistent", from: "a", to: "b" }, { table: "onlycurrent", from: "x", to: "y" }]) {
      const plan = diff(introspect(current), introspect(target), [rename]);
      assert.equal(plan.kind, "blocked", rename.table);
      if (plan.kind === "blocked") assert.match(plan.reason, /missing source or target table/);
    }
  } finally {
    current.close();
    target.close();
  }
});

// Two independent renames on different tables must not collide merely
// through a shared internal map key: each rename's source and target are
// keyed by both its table and its column name, not by the column alone.
test("independent renames on different tables with the same column spellings do not conflict with each other", () => {
  const current = open(["create table t1 (a text)", "create table t2 (c text)"]);
  const target = open(["create table t1 (b text)", "create table t2 (d text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t1", from: "a", to: "b" }, { table: "t2", from: "c", to: "d" }]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
  } finally {
    current.close();
    target.close();
  }
});

// Two renames that target the same destination column on the same table
// really do conflict, and this is what actually detects that: a source
// column can only donate its rows to the target column once.
test("two renames that target the same destination column on the same table conflict", () => {
  const current = open(["create table t (a text, e text)"]);
  const target = open(["create table t (x text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t", from: "a", to: "x" }, { table: "t", from: "e", to: "x" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /rename intent conflicts at/);
  } finally {
    current.close();
    target.close();
  }
});

// A declared rename's own reviewed source column must not, in turn, hide an
// unrelated removed-and-added column pair on the SAME table from the
// generator's rename-repair suggestion: the exclusion is keyed on the exact
// table and column the drop names, not merely on any drop being present.
test("a reviewed drop for one column does not hide a sibling column's own rename-repair candidate", () => {
  const current = open(["create table t (id integer primary key, colA text, colB text)"]);
  const target = open(["create table t (id integer primary key, colC text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [], [{ kind: "column", table: "t", column: "colA" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind !== "blocked") return;
    assert.deepEqual(plan.renameCandidates, [{ table: "t", from: ["colB"], to: ["colC"] }]);
    assert.deepEqual(plan.renames, [{ table: "t", from: "colB", to: "colC" }]);
  } finally {
    current.close();
    target.close();
  }
});

// The same exclusion is also scoped by table: a reviewed drop for another
// table's column must not hide THIS table's own rename-repair candidate
// merely because the two tables happen to share a column spelling.
test("a reviewed drop for one table does not hide another table's own rename-repair candidate", () => {
  const current = open(["create table t (id integer primary key, shared text)", "create table u (id integer primary key, shared text)"]);
  const target = open(["create table t (id integer primary key, renamed_to text)", "create table u (id integer primary key)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [], [{ kind: "column", table: "u", column: "shared" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind !== "blocked") return;
    assert.deepEqual(plan.renameCandidates, [{ table: "t", from: ["shared"], to: ["renamed_to"] }]);
    assert.deepEqual(plan.renames, [{ table: "t", from: "shared", to: "renamed_to" }]);
  } finally {
    current.close();
    target.close();
  }
});

// A rename's target name must not already be a source column: that column
// still has to go somewhere, and this rename does not say where.
test("a rename intent whose target column already exists as a source column is rejected", () => {
  const current = open(["create table t (a text, b text)"]);
  const target = open(["create table t (b text)"]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "t", from: "a", to: "b" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /conflicts with an existing source column/);
  } finally {
    current.close();
    target.close();
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

// A declared rename explains away its own table's removed column. It must
// not also explain away an unrelated table's own removed column that
// happens to share the same "from" spelling: required review is scoped per
// table, matching the rename declaration itself.
test("a declared rename does not excuse another table's own column removal, sharing only its spelling", () => {
  const current = open(["create table t1 (id integer primary key, a text)", "create table t2 (id integer primary key, a text, c text)"]);
  const target = open(["create table t1 (id integer primary key, b text)", "create table t2 (id integer primary key, b text)"]);
  try {
    const renames = [{ table: "t1", from: "a", to: "b" }, { table: "t2", from: "c", to: "b" }];
    const plan = diff(introspect(current), introspect(target), renames);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /removes ordinary objects: column "t2"\."a"/);
  } finally {
    current.close();
    target.close();
  }
});
