// Responsibility: compare inferred scalar guarantees with real SQLite rows across query scopes.
// Boundary: this oracle understands scalar unions, not TypeScript's complete type language.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { onEqualities, queryScope, querySources, unionType } from "../src/build/scope.ts";
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

function otherOperand(expression: string) {
  return onEqualities(`b.code = ${expression}`, "b")!.get("code")!.other;
}

test("onEqualities classifies a bare column operand", () => {
  assert.deepEqual(otherOperand("other"), { kind: "column", alias: null, column: "other" });
});

test("onEqualities classifies an alias-qualified column operand", () => {
  assert.deepEqual(otherOperand("x.y"), { kind: "column", alias: "x", column: "y" });
});

test("onEqualities rejects extra tokens after an alias-qualified column", () => {
  assert.equal(otherOperand("x.y || 'z'"), null);
});

test("onEqualities requires an identifier before a column separator", () => {
  assert.equal(otherOperand("'a'.x"), null);
});

test("onEqualities requires a column separator between identifiers", () => {
  assert.equal(otherOperand("x + y"), null);
});

test("onEqualities requires an identifier after a column separator", () => {
  assert.equal(otherOperand("x.'a'"), null);
});

test("querySources rejects a non-identifier FROM source", () => {
  assert.throws(() => querySources("select * from 1"), /unrecognized FROM source/);
});

test("querySources uses the name after AS as the source alias", () => {
  assert.equal(querySources("select * from t as x")[0]!.alias, "x");
});

test("quoted union members keep union delimiters literal", () => {
  hegel.test((tc) => {
    const left = tc.draw(gs.text({ alphabet: "abc", maxSize: 12 }));
    const right = tc.draw(gs.text({ alphabet: "xyz", maxSize: 12 }));
    for (const quote of ['"', "'"]) {
      const member = `${quote}${left}|${right}${quote}`;
      assert.equal(unionType(member, "null"), `${member} | null`);
    }
  });
});

test("querySources gives a source without USING an empty column list", () => {
  assert.deepEqual(querySources("select * from t join u on t.id = u.id").map((s) => s.using), [[], []]);
});

test("querySources does not read a clause keyword as the source's alias", () => {
  const clauses = ["where a = 1", "group by a", "having count(*) > 0", "window w as ()", "order by a", "limit 1"];
  for (const clause of clauses) {
    assert.deepEqual(querySources(`select a from t ${clause}`).map((s) => s.alias), ["t"], clause);
  }
  assert.deepEqual(querySources("delete from t returning id").map((s) => s.alias), ["t"]);
});

test("querySources does not read a join attribute as the previous source's alias", () => {
  for (const join of ["natural join", "left join", "right join", "full join", "left outer join", "inner join", "cross join"]) {
    assert.deepEqual(querySources(`select * from t ${join} u`).map((s) => s.alias), ["t", "u"], join);
  }
});

test("queryScope separates compound operators and trims branch text", () => {
  assert.deepEqual(queryScope("  select 1  INTERSECT select 2 EXCEPT select 3 UNION ALL select 4;  \n"), {
    ctes: [], branches: ["select 1", "select 2", "select 3", "select 4"],
    operators: ["intersect", "except", "union all"],
  });
  for (const ending of [";", "; ", ";  \n", "  "]) {
    assert.deepEqual(queryScope(`select 1${ending}`).branches, ["select 1"]);
  }
});

test("queryScope keeps nested clauses and removes only the compound tail", () => {
  const first = "select (select x from t order by x limit 1)";
  const last = "select (select y from u order by y limit 2)";
  for (const tail of ["order by 1", "limit 1", "order by 1 limit 1"]) {
    assert.deepEqual(queryScope(`${first} union ${last} ${tail}`).branches, [first, last]);
  }
  assert.deepEqual(queryScope("select x from t order by x limit 1").branches, ["select x from t order by x limit 1"]);
});

test("querySources records complete named and derived bindings", () => {
  assert.deepEqual(querySources("select * from main.t as x"), [{
    alias: "x", name: "t", schema: "main", query: null, functionSql: null,
    join: "inner", using: [], natural: false, on: null,
  }]);
  assert.equal(querySources("from t")[0]!.name, "t");
  assert.equal(querySources("select * from t x")[0]!.alias, "x");
  assert.deepEqual(querySources("select * from ( select 1), (values(2))").map((s) => [s.alias, s.query]),
    [["__source_1", " select 1"], ["__source_2", "values(2)"]]);
  assert.deepEqual(querySources("select * from (with x as (select 1) select * from x) y").map((s) => s.alias), ["y"]);
  assert.deepEqual(querySources("select * from json_each('[1]') j, t").map((s) => [s.alias, s.functionSql]),
    [["j", "json_each('[1]')"], ["t", null]]);
});

