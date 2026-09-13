// Responsibility: exercise exact parameter contracts through every public operation.
// Boundary: generated metadata defines keys; each statement retains its own bind order.
import { assert as guard, commands, queries, read, type Database } from '../src/index.ts';
import { GUARD_DDL } from '../src/runtime/plan.ts';

const insert='insert into param_items(id,value) values(:id,\'first\')';
const update='update param_items set value=@value where id=:id';
const predicate='$allowed=1';
const returned='select :label as label,value from param_items where id=:id';
const byId='select value from param_items where id=:id';
const literal='select :value as value';
const count='select count(*) as n from param_items';
const generated={
  [insert]:{params:[':id'],encode:[],json:[],reads:[]},
  [update]:{params:['@value',':id'],encode:[],json:[],reads:['param_items']},
  [predicate]:{params:['$allowed'],encode:[],json:[],reads:[]},
  [returned]:{params:[':label',':id'],encode:[],json:[],reads:['param_items']},
  [byId]:{params:[':id'],encode:[],json:[],reads:['param_items']},
  [literal]:{params:[':value'],encode:[],json:[],reads:[]},
  [count]:{params:[],encode:[],json:[],reads:['param_items']},
};
const command=commands(generated,{write:{plan:[insert,update,guard('allowed',predicate)],returns:returned}}).write;
const reads=queries(generated,{byId,literal,count});

export const ddlStatements=[...GUARD_DDL,'create table param_items(id text primary key not null,value text not null) strict'];
export const sharedDdlStatements=ddlStatements.map(sql=>sql.replace(/^create (table|trigger) /, 'create $1 if not exists '));
export const ddl=ddlStatements.join(';');

async function message(work:()=>Promise<unknown>):Promise<string> {
  try { await work(); }
  catch(error) { return error instanceof Error ? error.message : String(error); }
  throw Error('Expected the parameter contract to reject the operation');
}

export async function parameterContracts(db:Database) {
  const valid=await db.run(command,{':id':'kept','@value':'second','$allowed':1,':label':'done'});
  const queryExtra=await message(()=>db.all(reads.byId,{':id':'kept',stale:true} as never));
  const inherited=Object.assign(Object.create({':id':'kept'}),{});
  const queryInherited=await message(()=>db.all(reads.byId,inherited));
  const batchExtra=await message(()=>db.batch([read(reads.byId,{':id':'kept'}),read(reads.literal,{':value':'x',stale:true} as never)]));
  const commandParams=Object.assign(Object.create({':id':'rejected'}),{'@value':'bad','$allowed':1,':label':'bad',stale:true});
  const commandInvalid=await message(()=>db.run(command,commandParams));
  const row=await db.first(reads.count);
  return {valid,errors:[queryExtra,queryInherited,batchExtra,commandInvalid],count:row?.n};
}
