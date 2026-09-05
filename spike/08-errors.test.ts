// Spike as a test: the exact error text of each constraint kind on the
// three engines, so the adapter can turn a thrown error into a value.
import { after, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const ddl = [
  `create table parent (id text primary key not null) strict`,
  `create table t (id text primary key not null, email text not null unique, n integer not null check (n > 0), p text references parent(id), status text not null, constraint status_ok check (status in ('a', 'b'))) strict`,
];
const cases: [string, string][] = [
  ["unique pk", "insert into t values ('x', 'e1', 1, null, 'a'), ('x', 'e2', 1, null, 'a')"],
  ["unique column", "insert into t values ('y1', 'same', 1, null, 'a'), ('y2', 'same', 1, null, 'a')"],
  ["check unnamed", "insert into t values ('z', 'e3', 0, null, 'a')"],
  ["check named", "insert into t values ('z', 'e3', 1, null, 'nope')"],
  ["not null", "insert into t values ('z', null, 1, null, 'a')"],
  ["foreign key", "insert into t values ('z', 'e4', 1, 'missing', 'a')"],
  ["datatype", "insert into t values ('z', 'e5', 'seven', null, 'a')"],
];

describe("constraint error text", () => {
  test("node:sqlite", () => {
    const db = new DatabaseSync(":memory:");
    for (const s of ddl) db.exec(s);
    for (const [label, sql] of cases) {
      try { db.exec(sql); console.log(`node   ${label.padEnd(14)} no error`); }
      catch (e) { const err = e as Error & { errcode: number; errstr: string }; console.log(`node   ${label.padEnd(14)} ${JSON.stringify(err.message)} errcode=${err.errcode}`); }
    }
  });

  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const { sql, ddl } = await request.json();
    try {
      for (const s of ddl) this.ctx.storage.sql.exec(s);
      this.ctx.storage.sql.exec(sql);
      return Response.json({ ok: true });
    } catch (e) { return Response.json({ ok: false, message: e.message }); }
  }
}
export default {
  async fetch(request, env) {
    const body = await request.json();
    if (body.target === "do") return env.STORE.get(env.STORE.idFromName("x")).fetch("http://do/", { method: "POST", body: JSON.stringify(body) });
    try {
      if (body.ddl.length) await env.DB.batch(body.ddl.map((s) => env.DB.prepare(s)));
      await env.DB.prepare(body.sql).run();
      return Response.json({ ok: true });
    } catch (e) { return Response.json({ ok: false, message: e.message, cause: e.cause ? String(e.cause.message ?? e.cause) : null }); }
  },
};`;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-08-28", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "spike" }, durableObjects: { STORE: { className: "Store", useSQLite: true } } }));
  after(async () => { await mf.dispose(); });
  for (const target of ["d1", "do"]) {
    test(target, async () => {
      let first = true;
      for (const [label, sql] of cases) {
        const r = await (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ target, sql, ddl: first ? ddl : [] }) })).json() as { ok: boolean; message?: string };
        first = false;
        console.log(`${target.padEnd(6)} ${label.padEnd(14)} ${r.ok ? "no error" : JSON.stringify(r.message)}`);
      }
    });
  }
});
