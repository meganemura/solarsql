// Spike as a test: measures rows_read for a single-column keyset page, a
// composite (row-value) keyset page, and an OFFSET page, at increasing
// depth, on Miniflare's local D1. Cited from docs/adr/0131-keyset-paging-
// for-fixed-keys.md. Run directly: node --test spike/14-keyset-paging.test.ts
import { after, describe, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const N = 20000;

const script = `
export default {
  async fetch(request, env) {
    const { sql, params } = await request.json();
    const r = await env.DB.prepare(sql).bind(...(params ?? [])).all();
    return Response.json({ rows: r.results.length, meta: r.meta });
  },
};`;

describe("keyset vs OFFSET rows_read", () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-08-28", d1Databases: { DB: "spike" } }));
  const send = async (sql: string, params: unknown[] = []): Promise<{ rows: number; meta: { rows_read?: number } }> =>
    (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql, params }) })).json() as Promise<{ rows: number; meta: { rows_read?: number } }>;
  after(async () => { await mf.dispose(); });

  test(`rows_read at page k, ${N} rows, page size 100`, async () => {
    await send("create table t (id text primary key not null, g integer not null) strict");
    await send("create index t_g_id on t (g, id)");
    await send(`with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${N}) insert into t (id, g) select printf('%08d', n), n from seq`);

    for (const k of [0, 10, 100, 500, 999]) {
      const offset = k * 100;
      const offsetResult = await send("select id from t order by id limit ? offset ?", [100, offset]);
      console.log(`OFFSET page ${k}: rows_read=${offsetResult.meta.rows_read}`);

      // The id one row before this page's start; ids are printf('%08d', n)
      // with n counting from 1, so offset rows precede row id offset - 1 + 1.
      const cursorRow = offset === 0 ? "" : String(offset).padStart(8, "0");
      const keysetResult = offset === 0
        ? await send("select id from t order by id limit ?", [100])
        : await send("select id from t where id > ? order by id limit ?", [cursorRow, 100]);
      console.log(`keyset page ${k}: rows_read=${keysetResult.meta.rows_read}`);

      const compositeResult = offset === 0
        ? await send("select id, g from t where (g, id) > (?, ?) order by g, id limit ?", [-1, "", 100])
        : await send("select id, g from t where (g, id) > (?, ?) order by g, id limit ?", [offset, cursorRow, 100]);
      console.log(`composite page ${k}: rows_read=${compositeResult.meta.rows_read}`);
    }
  });
});
