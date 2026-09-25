// Responsibility: pins the fact facts.ts's WORKERD_LIMITS depends on: D1 and
// a Durable Object's own SQLite refuse a statement past workerd's
// prepare-time limits (cloudflare/workerd src/workerd/util/sqlite.c++,
// SqliteDatabase::setupSecurity), and accept one at or under them. Each case
// below asserts that D1's verdict, the Durable Object's verdict, and
// facts.ts's Engine.prepare() verdict all agree -- so a future workerd
// release that moves one of these numbers fails here first, against the
// real deploy targets, not only against the local copy in facts.ts.
// Boundary: no assertions about the build's own error message live here;
// test/facts.test.ts owns those. No case in this file sits between 15,000
// and 25,000 VDBE ops: this round measured node:sqlite and a local
// Durable Object disagreeing in that band (a local DO accepted up to 21,843
// ops on macOS where node:sqlite's own vdbeOp 25,000 already refuses), so a
// case there would pin a boundary this library cannot make both engines
// agree on.
import { afterAll, describe, test } from "vitest";
import assert from "node:assert/strict";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness } from "../d1.ts";
import { Engine } from "../../src/build/facts.ts";

const union = (n: number) => Array.from({ length: n }, (_, i) => `select ${i}`).join(" union all ");
const args = (n: number) => Array.from({ length: n }, () => "null").join(",");
const chain = (n: number) => "1" + "+1".repeat(n - 1);
const cols = (n: number) => Array.from({ length: n }, (_, i) => `1 as c${i}`).join(",");
// `?` positional placeholders, not `:name` ones: a Durable Object's
// storage.sql.exec() binds only positional varargs, so the fixture must
// work unbound (for node:sqlite's prepare(), which never runs the
// statement) and bound (for D1 and the Durable Object, which must run it
// to reach a limit workerd checks only once the VDBE program is asked to
// execute, such as vdbeOp).
const params = (n: number) => Array.from({ length: n }, () => "?").join(",");
const paramValues = (n: number) => Array.from({ length: n }, (_, i) => i);
const padded = (bytes: number) => {
  const prefix = "select 1 as a --";
  return prefix + " " + "x".repeat(Math.max(0, bytes - prefix.length - 1));
};
const values = (rows: number) => `select * from (values ${Array.from({ length: rows }, (_, i) => `(${i})`).join(",")})`;

// Each case is a SELECT (so D1's .first(), a Durable Object's exec(), and
// Engine.prepare() all take the same statement) and the verdict every
// engine is expected to agree on.
const cases: { name: string; sql: string; refused: boolean; values?: unknown[] }[] = [
  { name: "6-term UNION ALL (compoundSelect 5)", sql: `select * from (${union(6)})`, refused: true },
  { name: "5-term UNION ALL", sql: `select * from (${union(5)})`, refused: false },
  { name: "600-row VALUES (multi-row VALUES is exempt)", sql: `select * from (values ${Array.from({ length: 600 }, (_, i) => `(${i})`).join(",")})`, refused: false },
  { name: "coalesce with 128 arguments (functionArg 127)", sql: `select coalesce(${args(128)})`, refused: true },
  { name: "coalesce with 127 arguments", sql: `select coalesce(${args(127)})`, refused: false },
  { name: "101-term addition chain (exprDepth 100)", sql: `select ${chain(101)}`, refused: true },
  { name: "100-term addition chain", sql: `select ${chain(100)}`, refused: false },
  { name: "101 result columns (column 100)", sql: `select ${cols(101)}`, refused: true },
  { name: "100 result columns", sql: `select ${cols(100)}`, refused: false },
  { name: "101 bound parameters (variableNumber 100)", sql: `select ${params(101)}`, refused: true, values: paramValues(101) },
  { name: "100 bound parameters", sql: `select ${params(100)}`, refused: false, values: paramValues(100) },
  { name: "100,001-byte statement (sqlLength 100,000)", sql: padded(100_001), refused: true },
  { name: "99,990-byte statement", sql: padded(99_990), refused: false },
  { name: "~30,000 EXPLAIN rows (vdbeOp 25,000)", sql: values(14_995), refused: true },
  { name: "~10,000 EXPLAIN rows", sql: values(4_995), refused: false },
];

function nodeVerdict(sql: string): boolean {
  const engine = new Engine([]);
  try {
    engine.prepare(sql);
    return false;
  } catch {
    return true;
  } finally {
    engine.close();
  }
}

describe("D1 SQLite's prepare-time verdict matches facts.ts's WORKERD_LIMITS", () => {
  const d1 = new D1Harness();

  afterAll(async () => {
    await d1.dispose();
  });

  for (const c of cases) {
    test(c.name, async () => {
      const reply = await d1.first(c.sql, c.values ?? []);
      const refused = reply.ok === false;
      assert.equal(refused, c.refused, JSON.stringify(reply));
      assert.equal(refused, nodeVerdict(c.sql), "D1 and the build's Engine.prepare() disagree");
    });
  }

  test("101 columns in a CREATE TABLE is refused, 100 is not (column 100)", async () => {
    const wide = (n: number) => `create table wide (${Array.from({ length: n }, (_, i) => `c${i} integer`).join(",")})`;
    const refused = await d1.exec(wide(101));
    const ok = await d1.exec(wide(100).replace("wide", "wide_ok"));
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });
});

describe("A Durable Object's SQLite prepare-time verdict matches facts.ts's WORKERD_LIMITS", () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const { sql, values } = await request.json();
    try {
      this.ctx.storage.sql.exec(sql, ...(values ?? [])).toArray();
      return Response.json({ ok: true });
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

  afterAll(async () => {
    await runtime?.dispose();
  });

  const run = async (sql: string, values: unknown[] = []): Promise<{ ok: boolean; message?: string }> => {
    const response = await mf().dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ sql, values }) });
    return (await response.json()) as { ok: boolean; message?: string };
  };

  for (const c of cases) {
    test(c.name, async () => {
      const reply = await run(c.sql, c.values ?? []);
      const refused = reply.ok === false;
      assert.equal(refused, c.refused, JSON.stringify(reply));
      assert.equal(refused, nodeVerdict(c.sql), "the Durable Object and the build's Engine.prepare() disagree");
    });
  }
});
