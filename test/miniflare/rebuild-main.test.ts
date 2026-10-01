// Responsibility: measure main-qualified rebuild statements on workerd.
// Boundary: generated values and quoting are tested in-process.
import { test } from "vitest";
import assert from "node:assert/strict";
import { resolve, relative } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { diff, introspect, open, render } from "../../src/build/migration.ts";
import { D1Harness, type WorkerOk } from "../d1.ts";
import { loadWorkerModules } from "../worker.ts";

const ddl = [
  "create table t(id integer primary key autoincrement,value text)",
  "create index i on t(value)",
  "create view v as select * from t",
  "create trigger tr after insert on t begin select 1; end",
];

test('Durable Object SQL storage reads main.table_xinfo with a pragma_table_xinfo shadow', async () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    s.exec('create table t(id integer primary key, value text, computed text as (value) stored)');
    s.exec('create table "t"" ]"(id integer primary key, value text)');
    const before = s.exec("select * from pragma_table_xinfo(?, 'main')", 't').toArray();
    s.exec('create table pragma_table_xinfo(name)');
    return Response.json({before,
      after: s.exec('pragma main.table_xinfo("t")').toArray(),
      quoted: s.exec('pragma main.table_xinfo("t"" ]")').toArray()});
  }
}
export default {fetch(request,env){return env.STORE.get(env.STORE.idFromName('pragma')).fetch(request);}};
`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'pragma-xinfo-worker.js', contents: script }],
    compatibilityDate: '2026-08-28',
    durableObjects: { STORE: { className: 'Store', useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch('http://localhost/');
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { before: unknown; after: unknown; quoted: { name: string }[] };
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.quoted.map(c => c.name), ['id', 'value']);
  } finally { await mf.dispose(); }
});
const seed = [...ddl, "insert into main.t values(100,'deleted')", "delete from main.t", "insert into main.t values(1,'main')"];
function rebuild() {
  const db = open(ddl), declared = open([ddl[0]! + " strict", ...ddl.slice(1)]);
  try {
    const plan = diff(introspect(db), introspect(declared));
    if (plan.kind !== "ok") throw new Error(plan.reason);
    return { statements: plan.statements, file: render(1, "strict", plan.statements, plan.rebuilds) };
  } finally { db.close(); declared.close(); }
}

// D1 refuses TEMP objects (measured: SQLITE_AUTH), so no TEMP table can
// shadow main there. The test pins that refusal and the rebuild.
test("D1 refuses TEMP tables and executes main-qualified table, index, trigger, view and sequence rebuild statements", async () => {
  const d1 = new D1Harness();
  try {
    const temp = await d1.run("create temp table temp_probe(id integer primary key,value text)");
    assert.equal(temp.ok, false);
    if (!temp.ok) assert.match(temp.message, /not authorized/);
    assert.equal((await d1.batch(seed.map(sql => ({ sql })))).ok, true);
    const reply = await d1.batch(rebuild().statements.map(sql => ({ sql })));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const result = await d1.all("select * from main.v");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(((result as WorkerOk).results as { results: unknown[] }).results, [{ id: 1, value: "main" }]);
    const next = await d1.all("insert into main.t(value) values('next') returning id");
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.deepEqual(((next as WorkerOk).results as { results: unknown[] }).results, [{ id: 101 }]);
  } finally { await d1.dispose(); }
});

// A Durable Object refuses TEMP objects (measured: SQLITE_AUTH), so no TEMP
// table can shadow main there. The test pins that refusal and the rebuild.
test("Durable Object SQL storage refuses TEMP tables and executes main-qualified rebuilds", async () => {
  const root = resolve("/");
  const entry = resolve(import.meta.dirname, "../../src/durable.ts");
  const { file } = rebuild();
  const script = `
import { DurableObject } from "cloudflare:workers";
import { migrate } from "./${relative(root, entry).split("\\").join("/")}";
export class Store extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    for (const sql of ${JSON.stringify(seed)}) s.exec(sql);
    let tempError = null;
    try { s.exec("create temp table t(id integer primary key,value text)"); } catch (e) { tempError = String(e.message); }
    migrate(this.ctx.storage, [{name:${JSON.stringify(file.filename)},sql:${JSON.stringify(file.sql)}}]);
    return Response.json({tempError,
      main:s.exec("select * from main.v").toArray(),
      strict:s.exec("select strict from pragma_table_list where schema='main' and name='t'").toArray(),
      next:s.exec("insert into main.t(value) values('next') returning id").toArray()});
  }
}
export default {fetch(request,env){return env.STORE.get(env.STORE.idFromName('one')).fetch(request);}};
`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: root,
    modules: [{ type: "ESModule", path: "rebuild-main-worker.js", contents: script }, ...loadWorkerModules(entry, root)],
    compatibilityDate: "2026-08-28",
    durableObjects: { STORE: { className: "Store", useSQLite: true } },
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { tempError: string | null; main: unknown; strict: unknown; next: unknown };
    assert.match(result.tempError ?? "", /not authorized/);
    assert.deepEqual(result.main, [{ id: 1, value: "main" }]);
    assert.deepEqual(result.strict, [{ strict: 1 }]);
    assert.deepEqual(result.next, [{ id: 101 }]);
  } finally { await mf.dispose(); }
});
