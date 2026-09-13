// Responsibility: exercise a generated command against an expression index.
// Boundary: callers create the database; this fixture checks the public result type.
import type { Database } from '../src/index.ts';
import { customerCommands } from '../example/modules/customers/public.ts';
export const ddl=`create table customers(id text primary key not null,name text not null,email text not null unique) strict;
create unique index "lower'email" on customers(lower(email));`;
export async function conflict(db:Database) {
  const first=await db.run(customerCommands.create,{id:'first' as never,name:'First',email:'A@example.test'});
  if(!first.ok)throw Error('Initial insert failed');
  const result=await db.run(customerCommands.create,{id:'second' as never,name:'Second',email:'a@example.test'});
  if(!result.ok && result.kind==='unique_index')return {result,index:result.index};
  throw Error('Expected an index-specific unique failure');
}
