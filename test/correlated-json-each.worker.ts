// Fixture Worker: runs the analyze output in
// test/fixtures/correlated-json-each.generated.ts through the real d1() and
// durable() adapters, and the same SQL through each target's own driver, so
// the test can compare the adapter's rows with the driver's rows.
// Boundary: no assertion here; test/miniflare/correlated-json-each.test.ts
// compares the results.
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { queries } from "../src/index.ts";
import { catalog, labels, rows, schema } from "./fixtures/correlated-json-each.ts";
import { generated, statements } from "./fixtures/correlated-json-each.generated.ts";

const q = queries(generated, statements);

type Adapter = { all(query: unknown, params?: unknown): Promise<unknown[]> };
type Driver = (sql: string, params: unknown[]) => Promise<unknown[]>;

async function results(db: Adapter, driver: Driver) {
  const out: Record<string, unknown> = {};
  for (const label of labels) {
    out[`byLabel:${label}`] = { adapter: await db.all(q.byLabel, { label }), driver: await driver(catalog.byLabel.replace(":label", "?"), [label]) };
    out[`byLabelJoin:${label}`] = { adapter: await db.all(q.byLabelJoin, { label }), driver: await driver(catalog.byLabelJoin.replace(":label", "?"), [label]) };
  }
  out.labelCounts = { adapter: await db.all(q.labelCounts), driver: await driver(catalog.labelCounts, []) };
  return out;
}

export class CorrelatedProbe extends DurableObject {
  async fetch(): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    const sql = this.ctx.storage.sql;
    sql.exec(schema);
    for (const [id, labels] of rows) sql.exec("insert into items (id, labels) values (?, ?)", id, labels);
    const driver: Driver = async (text, params) => sql.exec(text, ...params).toArray();
    return Response.json(await results(durable(storage) as unknown as Adapter, driver));
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    if (new URL(request.url).pathname === "/do") return env.PROBE.get(env.PROBE.idFromName("default")).fetch(request);
    const raw = env.DB as unknown as { exec(sql: string): Promise<unknown>; prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown>; all(): Promise<{ results: unknown[] }> } } };
    await raw.exec(schema);
    for (const [id, labels] of rows) await raw.prepare("insert into items (id, labels) values (?, ?)").bind(id, labels).run();
    const driver: Driver = async (text, params) => (await raw.prepare(text).bind(...params).all()).results;
    return Response.json(await results(d1(env.DB) as unknown as Adapter, driver));
  },
};
