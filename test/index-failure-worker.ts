// Responsibility: verify expression-index command failures on local Cloudflare.
// Boundary: one isolated request per backend; production setup belongs to applications.
import { DurableObject } from 'cloudflare:workers';
import { d1, type D1Like } from '../src/d1.ts';
import { durable } from '../src/durable.ts';
import { ddl, conflict } from './index-failure-fixture.ts';
export class IndexFailure extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(ddl);return Response.json(await conflict(durable(this.ctx.storage)));}
}
export default {
  async fetch(request:Request,env:{DB:D1Like & {exec(sql:string):Promise<unknown>};INDEX:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}}}) {
    if(new URL(request.url).pathname==='/do')return env.INDEX.get(env.INDEX.idFromName('index')).fetch('http://local');
    await env.DB.exec(ddl);
    return Response.json(await conflict(d1(env.DB)));
  }
};
