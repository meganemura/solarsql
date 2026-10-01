// Responsibility: test catalog resolution and file-backed query execution.
// Boundary: real project imports and SQLite files; no CLI process or environment overrides.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseQueryTarget, runQuery } from "../src/build/query.ts";
import { BuildError } from "../src/build/build-error.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-query-"));
  const config = join(dir, "config.ts");
  writeFileSync(config, 'export default { modules: ["./first", "./second"], migrations: "./migrations" };');
  for (const name of ["first", "second"]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "solarsql.generated.ts"), "export const generated = {};");
    writeFileSync(join(dir, name, "module.ts"), `
const meta = { params: ["value"], encode: [], json: ["nested"], reads: [] };
const q = { kind: "query", name: "read", sql: "select :value as value, '${name}' as source, json_array(1, 2) as nested", meta };
export const reads = { kind: "queries", entries: { read: q, wrong: { ...q, kind: "other" } } };
Object.defineProperty(reads.entries, "nil", { value: null });
Object.defineProperty(reads.entries, "zero", { value: 0 });
export const writes = { kind: "commands", entries: { change: { plan: [], returns: null } } };
export const other = { kind: "other", entries: { read: q } };
export const nil = null;
export const scalar = 1;
export const callable = Object.assign(() => {}, { kind: "queries", entries: { read: q } });
export const noKind = { entries: { read: q } };
`);
  }
  const database = join(dir, "data.sqlite");
  const raw = new DatabaseSync(database);
  raw.exec("pragma journal_mode=wal; create table items (id integer); insert into items values (1)");
  raw.close();
  const run = (module = "second", catalog = "reads", name = "read", path = database, timeout = 30_000) =>
    runQuery(config, { module, catalog, name }, path, { value: 42 }, timeout);
  return { dir, config, database, run, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("three nonempty components round-trip without changing their text", () => {
  hegel.test((tc) => {
    const component = gs.text({ alphabet: "abc_ 012", minSize: 1, maxSize: 20 });
    const module = tc.draw(component), catalog = tc.draw(component), name = tc.draw(component);
    assert.deepEqual(parseQueryTarget(`${module}.${catalog}.${name}`), { module, catalog, name });
  });
});

test("targets with a wrong component count or an empty component report the supplied name", () => {
  for (const spec of ["", "a", "a.b", "a.b.c.d", ".b.c", "a..c", "a.b.", "..", "..."]) {
    assert.throws(() => parseQueryTarget(spec), { name: "BuildError", message: `query name must be <module>.<catalog>.<name>: ${spec}` });
  }
});

test("the selected module supplies the rows, bound value, and decoded JSON", async () => {
  const f = fixture();
  try { assert.deepEqual(await f.run(), [{ value: 42, source: "second", nested: [1, 2] }]); }
  finally { f.clean(); }
});

test("missing modules and invalid catalogs report their target", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run("absent"), { name: "BuildError", message: `no module named "absent" in ${f.config}` });
    for (const catalog of ["absent", "nil", "scalar", "callable", "noKind", "other"]) {
      await assert.rejects(f.run("second", catalog), { name: "BuildError", message: `no query catalog named "${catalog}" in module second` });
    }
  } finally { f.clean(); }
});

test("command catalogs report the db.run remedy even for an absent entry", async () => {
  const f = fixture();
  try {
    for (const name of ["change", "absent"]) await assert.rejects(f.run("second", "writes", name), {
      name: "BuildError", message: `second.writes.${name} is a command, not a query. Run a command through db.run, not this CLI.`,
    });
  } finally { f.clean(); }
});

test("missing, null, zero, and wrong-kind query entries report the entry name", async () => {
  const f = fixture();
  try {
    for (const name of ["absent", "nil", "zero", "wrong"]) await assert.rejects(f.run("second", "reads", name), {
      name: "BuildError", message: `no query named "${name}" in second.reads`,
    });
  } finally { f.clean(); }
});

test("a missing generated file is refused without creating a stub", async () => {
  const f = fixture();
  const generated = join(f.dir, "second", "solarsql.generated.ts");
  try {
    rmSync(generated);
    await assert.rejects(f.run(), (e: unknown) => e instanceof BuildError && e.message.includes(`${generated} is missing. Run: npx solarsql build`));
    assert.equal(existsSync(generated), false);
  } finally { f.clean(); }
});

test("a nonexistent database is refused without creating a file", async () => {
  const f = fixture();
  const missing = join(f.dir, "missing.sqlite");
  try {
    await assert.rejects(f.run("second", "reads", "read", missing), (e: unknown) => e instanceof BuildError && e.message.startsWith(`--database ${missing}: `) && e.message.includes("unable to open database file"));
    assert.equal(existsSync(missing), false);
  } finally { f.clean(); }
});

test("an exclusive lock waits out the busy timeout the budget leaves and reports the database path", async () => {
  const f = fixture();
  const locker = new DatabaseSync(f.database);
  try {
    locker.exec("pragma locking_mode=exclusive; begin exclusive; update items set id=2");
    const start = performance.now();
    await assert.rejects(f.run("second", "reads", "read", f.database, 1100), {
      name: "BuildError", message: `${f.database} is locked: another connection held it for longer than 100ms. Retry.`,
    });
    assert.ok(performance.now() - start >= 90);
  } finally { locker.close(); f.clean(); }
});

test("successful and failed queries close their WAL connection", async () => {
  const f = fixture();
  const writer = new DatabaseSync(f.database);
  try {
    await f.run();
    // A retained WAL connection prevents the writer from changing journal mode.
    assert.equal(writer.prepare("pragma journal_mode=delete").get()!.journal_mode, "delete");
    writer.exec("pragma journal_mode=wal");
    await assert.rejects(runQuery(f.config, parseQueryTarget("second.reads.read"), f.database, {}), /missing parameter/);
    assert.equal(writer.prepare("pragma journal_mode=delete").get()!.journal_mode, "delete");
  } finally { writer.close(); f.clean(); }
});
