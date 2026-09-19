// Responsibility: exercise adoption, query repair, and a populated transition through the CLI.
// Boundary: local evidence; remote adapter execution has its own opt-in suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { analyzeSchema } from '../src/build/analyze.ts';
import { queries } from '../src/index.ts';
import { node } from '../src/node.ts';
import { fixtureDir, librarySpecifier, specifier } from './fixture-dir.ts';

const root = resolve(import.meta.dirname, '..');
const schema = `create table accounts(name text not null) strict;
create table invoices(account text not null, amount integer not null) strict;`;
const initial = 'select name from accounts order by name';
const report = `with totals as (
  select account, cast(sum(amount) as integer) as total
  from invoices group by account
)
select a.name, t.total
from accounts a left join totals t on t.account = a.name
order by a.name`;

test('SQL changes retain caller types, expose repair steps, and rehearse against stored rows', t => {
  const dir = fixtureDir('solarsql-workflow-');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  symlinkSync(join(root,'node_modules'),join(dir,'node_modules'),'dir');
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  const ddl = join(dir,'schema.sql'), catalog = join(dir,'queries.json'), out = join(dir,'generated.ts');
  const database = join(dir,'app.sqlite'), change = join(dir,'change.sql'), checks = join(dir,'checks.json');
  writeFileSync(ddl,schema);
  writeFileSync(catalog,JSON.stringify({report:initial}));
  const cli = (...args:string[]) => {
    const child = spawnSync(process.execPath,[join(root,'src/build/cli.ts'),...args],{encoding:'utf8',timeout:15_000});
    assert.ifError(child.error);
    return {status:child.status, report:JSON.parse(child.stdout)};
  };
  // --library only ever lands in a type-only import (src/build/emit.ts), which
  // tsc needs as a plain path (see test/fixture-dir.ts); it stays absolute.
  const analyze = (...args:string[]) => cli('analyze',ddl,catalog,'--out',out,'--library',join(root,'src/index.ts'),...args);
  assert.equal(analyze().status,0);
  writeFileSync(catalog,JSON.stringify({report:report.replace('sum(amount)','sum(missing)')}));
  const broken = analyze();
  assert.equal(broken.status,1);
  assert.deepEqual(broken.report.diagnostics[0].locations,['queries.report']);
  writeFileSync(catalog,JSON.stringify({report}));
  assert.equal(analyze('--check').report.diagnostics[0].code,'GENERATED_STALE');
  const repaired = analyze();
  assert.equal(repaired.status,0);
  assert.deepEqual(repaired.report.operations[0].columns,[{name:'name',type:'string',json:false},{name:'total',type:'number | null',json:false}]);
  assert.deepEqual(repaired.report.operations[0].reads,['accounts','invoices']);
  assert.equal(analyze('--check').status,0);
  writeFileSync(join(dir,'consumer.ts'), `
import { queries, type Row } from ${JSON.stringify(librarySpecifier(dir))};
import { generated, statements } from './generated.ts';
export const q = queries(generated, statements);
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Report = Assert<Equal<Row<typeof q.report>, {name:string;total:number|null}>>;
`);
  const compiled = spawnSync(join(root,'node_modules/.bin/tsc'),['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')],{encoding:'utf8',timeout:30_000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const db = new DatabaseSync(database);
  db.exec(schema);
  db.exec("insert into accounts values ('A'),('B'); insert into invoices values ('A',5),('A',7)");
  db.close();
  const before = readFileSync(database);
  writeFileSync(change,'alter table invoices add column note text;');
  const rules = {queries:{initial,report},assertions:{accounts:'select count(*) = 2 from accounts',amounts:'select sum(amount) = 12 from invoices'}};
  writeFileSync(checks,JSON.stringify(rules));
  const rehearsal = cli('rehearse',database,change,checks);
  assert.equal(rehearsal.status,0,JSON.stringify(rehearsal.report));
  assert.deepEqual(rehearsal.report.before,{accounts:2,invoices:2});
  assert.deepEqual(rehearsal.report.after,rehearsal.report.before);
  assert.deepEqual(rehearsal.report.queries,['initial','report']);
  assert.deepEqual(readFileSync(database),before);
  writeFileSync(checks,JSON.stringify({assertion:rules.assertions}));
  const misspelled = cli('rehearse',database,change,checks);
  assert.equal(misspelled.status,1);
  assert.equal(misspelled.report.diagnostics[0].code,'CHECKS_INVALID');
  assert.deepEqual(readFileSync(database),before);
  writeFileSync(join(dir,'execute.mjs'), `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { node } from ${JSON.stringify(specifier(dir, join(root,'src/node.ts')))};
import { q } from './consumer.ts';
const db = new DatabaseSync(${JSON.stringify(database)});
try {
  const adapter = node(db);
  assert.equal(q.report.sql,${JSON.stringify(report)});
  const expected = [{name:'A',total:12},{name:'B',total:null}];
  assert.deepEqual(await adapter.all(q.report),expected);
  assert.deepEqual(db.prepare(q.report.sql).all().map(row=>({...row})),expected);
  db.exec('alter table invoices add column note text');
  assert.deepEqual(await adapter.all(q.report),expected);
} finally { db.close(); }
`);
  const executed = spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:15_000});
  assert.equal(executed.status,0,executed.stdout+executed.stderr);
});

test('generated outer-join reports preserve arbitrary invoice totals and empty accounts', async t => {
  const { testAsync } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  const dir = mkdtempSync(join(tmpdir(),'solarsql-report-property-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'generated.ts');
  writeFileSync(file,analyzeSchema(schema,{report},join(root,'src/index.ts')).generated);
  const emitted = await import(pathToFileURL(file).href);
  const q = queries(emitted.generated, emitted.statements);
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(schema);
  db.exec("insert into accounts values ('A'),('B')");
  const adapter = node(db);
  await testAsync(async tc => {
    const amounts = tc.draw(gs.arrays(gs.integers({minValue:-1000,maxValue:1000}),{maxSize:20}));
    db.exec('delete from invoices');
    for (const amount of amounts) db.prepare("insert into invoices values ('A', ?)").run(amount);
    assert.deepEqual(await adapter.all(q.report!), [
      {name:'A',total:amounts.length ? amounts.reduce((sum,n)=>sum+n,0) : null},
      {name:'B',total:null},
    ]);
  });
});
