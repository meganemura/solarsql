// Responsibility: require an exact declaration before generated SQL removes
// ordinary data containers. Boundary: virtual search tables keep their own
// replace-on-change rule in search-migration.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { diff, introspect, open, shape, type DropIntent } from "../src/build/migration.ts";
import { parseMigrationIntent } from "../src/build/migration-intent.ts";

function schema(columns: readonly string[]): string {
  return `create table "order.lines" (${["kept text", ...columns.map(column => `"${column}" text`)].join(", ")})`;
}

test("ordinary table and column removals need their exact intent", () => {
  const current = open([schema(["old.column"]), 'create table "retired.table" (id integer)']);
  const target = open([schema([])]);
  try {
    const blocked = diff(introspect(current), introspect(target));
    assert.equal(blocked.kind, "blocked");
    if (blocked.kind !== "blocked") return;
    assert.match(blocked.reason, /column "order\.lines"\."old\.column", table "retired\.table"/);
    assert.deepEqual(blocked.drops, [
      { kind: "column", table: "order.lines", column: "old.column" },
      { kind: "table", table: "retired.table" },
    ]);
    const accepted = diff(introspect(current), introspect(target), [], blocked.drops);
    assert.equal(accepted.kind, "ok");
    if (accepted.kind !== "ok") return;
    for (const statement of accepted.statements) current.exec(statement);
    assert.deepEqual(shape(introspect(current)), shape(introspect(target)));

    const duplicate = diff(introspect(open([schema(["old.column"])])), introspect(open([schema([])])), [], [
      { kind: "column", table: "order.lines", column: "old.column" },
      { kind: "column", table: "order.lines", column: "old.column" },
    ]);
    assert.equal(duplicate.kind, "blocked");
    if (duplicate.kind === "blocked") assert.match(duplicate.reason, /repeats column "order\.lines"\."old\.column"/);
  } finally {
    current.close();
    target.close();
  }
});

test("a rename consumes its source column before the drop check", () => {
  const current = open([schema(["before"])]);
  const target = open([schema(["after"])]);
  try {
    const plan = diff(introspect(current), introspect(target), [{ table: "order.lines", from: "before", to: "after" }]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind === "ok") assert.ok(plan.statements.some(statement => /rename column "before" to "after"/.test(statement)));
  } finally {
    current.close();
    target.close();
  }
});

test("a removed parent with a surviving cascading child needs an explicit migration", () => {
  const current = open([
    "pragma foreign_keys = on",
    "create table parents (id integer primary key)",
    "create table children (id integer primary key, parent_id integer not null references parents(id) on delete cascade)",
    "insert into parents values (1)",
    "insert into children values (1, 1)",
  ]);
  const target = open([
    "pragma foreign_keys = on",
    "create table children (id integer primary key, parent_id integer not null references parents(id) on delete cascade)",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target), [], [{ kind: "table", table: "parents" }]);
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /children\.parent_id has ON DELETE CASCADE.*Write an explicit migration/);
    // No generated DROP reaches the populated database, so its surviving
    // child row remains available for the explicit migration to preserve.
    assert.deepEqual(current.prepare("select id, parent_id from children").all().map(row => ({ ...row })), [{ id: 1, parent_id: 1 }]);
  } finally {
    current.close();
    target.close();
  }
});

test("parent removal checks delete actions in both schema versions", () => {
  for (const actionSchema of ["current", "target"] as const) {
    const child = (action: boolean) => `create table children (id integer primary key, parent_id integer${action ? " references parents(id) on delete set null" : ""})`;
    const current = open(["create table parents (id integer primary key)", child(actionSchema === "current")]);
    const target = open([child(actionSchema === "target")]);
    try {
      const plan = diff(introspect(current), introspect(target), [], [{ kind: "table", table: "parents" }]);
      assert.equal(plan.kind, "blocked", actionSchema);
      if (plan.kind === "blocked") assert.match(plan.reason, /children\.parent_id has ON DELETE SET NULL/);
    } finally {
      current.close();
      target.close();
    }
  }
});

