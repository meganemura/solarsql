// Property: for two declared schemas S1 and S2, the generated migration takes
// a database at S1 (with rows) to the shape of S2, and a second diff is empty.
// When one table has both a removed and an added column, the generator must
// stop instead of guessing a rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { diff, introspect, open, shape, render } from "../src/build/migration.ts";
import { splitStatements } from "../src/build/scan.ts";

type ColumnType = "text" | "integer" | "real";
// A generated column computes a constant of its type, stored or virtual.
type Column = { name: string; type: ColumnType; notnull: boolean; check: boolean; generated: "stored" | "virtual" | null };
type Table = { name: "a" | "b"; columns: Column[]; fkToA: boolean };
type IndexDef = { name: string; table: "a" | "b"; columns: string[] };
type Schema = { tables: Table[]; indexes: IndexDef[] };

const names = ["c1", "c2", "c3", "c4"];
const types: ColumnType[] = ["text", "integer", "real"];

function defaultFor(type: ColumnType): string {
  return type === "text" ? "'d'" : type === "integer" ? "0" : "0.5";
}

// The constant a generated column computes. A value every STRICT type
// accepts, because a retype copies the stored value into the new column.
function constantFor(type: ColumnType): string {
  return type === "text" ? "'7'" : type === "integer" ? "7" : "7.0";
}

function columnDdl(c: Column): string {
  let s = `${c.name} ${c.type}`;
  // A generated column takes no default; its expression is the value.
  if (c.notnull) s += c.generated ? " not null" : ` not null default ${defaultFor(c.type)}`;
  if (c.check && c.type === "integer") s += ` check (${c.name} >= 0)`;
  if (c.generated) s += ` as (${constantFor(c.type)}) ${c.generated}`;
  return s;
}

function ddl(s: Schema): string[] {
  const out: string[] = [
    `create table guard (name text not null, ok integer not null) strict`,
    `create trigger guard_check before insert on guard when new.ok = 0 begin select raise(abort, new.name); end`,
  ];
  for (const t of s.tables) {
    const cols = [`id text primary key not null`];
    if (t.name === "b" && t.fkToA) cols.push(`a_id text not null references a(id)`);
    cols.push(...t.columns.map(columnDdl));
    out.push(`create table ${t.name} (${cols.join(", ")}) strict`);
  }
  for (const i of s.indexes) out.push(`create index ${i.name} on ${i.table} (${i.columns.join(", ")})`);
  return out;
}

function rowsFor(s: Schema): string[] {
  const out: string[] = [];
  for (const t of s.tables) {
    for (const i of [1, 2]) {
      const written = t.columns.filter((c) => !c.generated);
      const cols = ["id", ...(t.name === "b" && t.fkToA ? ["a_id"] : []), ...written.map((c) => c.name)];
      // Values that every STRICT type accepts without loss, so a retype of a
      // column with rows rebuilds cleanly: '7' -> 7, 7.0 -> 7, 7 -> '7'.
      const vals = [`'${t.name}${i}'`, ...(t.name === "b" && t.fkToA ? ["'a1'"] : []), ...written.map((c) => (c.type === "text" ? `'${i}'` : c.type === "integer" ? `${i}` : `${i}.0`))];
      out.push(`insert into ${t.name} (${cols.join(", ")}) values (${vals.join(", ")})`);
    }
  }
  return out;
}

const columnGen = gs.composite((tc): Column => ({
  name: tc.draw(gs.sampledFrom(names)),
  type: tc.draw(gs.sampledFrom(types)),
  notnull: tc.draw(gs.booleans()),
  check: tc.draw(gs.booleans()),
  generated: tc.draw(gs.sampledFrom<"stored" | "virtual" | null>([null, null, null, "stored", "virtual"])),
}));

