// Responsibility: compare inferred scalar guarantees with real SQLite rows across query scopes.
// Boundary: this oracle understands scalar unions, not TypeScript's complete type language.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { unionType } from "../src/build/scope.ts";
import { Typer, type Brand } from "../src/build/typegen.ts";

function fixture(left = true, right = true, matches = true): Engine {
  const engine = new Engine([
    "create table a(id text primary key not null, n integer not null, label text not null) strict",
    "create table b(id text primary key not null, n integer not null, label text not null) strict",
    "create view renamed(key, amount) as select id, n from a",
    "create view outer_values as select b.n from a left join b on a.id=b.id",
    "create view combined as select n as value from a union all select null union all select label from b",
  ]);
  if (left) engine.db.prepare("insert into a values (?, ?, ?)").run("a", 7, "left");
  if (right) engine.db.prepare("insert into b values (?, ?, ?)").run(matches ? "a" : "b", 11, "right");
  return engine;
}

function typer(engine: Engine): Typer {
  return new Typer(engine, new Map<string, Brand>([
    ["a", { table: "a", column: "id", typeName: "AId", module: "m" }],
    ["b", { table: "b", column: "id", typeName: "BId", module: "m" }],
  ]));
}

// Runtime membership uses JavaScript values and a finite emitted scalar vocabulary.
// Fail on an unexpected type so widening to an unchecked oracle cannot hide a bug.
function fits(type: string, value: unknown): boolean {
  return type.split(" | ").map((part) => {
    if (part === "null") return value === null;
    if (part === "number" || part === "string") return typeof value === part;
    if (part === "AId" || part === "BId") return typeof value === "string";
    if (part.startsWith('"') || /^-?\d+$/.test(part)) return value === JSON.parse(part);
    throw new Error(`unexpected oracle type: ${part}`);
  }).some(Boolean);
}

function verify(engine: Engine, sql: string): void {
  // Execute first: a malformed test query must not masquerade as an inference failure.
  const rows = engine.db.prepare(sql).all();
  const analysis = typer(engine).analyze(sql, "m");
  for (const row of rows) for (const column of analysis.columns) {
    assert.ok(fits(column.type, row[column.name]), `${sql}: ${column.name}=${JSON.stringify(row[column.name])} does not fit ${column.type}`);
  }
}

for (const sql of [
  "select amount from renamed",
  "with x(v) as (select n from a) select v from x",
  "select v from (select n as v from a) x",
  "with a as (select n as v from main.a) select v from a",
]) {
  test(`scope preserves NOT NULL: ${sql}`, () => {
    const engine = fixture();
    try { verify(engine, sql); assert.equal(typer(engine).analyze(sql, "m").columns[0]!.type, "number"); }
    finally { engine.close(); }
  });
}

for (const sql of [
  "select b.n from a left join b on a.id=b.id",
  "select a.n from a right join b on a.id=b.id",
  "select a.n from a full join b on a.id=b.id",
  "select n from outer_values",
  "select (select n from b where b.id=a.id) as n from a",
]) {
  test(`scope retains possible NULL: ${sql}`, () => {
    const engine = fixture(true, true, false);
    try { verify(engine, sql); assert.ok(typer(engine).analyze(sql, "m").columns[0]!.type.split(" | ").includes("null")); }
    finally { engine.close(); }
  });
}

for (const sql of [
  "select n as value from a union all select null union all select label from b",
  "with x as (select n as value from a union select null union select label from b) select value from x",
  "select value from combined",
]) {
  test(`compound includes every branch: ${sql}`, () => {
    const engine = fixture();
    try {
      verify(engine, sql);
      assert.deepEqual(new Set(typer(engine).analyze(sql, "m").columns[0]!.type.split(" | ")), new Set(["number", "string", "null"]));
    } finally { engine.close(); }
  });
}

test("scalar JSON subquery permits NULL when the inner query is empty", () => {
  const engine = fixture(true, false);
  const sql = "select (select json_object('id',id) from b) as payload from a";
  try {
    assert.equal(engine.db.prepare(sql).get()!.payload, null);
    const column = typer(engine).analyze(sql, "m").columns[0]!;
    assert.equal(column.json, true);
    assert.match(column.type, /\| null$/);
    assert.match(column.type, /"id": BId/);
  } finally { engine.close(); }
});

test("FULL JOIN USING includes the value types of both coalesced keys", () => {
  const engine = new Engine([
    "create table numbers(id integer not null) strict",
    "create table strings(id text not null) strict",
  ]);
  try {
    engine.db.exec("insert into numbers values(1); insert into strings values('text-id')");
    const sql = "select id from numbers full join strings using(id)";
    verify(engine, sql);
    assert.deepEqual(new Set(typer(engine).analyze(sql, "m").columns[0]!.type.split(" | ")), new Set(["number", "string"]));
  } finally { engine.close(); }
});

for (const wrapper of ["view", "cte"]) {
  test(`${wrapper} preserves JSON shape and decoding`, () => {
    const engine = fixture();
    try {
      engine.db.exec("create view objects(payload) as select json_object('id',id) from a");
      const sql = wrapper === "view" ? "select payload from objects"
        : "with objects(payload) as (select json_object('id',id) from a) select payload from objects";
      const actual = JSON.parse(engine.db.prepare(sql).get()!.payload as string);
      assert.deepEqual(actual, { id: "a" });
      const column = typer(engine).analyze(sql, "m").columns[0]!;
      assert.equal(column.json, true);
      assert.equal(column.type, '{ "id": AId }');
    } finally { engine.close(); }
  });
}

test("actual scalar rows fit types across scope and join combinations", () => {
  hegel.test((tc) => {
    // Presence and key equality cover empty, matched, and each unmatched join side.
    const engine = fixture(tc.draw(gs.booleans()), tc.draw(gs.booleans()), tc.draw(gs.booleans()));
    try {
      const join = tc.draw(gs.sampledFrom(["left", "right", "full"]));
      const source = tc.draw(gs.sampledFrom([
        "a", "(select id, n from a)", "renamed",
      ]));
      const renamed = source === "renamed";
      const sql = `select x.${renamed ? "amount" : "n"} as lhs, b.n as rhs from ${source} x ${join} join b on x.${renamed ? "key" : "id"}=b.id`;
      verify(engine, sql);
      verify(engine, "with b as (select n as value from a union all select null union all select label from main.b) select value from b");
      verify(engine, "select a.*, b.n as child from a left join b on a.id=b.id");
      verify(engine, "select (select n from b where b.id=a.id) as scalar from a");
    } finally { engine.close(); }
  });
});

test("later RIGHT JOIN nullability reaches earlier derived and CTE sources", () => {
  const engine = fixture(true, false);
  try {
    for (const sql of [
      "select x.n as lhs, b.n as middle, c.n as rhs from (select id,n from a) x left join b on x.id=b.id right join a c on b.id=c.id",
      "with x as (select b.id,b.n from a left join b on a.id=b.id) select n from x",
      "select id from a natural left join b",
      "select id from a left join b using(id)",
    ]) verify(engine, sql);
  } finally { engine.close(); }
});

test("a union drops a literal member the bare string or number type already covers", () => {
  assert.equal(unionType("string", "null", '"formula"', '"cask"'), "string | null");
  assert.equal(unionType('"a"', '"b"', "string"), "string");
  assert.equal(unionType("1", "2", "number"), "number");
  assert.equal(unionType('"a"', '"b"'), '"a" | "b"');
  assert.equal(unionType("1", "2"), "1 | 2");
  assert.equal(unionType("string", "number"), "string | number");
  assert.equal(unionType('"a"', "null"), '"a" | null');
});