test("the intent parser accepts only version one intent objects", () => {
  assert.deepEqual(parseMigrationIntent('{"version":1,"drops":[{"kind":"column","table":"order.lines","column":"old.column"}],"renames":[]}'), {
    drops: [{ kind: "column", table: "order.lines", column: "old.column" }], renames: [],
  });
  for (const text of [
    "not json",
    '{"version":2,"drops":[]}',
    '{"version":1,"drops":[]}',
    '{"version":1,"drops":[{"kind":"table","table":"t","extra":true}]}',
    '{"version":1,"drops":[{"kind":"virtual","table":"search"}]}',
  ]) assert.throws(() => parseMigrationIntent(text), /Invalid migration intent/);
});

test("an exact intent is necessary and sufficient for every generated column removal", () => {
  let cases = 0;
  hegel.test(tc => {
    cases++;
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
    const removed = Array.from({ length: count }, (_, index) => `drop_${index}`)
      .filter(() => tc.draw(gs.booleans()));
    const names = removed.length === 0 ? ["drop_0"] : removed;
    const current = open([schema(names)]);
    const target = open([schema([])]);
    try {
      const blocked = diff(introspect(current), introspect(target));
      assert.equal(blocked.kind, "blocked");
      if (blocked.kind !== "blocked") return;
      const drops = blocked.drops!;
      assert.deepEqual(drops, names.map(column => ({ kind: "column", table: "order.lines", column })));
      const accepted = diff(introspect(current), introspect(target), [], drops);
      assert.equal(accepted.kind, "ok");
      const extra: DropIntent = { kind: "column", table: "order.lines", column: "not_removed" };
      const rejected = diff(introspect(current), introspect(target), [], [...drops, extra]);
      assert.equal(rejected.kind, "blocked");
    } finally {
      current.close();
      target.close();
    }
  }, { testCases: 100 });
  console.log("destructive intent cases:", cases);
});

test("an exact intent is necessary and sufficient for generated table removals", () => {
  let cases = 0;
  hegel.test(tc => {
    cases++;
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
    const current = open(Array.from({ length: count }, (_, index) => `create table removed_${index} (id integer primary key, value text)`));
    const target = open([]);
    try {
      const blocked = diff(introspect(current), introspect(target));
      assert.equal(blocked.kind, "blocked");
      if (blocked.kind !== "blocked") return;
      const drops = blocked.drops!;
      assert.deepEqual(drops, Array.from({ length: count }, (_, index) => ({ kind: "table" as const, table: `removed_${index}` })));
      const accepted = diff(introspect(current), introspect(target), [], drops);
      assert.equal(accepted.kind, "ok");
      if (accepted.kind === "ok") for (const statement of accepted.statements) current.exec(statement);
      assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
    } finally {
      current.close();
      target.close();
    }
  }, { testCases: 100 });
  console.log("destructive table intent cases:", cases);
});

test("virtual search removal remains automatic with or without an empty intent", () => {
  let cases = 0;
  hegel.test(tc => {
    cases++;
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
    const ordinary = "create table items (id integer primary key, value text)";
    const searches = Array.from({ length: count }, (_, index) => `create virtual table item_search_${index} using fts5(value)`);
    const current = open([ordinary, ...searches]);
    const target = open([ordinary]);
    try {
      for (const plan of [diff(introspect(current), introspect(target)), diff(introspect(current), introspect(target), [], [])]) {
        assert.equal(plan.kind, "ok");
        if (plan.kind === "ok") assert.deepEqual(plan.statements, Array.from({ length: count }, (_, index) => `drop table "item_search_${index}"`));
      }
    } finally {
      current.close();
      target.close();
    }
  }, { testCases: 100 });
  console.log("virtual search removal cases:", cases);
});