test("querySources reports missing and unsupported sources", () => {
  for (const sql of ["select * from"]) {
    assert.throws(() => querySources(sql), /missing FROM source/);
  }
  for (const body of ["t join u", "t, (select 1)"]) {
    assert.throws(() => querySources(`select * from (${body})`), /parenthesized join groups need an explicit SELECT scope/);
  }
  assert.throws(() => querySources("select * from 1"), /unrecognized FROM source/);
});

test("querySources retains USING columns and subsequent joins", () => {
  const sources = querySources('select * from t join u using("a", b) left join v using(b)');
  assert.deepEqual(sources.map((s) => [s.alias, s.using, s.join]),
    [["t", [], "inner"], ["u", ["a", "b"], "inner"], ["v", ["b"], "left"]]);
  assert.deepEqual(querySources("select * from t using").map((s) => s.using), [[]]);
});

test("querySources preserves nested ON expressions and resets comma joins", () => {
  const on = "t.id = (select u.id from u left join v on u.id=v.id order by u.id limit 1)";
  const sources = querySources(`select * from t natural left join u on ${on}  , v join w on w.id = v.id  where 1`);
  assert.deepEqual(sources.map((s) => [s.alias, s.join, s.natural, s.on]), [
    ["t", "inner", false, null], ["u", "left", true, on],
    ["v", "inner", false, null], ["w", "inner", false, "w.id = v.id"],
  ]);
  assert.equal(querySources("select * from t join u on")[1]!.on, "");
  assert.deepEqual(querySources("select * from t indexed by idx").map((s) => s.alias), ["t"]);
  assert.deepEqual(querySources("select * from t (ignored, left)").map((s) => s.alias), ["t"]);
});

test("querySources classifies all join attributes and clause boundaries", () => {
  for (const [words, join, natural] of [
    ["natural", "inner", true], ["left", "left", false], ["right", "right", false],
    ["full", "full", false], ["inner", "inner", false], ["outer left", "left", false],
    ["cross", "inner", false], ["left right", "full", false],
  ] as const) {
    assert.deepEqual(querySources(`select * from t ${words} join u`).map((s) => [s.alias, s.join, s.natural]),
      [["t", "inner", false], ["u", join, natural]]);
  }
  for (const clause of ["where 1", "group by a", "having 1", "window w as ()", "order by a", "limit 1", "returning a"]) {
    assert.deepEqual(querySources(`select * from t join u on t.a=u.a ${clause}`).map((s) => [s.alias, s.on]),
      [["t", null], ["u", "t.a=u.a"]]);
  }
});

test("unionType preserves escaped literals and nested member unions", () => {
  hegel.test((tc) => {
    const text = tc.draw(gs.text());
    const member = JSON.stringify(`${text}"|end`);
    assert.equal(unionType(member, "null"), `${member} | null`);
    for (const nested of ['{ x: string | null }', "(string | null)", "[string | null]", "Array<string | null>"]) {
      assert.equal(unionType(nested, "null"), `${nested} | null`);
    }
  });
});

test("unionType absorbs complete literals and preserves larger type expressions", () => {
  assert.equal(unionType("number", "12", "-12.34", "1.2"), "number");
  for (const member of ["Brand12", "12Brand", "12.x", 'Brand<"a">', '"a"[]', 'Brand & "a"']) {
    assert.equal(unionType("string", "number", member), `string | number | ${member}`);
  }
  hegel.test((tc) => {
    const literal = JSON.stringify(tc.draw(gs.text()));
    const integer = String(tc.draw(gs.integers()));
    assert.equal(unionType("string", literal), "string");
    assert.equal(unionType("number", integer), "number");
    assert.equal(unionType(literal, integer), `${literal} | ${integer}`);
  });
});

