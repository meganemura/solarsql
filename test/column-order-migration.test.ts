// Responsibility: a table's shape (its columns and foreign keys) compares as
// a set, keyed by name, not as an ordered list. Declaration order is not
// part of the shape: `ALTER TABLE ... ADD COLUMN` always appends, so two
// histories that are each legitimate on their own can end up with the same
// columns in a different order (two branches each adding a column, merged
// in either order; a human resolving a merge by hand). tableShape() (used by
// both diff() and shape()) sorts columns and foreign keys before comparing,
// the same way it already sorted constraints, so a reorder with no other
// change is a no-op migration, not a rebuild or a block.
// Boundary: this file pins diff()'s own comparison. The RebuildRecord check
// a replay runs (ADR 0099/0101/0102, applied()/durable.ts's migrate()) is
// already order-insensitive and is not touched here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { applied, diff, introspect, open } from "../src/build/migration.ts";

test("a table reorder with a dependent view is a no-op, not a rebuild", () => {
  // Mirrors example/modules/customers/module.ts (name/email swapped) and
  // example/modules/reports/module.ts's confirmed_orders view, which reads
  // customers.name: a genuine repro, not only a synthetic fixture.
  const orders = `
    create table orders (
      id text primary key not null,
      customer_id text not null references customers(id),
      status text not null check (status in ('draft', 'confirmed')),
      note text,
      updated_at text
    ) strict`;
  const view = `
    create view confirmed_orders as
    select o.id, o.customer_id, c.name as customer_name
    from orders o join customers c on c.id = o.customer_id
    where o.status = 'confirmed'`;
  const customersDeclared = `
    create table customers (
      id text primary key not null,
      name text not null check (length(name) > 0),
      email text not null unique
    ) strict`;
  const customersReordered = `
    create table customers (
      id text primary key not null,
      email text not null unique,
      name text not null check (length(name) > 0)
    ) strict`;
  const current = open([customersDeclared, orders, view]);
  const target = open([customersReordered, orders, view]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.deepEqual(plan, { kind: "ok", statements: [] });
  } finally {
    current.close();
    target.close();
  }
});

test("two independently generated ADD COLUMNs, replayed and then declared in the opposite order, diff to nothing", () => {
  const base = "create table t (id integer primary key not null) strict;";
  const addX = "alter table t add column x text;";
  const addY = "alter table t add column y text;";
  // Branch A's migration adds x; branch B's, generated independently, adds
  // y. Replayed in B-then-A file order, the live table ends up [id, x, y]
  // only because applied() below runs A's file first -- what matters is
  // that the declared schema below lists the pair in the opposite order
  // from however the migration files actually ran.
  const current = applied([base, addX, addY]);
  const target = open(["create table t (id integer primary key not null, y text, x text) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.deepEqual(plan, { kind: "ok", statements: [] });
  } finally {
    current.close();
    target.close();
  }
});

test("a parent reordered under an ON DELETE CASCADE child is a no-op, not a block", () => {
  const childDdl = `
    create table children (
      id integer primary key not null,
      parent_id integer references parents(id) on delete cascade
    ) strict`;
  const parentsDeclared = `create table parents (id integer primary key not null, a text, b text) strict`;
  const parentsReordered = `create table parents (id integer primary key not null, b text, a text) strict`;
  const current = open([parentsDeclared, childDdl]);
  const target = open([parentsReordered, childDdl]);
  try {
    // On HEAD before this fix, this table's reorder made diff() propose a
    // rebuild of parents, which this file's foreign key blocked outright
    // (kind: "blocked") -- with a reason naming a change the declared
    // schema never made and never mentioning column order.
    const plan = diff(introspect(current), introspect(target));
    assert.deepEqual(plan, { kind: "ok", statements: [] });
  } finally {
    current.close();
    target.close();
  }
});

test("reordering columns that each carry their own inline foreign key is a no-op", () => {
  const p1 = "create table p1 (id integer primary key not null) strict";
  const p2 = "create table p2 (id integer primary key not null) strict";
  const tDeclared = `create table t (id integer primary key not null, a integer references p1(id), b integer references p2(id)) strict`;
  const tReordered = `create table t (id integer primary key not null, b integer references p2(id), a integer references p1(id)) strict`;
  const current = open([p1, p2, tDeclared]);
  const target = open([p1, p2, tReordered]);
  try {
    // pragma_foreign_key_list follows declaration order, so reordering the
    // columns above also reorders introspect()'s foreignKeys array: this is
    // the fact that makes sorting columns alone insufficient.
    const currentKeys = introspect(current).tables.get("t")!.foreignKeys.map((f) => f.from);
    const targetKeys = introspect(target).tables.get("t")!.foreignKeys.map((f) => f.from);
    assert.notDeepEqual(currentKeys, targetKeys);
    const plan = diff(introspect(current), introspect(target));
    assert.deepEqual(plan, { kind: "ok", statements: [] });
  } finally {
    current.close();
    target.close();
  }
});

test("a genuine column add alongside an unrelated reorder is a single ALTER, not a rebuild", () => {
  const current = open(["create table t (id integer primary key not null, a text, b text) strict"]);
  // b and a swap (a merge's unrelated reorder) while c is genuinely new.
  const target = open(["create table t (id integer primary key not null, b text, a text, c text) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok");
    if (plan.kind !== "ok") return;
    assert.equal(plan.statements.length, 1, JSON.stringify(plan.statements));
    assert.match(plan.statements[0]!, /add column/i);
    assert.equal(plan.rebuilds ?? undefined, undefined);
  } finally {
    current.close();
    target.close();
  }
});

// The cheap-ALTER candidate at tableStatements' scratch check must still
// reject a candidate whose resulting column set is genuinely wrong -- not
// only differently ordered -- and fall through to a rebuild. A reorder is
// present in both cases below so the order-insensitive comparison is
// actually exercised, not sidestepped.
test("a reorder that also retypes a column still falls through to a rebuild", () => {
  const current = open(["create table t (id integer primary key not null, a text, b text) strict"]);
  // a and b swap position, and b's type also changes: the column set's
  // names match, so no ADD/DROP COLUMN is proposed, and the scratch check
  // must still see the shapes differ.
  const target = open(["create table t (id integer primary key not null, b integer, a text) strict"]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), `expected a rebuild, got ${JSON.stringify(plan.statements)}`);
  } finally {
    current.close();
    target.close();
  }
});

