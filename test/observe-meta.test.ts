// Responsibility: verify observer metadata and isolation from database outcomes.
// Boundary: adapter contracts; telemetry delivery remains the caller's responsibility.
// The observe hook carries D1's meta: one reply for a query, the sum of the
// replies for a batch and for a command, the region from the first reply,
// and no field at all when the engine reports none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, type D1Like, type D1StatementLike } from "../src/d1.ts";
import { read, type Observed } from "../src/index.ts";
import { customerCommands, customerQueries } from "../example/modules/customers/public.ts";
import { orderQueries } from "../example/modules/orders/public.ts";

// A binding that answers every statement with the same reply.
function binding(reply: { results?: unknown; meta?: unknown }): D1Like {
  const statement: D1StatementLike = { bind: () => statement, all: async () => reply };
  return { prepare: () => statement, batch: async (statements) => statements.map(() => reply) };
}

const meta = { rows_read: 3, rows_written: 1, duration: 0.25, served_by_region: "ENAM", served_by_primary: true, changes: 1 };

test("a query carries one meta, a batch and a command the sum", async () => {
  const events: Observed[] = [];
  const db = d1(binding({ results: [], meta }), { observe: (e) => events.push(e) });
  await db.all(customerQueries.all);
  await db.batch([read(customerQueries.all), read(orderQueries.byId, { id: "o1" as never })]);
  await db.run(customerCommands.create, { id: "c1" as never, name: "Ann", email: "a@x" });
  assert.deepEqual(events.map((e) => [e.kind, e.meta]), [
    ["query", { rows_read: 3, rows_written: 1, duration: 0.25, served_by_region: "ENAM", served_by_primary: true }],
    ["batch", { rows_read: 6, rows_written: 2, duration: 0.5, served_by_region: "ENAM", served_by_primary: true }],
    // create is one statement plus its returns.
    ["command", { rows_read: 6, rows_written: 2, duration: 0.5, served_by_region: "ENAM", served_by_primary: true }],
  ]);
});

test("an engine that reports no meta leaves the field out", async () => {
  const events: Observed[] = [];
  const db = d1(binding({ results: [] }), { observe: (e) => events.push(e) });
  await db.all(customerQueries.all);
  assert.equal(events.length, 1);
  assert.ok(!("meta" in events[0]!));
});

test('observer failures preserve operation result identity and notify once', async () => {
  const {testAsync}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {observed}=await import('../src/runtime/plan.ts');
  await testAsync(async tc=>{
    const fails=tc.draw(gs.booleans());
    const mode=tc.draw(gs.sampledFrom(['throw','reject','pending','ok']));
    const events:string[]=[];
    const original=new Error('database failure');
    const result={value:tc.draw(gs.integers())};
    const hook=(event:Observed)=>{
      events.push(event.outcome);
      if(mode==='throw')throw Error('telemetry failure');
      if(mode==='reject')return Promise.reject(Error('telemetry failure'));
      if(mode==='pending')return new Promise<void>(()=>{});
    };
    const promise=observed(hook,'command','write',async()=>{if(fails)throw original;return result;},()=> 'ok');
    if(fails)await assert.rejects(promise,error=>error===original);
    else assert.equal(await promise,result);
    assert.deepEqual(events,[fails?'error':'ok']);
  },{testCases:1000});
});

test('a public Node command preserves commit and constraint results when observation throws', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {node,migrate}=await import('../src/node.ts');
  const {migrations}=await import('../example/migrations/index.ts');
  const raw=new DatabaseSync(':memory:');
  try {
    migrate(raw,migrations);
    const outcomes:string[]=[];
    const db=node(raw,{observe:e=>{outcomes.push(e.outcome);throw Error('logger failed');}});
    const params={id:'observer' as never,name:'Observer',email:'observer@example.test'};
    const created=await db.run(customerCommands.create,params);
    assert.equal(created.ok,true);
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,1);
    const duplicate=await db.run(customerCommands.create,{...params,id:'other' as never});
    assert.deepEqual(duplicate,{ok:false,kind:'unique',table:'customers',columns:['email']});
    assert.deepEqual(outcomes,['ok','unique']);
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,1);
  }finally{raw.close();}
});

test('D1 and Durable adapter calls retain outcomes after rejected observation', async () => {
  const {durable}=await import('../src/durable.ts');
  const {storageOf}=await import('../src/node.ts');
  const {DatabaseSync}=await import('node:sqlite');
  const raw=new DatabaseSync(':memory:');
  const {migrate}=await import('../src/node.ts');
  const {migrations}=await import('../example/migrations/index.ts');
  try {
    migrate(raw,migrations);
    for(const db of [d1(binding({results:[]} ),{observe:async()=>{throw Error('logger failed');}}),durable(storageOf(raw),{observe:async()=>{throw Error('logger failed');}})]) {
      assert.deepEqual(await db.all(customerQueries.all),[]);
      assert.deepEqual(await db.batch([read(customerQueries.all)]),[[]]);
    }
    // Let rejected observer promises settle; the test runner detects leaked rejections.
    await new Promise<void>(resolve=>setImmediate(resolve));
  }finally{raw.close();}
});
