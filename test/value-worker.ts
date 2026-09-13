// Responsibility: expose scalar adapter results for local Cloudflare conformance.
// Boundary: fixture SQL only; the test validates the returned representation.
import { DurableObject } from 'cloudflare:workers';
import { d1, type D1Like } from '../src/d1.ts';
import { durable, type StorageLike } from '../src/durable.ts';
import { queries, read, type Meta } from '../src/index.ts';
const sql = `select x'00ff' as data, null as empty, 9007199254740991 as n, '[1,2]' as items`;
type G = { [sql]: { params: {}; row: { data: Uint8Array; empty: null; n: number; items: number[] } } };
const meta: Meta<G> = { [sql]: { params: [], encode: [], json: ['items'], reads: [] } };
const q = queries(meta, { values: sql });
async function result(db: ReturnType<typeof d1>): Promise<Response> {
  const rows = await db.all(q.values);
  const batched = await db.batch([read(q.values)]);
  return Response.json({ bytes: Array.from(rows[0]!.data), typed: rows[0]!.data instanceof Uint8Array, empty: rows[0]!.empty, n: rows[0]!.n, items: rows[0]!.items, batchTyped: batched[0][0]!.data instanceof Uint8Array });
}
export class Values extends DurableObject {
  async fetch(): Promise<Response> { return result(durable(this.ctx.storage as unknown as StorageLike)); }
}
export default {
  async fetch(_request: Request, env: { DB: D1Like; VALUES: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } } }): Promise<Response> {
    if (new URL(_request.url).pathname === '/do') return env.VALUES.get(env.VALUES.idFromName('values')).fetch('http://local/');
    return result(d1(env.DB));
  },
};