test("a reorder that also changes a foreign key's ON DELETE action still falls through to a rebuild", () => {
  const p = "create table p (id integer primary key not null) strict";
  const current = open([p, `create table t (id integer primary key not null, a integer references p(id) on delete cascade, b integer references p(id)) strict`]);
  // a and b swap position, and a's ON DELETE action also changes: the
  // column names and foreign-key source columns match, so the scratch
  // check must still see the foreign keys' own fields differ.
  const target = open([p, `create table t (id integer primary key not null, b integer references p(id), a integer references p(id) on delete set null) strict`]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), `expected a rebuild, got ${JSON.stringify(plan.statements)}`);
  } finally {
    current.close();
    target.close();
  }
});

// Property: a table's own columns, permuted two different ways, always diff
// to nothing; a table whose declaration differs by one genuine field never
// diffs to nothing.
const names = ["c1", "c2", "c3", "c4", "c5"];
const types = ["text", "integer", "real"] as const;
type ColumnType = (typeof types)[number];
type Col = { name: string; type: ColumnType; notnull: boolean; hasDefault: boolean };

function columnDdl(c: Col): string {
  let s = `${c.name} ${c.type}`;
  if (c.notnull) s += " not null";
  if (c.hasDefault) s += ` default ${c.type === "text" ? "'d'" : c.type === "integer" ? "0" : "0.5"}`;
  return s;
}

function tableDdl(order: readonly Col[]): string {
  return `create table t (id integer primary key not null, ${order.map(columnDdl).join(", ")}) strict`;
}

// Fisher-Yates, driven by hegel's own randomness so shrinking still works.
function permute<T>(tc: hegel.TestCase, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = tc.draw(gs.integers({ minValue: 0, maxValue: i }));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const colGen = gs.composite((tc): Col => ({
  name: tc.draw(gs.sampledFrom(names)),
  type: tc.draw(gs.sampledFrom(types)),
  notnull: tc.draw(gs.booleans()),
  hasDefault: tc.draw(gs.booleans()),
}));

function distinct(columns: readonly Col[]): Col[] {
  const seen = new Set<string>();
  return columns.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

test("diff() ignores a column-only reorder and still notices a genuine field change", () => {
  hegel.test((tc) => {
    const columns = distinct(tc.draw(gs.arrays(colGen, { minSize: 1, maxSize: 4 })));
    const orderA = permute(tc, columns);
    const orderB = permute(tc, columns);
    const current = open([tableDdl(orderA)]);
    try {
      const target = open([tableDdl(orderB)]);
      try {
        const plan = diff(introspect(current), introspect(target));
        assert.deepEqual(plan, { kind: "ok", statements: [] }, `orderA=${JSON.stringify(orderA)} orderB=${JSON.stringify(orderB)}`);
      } finally {
        target.close();
      }

      // One genuine field change on one column, kept distinct from the
      // permutation above so a same-DDL mutation (a no-op edit) cannot pass
      // this assertion by accident.
      const victim = tc.draw(gs.integers({ minValue: 0, maxValue: columns.length - 1 }));
      const field = tc.draw(gs.sampledFrom(["type", "notnull", "hasDefault"] as const));
      const mutated = orderB.map((c, i) => {
        if (i !== victim) return c;
        if (field === "type") return { ...c, type: types.find((t) => t !== c.type)! };
        if (field === "notnull") return { ...c, notnull: !c.notnull };
        return { ...c, hasDefault: !c.hasDefault };
      });
      if (columnDdl(mutated[victim]!) === columnDdl(orderB[victim]!)) return; // no actual change to assert against
      const mutatedTarget = open([tableDdl(mutated)]);
      try {
        const plan = diff(introspect(current), introspect(mutatedTarget));
        assert.ok(plan.kind !== "ok" || plan.statements.length > 0, `expected a change for ${JSON.stringify({ orderA, mutated })}`);
      } finally {
        mutatedTarget.close();
      }
    } finally {
      current.close();
    }
  }, { testCases: 200 });
});
