// Responsibility: pins NODE_TEST_LIMITS's own two boundaries (LIKE/GLOB
// pattern length, trigger recursion depth) against D1 and a Durable
// Object's own verdict, so a workerd change that moves either value fails
// here first. test/node-limits.test.ts pins the same two boundaries
// against node:sqlite under the constant.
// Boundary: run-time limits only (prepare-limits.test.ts owns the
// prepare-time ones).
import { afterAll, describe, test } from "vitest";
import assert from "node:assert/strict";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { D1Harness } from "../d1.ts";
import { NODE_TEST_LIMITS } from "../../src/runtime/node-limits.ts";

// `new.n < depth - 1` recurses `depth` times in total (test/node-limits.test.ts's
// own comment explains why); triggerDepth 10 passes at depth 10 and fails at 11.
// D1 and a Durable Object leave `recursive_triggers` off by default, unlike
// node:sqlite; without it a trigger that inserts into its own table never
// recurses, and no depth here would ever fail.
const recurseDdl = (depth: number) =>
  `pragma recursive_triggers = on; create table t (n integer); create trigger r after insert on t when new.n < ${depth - 1} begin insert into t (n) values (new.n + 1); end;`;

describe("D1's SQLite run-time verdict matches NODE_TEST_LIMITS", () => {
  const d1 = new D1Harness();

  afterAll(async () => {
    await d1.dispose();
  });

  test(`a bound ${NODE_TEST_LIMITS.likePatternLength + 1}-byte LIKE pattern is refused`, async () => {
    const reply = await d1.first("select 'x' like ?", ["x".repeat(NODE_TEST_LIMITS.likePatternLength + 1)]);
    assert.equal(reply.ok, false, JSON.stringify(reply));
  });

  test(`a bound ${NODE_TEST_LIMITS.likePatternLength}-byte LIKE pattern passes`, async () => {
    const reply = await d1.first("select 'x' like ?", ["x".repeat(NODE_TEST_LIMITS.likePatternLength)]);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  test(`a ${NODE_TEST_LIMITS.triggerDepth + 1}-deep recursive trigger is refused`, async () => {
    const ddl = await d1.exec(recurseDdl(NODE_TEST_LIMITS.triggerDepth + 1));
    assert.equal(ddl.ok, true, JSON.stringify(ddl));
    const reply = await d1.run("insert into t (n) values (0)");
    assert.equal(reply.ok, false, JSON.stringify(reply));
  });

  test(`a ${NODE_TEST_LIMITS.triggerDepth}-deep recursive trigger passes`, async () => {
    const ddl = await d1.exec(recurseDdl(NODE_TEST_LIMITS.triggerDepth).replace(/\bt\b/g, "t_ok").replace(/\br\b/g, "r_ok"));
    assert.equal(ddl.ok, true, JSON.stringify(ddl));
    const reply = await d1.run("insert into t_ok (n) values (0)");
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
});

describe("A Durable Object's SQLite run-time verdict matches NODE_TEST_LIMITS", () => {
  const script = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  async fetch(request) {
    const { sql } = await request.json();
    try {
      this.ctx.storage.sql.exec(sql).toArray();
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, message: e.message });
    }
  }
}
export default {
  async fetch(request, env) {
    const id = env.STORE.idFromName(new URL(request.url).searchParams.get("name"));
    return env.STORE.get(id).fetch("http://do/", { method: "POST", body: await request.text() });
  },
};
`;
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

  const run = async (name: string, sql: string): Promise<{ ok: boolean; message?: string }> => {
    const response = await mf().dispatchFetch(`http://localhost/?name=${name}`, { method: "POST", body: JSON.stringify({ sql }) });
    return (await response.json()) as { ok: boolean; message?: string };
  };

  test(`a bound ${NODE_TEST_LIMITS.likePatternLength + 1}-byte LIKE pattern is refused`, async () => {
    const reply = await run("like-over", `select 'x' like '${"x".repeat(NODE_TEST_LIMITS.likePatternLength + 1)}'`);
    assert.equal(reply.ok, false, JSON.stringify(reply));
  });

  test(`a bound ${NODE_TEST_LIMITS.likePatternLength}-byte LIKE pattern passes`, async () => {
    const reply = await run("like-at", `select 'x' like '${"x".repeat(NODE_TEST_LIMITS.likePatternLength)}'`);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  test(`a ${NODE_TEST_LIMITS.triggerDepth + 1}-deep recursive trigger is refused`, async () => {
    const name = "trigger-over";
    const ddl = await run(name, recurseDdl(NODE_TEST_LIMITS.triggerDepth + 1));
    assert.equal(ddl.ok, true, JSON.stringify(ddl));
    const reply = await run(name, "insert into t (n) values (0)");
    assert.equal(reply.ok, false, JSON.stringify(reply));
  });

  test(`a ${NODE_TEST_LIMITS.triggerDepth}-deep recursive trigger passes`, async () => {
    const name = "trigger-at";
    const ddl = await run(name, recurseDdl(NODE_TEST_LIMITS.triggerDepth));
    assert.equal(ddl.ok, true, JSON.stringify(ddl));
    const reply = await run(name, "insert into t (n) values (0)");
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });
});
