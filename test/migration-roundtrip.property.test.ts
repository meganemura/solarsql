// Property: for two declared schemas S1 and S2, the generated migration takes
// a database at S1 (with rows) to the shape of S2, and a second diff is empty.
// When one table has both a removed and an added column, the generator must
// stop instead of guessing a rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { applied, diff, introspect, open, shape, render } from "../src/build/migration.ts";
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

type Edit = "add" | "drop" | "retype" | "nullability" | "check" | "index" | "table" | "fk" | "rename";
const editGen = gs.sampledFrom<Edit>(["add", "drop", "retype", "nullability", "check", "index", "table", "fk", "rename"]);

// One edit on a copy of the schema. Edits that do not apply leave it unchanged.
// A rename also reports what it renamed, so the caller can track a surviving
// column's name through a chain of edits and hand diff() an unambiguous
// Rename instead of relying on its own repair suggestion.
//
// isOriginalName and isVacatedOriginal keep that tracking sound (found by
// running the property below and reading renameIntentPlan's rejections):
// a rename must never retarget an s1-original name (isOriginalName), or a
// later rename could reuse a name freed earlier and produce a from/to chain
// that renameIntentPlan rejects; an add must never reintroduce a name an
// active rename chain still has vacated (isVacatedOriginal), or the caller
// could not tell a fresh column from the tracked original.
function apply(
  s: Schema,
  edit: Edit,
  pick: <T>(xs: T[]) => T,
  column: Column,
  isOriginalName: (table: "a" | "b", name: string) => boolean,
  isVacatedOriginal: (table: "a" | "b", name: string) => boolean,
): { schema: Schema; renamed: { table: "a" | "b"; from: string; to: string } | null } {
  const tables = s.tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c })) }));
  let indexes = s.indexes.map((i) => ({ ...i, columns: [...i.columns] }));
  const t = pick(tables);
  let renamed: { table: "a" | "b"; from: string; to: string } | null = null;
  switch (edit) {
    case "add":
      if (!t.columns.some((c) => c.name === column.name) && !isVacatedOriginal(t.name, column.name)) t.columns.push(column);
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
    case "rename":
      if (t.columns.length > 0) {
        const c = pick(t.columns);
        if (column.name !== c.name && !t.columns.some((x) => x.name === column.name) && !isOriginalName(t.name, column.name)) {
          renamed = { table: t.name, from: c.name, to: column.name };
          c.name = column.name;
          // An index on the renamed column must follow it, or ddl(s2) will
          // reference a column name that no longer exists.
          indexes = indexes.map((i) => (i.table === t.name ? { ...i, columns: i.columns.map((n) => (n === renamed!.from ? renamed!.to : n)) } : i));
        }
      }
      break;
  }
  return { schema: { tables, indexes }, renamed };
}

