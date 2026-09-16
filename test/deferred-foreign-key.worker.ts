// Fixture Worker: a hand-assembled schema and Command that declares a
// DEFERRABLE INITIALLY DEFERRED foreign key, run through the real d1() and
// durable() adapters' own run(). src/build/build.ts now refuses this exact
// declaration, so this fixture cannot come from a build: the
// schema and the Command are built by hand, the way test/value-worker.ts
// builds a hand-written Meta, so run() can be pinned against the shape the
// build refuses to ever ship.
// Boundary: no proactive scan runs here. This fixture exists to show what
// run() does today, without it -- the same question migrate() answered for
// itself before its own fix, now asked of run() (a different call site,
// deliberately left unchanged; see the ADR 0114 addendum).
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { commands, type Meta } from "../src/index.ts";

// "if not exists": the D1 binding below is shared across every request this
// fixture handles (one D1 database, unlike the Durable Object below, which
// gets a fresh instance per test-chosen name), so a second request must not
// fail on a table the first request already made.
const createParent = `create table if not exists parent (id text primary key not null) strict`;
const createChildImmediate = `create table if not exists child_immediate (id text primary key not null, parent_id text not null references parent(id)) strict`;
const createChildDeferred = `create table if not exists child_deferred (id text primary key not null, parent_id text not null references parent(id) deferrable initially deferred) strict`;

const insertImmediate = `insert into child_immediate (id, parent_id) values (:id, :parent_id)`;
const insertDeferred = `insert into child_deferred (id, parent_id) values (:id, :parent_id)`;

type G = {
  [insertImmediate]: { params: { id: string; parent_id: string }; row: {} };
  [insertDeferred]: { params: { id: string; parent_id: string }; row: {} };
};
const meta: Meta<G> = {
  [insertImmediate]: { params: ["id", "parent_id"], encode: [], json: [], reads: ["child_immediate"] },
  [insertDeferred]: { params: ["id", "parent_id"], encode: [], json: [], reads: ["child_deferred"] },
};
const cmd = commands(meta, {
  insertImmediate: { plan: [insertImmediate] },
  insertDeferred: { plan: [insertDeferred] },
});

type ProbeRequest = { variant: "immediate" | "deferred"; id: string; parentId: string };

export class DeferredForeignKeyProbe extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const { variant, id, parentId } = (await request.json()) as ProbeRequest;
    const storage = this.ctx.storage as unknown as StorageLike;
    storage.sql.exec(createParent);
    storage.sql.exec(createChildImmediate);
    storage.sql.exec(createChildDeferred);
    const db = durable(storage);
    const result = variant === "immediate" ? await db.run(cmd.insertImmediate, { id, parent_id: parentId }) : await db.run(cmd.insertDeferred, { id, parent_id: parentId });
    return Response.json(result);
  }
}

async function d1Run(env: { DB: D1Like }, body: ProbeRequest): Promise<Response> {
  const { variant, id, parentId } = body;
  const raw = env.DB as unknown as { exec(sql: string): Promise<unknown> };
  await raw.exec(createParent);
  await raw.exec(createChildImmediate);
  await raw.exec(createChildDeferred);
  const db = d1(env.DB);
  try {
    const result = variant === "immediate" ? await db.run(cmd.insertImmediate, { id, parent_id: parentId }) : await db.run(cmd.insertDeferred, { id, parent_id: parentId });
    return Response.json({ threw: false, result });
  } catch (e) {
    return Response.json({ threw: true, name: (e as Error).name, message: (e as Error).message });
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as ProbeRequest & { instance?: string };
    if (url.pathname.startsWith("/do")) {
      const id = env.PROBE.idFromName(body.instance ?? "default");
      return env.PROBE.get(id).fetch(new Request("http://do/", { method: "POST", body: JSON.stringify(body) }));
    }
    return d1Run(env, body);
  },
};
