// Responsibility: verify source context through the public build entry point.
// Boundary: exact diagnostic examples; SQL typing rules have their own tests.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { build } from "../src/build/build.ts";
import { BuildError } from "../src/build/typegen.ts";
import { fixtureDir, librarySpecifier } from "./fixture-dir.ts";

// The config's `library` is only ever written into a type-only import (see
// src/build/emit.ts), which Node never resolves at runtime, so it stays a
// plain absolute path (see test/fixture-dir.ts for the module.ts imports,
// which Node does resolve).
const library = resolve(import.meta.dirname, "../src/index.ts");

async function diagnostic(body: string, check: (error: BuildError, source: string) => void, other?: string): Promise<void> {
  const dir = fixtureDir("solarsql-diagnostic-");
  const source = join(dir, "items/module.ts");
  try {
    mkdirSync(join(dir, "items"));
    writeFileSync(source, `import { table, queries, commands, assert } from ${JSON.stringify(librarySpecifier(join(dir, "items")))};
import { generated } from "./solarsql.generated.ts";
export const items = table("create table items (id text primary key not null, count integer not null) strict");
${body}`);
    if (other) {
      mkdirSync(join(dir, "other"));
      writeFileSync(join(dir, "other/module.ts"), `import { table } from ${JSON.stringify(librarySpecifier(join(dir, "other")))};\n${other}`);
    }
    const config = join(dir, "solarsql.config.ts");
    writeFileSync(config, `export default { modules: ["./items"${other ? ', "./other"' : ""}], migrations: "./migrations", library: ${JSON.stringify(library)} };`);
    await assert.rejects(build(config), (error: unknown) => {
      assert.ok(error instanceof BuildError, String(error));
      check(error, source);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("invalid query identifies its source and exported catalog", async () => {
  await diagnostic('export const itemQueries = queries(generated, { broken: "select missing from items" });', (error, source) => {
    assert.ok(error.message.includes(`${source}: query itemQueries.broken`));
    assert.match(error.message, /no such column: missing/);
    assert.equal(error.sql, "select missing from items");
  });
});

for (const [shape, location, sql] of [
  ['plan: ["delete from items", "update items set missing = 1"]', "plan item 2", "update items set missing = 1"],
  ['plan: ["delete from items", assert("available", "missing > 0")]', "plan item 2, assert available", "missing > 0"],
  ['plan: ["delete from items"], returns: "select missing from items"', "returns", "select missing from items"],
]) {
  test(`invalid command SQL identifies ${location}`, async () => {
    await diagnostic(`export const itemCommands = commands(generated, { change: { ${shape} } });`, (error, source) => {
      assert.ok(error.message.includes(`${source}: command itemCommands.change, ${location}`));
      assert.match(error.message, /no such column: missing/);
      assert.ok(error.sql?.includes(sql!));
    });
  });
}

test("reused SQL reports every catalog and command position", async () => {
  await diagnostic(`
const sql = "select missing from items";
export const first = queries(generated, { broken: sql });
export const second = queries(generated, { alsoBroken: sql });
export const writes = commands(generated, { change: { plan: [sql, sql], returns: sql } });`, (error, source) => {
    for (const location of ["query first.broken", "query second.alsoBroken", "command writes.change, plan item 1", "command writes.change, plan item 2", "command writes.change, returns"]) {
      assert.ok(error.message.includes(`${source}: ${location}`), error.message);
    }
    assert.equal(error.sql, "select missing from items");
  });
});

test("a boundary error retains its reason and adds the query location", async () => {
  await diagnostic('export const itemQueries = queries(generated, { foreign: "select value from secrets" });', (error, source) => {
    assert.ok(error.message.includes(`${source}: query itemQueries.foreign`));
    assert.match(error.message, /module items reads secrets.value. Module other owns secrets/);
    assert.equal(error.sql, "select value from secrets");
  }, 'export const secrets = table("create table secrets (id text primary key not null, value text not null) strict");');
});

test("command validation identifies the exported catalog and source", async () => {
  await diagnostic('export const itemCommands = commands(generated, { change: { plan: [assert("changed", "changes() > 0")] } });', (error, source) => {
    assert.ok(error.message.includes(`${source}: command itemCommands.change`));
    assert.match(error.message, /command items.change: assert changed uses changes\(\)/);
    assert.ok(error.message.includes(`${source}: command itemCommands.change, plan item 1, assert changed`));
  });
});

test("conflicting command parameters report shared SQL across exported catalogs", async () => {
  await diagnostic(`
const shared = "select cast(:value as text) as value";
export const itemQueries = queries(generated, { echo: shared });
export const first = commands(generated, { text: { plan: [shared, "select id from items where id = :value"] } });
export const second = commands(generated, { number: { plan: [shared, "select count from items where count = :value"] } });`, (error, source) => {
    assert.match(error.message, /parameter "value"/);
    for (const location of [
      "query itemQueries.echo",
      "command first.text, plan item 1",
      "command second.number",
      "command second.number, plan item 1",
      "command second.number, plan item 2",
    ]) {
      assert.ok(error.message.includes(`${source}: ${location}`), error.message);
    }
    const locations = error.message.split("\n").filter((line) => line.startsWith("  at: "));
    assert.equal(new Set(locations).size, locations.length);
  });
});
