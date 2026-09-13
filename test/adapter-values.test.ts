// Responsibility: test generated contracts and scalar normalization across adapters.
// Boundary: local Miniflare evidence; deployed behavior needs the remote suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, relative } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { analyzeSchema } from '../src/build/analyze.ts';
import { workerMiniflare } from './worker.ts';
import { parseJson } from '../src/runtime/plan.ts';
import { test as property } from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';

test('BLOB conversion preserves bytes and JSON arrays', () => {
  property(tc => {
    const bytes = Uint8Array.from(tc.draw(gs.binary()));
    const values = tc.draw(gs.arrays(gs.integers()));
    for (const format of ['native', 'd1'] as const) {
      const raw = format === 'native' ? Uint8Array.from(bytes).buffer : Array.from(bytes);
      assert.deepEqual(parseJson([{ raw, json: JSON.stringify(values), nullable: null }], ['json'], format), [{ raw: bytes, json: values, nullable: null }]);
    }
  });
});

test('local D1 and Durable Objects return Uint8Array and decoded JSON', async t => {
  const root = resolve(import.meta.dirname, '..');
  const mf = workerMiniflare(resolve(root, 'test/value-worker.ts'), root, { durableObjects: { VALUES: 'Values' } });
  t.after(() => mf.dispose());
  for (const path of ['/', '/do']) {
    const response = await mf.dispatchFetch(`http://localhost${path}`);
    assert.deepEqual(await response.json(), { bytes: [0,255], typed: true, empty: null, n: Number.MAX_SAFE_INTEGER, items: [1,2], batchTyped: true });
  }
});

test('generated named-slot contracts compile and execute on Node, D1, and Durable Objects', async t => {
  const root=resolve(import.meta.dirname,'..');
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'solarsql-slots-')));
  let mf:ReturnType<typeof workerMiniflare>|undefined;
  t.after(async()=>{await mf?.dispose();rmSync(dir,{recursive:true,force:true});});
  const library=relative(dir,join(root,'src/index.ts'));
  const sql=`with data as (select cast(1 as integer) as id,cast('one' as text) as value
    union all select cast(2 as integer),cast('two' as text)
    union all select cast(3 as integer),cast('three' as text))
    select id from data where id=:id or value=@id or id=$other order by id`;
  const report=analyzeSchema('',{query:sql},library);
  assert.deepEqual(report.operations[0]!.params,[{name:':id',type:'number | null',encode:false},{name:'@id',type:'string | null',encode:false},{name:'other',type:'number | null',encode:false}]);
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  writeFileSync(join(dir,'generated.ts'),report.generated);
  writeFileSync(join(dir,'consumer.ts'),`
import {queries, type Params} from ${JSON.stringify(library)};
import {generated,statements} from './generated.ts';
export const q=queries(generated,statements);
export const params:Params<typeof q.query>={':id':1,'@id':'two',other:3};
// @ts-expect-error SQLite gives @id a text contract.
export const wrong:Params<typeof q.query>={':id':1,'@id':2,other:3};
`);
  const typed=spawnSync(join(root,'node_modules/.bin/tsc'),['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')],{encoding:'utf8',timeout:30_000});
  assert.equal(typed.status,0,typed.stdout+typed.stderr);
  writeFileSync(join(dir,'execute.mjs'),`
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {node} from ${JSON.stringify(relative(dir,join(root,'src/node.ts')))};
import {q,params} from './consumer.ts';
const raw=new DatabaseSync(':memory:');try{assert.deepEqual(await node(raw).all(q.query,params),[{id:1},{id:2},{id:3}]);}finally{raw.close();}
`);
  const executed=spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:30_000});
  assert.equal(executed.status,0,executed.stdout+executed.stderr);
  writeFileSync(join(dir,'worker.ts'),`
import {DurableObject} from 'cloudflare:workers';
import {d1} from ${JSON.stringify(relative(dir,join(root,'src/d1.ts')))};
import {durable} from ${JSON.stringify(relative(dir,join(root,'src/durable.ts')))};
import {q,params} from './consumer.ts';
export class Slots extends DurableObject {async fetch(){return Response.json(await durable(this.ctx.storage).all(q.query,params));}}
export default {async fetch(request,env){if(new URL(request.url).pathname==='/do')return env.SLOTS.get(env.SLOTS.idFromName('slots')).fetch('http://local');return Response.json(await d1(env.DB).all(q.query,params));}};
`);
  mf=workerMiniflare(join(dir,'worker.ts'),resolve('/'),{durableObjects:{SLOTS:'Slots'}});
  for(const path of ['/','/do']) {
    const response=await mf.dispatchFetch('http://localhost'+path);
    assert.deepEqual(await response.json(),[{id:1},{id:2},{id:3}]);
  }
});

