// Responsibility: verify structured engine failures and unrecognized error identity.
// Boundary: classification does not infer transaction completion for unknown failures.
// The adapter turns an engine error into a value. The message formats are
// fixed strings on node:sqlite, D1, and a Durable Object, so a message built
// from a kind, a table, and columns must parse back to the same value.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { assertFailure, constraintFailure } from "../src/runtime/plan.ts";

const ident = gs.fromRegex("[a-z_][a-z0-9_]{0,8}");
const wrap = gs.sampledFrom<(m: string, code: string) => string>([
  (m) => m,
  (m, code) => `${m}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${code})`,
  (m, code) => `D1_ERROR: ${m}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_${code})`,
]);

describe("constraintFailure", () => {
  test("unique, not null, and datatype messages round-trip through the three engine formats", () => {
    hegel.test((tc) => {
      const table = tc.draw(ident);
      const columns = tc.draw(gs.arrays(ident, { minSize: 1, maxSize: 3 }));
      const w = tc.draw(wrap);
      assert.deepEqual(constraintFailure(new Error(w(`UNIQUE constraint failed: ${columns.map((c) => `${table}.${c}`).join(", ")}`, "UNIQUE"))), { kind: "unique", table, columns });
      assert.deepEqual(constraintFailure(new Error(w(`NOT NULL constraint failed: ${table}.${columns[0]}`, "NOTNULL"))), { kind: "not_null", table, column: columns[0] });
      assert.deepEqual(constraintFailure(new Error(w(`cannot store TEXT value in INTEGER column ${table}.${columns[0]}`, "DATATYPE"))), {
        kind: "datatype",
        table,
        column: columns[0],
        stored: "TEXT",
        declared: "INTEGER",
      });
      assert.equal(constraintFailure(new Error(w(`UNIQUE constraint failed: ${table}.part.${columns[0]}`, "UNIQUE"))), null);
      assert.equal(constraintFailure(new Error(w(`NOT NULL constraint failed: ${table}.part.${columns[0]}`, "NOTNULL"))), null);
      assert.equal(constraintFailure(new Error(w(`cannot store TEXT value in INTEGER column ${table}.part.${columns[0]}`, "DATATYPE"))), null);
    });
  });

  test("check, foreign key, and the D1 cause", () => {
    assert.deepEqual(constraintFailure(new Error("CHECK constraint failed: status_ok")), { kind: "check", constraint: "status_ok" });
    assert.deepEqual(constraintFailure(new Error("D1_ERROR: CHECK constraint failed: n > 0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)")), { kind: "check", constraint: "n > 0" });
    assert.deepEqual(constraintFailure(new Error("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)")), { kind: "foreign_key" });
    const withCause = new Error("D1_ERROR: UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)", { cause: new Error("UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)") });
    assert.deepEqual(constraintFailure(withCause), { kind: "unique", table: "t", columns: ["id"] });
  });

  test("an assert is not a constraint, and an unknown error is neither", () => {
    const assertError = new Error("D1_ERROR: solarsql:assert:nonce:was_draft: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)");
    assert.equal(assertFailure(assertError, ["was_draft"], "nonce"), "was_draft");
    assert.equal(assertFailure(new Error("D1_ERROR: was_draft: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"), ["was_draft"], "nonce"), null);
    assert.equal(constraintFailure(assertError), null);
    assert.equal(constraintFailure(new Error("D1_ERROR: too many SQL variables at offset 230: SQLITE_ERROR")), null);
  });

  test("assert identities bind arbitrary public names to one command invocation", () => {
    hegel.test(tc => {
      const name = tc.draw(ident);
      const token = tc.draw(ident);
      const error = new Error(`solarsql:assert:${token}:${name}`) as Error & { errcode: number };
      error.errcode = 1811;
      assert.equal(assertFailure(error, [name], token), name);
      for (const message of [name, `solarsql:assert:${name}`, `solarsql:assert:other:${name}`]) {
        const userError = new Error(message) as Error & { errcode: number };
        userError.errcode = 1811;
        assert.equal(assertFailure(userError, [name], token), null);
      }
    }, { testCases: 1000 });
  });
});

