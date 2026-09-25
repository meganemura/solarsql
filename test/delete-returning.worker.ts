// Fixture Worker: ADR 0136's consume-token command (a DELETE ...
// RETURNING plan item as the command's row source, guarded by an
// `assert("found", "changes() = 1")`), run through the real d1() and
// durable() adapters' own run(). Hand-built the same way
// test/or-rollback.worker.ts is: this file exercises the adapters and
// commands() directly, not solarsql build.
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { assert as sqlAssert, commands, type Meta } from "../src/index.ts";
import { GUARD_DDL } from "../src/runtime/plan.ts";

const createTokens = `create table if not exists tokens (id text primary key not null, payload text not null) strict`;
// GUARD_DDL is not written "if not exists" (a real build's migration runs
// it once); this fixture's D1 binding is shared across every request it
// handles, so its own copy needs that guard the way createTokens above does.
const createGuard = GUARD_DDL.map((sql) => sql.replace(/^create table/i, "create table if not exists").replace(/^create trigger/i, "create trigger if not exists"));

const insertToken = `insert into tokens (id, payload) values (:id, :payload)`;
const deleteReturning = `delete from tokens where id = :id returning payload`;
const foundOnce = `changes() = 1`;

type G = {
  [insertToken]: { params: { id: string; payload: string }; row: {} };
  [deleteReturning]: { params: { id: string }; row: { payload: string }; returning: true };
  [foundOnce]: { params: {}; row: {} };
};
const meta: Meta<G> = {
  [insertToken]: { params: ["id", "payload"], encode: [], json: [], reads: ["tokens"] },
  [deleteReturning]: { params: ["id"], encode: [], json: ["payload"], reads: ["tokens"], returning: true },
  [foundOnce]: { params: [], encode: [], json: [], reads: [] },
};
const cmd = commands(meta, {
  seed: { plan: [insertToken] },
  consume: { plan: [deleteReturning, sqlAssert("found", foundOnce)] },
});

type Body = { id: string; payload?: string };

export class DeleteReturningProbe extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    storage.sql.exec(createTokens);
    for (const sql of createGuard) storage.sql.exec(sql);
    const db = durable(storage);
    const { id, payload } = (await request.json()) as Body;
    const result = payload !== undefined ? await db.run(cmd.seed, { id, payload }) : await db.run(cmd.consume, { id });
    return Response.json(result);
  }
}

async function d1Run(env: { DB: D1Like }, body: Body): Promise<Response> {
  // D1Like's own exec() splits on newlines, which breaks GUARD_DDL's
  // multi-line trigger body; batch() sends each DDL statement whole, the
  // way a real migration file's own db.batch() call does (test/miniflare/
  // example.test.ts).
  await env.DB.batch([createTokens, ...createGuard].map((sql) => env.DB.prepare(sql)));
  const db = d1(env.DB);
  const result = body.payload !== undefined ? await db.run(cmd.seed, { id: body.id, payload: body.payload }) : await db.run(cmd.consume, { id: body.id });
  return Response.json(result);
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as Body & { instance?: string };
    if (url.pathname.startsWith("/do")) {
      const id = env.PROBE.idFromName(body.instance ?? "default");
      return env.PROBE.get(id).fetch(new Request("http://do/", { method: "POST", body: JSON.stringify(body) }));
    }
    return d1Run(env, body);
  },
};