test('generated JSONB contracts compile and execute on Node, D1, and Durable Objects', async t => {
  const root=resolve(import.meta.dirname,'..');
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'solarsql-jsonb-')));
  let mf:ReturnType<typeof workerMiniflare>|undefined;
  t.after(async()=>{await mf?.dispose();rmSync(dir,{recursive:true,force:true});});
  const library=relative(dir,join(root,'src/index.ts'));
  const sql="select json_object('data',value) as result from payload";
  const report=analyzeSchema('create table payload(value blob) strict',{query:sql},library);
  assert.equal(report.operations[0]!.columns[0]!.type,'{ "data": JsonValue }');
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  writeFileSync(join(dir,'generated.ts'),report.generated);
  writeFileSync(join(dir,'consumer.ts'),`
import {queries, type Row, type JsonValue} from ${JSON.stringify(library)};
import {generated,statements} from './generated.ts';
export const q=queries(generated,statements);
export const expected:JsonValue={nested:[true,null,3],text:'value'};
export const params={};
export const typedRow:Row<typeof q.query>={result:{data:expected}};
export function check(value:JsonValue):JsonValue{return value;}
// @ts-expect-error Binary storage does not describe decoded JSON.
export const wrong:JsonValue=new Uint8Array();
`);
  const typed=spawnSync(join(root,'node_modules/.bin/tsc'),['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')],{encoding:'utf8',timeout:30_000});
  assert.equal(typed.status,0,typed.stdout+typed.stderr);
  writeFileSync(join(dir,'execute.mjs'),`
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {node} from ${JSON.stringify(relative(dir,join(root,'src/node.ts')))};
import {q,params,expected,check} from './consumer.ts';
const raw=new DatabaseSync(':memory:');try{raw.exec('create table payload(value blob) strict');raw.prepare('insert into payload values(jsonb(?))').run(JSON.stringify(expected));const rows=await node(raw).all(q.query,params);assert.deepEqual(check(rows[0].result.data),expected);}finally{raw.close();}
`);
  const executed=spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:30_000});
  assert.equal(executed.status,0,executed.stdout+executed.stderr);
  writeFileSync(join(dir,'worker.ts'),`
import {DurableObject} from 'cloudflare:workers';
import {d1} from ${JSON.stringify(relative(dir,join(root,'src/d1.ts')))};
import {durable} from ${JSON.stringify(relative(dir,join(root,'src/durable.ts')))};
import {q,params,expected,check} from './consumer.ts';
export class Slots extends DurableObject {async fetch(){this.ctx.storage.sql.exec('create table payload(value blob) strict');this.ctx.storage.sql.exec('insert into payload values(jsonb(?))',JSON.stringify(expected));return Response.json(await durable(this.ctx.storage).all(q.query,params));}}
export default {async fetch(request,env){if(new URL(request.url).pathname==='/do')return env.SLOTS.get(env.SLOTS.idFromName('slots')).fetch('http://local');await env.DB.exec('create table payload(value blob) strict');await env.DB.prepare('insert into payload values(jsonb(?))').bind(JSON.stringify(expected)).run();return Response.json(await d1(env.DB).all(q.query,params));}};
`);
  mf=workerMiniflare(join(dir,'worker.ts'),resolve('/'),{durableObjects:{SLOTS:'Slots'}});
  for(const path of ['/','/do']) {
    const response=await mf.dispatchFetch('http://localhost'+path);
    assert.deepEqual(await response.json(),[{result:{data:{nested:[true,null,3],text:'value'}}}]);
  }
});