// A worker lets the test stop a parser that fails to advance its cursor.
async function scopeResult(method: "querySources" | "unionType", args: string[]): Promise<unknown> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.url).then((scope) => parentPort.postMessage(scope[workerData.method](...workerData.args)));
  `, { eval: true, workerData: { url: new URL("../src/build/scope.ts", import.meta.url).href, method, args } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("scope parsing did not finish")), 3000);
      worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  } finally { await worker.terminate(); }
}

test("querySources skips nested compound sources", async () => {
  const sql = "select a from t as x union select (select a from u left join v using(a))";
  const expected = [{ alias: "x", name: "t", schema: null, query: null, functionSql: null, join: "inner", using: [], natural: false, on: null }];
  assert.deepEqual(await scopeResult("querySources", [sql]), expected);
  assert.deepEqual(querySources(sql), expected);
});

test("unionType preserves escaped quote boundaries", async () => {
  const literal = JSON.stringify('a"|b');
  assert.equal(await scopeResult("unionType", [literal, "null"]), `${literal} | null`);
  assert.equal(unionType(literal, "null"), `${literal} | null`);
});

test("unionType preserves spacing inside nested unions", () => {
  hegel.test((tc) => {
    const spaces = tc.draw(gs.sampledFrom(["", "  ", "\t"]));
    const nested = `Array<string${spaces}|${spaces}null>`;
    assert.equal(unionType(nested, "null"), `${nested} | null`);
  });
});

test("querySources ignores an attribute without a following JOIN", () => {
  assert.deepEqual(querySources("select * from t as x union select left from u").map((s) => s.alias), ["x"]);
});

test("querySources starts ON text after an explicit keyword alias", async () => {
  const sql = "select * from t join u as left on t.id = 1";
  const expected = [
    { alias: "t", name: "t", schema: null, query: null, functionSql: null,
      join: "inner", using: [], natural: false, on: null },
    { alias: "left", name: "u", schema: null, query: null, functionSql: null,
      join: "inner", using: [], natural: false, on: "t.id = 1" },
  ];
  assert.deepEqual(await scopeResult("querySources", [sql]), expected);
  assert.deepEqual(querySources(sql), expected);
});

test("querySources keeps keyword aliases separate from following join attributes", async () => {
  const sql = "select * from t as natural join u";
  const expected = [
    { alias: "natural", name: "t", schema: null, query: null, functionSql: null,
      join: "inner", using: [], natural: false, on: null },
    { alias: "u", name: "u", schema: null, query: null, functionSql: null,
      join: "inner", using: [], natural: false, on: null },
  ];
  assert.deepEqual(await scopeResult("querySources", [sql]), expected);
  assert.deepEqual(querySources(sql), expected);
});

// SQLite reads WINDOW as a keyword only before `name AS`, so a table may be
// named window; the source after its implicit alias must still be read.
test("querySources reads the source after a table named window with an implicit alias", () => {
  assert.deepEqual(querySources("select * from window w join u on w.a = u.a").map((s) => [s.alias, s.name]), [["w", "window"], ["u", "u"]]);
  assert.deepEqual(querySources("select * from window w, u").map((s) => [s.alias, s.name]), [["w", "window"], ["u", "u"]]);
});

test("onEqualities excludes circular references and preserves independent operands", () => {
  hegel.test((tc) => {
    const suffix = tc.draw(gs.text({ alphabet: "abcdef", minSize: 1, maxSize: 8 }));
    const alias = `t_${suffix}`;
    for (const expression of [`${alias}.other`, `1 + ${alias}.other`, `coalesce(x.other, ${alias}.other)`]) {
      assert.deepEqual(onEqualities(`${alias}.id = ${expression}`, alias), new Map());
      assert.deepEqual(onEqualities(`${expression} = ${alias}.id`, alias), new Map());
    }
    for (const expression of [`'${alias}' || '.'`, `${alias} + 1`, `x.${alias}`]) {
      assert.equal(onEqualities(`${alias}.id = ${expression}`, alias)!.size, 1);
    }
  });
});

test("onEqualities distinguishes outer disjunctions from nested expressions", () => {
  assert.equal(onEqualities("b.id = x.id or b.id = 1", "b"), null);
  assert.deepEqual([...onEqualities("b.id = (x.id or x.other) and b.code = 1", "b")!.keys()], ["id", "code"]);
  assert.deepEqual([...onEqualities("b.id = (x.id and x.other) and b.code = 1", "b")!.keys()], ["id", "code"]);
  assert.deepEqual(onEqualities("(b.id = x.id)", "b"), new Map());
});

test("onEqualities ignores empty operands and clauses", () => {
  for (const clause of ["", " -- empty", "= b.id", "b.id =", "and b.id = and", "b.id"]) {
    assert.deepEqual(onEqualities(clause, "b"), new Map(), clause);
  }
});

test("onEqualities preserves collated columns and operand order", () => {
  for (const [clause, side, other] of [
    ["b.id collate nocase = x.id", "left", { kind: "column", alias: "x", column: "id" }],
    ["x.id = b.id collate nocase", "right", { kind: "column", alias: "x", column: "id" }],
    ["b.id = other collate nocase", "left", { kind: "column", alias: null, column: "other" }],
  ] as const) {
    assert.deepEqual(onEqualities(clause, "b")!.get("id"), {
      explicitCollation: { kind: "known", name: "NOCASE" }, other, targetSide: side,
    });
  }
  assert.deepEqual(onEqualities("other = b.id", "b")!.get("id"), {
    explicitCollation: { kind: "none" }, other: { kind: "column", alias: null, column: "other" }, targetSide: "right",
  });
});

test("onEqualities keeps literal values separate from column references", () => {
  for (const value of ["1", "'text'", ":id"]) {
    assert.deepEqual(otherOperand(value), { kind: "value" });
  }
  assert.deepEqual(otherOperand("'a'.x"), null);
});

test("onEqualities retains a nested conjunction before an outer equality", () => {
  assert.deepEqual(onEqualities("(1 and 2) = b.id", "b")!.get("id"), {
    explicitCollation: { kind: "none" }, other: null, targetSide: "right",
  });
  assert.deepEqual(onEqualities("b.id = (1 and b.other)", "b"), new Map());
  assert.deepEqual(onEqualities("(x.id = 1) = b.id", "b")!.get("id"), {
    explicitCollation: { kind: "none" }, other: null, targetSide: "right",
  });
});

test("onEqualities distinguishes single quoted source names from quote characters in an alias", () => {
  const engine = fixture();
  try {
    const clause = `"'a'".id = 'a'.id`;
    const sql = `select * from a as "'a'" join a as a on ${clause}`;
    assert.equal(engine.db.prepare(sql).all().length, 1);
    assert.deepEqual(onEqualities(clause, "'a'")!.get("id"), {
      explicitCollation: { kind: "none" }, other: null, targetSide: "left",
    });
  } finally { engine.close(); }
});

test("queryScope keeps compound operators inside a derived query", () => {
  const sql = "select * from (select 1 union select 2 intersect select 3 except select 4)";
  assert.deepEqual(queryScope(sql), { ctes: [], branches: [sql], operators: [] });
});

test("queryScope retains CTE hints, columns, and nested query text", () => {
  const engine = fixture();
  try {
    for (const hint of ["", "materialized", "not materialized"]) {
      const sql = `with x(id, n) as ${hint} (select (select 1), 2), y as (select * from x) select * from y`;
      assert.equal(engine.db.prepare(sql).get()!.n, 2);
      assert.deepEqual(queryScope(sql), {
        ctes: [{ name: "x", columns: ["id", "n"], sql: "select (select 1), 2" },
          { name: "y", columns: [], sql: "select * from x" }],
        branches: ["select * from y"], operators: [],
      });
    }
    assert.deepEqual(queryScope("with x as (select 1) select * from x", true), {
      ctes: [{ name: "x", columns: [], sql: "select 1" }], branches: [], operators: [],
    });
    assert.deepEqual(queryScope("with x as (select 1)", true), {
      ctes: [{ name: "x", columns: [], sql: "select 1" }], branches: [], operators: [],
    });
  } finally { engine.close(); }
});

test("queryScope reports incomplete query and CTE syntax", () => {
  for (const sql of ["with x as (select 1", "with x(a"]) {
    assert.throws(() => queryScope(sql), /unclosed query scope/);
  }
  for (const sql of ["with x", "with x select 1"]) {
    assert.throws(() => queryScope(sql), /unrecognized CTE binding/);
  }
  for (const sql of ["with x as", "with x as select 1"]) {
    assert.throws(() => queryScope(sql), /unrecognized CTE query/);
  }
  for (const sql of ["", "delete from t"]) {
    assert.throws(() => queryScope(sql), /query scope needs SELECT or VALUES/);
  }
});

test("query scopes preserve balanced expressions with SQLite keyword names", () => {
  hegel.test((tc) => {
    const name = tc.draw(gs.sampledFrom(["window", "begin", "end"]));
    const value = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
    const depth = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
    const expression = `${"(".repeat(depth)}${value}${")".repeat(depth)}`;
    const body = `select ${expression} as id`;
    const engine = fixture();
    try {
      for (const hint of ["", "materialized", "not materialized"]) {
        const sql = `with ${name}(id) as ${hint} (${body}) select id from ${name}`;
        assert.equal(engine.db.prepare(sql).get()!.id, value);
        assert.deepEqual(queryScope(sql), {
          ctes: [{ name, columns: ["id"], sql: body }], branches: [`select id from ${name}`], operators: [],
        });
      }
      const sql = `select * from (${body}) as ${name} join json_each('[0]') as j using(id)`;
      engine.db.prepare(sql).all();
      assert.deepEqual(querySources(sql).map((source) => [source.query, source.functionSql, source.using]),
        [[body, null, []], [null, "json_each('[0]')", ["id"]]]);
      for (const blank of ["", " \t\n", "-- empty\n", "/* empty */"]) {
        assert.deepEqual(onEqualities(blank, name), new Map());
      }
    } finally { engine.close(); }
  });
});
