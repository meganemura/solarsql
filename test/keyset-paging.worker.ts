// Fixture Worker: proves, through d1()'s and durable()'s observe hook, that
// a single-column keyset page and a composite (row-value) keyset page cost
// a fixed number of rows regardless of depth, while an OFFSET page costs
// offset + limit -- the claim docs/adr/0131-keyset-paging-for-fixed-keys.md
// makes and skills/solarsql/references/queries.md's paging recipe rests on.
// Kept apart from example/worker.ts: this table and its composite index
// exist only to demonstrate the two keyset shapes, and adding them to the
// example schema would force every module's migration file forward for a
// change the example itself does not need.
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here (see skills/solarsql/references/deploy.md's remote suite).
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { queries, read, type Meta, type Observed } from "../src/index.ts";

const N = 5000;
const LIMIT = 50;
const DEEP_OFFSET = 4000;

const ddl = ["create table t (id text primary key not null, g integer not null) strict", "create index t_g_id on t (g, id)"];
// A recursive CTE insert takes no bound parameters, so seeding N rows never
// meets the 100-bound-value limit (limits.md).
const seedSql = `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${N}) insert into t (id, g) select printf('%08d', n), n from seq`;

const keysetFirstSql = "select id from t order by id limit :limit";
const keysetNextSql = "select id from t where id > :after order by id limit :limit";
const compositeSql = "select id, g from t where (g, id) > (:after_g, :after_id) order by g, id limit :limit";
const offsetSql = "select id from t order by id limit :limit offset :offset";

type G = {
  [keysetFirstSql]: { params: { limit: number }; row: { id: string } };
  [keysetNextSql]: { params: { after: string; limit: number }; row: { id: string } };
  [compositeSql]: { params: { after_g: number; after_id: string; limit: number }; row: { id: string; g: number } };
  [offsetSql]: { params: { limit: number; offset: number }; row: { id: string } };
};
const meta: Meta<G> = {
  [keysetFirstSql]: { params: ["limit"], encode: [], json: [], reads: ["t"] },
  [keysetNextSql]: { params: ["after", "limit"], encode: [], json: [], reads: ["t"] },
  [compositeSql]: { params: ["after_g", "after_id", "limit"], encode: [], json: [], reads: ["t"] },
  [offsetSql]: { params: ["limit", "offset"], encode: [], json: [], reads: ["t"] },
};
const q = queries(meta, { keysetFirst: keysetFirstSql, keysetNext: keysetNextSql, composite: compositeSql, offsetPage: offsetSql });

// Runs the seed, then the three page shapes at the same depth, and reports
// the rows_read each page's own event carried. Anchoring pages (fetching
// the cursor to page from) are excluded from the measured events by
// clearing the sink right before the page under measurement.
async function measure(db: ReturnType<typeof d1> | ReturnType<typeof durable>, events: Observed[]): Promise<Record<string, unknown>> {
  const anchor = await db.all(q.keysetFirst, { limit: DEEP_OFFSET });
  const after = anchor[anchor.length - 1]!.id;
  const compositeAnchor = (await db.batch([read(q.composite, { after_g: -1, after_id: "", limit: DEEP_OFFSET })]))[0]!;
  const afterRow = compositeAnchor[compositeAnchor.length - 1]!;

  events.length = 0;
  await db.all(q.keysetNext, { after, limit: LIMIT });
  const keysetEvent = events.at(-1)!;

  events.length = 0;
  await db.all(q.composite, { after_g: afterRow.g, after_id: afterRow.id, limit: LIMIT });
  const compositeEvent = events.at(-1)!;

  events.length = 0;
  await db.all(q.offsetPage, { limit: LIMIT, offset: DEEP_OFFSET });
  const offsetEvent = events.at(-1)!;

  return {
    keyset: keysetEvent.meta?.rows_read ?? null,
    composite: compositeEvent.meta?.rows_read ?? null,
    offset: offsetEvent.meta?.rows_read ?? null,
    limit: LIMIT,
    offsetArg: DEEP_OFFSET,
  };
}

async function seedAndMeasure(exec: (sql: string) => Promise<void> | void, db: ReturnType<typeof d1> | ReturnType<typeof durable>, events: Observed[]): Promise<Record<string, unknown>> {
  for (const sql of ddl) await exec(sql);
  await exec(seedSql);
  return measure(db, events);
}

export class KeysetProbe extends DurableObject {
  override async fetch(): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    const events: Observed[] = [];
    const db = durable(storage, { observe: (e) => events.push(e) });
    const result = await seedAndMeasure((sql) => { storage.sql.exec(sql); }, db, events);
    return Response.json(result);
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    if (new URL(request.url).pathname === "/do") return env.PROBE.get(env.PROBE.idFromName("keyset-probe")).fetch(request);
    const events: Observed[] = [];
    const db = d1(env.DB, { observe: (e) => events.push(e) });
    const result = await seedAndMeasure(async (sql) => { await env.DB.prepare(sql).all(); }, db, events);
    return Response.json(result);
  },
};
