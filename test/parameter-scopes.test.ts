// Responsibility: check parameter binding against lexical SELECT scopes.
// Boundary: these cases use table columns, not inferred CTE output parameters.
import assert from "node:assert/strict";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Engine } from "../src/build/facts.ts";
import { Typer } from "../src/build/typegen.ts";

test("inner and outer parameters use their own table aliases", () => {
  const engine = new Engine([
    "create table a(id text primary key not null, value integer not null) strict",
    "create table b(id text primary key not null, value text not null) strict",
  ]);
  try {
    const typer = new Typer(engine, new Map());
    const sql = `select x.id from a x where x.value=:outer and exists (select 1 from b x where x.value=:inner)`;
    assert.deepEqual(typer.analyze(sql, "m").params, [
      { name: "outer", type: "number", encode: false },
      { name: "inner", type: "string", encode: false },
    ]);
    assert.equal(typer.analyze(`with a as (select value from b) select value from a where value=:p`, "m").params[0]!.type, "string");
    assert.throws(() => typer.analyze(sql.replace(":inner", ":outer"), "m"), /two different types/);
    assert.deepEqual(typer.analyze(`select id from a x where x.value=:a union all select id from b x where x.value=:b`, "m").params.map(p => p.type), ["number", "string"]);
    assert.deepEqual(typer.analyze(`select x.id from a x where exists (select 1 from b y where x.value=:p)`, "m").params.map(p => p.type), ["number"]);
  } finally { engine.close(); }
});

test("CTE, view, derived, and bare references share result-column resolution", () => {
  const engine = new Engine([
    "create table a(id text primary key not null, value integer not null) strict",
    "create table b(id text primary key not null, value text) strict",
    "create view amounts as select value as amount from a",
  ]);
  try {
    const typer = new Typer(engine, new Map());
    for (const sql of [
      "with c(n) as (select value from a) select n from c where n=:p",
      "select amount from amounts where amount=:p",
      "select n from (select value as n from a) c where n=:p",
    ]) assert.equal(typer.analyze(sql, "m").params[0]!.type, "number", sql);
    assert.equal(typer.analyze("select id from a where exists(select 1 from b where value=:p)", "m").params[0]!.type, "string | null");
    assert.equal(typer.analyze("with c(n) as (select value from a union all select value from b) select n from c where n=:p", "m").params[0]!.type, "number | string | null");
    assert.equal(typer.analyze("with c(n) as (select value from a union all select value from b) select n from c where n in (select value from json_each(:p))", "m").params[0]!.type, "readonly (number | string)[]");
    assert.equal(typer.analyze("with c(n) as (select value from a) update a set value=1 where exists(select 1 from c where n=:p)", "m").params[0]!.type, "number");
    const shadow = `with c as (select value from a) select x.value from c x where exists (
      with c as (select value from b) select 1 from c y where x.value=:outer and y.value=:inner)`;
    assert.deepEqual(typer.analyze(shadow, "m").params.map(p => p.type), ["number", "string | null"]);
  } finally { engine.close(); }
});


test("wrapped column parameters preserve values accepted by SQLite", () => {
  hegel.test(tc => {
    const value = tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 }));
    const engine = new Engine(["create table amounts(n integer not null) strict"]);
    try {
      engine.db.prepare("insert into amounts values (?)").run(value);
      const sql = tc.draw(gs.sampledFrom([
        "with c(v) as (select n from amounts) select v from c where v=:p",
        "select v from (select n as v from amounts) c where v=:p",
      ]));
      assert.equal(new Typer(engine, new Map()).analyze(sql, "m").params[0]!.type, "number");
      assert.deepEqual(engine.db.prepare(sql).all({ p: value }).map(row => row.v), [value]);
    } finally { engine.close(); }
  });
});
