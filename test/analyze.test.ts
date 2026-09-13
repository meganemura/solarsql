// Responsibility: verify schema-only adoption across generation, compilation, and execution.
// Boundary: module ownership checks belong to build tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeSchema } from "../src/build/analyze.ts";

const root = resolve(import.meta.dirname, "..");
const library = join(root, "src/index.ts");
const schema = 'create table legacy(n integer, label); create table items(n integer not null, label text) strict;';
const catalog = { legacy: 'select n, label from legacy', items: '-- Original SQL\nselect n, label from items where n = :n;' };

test('schema-only generation preserves SQL and coexists with a direct SQLite driver', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-analyze-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const report = analyzeSchema(schema, catalog, library);
  assert.equal(report.contract.imports, false);
  assert.equal(report.operations[1]!.sql, catalog.items);
  assert.deepEqual(report.operations[1]!.params, [{name:'n',type:'number',encode:false}]);
  writeFileSync(join(dir, 'generated.ts'), report.generated);
  writeFileSync(join(dir, 'consumer.ts'), `
import { queries, type Row, type Params, type SqlValue } from ${JSON.stringify(library)};
import { generated, statements } from './generated.ts';
export const q = queries(generated, statements);
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Legacy = Assert<Equal<Row<typeof q.legacy>, {n:SqlValue;label:SqlValue}>>;
export type Item = Assert<Equal<Row<typeof q.items>, {n:number;label:string|null}>>;
export type Parameter = Assert<Equal<Params<typeof q.items>, {n:number}>>;
`);
  const typed = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')], {encoding:'utf8',timeout:30_000});
  assert.equal(typed.status,0,typed.stdout+typed.stderr);
  writeFileSync(join(dir, 'execute.mjs'), `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { node } from ${JSON.stringify(join(root,'src/node.ts'))};
import { q } from './consumer.ts';
const db = new DatabaseSync(':memory:');
try {
  db.exec(${JSON.stringify(schema)});
  db.exec("insert into legacy values ('not a number', x'00ff'); insert into items values (7, null)");
  assert.equal(q.items.sql, ${JSON.stringify(catalog.items)});
  const adapter = node(db);
  assert.deepEqual(await adapter.all(q.legacy), db.prepare(q.legacy.sql).all().map(row=>({...row})));
  assert.deepEqual(await adapter.all(q.items,{n:7}),[{n:7,label:null}]);
  db.exec("insert into items values (8,'direct driver')");
  assert.deepEqual(await adapter.all(q.items,{n:8}),[{n:8,label:'direct driver'}]);
} finally { db.close(); }
`);
  const executed = spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:30_000});
  assert.equal(executed.status,0,executed.stdout+executed.stderr);
});

test('analyze CLI checks freshness without writing and reports query locations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-analyze-cli-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const ddl = join(dir,'schema.sql'), sql = join(dir,'queries.json'), out = join(dir,'generated.ts');
  writeFileSync(ddl,schema);
  writeFileSync(sql,JSON.stringify(catalog));
  const run = (...args:string[]) => {
    const child = spawnSync(process.execPath,[join(root,'src/build/cli.ts'),'analyze',ddl,sql,'--out',out,...args],{encoding:'utf8',timeout:10_000});
    return {status:child.status, report:JSON.parse(child.stdout)};
  };
  assert.equal(run().status,0);
  const before = readFileSync(out,'utf8');
  assert.equal(run('--check').status,0);
  writeFileSync(sql,JSON.stringify({...catalog,count:'select cast(count(*) as integer) as n from items'}));
  const stale = run('--check');
  assert.equal(stale.status,1);
  assert.equal(stale.report.diagnostics[0].code,'GENERATED_STALE');
  assert.equal(readFileSync(out,'utf8'),before);
  writeFileSync(sql,JSON.stringify({broken:'select missing from items'}));
  const failed = run();
  assert.equal(failed.status,1);
  assert.deepEqual(failed.report.diagnostics[0].locations,['queries.broken']);
  assert.equal(readFileSync(out,'utf8'),before);
});

test('schema-only analysis rejects invalid inputs and shares duplicate SQL metadata', () => {
  for (const value of [null, [], {query:1}]) assert.throws(()=>analyzeSchema(schema,value),/JSON object/);
  assert.throws(()=>analyzeSchema('attach database ":memory:" as extra',{}),/CREATE statements/);
  assert.throws(()=>analyzeSchema(schema,{write:'delete from items'}),/SELECT|read/);
  assert.throws(()=>analyzeSchema(schema,{entries:'select n from items'}),/reserved/);
  const same = analyzeSchema(schema,{one:catalog.items,two:catalog.items});
  assert.equal(same.operations.length,2);
  assert.equal(same.generated.match(/params: \{ n: number \}/g)?.length,1);
});
