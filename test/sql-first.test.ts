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

const root = resolve(import.meta.dirname, "..");

test("original SQL crosses CTEs, FULL JOIN, UNION and scalar JSON with precise caller types", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "solarsql-scopes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "stock"));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const library = join(root, "src/index.ts");
  const fixture = join(root, "spike/10-sql-scopes.ts");
  writeFileSync(join(dir, "config.ts"), `export default { modules: ["./stock"], migrations: "./migrations", library: ${JSON.stringify(library)} };`);
  writeFileSync(join(dir, "stock/module.ts"), [
    `import { table, queries } from ${JSON.stringify(library)};`,
    `import { stockSql } from ${JSON.stringify(fixture)};`,
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
import { node, migrate } from ${JSON.stringify(join(root, "src/node.ts"))};
import { stockSql, populateStock } from ${JSON.stringify(fixture)};
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
