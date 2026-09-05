// Spike as a test: does D1 accept named parameters, and does Miniflare 5
// run a SQLite-backed Durable Object with transactionSync()?
import { after, before, describe, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const { sql, mode } = await request.json();
    try {
      const s = this.ctx.storage.sql;
      s.exec("create table if not exists t (id text primary key not null, n integer not null)");
      if (mode === "txn-ok") {
        const out = this.ctx.storage.transactionSync(() => {
          s.exec("insert into t values ('a', 1)");
          return s.exec("select * from t").toArray();
        });
        return Response.json({ ok: true, out, version: s.exec("select sqlite_version() as v").one() });
      }
      if (mode === "txn-fail") {
        try {
          this.ctx.storage.transactionSync(() => {
            s.exec("insert into t values ('b', 2)");
            s.exec("insert into t values ('b', 3)");
          });
        } catch (e) {
          return Response.json({ ok: false, message: e.message, rows: s.exec("select * from t").toArray() });
        }
      }
      if (mode === "named") {
        const rows = s.exec("select * from t where id = :id", "a").toArray();
        return Response.json({ ok: true, rows });
      }
      return Response.json({ ok: false, message: "unknown mode" });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const { target, mode, sql, params } = await request.json();
    try {
      if (target === "do") {
        const id = env.STORE.idFromName("one");
        return env.STORE.get(id).fetch("http://do/", { method: "POST", body: JSON.stringify({ mode, sql }) });
      }
      const stmt = env.DB.prepare(sql).bind(...(params ?? []));
      return Response.json({ ok: true, results: await stmt.all() });
    } catch (e) {
      return Response.json({ ok: false, message: e.message, cause: e.cause ? String(e.cause.message ?? e.cause) : null });
    }
  },
};
`;

describe("D1 named parameters and DO transactionSync", () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-08-28",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "spike-db" },
    durableObjects: { STORE: { className: "Store", useSQLite: true } },
  }));
  const send = async (body: unknown) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) })).json();

  before(async () => {
    console.log("ddl:", JSON.stringify(await send({ target: "d1", sql: "create table t (id text primary key not null, n integer not null)" })));
    console.log("seed:", JSON.stringify(await send({ target: "d1", sql: "insert into t values ('a', 1), ('b', 2)" })));
  });
  after(async () => { await mf.dispose(); });

  test("D1: named parameter :id bound positionally", async () => {
    console.log("named+positional:", JSON.stringify(await send({ target: "d1", sql: "select * from t where id = :id", params: ["a"] })));
  });
  test("D1: numbered parameter ?1 bound positionally", async () => {
    console.log("numbered:", JSON.stringify(await send({ target: "d1", sql: "select * from t where id = ?1 or id = ?1", params: ["a"] })));
  });
  test("D1: named parameter bound as an object", async () => {
    console.log("named+object:", JSON.stringify(await send({ target: "d1", sql: "select * from t where id = :id", params: [{ id: "a" }] })));
  });
  test("DO: transactionSync commits and rolls back", async () => {
    console.log("do txn-ok:", JSON.stringify(await send({ target: "do", mode: "txn-ok" })));
    console.log("do txn-fail:", JSON.stringify(await send({ target: "do", mode: "txn-fail" })));
    console.log("do named:", JSON.stringify(await send({ target: "do", mode: "named" })));
  });
});