// The generator must stop in two cases: a table both loses and gains a column
// (a rename it cannot infer), or an existing table gains a NOT NULL column
// with no default (rows would have no value). In this generator only the
// foreign-key column a_id is NOT NULL without a default.
function expectedBlock(s1: Schema, s2: Schema, renames: readonly { table: "a" | "b"; from: string; to: string }[] = []): boolean {
  for (const t2 of s2.tables) {
    const t1 = s1.tables.find((t) => t.name === t2.name);
    if (!t1) continue;
    const n1 = new Set([...(t1.fkToA ? ["a_id"] : []), ...t1.columns.map((c) => c.name)]);
    const n2 = new Set([...(t2.fkToA ? ["a_id"] : []), ...t2.columns.map((c) => c.name)]);
    const tableRenames = renames.filter((r) => r.table === t2.name);
    // A supplied rename explains away one removed and one added name; only
    // a mismatch it does not explain is a genuine, still-ambiguous rename
    // candidate (mirroring renameRepairPlan's own source-adjusted check).
    const removed = [...n1].filter((n) => !n2.has(n) && !tableRenames.some((r) => r.from === n));
    const added = [...n2].filter((n) => !n1.has(n) && !tableRenames.some((r) => r.to === n));
    if (removed.length > 0 && added.length > 0) return true;
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
    // Tracks each surviving column's original (s1-side) name through a
    // chain of edits, so an unambiguous rename can be supplied to diff()
    // directly instead of relying on its own repair suggestion -- the
    // suggestion path already has dedicated coverage in the pinned "loses
    // and gains a column" test below. Keyed by the s1-side original name,
    // valued by the column's current name.
    const originalNames = new Map(s1.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
    const chains = new Map<"a" | "b", Map<string, string>>();
    const isOriginalName = (table: "a" | "b", name: string) => originalNames.get(table)?.has(name) ?? false;
    const isVacatedOriginal = (table: "a" | "b", name: string) => chains.get(table)?.has(name) ?? false;
    const edits = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    for (let i = 0; i < edits; i++) {
      const edit = tc.draw(editGen);
      const column = tc.draw(columnGen);
      const { schema, renamed } = apply(s2, edit, (xs) => xs[tc.draw(gs.integers({ minValue: 0, maxValue: xs.length - 1 }))]!, column, isOriginalName, isVacatedOriginal);
      s2 = schema;
      if (renamed) {
        const chain = chains.get(renamed.table) ?? new Map<string, string>();
        // isOriginalName above guarantees a rename never retargets an s1
        // name, so a column's current name is an s1 original only while
        // untouched. `from` is therefore either that untouched original, or
        // (multi-hop) the live current name of one already in this chain --
        // never a fresh column that happens to reuse an s1 name.
        const viaChain = [...chain].find(([, current]) => current === renamed.from)?.[0];
        const original = viaChain ?? (isOriginalName(renamed.table, renamed.from) ? renamed.from : undefined);
        if (original !== undefined) {
          chain.delete(original);
          if (original !== renamed.to) chain.set(original, renamed.to);
        }
        chains.set(renamed.table, chain);
      }
      // A later drop or table removal can retire a tracked rename: once its
      // s1 identity is gone from the working schema, diff() has nothing
      // left to rename away from.
      for (const [table, chain] of chains) {
        const survivor = s2.tables.find((x) => x.name === table);
        if (!survivor) { chains.delete(table); continue; }
        for (const [original, to] of chain) {
          if (!survivor.columns.some((c) => c.name === to)) chain.delete(original);
        }
      }
    }
    const appliedRenames = [...chains].flatMap(([table, chain]) => [...chain].map(([from, to]) => ({ table, from, to })));

    const current = open([...ddl(s1), ...rowsFor(s1)]);
    const target = open(ddl(s2));
    const currentSchema = introspect(current);
    const targetSchema = introspect(target);
    let plan = diff(currentSchema, targetSchema, appliedRenames);
    // This property studies the SQL transformation. It supplies the exact
    // removal set after first proving that the public default blocks it.
    if (plan.kind === "blocked" && plan.drops) plan = diff(currentSchema, targetSchema, appliedRenames, plan.drops);

    if (expectedBlock(s1, s2, appliedRenames)) {
      event("blocked");
      assert.equal(plan.kind, "blocked", `expected a block for ${JSON.stringify({ s1, s2, appliedRenames })}`);
      return;
    }
    assert.equal(plan.kind, "ok", JSON.stringify({ s1, s2, appliedRenames, plan }));
    if (plan.kind !== "ok") return;
    const rebuilt = plan.statements.some((s) => s.includes("_solarsql_new_"));
    event(rebuilt ? "rebuild" : plan.statements.length === 0 ? "no-op" : "alter-only");
    if (appliedRenames.length > 0) event("renamed");
    if (appliedRenames.length > 0 && rebuilt) event("renamed-rebuild");

    // Apply the rendered file the way wrangler does: split, one transaction.
    const file = render(1, "step", plan.statements, plan.rebuilds ?? []).sql;
    // Capture rowid identity per row before the migration, keyed by the
    // stable text id, so a rebuild that also renames a column is proven to
    // preserve row identity, not only the row count.
    const before = new Map(s1.tables.map((t) => [t.name, current.prepare(`select id, rowid as rid from ${t.name} order by id`).all() as { id: string; rid: number }[]]));
    current.exec("begin");
    try {
      for (const s of splitStatements(file)) current.exec(s);
      current.exec("commit");
    } catch (e) {
      current.exec("rollback");
      throw new Error(`apply failed: ${(e as Error).message}\n${file}\n${JSON.stringify({ s1, s2, appliedRenames })}`);
    }

    assert.deepEqual(shape(introspect(current)), shape(introspect(target)), `shape mismatch after\n${file}`);
    const again = diff(introspect(current), introspect(target));
    assert.deepEqual(again, { kind: "ok", statements: [] }, `second diff not empty after\n${file}`);

    // The recorded rebuild header must never cause a false refusal on the
    // exact history it was generated for: replay through the same
    // applied() build, build --check, and migration all use, from the base
    // schema, with no live database in between.
    try {
      applied([[...ddl(s1), ...rowsFor(s1)].map((s) => `${s};`).join("\n"), file], ["0001_base.sql", "0002_step.sql"]);
    } catch (e) {
      throw new Error(`applied() refused a valid migration: ${(e as Error).message}\n${file}\n${JSON.stringify({ s1, s2, appliedRenames })}`);
    }

    // Rows and rowids survive in every table that existed before and still exists.
    for (const t of s2.tables) {
      const previous = before.get(t.name);
      if (!previous) continue;
      const after = current.prepare(`select id, rowid as rid from ${t.name} order by id`).all() as { id: string; rid: number }[];
      assert.deepEqual(after, previous, `rows or rowids changed in ${t.name}`);
    }
  }, { testCases: 200 });
  console.log("property events:", JSON.stringify(Object.fromEntries(events)));
  assert.ok((events.get("rebuild") ?? 0) > 0, "no case exercised the rebuild path");
  assert.ok((events.get("alter-only") ?? 0) > 0, "no case exercised the cheap ALTER path");
  // A "renamed-rebuild" assertion here (a rename co-occurring with a
  // same-table rebuild) was tried and measured across 29 solo runs: it hit
  // zero once, so it is left out as flaky. The pinned case below covers the
  // combination deterministically instead.
  //
  // The "renamed" assertion above was removed for the same reason: 20 solo
  // runs at this testCases count put its count anywhere from 2 to 33, an
  // overdispersed distribution whose tail can reach zero. The pinned case
  // below exercises a rename directly (and also covers it co-occurring with
  // a rebuild), so it stands in as the deterministic coverage.
});

