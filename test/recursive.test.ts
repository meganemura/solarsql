// Responsibility: verify recursive result types against SQLite's actual fixed point.
// Boundary: finite fixtures test inference; SQL execution limits belong to the caller.
import assert from "node:assert/strict";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { BuildError, Typer } from "../src/build/typegen.ts";

test("recursive UNION reaches types introduced after the seed", () => {
  const engine = new Engine([]);
  try {
    const sql = `with recursive r(a,b) as (select 1,'text' union select b,a from r) select a,b from r`;
    const columns = new Typer(engine, new Map()).analyze(sql, "m").columns;
    const rows = engine.db.prepare(sql).all();
    assert.equal(rows.length, 2);
    for (const column of columns) {
      assert.match(column.type, /number/);
      assert.match(column.type, /string/);
    }
  } finally { engine.close(); }
});

test("recursive graph rows preserve nullable fields through cycles and empty seeds", () => {
  hegel.test((tc) => {
    const size = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
    const cycle = tc.draw(gs.booleans());
    const engine = new Engine(["create table edges(id integer primary key not null, parent integer, label text) strict"]);
    try {
      for (let i = 0; i < size; i++) engine.db.prepare("insert into edges values (?,?,?)").run(i, i === 0 ? cycle ? size - 1 : null : i - 1, i % 2 ? null : "node");
      const sql = `with recursive descendants as (
        select id,parent,label from edges where id=0
        union select e.id,e.parent,e.label from edges e join descendants d on e.parent=d.id
      ) select * from descendants`;
      const columns = new Typer(engine, new Map()).analyze(sql, "m").columns;
      assert.deepEqual(columns.map(c => c.type), ["number", "number | null", "string | null"]);
      const rows = engine.db.prepare(sql).all();
      assert.equal(rows.length, size);
      for (const row of rows) {
        assert.equal(typeof row.id, "number");
        assert.ok(row.parent === null || typeof row.parent === "number");
        assert.ok(row.label === null || typeof row.label === "string");
      }
    } finally { engine.close(); }
  });
});

test("recursive JSON values retain SQLite text at the CTE boundary", () => {
  const engine = new Engine([]);
  try {
    const sql = `with recursive r(n,payload) as (
      select 0,json_object('value',1)
      union all select cast(n+1 as integer),json_object('child',payload) from r where n<2
    ) select payload from r`;
    assert.equal(engine.db.prepare(sql).all().length, 3);
    const result = new Typer(engine, new Map()).analyze(sql, "m");
    assert.equal(result.columns[0]!.type, '{ "value": number } | { "child": string }');
    assert.equal(typeof JSON.parse(engine.db.prepare(sql).all()[1]!.payload as string).child, "string");
  } finally { engine.close(); }
});

test("a recursive CTE whose type exceeds the character budget is refused", () => {
  const engine = new Engine([]);
  try {
    // A key this long alone exceeds the build's 65,536-character type
    // budget in the very first round, without any self-reference: a
    // json_object value that embeds a JSON-typed self-reference collapses
    // to a constant "string" placeholder after one round (mergeColumn
    // keeps a merged guess's json flag true forever, and valueType
    // replaces any JSON-typed reference with "string"), so no query built
    // from this file's other json_object patterns ever reaches the
    // 32-step limit; the character budget is the only threshold this test
    // can reach.
    const hugeKey = "k".repeat(70_000);
    const sql = `with recursive r(n, payload) as (
      select 0, json_object('${hugeKey}', 1)
      union all select cast(n+1 as integer), json_object('k', 1) from r where n < 1
    ) select payload from r`;
    assert.throws(
      () => new Typer(engine, new Map()).analyze(sql, "m"),
      (e: unknown) => e instanceof BuildError && /result types do not stabilize within 32 steps and 65536 type characters/.test(e.message),
    );
  } finally { engine.close(); }
});
