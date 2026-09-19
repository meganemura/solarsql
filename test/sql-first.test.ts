// Responsibility: prove SQL survives generation, caller compilation, and adapter execution.
// Boundary: scope inference cases live with the resolver; this test crosses its public seams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, migration } from "../src/build/build.ts";
import { stockSchema } from "../spike/10-sql-scopes.ts";
import { fixtureDir, librarySpecifier, specifier } from "./fixture-dir.ts";

const root = resolve(import.meta.dirname, "..");

test("original SQL crosses CTEs, FULL JOIN, UNION and scalar JSON with precise caller types", async (t) => {
  const dir = fixtureDir("solarsql-scopes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "stock"));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  // The config's `library` is only ever written into a type-only import (see
  // src/build/emit.ts), which Node never resolves at runtime and tsc rejects
  // as a file:// URL, so it stays a plain absolute path.
  const library = join(root, "src/index.ts");
  const fixture = join(root, "spike/10-sql-scopes.ts");
  writeFileSync(join(dir, "config.ts"), `export default { modules: ["./stock"], migrations: "./migrations", library: ${JSON.stringify(library)} };`);
  writeFileSync(join(dir, "stock/module.ts"), [
    `import { table, queries } from ${JSON.stringify(librarySpecifier(join(dir, "stock")))};`,
    `import { stockSql } from ${JSON.stringify(specifier(join(dir, "stock"), fixture))};`,
    `import { generated } from "./solarsql.generated.ts";`,
    ...Object.entries(stockSchema).map(([name, sql]) => `export const ${name} = table(${JSON.stringify(sql)});`),
    "export const stockQueries = queries(generated, stockSql);",
  ].join("\n"));
  const config = join(dir, "config.ts");
  await build(config);
  const written = await migration(config, "stock");
  assert.ok(written.filename);
  writeFileSync(join(dir, "consumer.ts"), `
import type { Id, Row, Params, SqlValue } from ${JSON.stringify(library)};
import { stockQueries } from "./stock/module.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type Filter = Assert<Equal<Params<typeof stockQueries.filtered>, { minimum: number }>>;
export type Literals = Assert<Equal<Row<typeof stockQueries.literals>, { column1: number | string | null }>>;
export type Values = Assert<Equal<Row<typeof stockQueries.values>, { value: SqlValue }>>;
export type Cte = Assert<Equal<Row<typeof stockQueries.cte>, { sku: Id<"expected_stock">; qty: number }>>;
export type Reconciliation = Assert<Equal<Row<typeof stockQueries.reconciliation>, {
  expected_sku: Id<"expected_stock"> | null; expected_qty: number | null;
  actual_sku: Id<"actual_stock"> | null; actual_qty: number | null;
}>>;
export type Observation = Assert<Equal<Row<typeof stockQueries.observations>, { observation: number | string }>>;
export type Detail = Assert<Equal<Row<typeof stockQueries.details>, { sku: Id<"expected_stock">; actual: { qty: number } | null }>>;
`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "esnext", module: "nodenext", strict: true, noEmit: true,
    allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"],
  }, files: ["consumer.ts"] }));
  const typed = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", join(dir, "tsconfig.json")], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(typed.error);
  assert.equal(typed.status, 0, typed.stdout + typed.stderr);

  // A fresh process imports the emitted metadata instead of the build's bootstrap stub.
  writeFileSync(join(dir, "execute.mjs"), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { node, migrate } from ${JSON.stringify(specifier(dir, join(root, "src/node.ts")))};
import { stockSql, populateStock } from ${JSON.stringify(specifier(dir, fixture))};
import { stockQueries } from './stock/module.ts';
const db = new DatabaseSync(':memory:');
try {
  migrate(db, [{ name: ${JSON.stringify(written.filename)}, sql: readFileSync(${JSON.stringify(join(dir, "migrations", written.filename!))}, 'utf8') }]);
  populateStock(db);
  const adapter = node(db);
  const results = {};
  for (const [name, sql] of Object.entries(stockSql)) {
    const query = stockQueries[name];
    assert.equal(query.sql, sql);
    const params = name === "filtered" ? { minimum: 10 } : {};
    const direct = db.prepare(sql).all(params).map(row => ({ ...row }));
    const expected = direct.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, query.meta.json.includes(key) && value !== null ? JSON.parse(value) : value])));
    results[name] = await adapter.all(query, params);
    assert.deepEqual(results[name], expected);
  }
  assert.deepEqual(results.values, [{ value: 1 }, { value: "counted" }, { value: null }]);
  assert.deepEqual(results.reconciliation, [
    { expected_sku: 'A', expected_qty: 10, actual_sku: 'A', actual_qty: 9 },
    { expected_sku: 'B', expected_qty: 20, actual_sku: null, actual_qty: null },
    { expected_sku: null, expected_qty: null, actual_sku: 'C', actual_qty: 30 },
  ]);
  assert.deepEqual(results.details, [{ sku: 'A', actual: { qty: 9 } }, { sku: 'B', actual: null }]);
  assert.deepEqual(results.observations, [{ observation: 10 }, { observation: 20 }, { observation: 'counted' }]);
} finally { db.close(); }
`);
  const executed = spawnSync(process.execPath, [join(dir, "execute.mjs")], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(executed.error);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
});

test("integer and blob keys retain runtime types while text references retain brands", async (t) => {
  const dir = fixtureDir("solarsql-key-types-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "keys"));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const library = join(root, "src/index.ts");
  const ddl = [
    'create table counters(id integer primary key not null) strict',
    'create table chunks(id blob primary key not null) strict',
    'create table names(id text primary key not null) strict',
    'create table refs(id text primary key not null, numeric_ref integer references names(id), text_ref text references names(id)) strict',
  ];
  writeFileSync(join(dir, "config.ts"), `export default { modules: ["keys"], migrations: "migrations", library: ${JSON.stringify(library)} };`);
  writeFileSync(join(dir, "keys/module.ts"), `
