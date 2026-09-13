// Responsibility: build-time statement roles and transaction containment.
// Boundary: runtime behavior of valid plans is covered by adapter tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../src/build/build.ts";

async function project(body: string, rejects: boolean | RegExp): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-role-"));
  try {
    mkdirSync(join(dir, "items"));
    writeFileSync(join(dir, "items/module.ts"), `import { table, queries, commands, assert } from ${JSON.stringify(resolve("src/index.ts"))};
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