test('unknown thrown values are not replaced by classification errors', () => {
  hegel.test(tc=>{
    const value=tc.draw(gs.sampledFrom<unknown>([null,undefined,tc.draw(gs.integers()),tc.draw(gs.text()),Symbol('failure'),{},
      {message:12},{cause:{message:false}},{get message(){throw Error('unreadable');}},
      new AggregateError([new Error('UNIQUE constraint failed: t.id')],'cleanup failed',{cause:new Error('UNIQUE constraint failed: t.id')}),
      new Proxy({}, {getPrototypeOf(){throw Error('unreadable prototype');}}),
    ]));
    assert.equal(assertFailure(value,['failed'],'nonce'),null);
    assert.equal(constraintFailure(value),null);
  },{testCases:1000});
});

test('public command adapters rethrow unrecognized values unchanged', async () => {
  const {d1}=await import('../src/d1.ts');
  const {durable}=await import('../src/durable.ts');
  const {customerCommands}=await import('../example/modules/customers/public.ts');
  for(const value of [null,undefined,7,'transport failed',{message:42},{get cause(){throw Error('unreadable');}}]) {
    const statement={bind(){return this;},async all(){throw value;}};
    const binding={prepare(){return statement;},async batch(){throw value;}};
    const storage={sql:{exec(){return {toArray(){return [];}};}},transactionSync<T>(_body:()=>T):T{throw value;}};
    for(const db of [d1(binding),durable(storage)]) {
      let rejected=false;
      try{await db.run(customerCommands.create,{id:'x' as never,name:'X',email:'x@example.test'});}
      catch(error){rejected=true;assert.equal(error,value);}
      assert.equal(rejected,true);
    }
  }
});

test('unique expression-index failures retain their actual index names', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const raw=new DatabaseSync(':memory:');
  try {
    raw.exec("create table items(value text);insert into items values('A')");
    hegel.test(tc=>{
      // Prefix avoids SQLite's reserved index namespace; SQL source excludes NUL.
      const name='user_'+tc.draw(gs.text()).replaceAll('\0','');
      const quoted='"'+name.replaceAll('"','""')+'"';
      raw.exec(`create unique index ${quoted} on items(lower(value))`);
      try {
        let error:unknown;
        try{raw.exec("insert into items values('a')");assert.fail('Expected index conflict');}catch(e){error=e;}
        assert.deepEqual(constraintFailure(error),{kind:'unique_index',index:name});
      }finally{raw.exec(`drop index ${quoted}`);}
    },{testCases:1000});
  }finally{raw.close();}
});

