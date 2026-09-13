// Responsibility: verify VALUES rows and recursive seeds against SQLite.
// Boundary: parameter contracts have separate scanner tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { Typer } from "../src/build/typegen.ts";
import { catalogStatement } from "../src/build/statements.ts";

test("VALUES combines every row by ordinal and retains SQL", () => {
  const engine = new Engine([]);
  try {
    const sql = "values (1, 'a,b'), (null, 'c'), ('text', null)";
    assert.equal(catalogStatement(sql, "read"), sql);
    const result = new Typer(engine, new Map()).analyze(sql, "m");
    assert.equal(result.sql, sql);
    assert.deepEqual(result.columns.map(c => c.type), ["number | null | string", "string | null"]);
    assert.equal(engine.db.prepare(sql).all().length, 3);
  } finally { engine.close(); }
});

test("VALUES seeds preserve recursive rows for generated bounds", () => {
  hegel.test(tc => {
    const end = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
    const engine = new Engine([]);
    try {
      const sql = `with recursive series(n) as (values(1) union all select cast(n+1 as integer) from series where n<${end}) select n from series`;
      const columns = new Typer(engine, new Map()).analyze(sql, "m").columns;
      assert.equal(columns[0]!.type, "number | null");
      assert.deepEqual(engine.db.prepare(sql).all().map(row => row.n), Array.from({length: end}, (_, i) => i+1));
    } finally { engine.close(); }
  });
});

test("VALUES inside CTEs preserves JSON decoding and renamed columns", () => {
  const engine = new Engine([]);
  try {
    const sql = `with v(payload) as (values(json_object('n',1)),(null)) select payload from v`;
    assert.deepEqual(new Typer(engine, new Map()).analyze(sql, "m").columns, [{name: "payload", type: '{ "n": number } | null', json: true}]);
  } finally { engine.close(); }
});
