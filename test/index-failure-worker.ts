// Responsibility: verify expression-index command failures on local Cloudflare.
// Boundary: one isolated request per backend; production setup belongs to applications.
import { DurableObject } from 'cloudflare:workers';
import { d1, type D1Like } from '../src/d1.ts';
import { durable } from '../src/durable.ts';
import { ddl, conflict } from './index-failure-fixture.ts';
import { ddl as collisionDdl, ddlStatements as collisionDdlStatements, collisions } from './assert-collision-fixture.ts';
export class IndexFailure extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(ddl);return Response.json(await conflict(durable(this.ctx.storage)));}
}
export class AssertCollision extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(collisionDdl);return Response.json(await collisions(durable(this.ctx.storage)));}
}
export default {
  async fetch(request:Request,env:{DB:D1Like & {exec(sql:string):Promise<unknown>};INDEX:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}};COLLISION:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}}}) {
    const path=new URL(request.url).pathname;
    if(path==='/do')return env.INDEX.get(env.INDEX.idFromName('index')).fetch('http://local');
    if(path==='/collision-do')return env.COLLISION.get(env.COLLISION.idFromName('collision')).fetch('http://local');
    if(path==='/collision') {
      await env.DB.batch(collisionDdlStatements.map(sql=>env.DB.prepare(sql)));
      return Response.json(await collisions(d1(env.DB)));
    }
    await env.DB.exec(ddl);
    return Response.json(await conflict(d1(env.DB)));
  }
};