// tableStatements orders a rename ALTER ahead of a rebuild's copy on the
// same table, so a rename survives even when the rebuild also runs. The
// combination is real but rare under the fuzzer above (absent in 1 of 29
// solo runs at its testCases count), so this pins it directly.
test("a rename on a table that also needs a rebuild preserves rows and row identity", () => {
  const current = open([
    "create table t (id integer primary key, old_value text not null)",
    "insert into t (old_value) values ('a'), ('b')",
  ]);
  const target = open([
    "create table t (id integer primary key, new_value text not null check (new_value <> ''))",
  ]);
  try {
    const rename = { table: "t", from: "old_value", to: "new_value" };
    const blocked = diff(introspect(current), introspect(target));
    assert.equal(blocked.kind, "blocked");
    const plan = diff(introspect(current), introspect(target), [rename]);
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), "expected a rebuild, not a cheap ALTER");
    const before = current.prepare("select id, rowid as rid, old_value from t order by id").all();
    for (const statement of plan.statements) current.exec(statement);
    assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
    const after = current.prepare("select id, rowid as rid, new_value from t order by id").all();
    // node:sqlite rows have a null prototype; spread each into a plain
    // object so deepEqual compares values, not the prototype.
    assert.deepEqual(after.map((r) => ({ ...r })), before.map((r: any) => ({ id: r.id, rid: r.rid, new_value: r.old_value })));
  } finally {
    current.close();
    target.close();
  }
});

// A generated column takes no value in the rebuild's restore INSERT (its
// column list excludes generated columns); SQLite computes the value itself
// from the copied row data. This pins that computation for a row that
// existed before the column did, for both storage kinds.
test("a stored generated column added by a rebuild computes correctly for a row that predates it", () => {
  const current = open([
    "create table t (id integer primary key, a integer not null) strict",
    "insert into t (a) values (5), (7)",
  ]);
  const target = open([
    "create table t (id integer primary key, a integer not null, b integer as (a * 2) stored) strict",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.ok(plan.statements.some((s) => s.includes("_solarsql_new_")), "expected a rebuild, not a cheap ALTER");
    for (const statement of plan.statements) current.exec(statement);
    assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
    // node:sqlite rows have a null prototype; spread each into a plain
    // object so deepEqual compares values, not the prototype.
    const rows = current.prepare("select id, a, b from t order by id").all().map((r: any) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 1, a: 5, b: 10 },
      { id: 2, a: 7, b: 14 },
    ]);
  } finally {
    current.close();
    target.close();
  }
});

test("a virtual generated column added to a populated table computes correctly without a rebuild", () => {
  const current = open([
    "create table t (id integer primary key, a integer not null) strict",
    "insert into t (a) values (5), (7)",
  ]);
  const target = open([
    "create table t (id integer primary key, a integer not null, b integer as (a * 2) virtual) strict",
  ]);
  try {
    const plan = diff(introspect(current), introspect(target));
    assert.equal(plan.kind, "ok", plan.kind === "blocked" ? plan.reason : "");
    if (plan.kind !== "ok") return;
    assert.ok(!plan.statements.some((s) => s.includes("_solarsql_new_")), "expected a cheap ALTER, not a rebuild");
    for (const statement of plan.statements) current.exec(statement);
    assert.deepEqual(shape(introspect(current)), shape(introspect(target)));
    const rows = current.prepare("select id, a, b from t order by id").all().map((r: any) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 1, a: 5, b: 10 },
      { id: 2, a: 7, b: 14 },
    ]);
  } finally {
    current.close();
    target.close();
  }
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
