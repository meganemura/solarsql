// Responsibility: exercise constraints whose SQLite messages contain ambiguous dots.
// Boundary: the adapter must preserve these errors; it does not guess identifier boundaries.
import { commands, queries, type Database } from '../src/index.ts';

const statements=[
  `insert into "a.b"(id,"c.d","n.x") values('seed','v',1)`,
  `insert into "a.b"(id,"c.d","n.x") values('unique','v',2)`,
  `insert into "a.b"(id,"c.d") values('null','w')`,
  `insert into "a.b"(id,"c.d","n.x") values('datatype','x','bad')`,
] as const;
const count='select count(*) as n from "a.b"';
const ordinaryStatements=[
  `insert into ordinary(id,value) values('seed',1)`,
  `insert into ordinary(id,value) values('unique',1)`,
  `insert into ordinary(id) values('null')`,
  `insert into ordinary(id,value) values('datatype','bad')`,
] as const;
const generated=Object.fromEntries([...statements,...ordinaryStatements,count].map(sql=>[sql,{params:[],encode:[],json:[],reads:['a.b','ordinary']}])) as Record<string,{params:string[];encode:string[];json:string[];reads:string[]}>;
const writes=commands(generated,Object.fromEntries(statements.map((sql,index)=>[`write${index}`,{plan:[sql]}]))).entries;
const ordinaryWrites=commands(generated,Object.fromEntries(ordinaryStatements.map((sql,index)=>[`write${index}`,{plan:[sql]}]))).entries;
const readCount=queries(generated,{count}).count;

export const ddlStatements=['create table "a.b"(id text primary key not null,"c.d" text unique,"n.x" integer not null) strict','create table ordinary(id text primary key not null,value integer not null unique) strict'];
export const ddl=ddlStatements.join(';');

export async function ambiguousFailures(db:Database):Promise<{messages:string[];count:number;ordinary:unknown[]}> {
  const seeded=await db.run(writes.write0!);
  if(!seeded.ok)throw Error('The constraint fixture seed failed');
  const messages:string[]=[];
  for(const command of [writes.write1!,writes.write2!,writes.write3!]) {
    let failure:unknown;
    try { await db.run(command); } catch(error) { failure=error; }
    if(failure===undefined)throw Error('Expected an ambiguous constraint failure to be rethrown');
    messages.push(failure instanceof Error ? failure.message : String(failure));
  }
  const row=await db.first(readCount);
  if(typeof row?.n!=='number')throw Error('The constraint row count is missing');
  const ordinarySeed=await db.run(ordinaryWrites.write0!);
  if(!ordinarySeed.ok)throw Error('The ordinary constraint seed failed');
  const ordinary=[];
  for(const command of [ordinaryWrites.write1!,ordinaryWrites.write2!,ordinaryWrites.write3!]) ordinary.push(await db.run(command));
  return {messages,count:row.n,ordinary};
}
