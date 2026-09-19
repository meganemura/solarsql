// Responsibility: pins the fact ADR 0113's copy of workerd's
// ALLOWED_SQLITE_FUNCTIONS depends on: D1 and a Durable Object's own
// storage refuse a call to a function outside that allowlist at prepare,
// with a "not authorized to use function: <name>" message, and allow a
// call to a function on it. facts.ts's Engine.prepare() mirrors this
// allowlist so the build catches the same refusal locally; if a future
// workerd release changes its own allowlist, one of the two cases below
// fails first, against the real deploy targets, not only against the
// local copy.
// Boundary: no assertions about the build's own message live here;
// test/typegen.test.ts and test/build.test.ts own those.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness, type WorkerOk, type WorkerError } from "../d1.ts";

describe("D1 SQLite refuses a function outside workerd's own allowlist, and allows one on it", () => {
  const d1 = new D1Harness();

  after(async () => {
    await d1.dispose();
  });

  test("sqlite_version(), cast to a type, is refused by name", async () => {
    const reply = await d1.all("select cast(sqlite_version() as text) as v");
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.match((reply as WorkerError).message, /not authorized to use function: sqlite_version/);
  });

  test("random(), cast to a type, succeeds", async () => {
    const reply = await d1.all("select cast(random() as integer) as r");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0]!.r, "number");
  });
});

describe("Durable Object SQLite also refuses a function outside workerd's own allowlist, and allows one on it", () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const { sql } = await request.json();
    const s = this.ctx.storage.sql;
    try {
      const rows = s.exec(sql).toArray();
      return Response.json({ ok: true, rows });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.STORE.idFromName("one");
    return env.STORE.get(id).fetch("http://do/", { method: "POST", body: await request.text() });
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

  const run = async (sql: string): Promise<{ ok: boolean; rows?: Record<string, unknown>[]; message?: string }> => {
    const response = await mf().dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql }) });
    return (await response.json()) as { ok: boolean; rows?: Record<string, unknown>[]; message?: string };
  };

  test("sqlite_version(), cast to a type, is refused by name", async () => {
    const reply = await run("select cast(sqlite_version() as text) as v");
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.match(reply.message!, /not authorized to use function: sqlite_version/);
  });

  test("random(), cast to a type, succeeds", async () => {
    const reply = await run("select cast(random() as integer) as r");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.rows!.length, 1);
    assert.equal(typeof reply.rows![0]!.r, "number");
  });
});

// The two suites below pin a DEFAULT expression's function call, not a
// bare `select`. Today it evaluates on node:sqlite, D1, and a Durable
// Object alike, so both tests pass now. workerd carries an unreleased
// patch that adds an authorizer check to exactly this DEFAULT-expression
// path; once a pinned Miniflare build picks it up, D1 and a Durable
// Object would start refusing this same `insert`, and one of these two
// tests is the first thing to fail and say so.
describe("D1 SQLite evaluates a DEFAULT expression's function call today (ADR 0114)", () => {
  const d1 = new D1Harness();

  after(async () => {
    await d1.dispose();
  });

  test("a column default calling sqlite_version() is applied by an insert that omits it", async () => {
    const batchReply = await d1.batch([
      { sql: "create table t (id text primary key not null, a text default (sqlite_version()))" },
      { sql: "insert into t (id) values ('x')" },
    ]);
    assert.equal(batchReply.ok, true, JSON.stringify(batchReply));

    const reply = await d1.all("select a from t");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const rows = ((reply as WorkerOk).results as { results: Record<string, unknown>[] }).results;
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.a as string, /^\d+\.\d+\.\d+$/);
  });
});

describe("Durable Object SQLite also evaluates a DEFAULT expression's function call today (ADR 0114)", () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const s = this.ctx.storage.sql;
    try {
      s.exec("create table t (id text primary key not null, a text default (sqlite_version()))");
      s.exec("insert into t (id) values ('x')");
      const rows = s.exec("select a from t").toArray();
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

  test("a column default calling sqlite_version() is applied by an insert that omits it", async () => {
    const response = await mf().dispatchFetch("http://localhost/", { method: "POST" });
    const reply = (await response.json()) as { ok: boolean; rows?: Record<string, unknown>[]; message?: string };
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.rows!.length, 1);
    assert.match(reply.rows![0]!.a as string, /^\d+\.\d+\.\d+$/);
  });
});
