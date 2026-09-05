// The plan model returns rows from a command, so the D1 side must accept
// RETURNING in prepared statements and inside a batch. This file measures
// that on the local D1 engine, and records which introspection functions
// the engine refuses.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { D1Harness, type WorkerOk } from "./d1.ts";

function rows(reply: WorkerOk): Record<string, unknown>[] {
  return (reply.results as { results: Record<string, unknown>[] }).results;
}

describe("D1 RETURNING", () => {
  const d1 = new D1Harness();

  before(async () => {
    const reply = await d1.batch([
      { sql: "create table notes (id text primary key, body text not null, n integer not null default 0)" },
    ]);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  });

  after(async () => {
    await d1.dispose();
  });

  test("sqlite_version() availability is recorded, pass or fail", async () => {
    const reply = await d1.all("select sqlite_version() as v");
    console.log("sqlite_version() reply:", JSON.stringify(reply));
  });

  test("insert ... returning through all()", async () => {
    const reply = await d1.all("insert into notes (id, body) values (?, ?) returning id, body, n", ["n1", "one"]);
    console.log("all() returning reply:", JSON.stringify(reply));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(rows(reply as WorkerOk), [{ id: "n1", body: "one", n: 0 }]);
  });

  test("insert ... returning through first()", async () => {
    const reply = await d1.first("insert into notes (id, body) values (?, ?) returning id", ["n2", "two"]);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual((reply as WorkerOk).results, { id: "n2" });
  });

  test("insert ... returning through run()", async () => {
    const reply = await d1.run("insert into notes (id, body) values (?, ?) returning id", ["n3", "three"]);
    console.log("run() returning reply:", JSON.stringify(reply));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(rows(reply as WorkerOk), [{ id: "n3" }]);
  });

  test("update and delete ... returning inside a batch", async () => {
    const reply = await d1.batch([
      { sql: "update notes set n = n + 1 where id = ? returning id, n", params: ["n1"] },
      { sql: "delete from notes where id = ? returning id, body", params: ["n2"] },
      { sql: "insert into notes (id, body) values (?, ?) returning id", params: ["n4", "four"] },
    ]);
    console.log("batch returning reply:", JSON.stringify(reply));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const results = (reply as WorkerOk).results as { results: Record<string, unknown>[] }[];
    assert.deepEqual(results.map((r) => r.results), [
      [{ id: "n1", n: 1 }],
      [{ id: "n2", body: "two" }],
      [{ id: "n4" }],
    ]);
  });

  test("returning inside a batch that fails is rolled back with the rest", async () => {
    const reply = await d1.batch([
      { sql: "insert into notes (id, body) values (?, ?) returning id", params: ["n5", "five"] },
      { sql: "insert into notes (id, body) values (?, ?) returning id", params: ["n5", "duplicate"] },
    ]);
    console.log("batch returning failure reply:", JSON.stringify(reply));
    assert.equal(reply.ok, false);
    const count = await d1.first("select count(*) as n from notes where id = 'n5'");
    assert.deepEqual((count as WorkerOk).results, { n: 0 });
  });
});