function distinct(columns: Column[]): Column[] {
  const seen = new Set<string>();
  return columns.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

const schemaGen = gs.composite((tc): Schema => {
  const a: Table = { name: "a", columns: distinct(tc.draw(gs.arrays(columnGen, { minSize: 0, maxSize: 3 }))), fkToA: false };
  const tables: Table[] = [a];
  if (tc.draw(gs.booleans())) {
    tables.push({ name: "b", columns: distinct(tc.draw(gs.arrays(columnGen, { minSize: 0, maxSize: 3 }))), fkToA: tc.draw(gs.booleans()) });
  }
  const indexes: IndexDef[] = [];
  for (const t of tables) {
    if (t.columns.length > 0 && tc.draw(gs.booleans())) {
      indexes.push({ name: `idx_${t.name}_${t.columns[0]!.name}`, table: t.name, columns: [t.columns[0]!.name] });
    }
  }
  return { tables, indexes };
});

type Edit = "add" | "drop" | "retype" | "nullability" | "check" | "index" | "table" | "fk";
const editGen = gs.sampledFrom<Edit>(["add", "drop", "retype", "nullability", "check", "index", "table", "fk"]);

// One edit on a copy of the schema. Edits that do not apply leave it unchanged.
function apply(s: Schema, edit: Edit, pick: <T>(xs: T[]) => T, column: Column): Schema {
  const tables = s.tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c })) }));
  let indexes = s.indexes.map((i) => ({ ...i, columns: [...i.columns] }));
  const t = pick(tables);
  switch (edit) {
    case "add":
      if (!t.columns.some((c) => c.name === column.name)) t.columns.push(column);
      break;
    case "drop":
      if (t.columns.length > 0) {
        const gone = pick(t.columns).name;
        t.columns = t.columns.filter((c) => c.name !== gone);
        indexes = indexes.filter((i) => !(i.table === t.name && i.columns.includes(gone)));
      }
      break;
    case "retype":
      if (t.columns.length > 0) pick(t.columns).type = column.type;
      break;
    case "nullability":
      if (t.columns.length > 0) { const c = pick(t.columns); c.notnull = !c.notnull; }
      break;
    case "check":
      if (t.columns.length > 0) { const c = pick(t.columns); c.check = !c.check; }
      break;
    case "index":
      if (t.columns.length > 0) {
        const c = pick(t.columns);
        const name = `idx_${t.name}_${c.name}`;
        if (indexes.some((i) => i.name === name)) indexes = indexes.filter((i) => i.name !== name);
        else indexes.push({ name, table: t.name, columns: [c.name] });
      }
      break;
    case "table":
      if (tables.length === 2) { tables.pop(); indexes = indexes.filter((i) => i.table !== "b"); }
      else tables.push({ name: "b", columns: [column], fkToA: false });
      break;
    case "fk":
      if (t.name === "b") t.fkToA = !t.fkToA;
      break;
  }
  return { tables, indexes };
}

// The generator must stop in two cases: a table both loses and gains a column
// (a rename it cannot infer), or an existing table gains a NOT NULL column
// with no default (rows would have no value). In this generator only the
// foreign-key column a_id is NOT NULL without a default.
function expectedBlock(s1: Schema, s2: Schema): boolean {
  for (const t2 of s2.tables) {
    const t1 = s1.tables.find((t) => t.name === t2.name);
    if (!t1) continue;
    const n1 = new Set([...(t1.fkToA ? ["a_id"] : []), ...t1.columns.map((c) => c.name)]);
    const n2 = new Set([...(t2.fkToA ? ["a_id"] : []), ...t2.columns.map((c) => c.name)]);
    const removed = [...n1].some((n) => !n2.has(n));
    const added = [...n2].some((n) => !n1.has(n));
    if (removed && added) return true;
    if (!t1.fkToA && t2.fkToA) return true;
  }
  return false;
}

test("migration diff round-trips the declared schema", () => {
  // Installed hegel 0.4.5 has no tc.event; counts are kept here instead.
  const events = new Map<string, number>();
  const event = (label: string) => events.set(label, (events.get(label) ?? 0) + 1);
  hegel.test((tc) => {
    const s1 = tc.draw(schemaGen);
    let s2 = s1;
    const edits = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    for (let i = 0; i < edits; i++) {
      const edit = tc.draw(editGen);
      const column = tc.draw(columnGen);
      s2 = apply(s2, edit, (xs) => xs[tc.draw(gs.integers({ minValue: 0, maxValue: xs.length - 1 }))]!, column);
    }

    const current = open([...ddl(s1), ...rowsFor(s1)]);
    const target = open(ddl(s2));
    const currentSchema = introspect(current);
    const targetSchema = introspect(target);
    let plan = diff(currentSchema, targetSchema);
    // This property studies the SQL transformation. It supplies the exact
    // removal set after first proving that the public default blocks it.
    if (plan.kind === "blocked" && plan.drops) plan = diff(currentSchema, targetSchema, [], plan.drops);

    if (expectedBlock(s1, s2)) {
      event("blocked");
      assert.equal(plan.kind, "blocked", `expected a block for ${JSON.stringify({ s1, s2 })}`);
      return;
    }
    assert.equal(plan.kind, "ok", JSON.stringify({ s1, s2, plan }));
    if (plan.kind !== "ok") return;
    event(plan.statements.some((s) => s.includes("_solarsql_new_")) ? "rebuild" : plan.statements.length === 0 ? "no-op" : "alter-only");

    // Apply the rendered file the way wrangler does: split, one transaction.
    const file = render(1, "step", plan.statements).sql;
    current.exec("begin");
    try {
      for (const s of splitStatements(file)) current.exec(s);
      current.exec("commit");
    } catch (e) {
      current.exec("rollback");
      throw new Error(`apply failed: ${(e as Error).message}\n${file}\n${JSON.stringify({ s1, s2 })}`);
    }

    assert.deepEqual(shape(introspect(current)), shape(introspect(target)), `shape mismatch after\n${file}`);
    const again = diff(introspect(current), introspect(target));
    assert.deepEqual(again, { kind: "ok", statements: [] }, `second diff not empty after\n${file}`);

    // Rows survive: two per table that existed before and still exists.
    for (const t of s2.tables) {
      if (!s1.tables.some((x) => x.name === t.name)) continue;
      const n = (current.prepare(`select count(*) as n from ${t.name}`).get() as { n: number }).n;
      assert.equal(n, 2, `rows lost in ${t.name}`);
    }
  }, { testCases: 200 });
  console.log("property events:", JSON.stringify(Object.fromEntries(events)));
  assert.ok((events.get("rebuild") ?? 0) > 0, "no case exercised the rebuild path");
  assert.ok((events.get("alter-only") ?? 0) > 0, "no case exercised the cheap ALTER path");
});

