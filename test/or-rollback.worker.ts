// Fixture Worker: a hand-assembled Command whose second plan item is
// INSERT OR ROLLBACK, run through the real d1() and durable() adapters' own
// run(). src/build/build.ts now refuses this exact declaration (ADR 0131),
// so this fixture cannot come from a build: it is built by hand, the way
// test/deferred-foreign-key.worker.ts builds its own Command, so run() can
// be pinned against the shape the build refuses to ever ship.
// Boundary: no proactive scan runs here. This fixture exists to show what
// run() does today against a plan item that ends its own transaction.
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { commands, type Meta } from "../src/index.ts";

const createLog = `create table if not exists log (id text primary key not null) strict`;

const insertFirst = `insert into log (id) values ('first')`;
const insertOrRollback = `insert or rollback into log (id) values ('first')`;
const insertThird = `insert into log (id) values ('third')`;

type G = {
  [insertFirst]: { params: {}; row: {} };
  [insertOrRollback]: { params: {}; row: {} };
  [insertThird]: { params: {}; row: {} };
};
const meta: Meta<G> = {
  [insertFirst]: { params: [], encode: [], json: [], reads: ["log"] },
  [insertOrRollback]: { params: [], encode: [], json: [], reads: ["log"] },
  [insertThird]: { params: [], encode: [], json: [], reads: ["log"] },
};
// The conflict: insertFirst already put 'first' in the table, so the second
// item's own INSERT OR ROLLBACK collides with it.
const cmd = commands(meta, { conflict: { plan: [insertFirst, insertOrRollback, insertThird] } });

export class OrRollbackProbe extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    storage.sql.exec(createLog);
    const url = new URL(request.url);
    if (url.searchParams.get("action") === "rows") {
      const cursor = storage.sql.exec("select id from log order by id") as unknown as { toArray(): { id: string }[] };
      return Response.json({ rows: cursor.toArray() });
    }
    const db = durable(storage);
    try {
      const result = await db.run(cmd.conflict);
      return Response.json({ threw: false, result });
    } catch (e) {
      return Response.json({ threw: true, name: (e as Error).name, message: (e as Error).message });
    }
  }
}

async function d1Run(env: { DB: D1Like }): Promise<Response> {
  const raw = env.DB as unknown as { exec(sql: string): Promise<unknown> };
  await raw.exec(createLog);
  const db = d1(env.DB);
  try {
    const result = await db.run(cmd.conflict);
    return Response.json({ threw: false, result });
  } catch (e) {
    return Response.json({ threw: true, name: (e as Error).name, message: (e as Error).message });
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/do")) {
      const id = env.PROBE.idFromName(url.searchParams.get("instance") ?? "default");
      const action = url.searchParams.get("action");
      const target = new URL("http://do/");
      if (action) target.searchParams.set("action", action);
      return env.PROBE.get(id).fetch(new Request(target, { method: "POST" }));
    }
    return d1Run(env);
  },
};
