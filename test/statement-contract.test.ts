// Responsibility: build-time statement roles and transaction containment.
// Boundary: runtime behavior of valid plans is covered by adapter tests.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/build/build.ts";
import { fixtureDir, librarySpecifier } from "./fixture-dir.ts";

async function project(body: string, rejects: boolean | RegExp): Promise<void> {
  const dir = fixtureDir("solarsql-role-");
  try {
    mkdirSync(join(dir, "items"));
    writeFileSync(join(dir, "items/module.ts"), `import { table, queries, commands, assert } from ${JSON.stringify(librarySpecifier(join(dir, "items")))};
import { generated } from "./solarsql.generated.ts";
export const items = table("create table items(id text primary key not null, value text not null) strict");
${body}`);
    const config = join(dir, "solarsql.config.ts");
    writeFileSync(config, 'export default { modules: ["./items"], migrations: "./migrations" };');
    if (rejects) await assert.rejects(build(config), rejects instanceof RegExp ? rejects : /module\.ts:.*(?:query|command)/s);
    else await build(config);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const sql of ["delete from items", "update items set value='x' returning id", "with x as (select id from items) delete from items"]) {
  test(`query refuses ${sql}`, () => project(`export const q = queries(generated, { bad: ${JSON.stringify(sql)} });`, true));
  test(`returns refuses ${sql}`, () => project(`export const c = commands(generated, { bad: { plan: ["select id from items"], returns: ${JSON.stringify(sql)} } });`, true));
}
for (const sql of ["COMMIT", "BEGIN", "ROLLBACK", "SAVEPOINT s", "PRAGMA user_version=1", "create table escape(x)", "update items set value='x'; delete from items"]) {
  test(`plan refuses ${sql}`, () => project(`export const c = commands(generated, { bad: { plan: [${JSON.stringify(sql)}] } });`, true));
}
test("shared SQL must satisfy each catalog role", () => project(`const sql = "delete from items";
export const c = commands(generated, { change: { plan: [sql] } });
export const q = queries(generated, { bad: sql });`, true));
test("assert predicate cannot append a statement", () => project(`export const c = commands(generated, { bad: { plan: [assert("guard", "1); delete from items; --")] } });`, true));
for (const sql of ["insert into items (id, value) values ('a','b') returning id", "update items set value='x' where id='a' returning id"]) {
  test(`plan refuses ${sql}`, () => project(`export const c = commands(generated, { bad: { plan: [${JSON.stringify(sql)}] } });`, /RETURNING clause is discarded/));
}

test("plan allows a DELETE ... RETURNING item (ADR 0136)", () => project(`export const c = commands(generated, { good: { plan: ["delete from items where id = :id returning id, value"] } });`, false));
test("plan allows a WITH ... DELETE ... RETURNING item", () => project(`export const c = commands(generated, { good: { plan: ["with x as (select 1) delete from items where id = :id returning id, value"] } });`, false));
test("a command with `returns` and a DELETE ... RETURNING item refuses, naming both", () => project(`export const c = commands(generated, { bad: {
  plan: ["delete from items where id = :id returning id, value"],
  returns: "select id from items",
} });`, /more than one row source.*select id from items.*delete from items where id = :id returning id, value/s));
test("a command with two DELETE ... RETURNING items refuses, naming both", () => project(`export const c = commands(generated, { bad: { plan: [
  "delete from items where id = :id returning id",
  "delete from items where value = :value returning id",
] } });`, /more than one row source.*delete from items where id = :id returning id.*delete from items where value = :value returning id/s));
test("a RETURNING subquery on the DELETE's own target table refuses", () => project(`export const c = commands(generated, { bad: { plan: ["delete from items where id = :id returning id, cast((select count(*) from items) as integer)"] } });`, /indeterminate/));

for (const sql of [
  "insert or rollback into items (id, value) values ('a','b')",
  "update or rollback items set value='x'",
  "with x as (select 1) insert or rollback into items (id, value) values ('a','b')",
]) {
  test(`plan refuses ${sql}`, () => project(`export const c = commands(generated, { bad: { plan: [${JSON.stringify(sql)}] } });`, /OR ROLLBACK/));
}
for (const sql of [
  "insert or ignore into items (id, value) values ('a','b')",
  "insert or replace into items (id, value) values ('a','b')",
  "insert or abort into items (id, value) values ('a','b')",
  "insert or fail into items (id, value) values ('a','b')",
  "update or ignore items set value='x'",
]) {
  test(`plan still allows ${sql}`, () => project(`export const c = commands(generated, { good: { plan: [${JSON.stringify(sql)}] } });`, false));
}
test("plan still allows a bare select with output columns", () => project(`export const c = commands(generated, { good: { plan: ["select id from items"] } });`, false));
test("CTEs, read plans, and quoted or commented semicolons remain valid", () => project(`
export const q = queries(generated, { good: "with x as (select id from items) select id from x; -- trailing ;" });
export const c = commands(generated, { good: { plan: [
  "select id from items",
  "with x as (select id from items) update items set value='a;b' where id in (select id from x); /* ; */"
], returns: "select id from items" } });`, false));

test('cross-statement type conflicts quote the generated parameter key', () => project(`
export const c=commands(generated,{ change:{ plan:[
  "update items set value=@id where :id=1",
  "update items set value=:id where @id=1"
]}});`, /parameter ":id" is number in one statement and string in another/));
