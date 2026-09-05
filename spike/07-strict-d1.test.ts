// Spike as a test: does the local D1 engine accept STRICT tables, and what
// do the two adapters receive for an integer, a real, and a JSON column?
import { after, describe, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const script = `
export default {
  async fetch(request, env) {
    const { sql, params } = await request.json();
    try {
      const r = await env.DB.prepare(sql).bind(...(params ?? [])).all();
      return Response.json({ ok: true, rows: r.results, types: r.results.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v]))) });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  },
};`;

describe("STRICT tables on D1", () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-08-28", d1Databases: { DB: "spike" } }));
  const send = async (sql: string, params: unknown[] = []) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql, params }) })).json();
  after(async () => { await mf.dispose(); });

  test("create strict, reject text in integer, read back types", async () => {
    console.log("create strict:", JSON.stringify(await send("create table s (id text primary key not null, n integer not null, r real, big integer) strict")));
    console.log("text into integer:", JSON.stringify(await send("insert into s values (?, ?, ?, ?)", ["a", "twelve", 1.5, 1])));
    console.log("ok row:", JSON.stringify(await send("insert into s values (?, ?, ?, ?)", ["b", 12, 1.5, 9007199254740993])));
    console.log("read back:", JSON.stringify(await send("select * from s")));
    console.log("plain table, text into integer:", JSON.stringify(await send("create table p (id text primary key not null, n integer not null)")), JSON.stringify(await send("insert into p values (?, ?)", ["a", "twelve"])), JSON.stringify(await send("select * from p")));
  });
});
