// Responsibility: pins the double-quoted-string (DQS) fallback fact that
// migration.ts's rebuild-refusal message depends on. A quoted name in
// expression position that does not match a real column can mean two
// different things: a reference SQLite rejects, or a string literal
// SQLite accepts. node:sqlite ships that fallback off, so the reference
// throws. D1 and Durable Object SQLite ship it on, so the same reference
// silently resolves as a literal. If a future SQLite build changes either
// side, one of the tests below fails first, and migration.ts's
// why-comment needs another look.
// Boundary: no assertions about migration.ts's own output live here;
// test/rebuild-column-loss-migration.test.ts owns the refusal message.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness, type WorkerOk } from "./d1.ts";

test("node:sqlite ships the double-quoted-string fallback off: a quoted name that is not a real column throws", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table zt (id text primary key not null)");
  db.exec("insert into zt (id) values ('r1')");
  assert.throws(() => db.prepare('select "zzz" from zt').all(), /no such column: "zzz"/);
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
  // Test registration also runs for filtered-out suites (see test/d1.ts):
  // start the runtime lazily, so a skipped suite disposes nothing.
  let runtime: Miniflare | undefined;
  const mf = () => runtime ??= new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-08-28",
    durableObjects: { STORE: { className: "Store", useSQLite: true } },
  }));

  after(async () => {
    await runtime?.dispose();
  });

  test("a quoted name that is not a real column resolves as a string literal, with no throw", async () => {
    const response = await mf().dispatchFetch("http://localhost/");
    const reply = (await response.json()) as { ok: boolean; rows?: Record<string, unknown>[]; message?: string };
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.rows, [{ '"zzz"': "zzz" }]);
  });
});
