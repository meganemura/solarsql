// Fixture Worker: a hand-built command and a real D1 binding and Durable
// Object, to prove `statements` (ADR 0039's 2026-09-25 section) and `at`
// (ADR 0137) on the two production engines, not only on node and a fake
// StorageLike/D1Like (test/observe-at.test.ts, test/observe-statements.test.ts).
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here.
import { DurableObject } from "cloudflare:workers";
import { d1, type D1Like } from "../src/d1.ts";
import { durable, type StorageLike } from "../src/durable.ts";
import { commands, type Meta, type Observed } from "../src/index.ts";

const DDL = "create table t (id text primary key not null, n integer not null) strict";
const insertA = "insert into t (id, n) values ('a', :n)";
const updateA = "update t set n = :n where id = 'a'";
const insertB = "insert into t (id, n) values ('b', :n2)";
const selectA = "select id, n from t where id = 'a'";
const failing = "update t set n = json_extract(:doc, '$.n') where id = 'a'";

const g: Meta<{
  [insertA]: { params: { n: number }; row: {} };
  [updateA]: { params: { n: number }; row: {} };
  [insertB]: { params: { n2: number }; row: {} };
  [selectA]: { params: {}; row: { id: string; n: number } };
  [failing]: { params: { doc: string }; row: {} };
}> = {
  [insertA]: { params: ["n"], encode: [], json: [], reads: ["t"] },
  [updateA]: { params: ["n"], encode: [], json: [], reads: ["t"] },
  [insertB]: { params: ["n2"], encode: [], json: [], reads: ["t"] },
  [selectA]: { params: [], encode: [], json: [], reads: ["t"] },
  [failing]: { params: ["doc"], encode: [], json: [], reads: ["t"] },
};

const okCmd = commands(g, { run: { plan: [insertA, updateA, insertB], returns: selectA } });
const failCmd = commands(g, { run: { plan: ["insert into t (id, n) values ('a', 1)", "insert into t (id, n) values ('b', 2)", failing] as never } });

async function d1Result(binding: D1Like): Promise<{ ok: Observed[]; fail: Observed[] }> {
  await binding.prepare(DDL).bind().all();
  const ok: Observed[] = [];
  await d1(binding, { observe: (e) => ok.push(e) }).run(okCmd.run, { n: 1, n2: 2 } as never);
  await binding.prepare("delete from t").bind().all();
  const fail: Observed[] = [];
  await d1(binding, { observe: (e) => fail.push(e) }).run(failCmd.run, { doc: "{not json" } as never).catch(() => {});
  return { ok, fail };
}

export class Probe extends DurableObject {
  override async fetch(): Promise<Response> {
    const storage = this.ctx.storage as unknown as StorageLike;
    storage.sql.exec(DDL);
    const ok: Observed[] = [];
    await durable(storage, { observe: (e) => ok.push(e) }).run(okCmd.run, { n: 1, n2: 2 } as never);
    storage.sql.exec("delete from t");
    const fail: Observed[] = [];
    await durable(storage, { observe: (e) => fail.push(e) }).run(failCmd.run, { doc: "{not json" } as never).catch(() => {});
    return Response.json({ ok, fail });
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Like; PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/do") return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
    const { ok, fail } = await d1Result(env.DB);
    return Response.json({ ok, fail });
  },
};
