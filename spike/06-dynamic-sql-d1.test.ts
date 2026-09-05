// Spike as a test: D1 caps bound parameters at 100. An IN list of 200
// placeholders must fail there, and one json_each parameter must work.
import { after, describe, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const script = `
export default {
  async fetch(request, env) {
    const { sql, params } = await request.json();
    try {
      const r = await env.DB.prepare(sql).bind(...params).all();
      return Response.json({ ok: true, rows: r.results.length });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  },
};`;

describe("D1 parameter limit", () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-08-28", d1Databases: { DB: "spike" } }));
  const send = async (sql: string, params: unknown[]) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql, params }) })).json();
  after(async () => { await mf.dispose(); });

  test("200 placeholders vs one json_each parameter", async () => {
    await send("create table t (id text primary key not null)", []);
    const values = Array.from({ length: 300 }, (_, i) => `('o${i}')`).join(",");
    await send(`insert into t values ${values}`, []);
    const ids = Array.from({ length: 200 }, (_, i) => `o${i}`);
    console.log("200 placeholders:", JSON.stringify(await send(`select id from t where id in (${ids.map(() => "?").join(",")})`, ids)));
    console.log("100 placeholders:", JSON.stringify(await send(`select id from t where id in (${ids.slice(0, 100).map(() => "?").join(",")})`, ids.slice(0, 100))));
    console.log("101 placeholders:", JSON.stringify(await send(`select id from t where id in (${ids.slice(0, 101).map(() => "?").join(",")})`, ids.slice(0, 101))));
    console.log("json_each, 200 ids:", JSON.stringify(await send("select id from t where id in (select value from json_each(?))", [JSON.stringify(ids)])));
    console.log("json_each, 5000 ids:", JSON.stringify(await send("select id from t where id in (select value from json_each(?))", [JSON.stringify(Array.from({ length: 5000 }, (_, i) => `o${i}`))])));
  });
});
