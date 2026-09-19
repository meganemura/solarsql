// Responsibility: pins the double-quoted-string (DQS) fallback fact that
// migration.ts's rebuild-refusal message depends on. A quoted name in
// expression position that does not match a real column can mean two
// different things: a reference SQLite rejects, or a string literal
// SQLite accepts. This file pins that fact for two statement shapes: a
// bare `select "zzz" from zt`, and the `create table ... as select
// "zzz" from zt` shape that migration.ts's own rebuild copy statement
// uses. node:sqlite ships the fallback off, so both shapes throw. D1
// and Durable Object SQLite ship it on, so both shapes silently resolve
// the quoted name as a literal. If a future SQLite build changes either
// side, one of the tests below fails first, and migration.ts's
// why-comment needs another look.
// Boundary: no assertions about migration.ts's own output live here;
// test/rebuild-column-loss-migration.test.ts owns the refusal message.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness, type WorkerOk } from "../d1.ts";

test("node:sqlite ships the double-quoted-string fallback off: a quoted name that is not a real column throws", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table zt (id text primary key not null)");
  db.exec("insert into zt (id) values ('r1')");
  assert.throws(() => db.prepare('select "zzz" from zt').all(), /no such column: "zzz"/);
});

test("node:sqlite ships the double-quoted-string fallback off for CREATE TABLE ... AS SELECT too", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table zt (id text primary key not null)");
  db.exec("insert into zt (id) values ('r1')");
  assert.throws(
    () => db.exec('create table zc2 as select "zzz" from zt'),
    /no such column: "zzz"/,
  );
});

describe("D1 SQLite ships the double-quoted-string fallback on", () => {
  const d1 = new D1Harness();

  before(async () => {
    const reply = await d1.batch([
      { sql: "create table zt (id text primary key not null)" },
      { sql: "insert into zt (id) values ('r1')" },
    ]);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  after(async () => {
    await d1.dispose();
  });

  test("a quoted name that is not a real column resolves as a string literal, with no throw", async () => {
    const reply = await d1.all('select "zzz" from zt');
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    assert.deepEqual(rows, [{ '"zzz"': "zzz" }]);
  });

  test("a quoted name in a CREATE TABLE ... AS SELECT also resolves as a string literal, with no throw", async () => {
    const created = await d1.batch([{ sql: 'create table zc2 as select "zzz" from zt' }]);
    assert.equal(created.ok, true, JSON.stringify(created));
    const reply = await d1.all("select * from zc2");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    assert.deepEqual(rows, [{ '"zzz"': "zzz" }]);
  });
});

describe("Durable Object SQLite also ships the double-quoted-string fallback on", () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    s.exec("create table if not exists zt (id text primary key not null)");
    s.exec("insert into zt (id) values ('r1')");
    try {
      const rows = s.exec('select "zzz" from zt').toArray();
      return Response.json({ ok: true, rows });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.STORE.idFromName("one");
    return env.STORE.get(id).fetch("http://do/");
  },
};
`;
  const ctasScript = `
import { DurableObject } from "cloudflare:workers";
export class StoreCtas extends DurableObject {
  async fetch() {
    const s = this.ctx.storage.sql;
    s.exec("create table if not exists zt (id text primary key not null)");
    s.exec("insert into zt (id) values ('r1')");
    try {
      s.exec('create table zc2 as select "zzz" from zt');
      const rows = s.exec('select * from zc2').toArray();
      return Response.json({ ok: true, rows });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.STORE.idFromName("one");
    return env.STORE.get(id).fetch("http://do/");
  },
};
`;
  // Test registration also runs for filtered-out suites (see test/d1.ts):
  // start the runtimes lazily, so a skipped suite disposes nothing.
  let runtime: Miniflare | undefined;
  const mf = () => runtime ??= new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-08-28",
    durableObjects: { STORE: { className: "Store", useSQLite: true } },
  }));
  let ctasRuntime: Miniflare | undefined;
  const ctasMf = () => ctasRuntime ??= new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: ctasScript,
    compatibilityDate: "2026-08-28",
    durableObjects: { STORE: { className: "StoreCtas", useSQLite: true } },
  }));

  after(async () => {
    await runtime?.dispose();
    await ctasRuntime?.dispose();
  });

  test("a quoted name that is not a real column resolves as a string literal, with no throw", async () => {
    const response = await mf().dispatchFetch("http://localhost/");
    const reply = (await response.json()) as { ok: boolean; rows?: Record<string, unknown>[]; message?: string };
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.rows, [{ '"zzz"': "zzz" }]);
  });

  test("a quoted name in a CREATE TABLE ... AS SELECT also resolves as a string literal, with no throw", async () => {
    const response = await ctasMf().dispatchFetch("http://localhost/");
    const reply = (await response.json()) as { ok: boolean; rows?: Record<string, unknown>[]; message?: string };
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.rows, [{ '"zzz"': "zzz" }]);
  });
});
