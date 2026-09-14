// Responsibility: verify expression-index command failures on local Cloudflare.
// Boundary: one isolated request per backend; production setup belongs to applications.
import { DurableObject } from 'cloudflare:workers';
import { d1, type D1Like } from '../src/d1.ts';
import { durable } from '../src/durable.ts';
import { ddl, conflict } from './index-failure-fixture.ts';
import { ddl as collisionDdl, ddlStatements as collisionDdlStatements, collisions } from './assert-collision-fixture.ts';
import { ddl as nullPredicateDdl, sharedDdlStatements as nullPredicateDdlStatements, nullPredicateResults } from './assert-null-predicate-fixture.ts';
import { ddl as ambiguousDdl, ddlStatements as ambiguousDdlStatements, ambiguousFailures } from './ambiguous-constraint-fixture.ts';
import { ddl as parameterDdl, sharedDdlStatements as parameterDdlStatements, parameterContracts } from './parameter-contract-fixture.ts';
export class IndexFailure extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(ddl);return Response.json(await conflict(durable(this.ctx.storage)));}
}
export class AssertCollision extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(collisionDdl);return Response.json(await collisions(durable(this.ctx.storage)));}
}
export class NullPredicateAssert extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(nullPredicateDdl);return Response.json(await nullPredicateResults(durable(this.ctx.storage)));}
}
export class AmbiguousConstraint extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(ambiguousDdl);return Response.json(await ambiguousFailures(durable(this.ctx.storage)));}
}
export class ParameterContract extends DurableObject {
  async fetch(){this.ctx.storage.sql.exec(parameterDdl);return Response.json(await parameterContracts(durable(this.ctx.storage)));}
}
export default {
  async fetch(request:Request,env:{DB:D1Like & {exec(sql:string):Promise<unknown>};INDEX:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}};COLLISION:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}};NULLPREDICATE:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}};AMBIGUOUS:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}};PARAMETERS:{idFromName(name:string):unknown;get(id:unknown):{fetch(url:string):Promise<Response>}}}) {
    const path=new URL(request.url).pathname;
    if(path==='/do')return env.INDEX.get(env.INDEX.idFromName('index')).fetch('http://local');
    if(path==='/collision-do')return env.COLLISION.get(env.COLLISION.idFromName('collision')).fetch('http://local');
    if(path==='/null-predicate-do')return env.NULLPREDICATE.get(env.NULLPREDICATE.idFromName('null-predicate')).fetch('http://local');
    if(path==='/ambiguous-do')return env.AMBIGUOUS.get(env.AMBIGUOUS.idFromName('ambiguous')).fetch('http://local');
    if(path==='/parameters-do')return env.PARAMETERS.get(env.PARAMETERS.idFromName('parameters')).fetch('http://local');
    if(path==='/parameters') {
      await env.DB.batch(parameterDdlStatements.map(sql=>env.DB.prepare(sql)));
      return Response.json(await parameterContracts(d1(env.DB)));
    }
    if(path==='/ambiguous') {
      await env.DB.batch(ambiguousDdlStatements.map(sql=>env.DB.prepare(sql)));
      return Response.json(await ambiguousFailures(d1(env.DB)));
    }
    if(path==='/collision') {
      await env.DB.batch(collisionDdlStatements.map(sql=>env.DB.prepare(sql)));
      return Response.json(await collisions(d1(env.DB)));
    }
    if(path==='/null-predicate') {
      await env.DB.batch(nullPredicateDdlStatements.map(sql=>env.DB.prepare(sql)));
      return Response.json(await nullPredicateResults(d1(env.DB)));
    }
    await env.DB.exec(ddl);
    return Response.json(await conflict(d1(env.DB)));
  }
};