test('generated command callers receive index targets on Node, D1, and Durable Objects', async t => {
  const {DatabaseSync}=await import('node:sqlite');
  const {node}=await import('../src/node.ts');
  const {ddl,conflict}=await import('./index-failure-fixture.ts');
  const {ddl:collisionDdl,collisions}=await import('./assert-collision-fixture.ts');
  const {ddl:ambiguousDdl,ambiguousFailures}=await import('./ambiguous-constraint-fixture.ts');
  const {ddl:parameterDdl,parameterContracts}=await import('./parameter-contract-fixture.ts');
  const {workerMiniflare}=await import('./worker.ts');
  const {resolve}=await import('node:path');
  const expected={result:{ok:false,kind:'unique_index',index:"lower'email"},index:"lower'email"};
  const raw=new DatabaseSync(':memory:');
  try {
    raw.exec(ddl);const outcomes:string[]=[];
    assert.deepEqual(await conflict(node(raw,{observe:e=>outcomes.push(e.outcome)})),expected);
    assert.deepEqual(outcomes,['ok','unique_index']);
    assert.equal(raw.prepare('select count(*) as n from customers').get()!.n,1);
  }finally{raw.close();}
  const collisionRaw=new DatabaseSync(':memory:');
  try {
    collisionRaw.exec(collisionDdl);
    const result=await collisions(node(collisionRaw));
    assert.deepEqual(result.messages.map(message=>message.includes('same_name')),[true,true]);
    assert.equal(result.count,0);
  }finally{collisionRaw.close();}
  const ambiguousRaw=new DatabaseSync(':memory:');
  try {
    ambiguousRaw.exec(ambiguousDdl);
    const result=await ambiguousFailures(node(ambiguousRaw));
    assert.match(result.messages[0]!,/UNIQUE constraint failed: a\.b\.c\.d/);
    assert.match(result.messages[1]!,/NOT NULL constraint failed: a\.b\.n\.x/);
    assert.match(result.messages[2]!,/cannot store TEXT value in INTEGER column a\.b\.n\.x/);
    assert.equal(result.count,1);
    assert.deepEqual(result.ordinary,[
      {ok:false,kind:'unique',table:'ordinary',columns:['value']},
      {ok:false,kind:'not_null',table:'ordinary',column:'value'},
      {ok:false,kind:'datatype',table:'ordinary',column:'value',stored:'TEXT',declared:'INTEGER'},
    ]);
  }finally{ambiguousRaw.close();}
  const parameterRaw=new DatabaseSync(':memory:');
  try {
    parameterRaw.exec(parameterDdl);
    assertParameterContracts(await parameterContracts(node(parameterRaw)));
  }finally{parameterRaw.close();}
  const root=resolve(import.meta.dirname,'..');
  const mf=workerMiniflare(resolve(root,'test/index-failure-worker.ts'),root,{durableObjects:{INDEX:'IndexFailure',COLLISION:'AssertCollision',AMBIGUOUS:'AmbiguousConstraint',PARAMETERS:'ParameterContract'}});
  t.after(()=>mf.dispose());
  for(const path of ['/','/do']) assert.deepEqual(await (await mf.dispatchFetch('http://localhost'+path)).json(),expected);
  for(const path of ['/collision','/collision-do']) {
    const result=await (await mf.dispatchFetch('http://localhost'+path)).json() as {messages:string[];count:number};
    assert.deepEqual(result.messages.map(message=>message.includes('same_name')),[true,true]);
    assert.equal(result.count,0);
  }
  for(const path of ['/ambiguous','/ambiguous-do']) {
    const result=await (await mf.dispatchFetch('http://localhost'+path)).json() as {messages:string[];count:number;ordinary:unknown[]};
    assert.match(result.messages[0]!,/UNIQUE constraint failed: a\.b\.c\.d/);
    assert.match(result.messages[1]!,/NOT NULL constraint failed: a\.b\.n\.x/);
    assert.match(result.messages[2]!,/cannot store TEXT value in INTEGER column a\.b\.n\.x/);
    assert.equal(result.count,1);
    assert.deepEqual(result.ordinary,[
      {ok:false,kind:'unique',table:'ordinary',columns:['value']},
      {ok:false,kind:'not_null',table:'ordinary',column:'value'},
      {ok:false,kind:'datatype',table:'ordinary',column:'value',stored:'TEXT',declared:'INTEGER'},
    ]);
  }
  for(const path of ['/parameters','/parameters-do']) assertParameterContracts(await (await mf.dispatchFetch('http://localhost'+path)).json());
});

function assertParameterContracts(value:unknown):void {
  const result=value as {valid:{ok:boolean;rows:unknown[];changes:number};errors:string[];count:number};
  assert.deepEqual(result.valid,{ok:true,rows:[{label:'done',value:'second'}],changes:2});
  assert.deepEqual(result.errors,[
    'unexpected parameter: "stale"',
    'missing parameter: ":id"',
    'unexpected parameter: "stale"',
    'missing parameter: ":id"; unexpected parameter: "stale"',
  ]);
  assert.equal(result.count,1);
}