// The blocked path is rare under the generator, so one case pins it: a
// table that loses one column and gains another in one change.
test("a table that loses and gains a column in one change is blocked", () => {
  const s1: Schema = { tables: [{ name: "a", columns: [{ name: "c1", type: "text", notnull: false, check: false, generated: null }], fkToA: false }], indexes: [] };
  const s2: Schema = { tables: [{ name: "a", columns: [{ name: "c2", type: "text", notnull: false, check: false, generated: null }], fkToA: false }], indexes: [] };
  assert.equal(expectedBlock(s1, s2), true);
  const current = introspect(open(ddl(s1)));
  const target = introspect(open(ddl(s2)));
  const initial = diff(current, target);
  const plan = initial.kind === "blocked" && initial.drops ? diff(current, target, [], initial.drops) : initial;
  assert.equal(plan.kind, "blocked");
  if (plan.kind === "blocked") assert.match(plan.reason, /columns \[c1\] removed and \[c2\] added in one change/);
});

test("a parent rebuild with cascading children is blocked before it can delete their rows", () => {
  const current = open([
    "create table parents (id integer primary key not null, value text not null) strict",
    "create table children (id integer primary key not null, parent_id integer references parents(id) on delete cascade) strict",
    "insert into parents values (1, 'keep')",
    "insert into children values (1, 1)",
  ]);
  const target = open([
    "create table parents (id integer primary key not null, value text not null check(length(value) > 0)) strict",
    "create table children (id integer primary key not null, parent_id integer references parents(id) on delete cascade) strict",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /children\.parent_id.*ON DELETE CASCADE.*parents.*explicit migration/);
    assert.equal(current.prepare("select count(*) as n from children").get()!.n, 1);
  } finally {
    current.close();
    target.close();
  }
});

test("accepted parent changes preserve rows and foreign keys across delete actions", () => {
  let cases = 0;
  const exercised = new Set<string>();
  hegel.test((tc) => {
    cases++;
    const action = tc.draw(gs.sampledFrom(["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"]));
    const rebuild = tc.draw(gs.booleans());
    const self = tc.draw(gs.booleans());
    const value = tc.draw(gs.text());
    const parent = (changed: boolean) => `create table parents (id integer primary key not null, value text not null${changed && rebuild ? " check(value is not null)" : ""}${self ? `, parent_id integer references parents(id) on delete ${action}` : ""}${changed && !rebuild ? ", extra text" : ""}) strict`;
    const child = `create table children (id integer primary key not null, parent_id integer references parents(id) on delete ${action}) strict`;
    const current = open([parent(false), ...(!self ? [child] : [])]);
    const target = open([parent(true), ...(!self ? [child] : [])]);
    try {
      current.prepare(`insert into parents (id, value) values (1, ?)`).run(value);
      if (self) current.prepare("insert into parents (id, value, parent_id) values (2, ?, 1)").run(value);
      else current.exec("insert into children values (1, 1)");
      const rows = () => ({
        parents: current.prepare(`select id, value${self ? ", parent_id" : ""} from parents order by id`).all(),
        children: self ? [] : current.prepare("select * from children order by id").all(),
      });
      const before = rows();
      const plan = diff(introspect(current), introspect(target));
      if (rebuild && action !== "NO ACTION") {
        exercised.add("blocked");
        assert.equal(plan.kind, "blocked", JSON.stringify({ action, self, plan }));
      } else {
        exercised.add(rebuild ? "rebuild" : "alter");
        assert.equal(plan.kind, "ok", JSON.stringify({ action, self, plan }));
        if (plan.kind !== "ok") return;
        current.exec("begin");
        try {
          for (const statement of plan.statements) current.exec(statement);
          current.exec("commit");
        } catch (error) {
          current.exec("rollback");
          throw error;
        }
        assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
      }
      assert.deepEqual(rows(), before);
      assert.deepEqual(current.prepare("pragma foreign_key_check").all(), []);
    } finally {
      current.close();
      target.close();
    }
  }, { testCases: 100 });
  console.log("foreign-key preservation cases:", cases);
  assert.deepEqual([...exercised].sort(), ["alter", "blocked", "rebuild"]);
});

test("a target child action blocks a later parent rebuild, including case-insensitive references", () => {
  const current = open([
    "create table parents (id integer primary key not null, value text) strict",
    "create table children (id integer primary key not null, parent_id integer references PARENTS(id)) strict",
  ]);
  const target = open([
    "create table parents (id integer primary key not null, value text check(value is not null)) strict",
    "create table children (id integer primary key not null, parent_id integer references PARENTS(id) on delete set null) strict",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "blocked");
    if (plan.kind === "blocked") assert.match(plan.reason, /children\.parent_id.*ON DELETE SET NULL.*parents/);
  } finally {
    current.close();
    target.close();
  }
});
