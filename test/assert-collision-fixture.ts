// Responsibility: exercise user trigger messages against public command assertions.
// Boundary: callers create the database and decide how to expose thrown messages.
import { assert as guard, commands, queries, type Database } from '../src/index.ts';
import { GUARD_DDL } from '../src/runtime/plan.ts';

const insert='insert into items(id) values(:id)';
const predicate='select 1';
const count='select count(*) as n from items';
const generated={
  [insert]:{params:['id'],encode:[],json:[],reads:[]},
  [predicate]:{params:[],encode:[],json:[],reads:[]},
  [count]:{params:[],encode:[],json:[],reads:['items']},
};
const command=commands(generated,{create:{plan:[insert,guard('same_name',predicate)]}}).create;
const reads=queries(generated,{count}).count;

export const ddlStatements=[...GUARD_DDL,
  'create table items(id text primary key not null) strict',
  `create trigger same_name before insert on items when new.id='same' begin select raise(abort,'same_name'); end`,
  `create trigger prefix_like before insert on items when new.id='prefix' begin select raise(abort,'solarsql:assert:other: same_name'); end`,
];
export const ddl=ddlStatements.join(';');

export async function collisions(db:Database):Promise<{messages:string[];count:number}> {
  const messages:string[]=[];
  for(const id of ['same','prefix']) {
    try { await db.run(command,{id}); throw Error('Expected the user trigger to reject the command'); }
    catch(error) { messages.push(error instanceof Error ? error.message : String(error)); }
  }
  const row=await db.first(reads);
  if(typeof row?.n!=='number')throw Error('The collision row count is missing');
  return {messages,count:row.n};
}