import { table, queries } from ${JSON.stringify(librarySpecifier(join(dir, "keys")))};
import { generated } from './solarsql.generated.ts';
${ddl.map((sql, i) => `export const t${i} = table(${JSON.stringify(sql)});`).join('\n')}
export const q = queries(generated, { counters: 'select id from counters where id = :id', chunks: 'select id from chunks', refs: 'select numeric_ref, text_ref from refs' });
`);
  await build(join(dir, "config.ts"));
  writeFileSync(join(dir, "consumer.ts"), `
import { newId, type Row, type Params, type Id } from ${JSON.stringify(library)};
import { q } from './keys/module.ts';
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Counter = Assert<Equal<Row<typeof q.counters>, {id: number}>>;
export type Parameter = Assert<Equal<Params<typeof q.counters>, {id: number}>>;
export type Chunk = Assert<Equal<Row<typeof q.chunks>, {id: Uint8Array}>>;
export type References = Assert<Equal<Row<typeof q.refs>, {numeric_ref: number | null; text_ref: Id<'names'> | null}>>;
// @ts-expect-error UUID generation requires a text identity.
newId<Row<typeof q.counters>['id']>();
newId<Id<'names'>>();
`);
  const compiled = spawnSync(join(root, "node_modules/.bin/tsc"), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'esnext', '--module', 'nodenext', '--allowImportingTsExtensions', join(dir, 'consumer.ts')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  writeFileSync(join(dir, 'execute.mjs'), `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { node } from ${JSON.stringify(specifier(dir, join(root, 'src/node.ts')))};
import { q } from './keys/module.ts';
const db = new DatabaseSync(':memory:');
db.exec(${JSON.stringify(ddl.join(';'))});
db.exec("insert into counters values (42); insert into chunks values (x'0011'); insert into names values ('42'); insert into refs values ('r',42,'42')");
const adapter = node(db);
assert.deepEqual(await adapter.all(q.counters, {id:42}), [{id:42}]);
assert.deepEqual(await adapter.all(q.chunks), [{id:new Uint8Array([0,17])}]);
assert.deepEqual(await adapter.all(q.refs), [{numeric_ref:42,text_ref:'42'}]);
db.close();
`);
  const executed = spawnSync(process.execPath, [join(dir, 'execute.mjs')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
});


test("CHECK-derived generated rows compile with their stored SQLite types", async (t) => {
  const { Engine } = await import("../src/build/facts.ts");
  const { Typer } = await import("../src/build/typegen.ts");
  const { emitGenerated } = await import("../src/build/emit.ts");
  const dir = mkdtempSync(join(tmpdir(), "solarsql-check-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const engine = new Engine([`create table values_table(
    text_value text not null check(text_value in (1)),
    number_value integer not null check(number_value in ('1')),
    enum_value text not null check(enum_value in ('a', 'b')),
    folded_value text collate nocase not null check(folded_value in ('a'))
  ) strict`]);
  try {
    const sql = "select * from values_table";
    const analysis = new Typer(engine, new Map()).analyze(sql, "values");
    writeFileSync(join(dir, "generated.ts"), emitGenerated({
      library: join(root, "src/index.ts"), module: "values", ownBrands: [], importedBrands: [], entries: [{ key: sql, analysis }],
    }));
    writeFileSync(join(dir, "consumer.ts"), `
import type { Generated } from './generated.ts';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type Checked = Assert<Equal<Generated[${JSON.stringify(sql)}]['row'], {
  text_value: string; number_value: number; enum_value: 'a' | 'b'; folded_value: string;
}>>;
`);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "esnext", module: "nodenext", strict: true, noEmit: true,
      allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"],
    }, files: ["consumer.ts"] }));
    const typed = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", join(dir, "tsconfig.json")], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(typed.error);
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
  } finally { engine.close(); }
});
