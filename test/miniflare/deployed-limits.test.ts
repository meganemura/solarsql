// Responsibility: run spike/17-deployed-limits.ts against the example Worker
// on local Miniflare and check each probe's local verdict, so a harness bug
// fails here before the owner's run on a deployed Worker.
// Boundary: local workerd's limits (127 arguments, 4 MiB values, 25,000 VDBE
// ops); the probes just past the docs' 32 arguments and 2 MB pass here.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { splitStatements } from "../../src/build/scan.ts";
import { workerMiniflare } from "../worker.ts";
import { deployedLimits, type Target } from "../../spike/17-deployed-limits.ts";

const root = resolve(import.meta.dirname, "../..");
const migrationsDir = resolve(root, "example/migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(migrationsDir, f), "utf8"));

const expected: [string, "pass" | RegExp][] = [
  ["5-term UNION ALL", "pass"],
  ["6-term UNION ALL", /too many terms in compound SELECT/],
  ["6-row VALUES", "pass"],
  ["coalesce with 32 arguments", "pass"],
  ["coalesce with 33 arguments", "pass"],
  ["coalesce with 127 arguments", "pass"],
  ["coalesce with 128 arguments", /too many arguments on function coalesce/],
  ["json_object with 17 pairs (34 arguments)", "pass"],
  ["json_object with 63 pairs (126 arguments)", "pass"],
  ["100-term addition", "pass"],
  ["101-term addition", /Expression tree is too large \(maximum depth 100\)/],
  ["100 result columns", "pass"],
  ["101 result columns", /too many columns in result set/],
  ["100 bound parameters", "pass"],
  ["101 bound parameters", /too many SQL variables/],
  ["100,000-byte statement", "pass"],
  ["100,001-byte statement", /statement too long/],
  ["bound LIKE pattern of 50 bytes", "pass"],
  ["bound LIKE pattern of 51 bytes", /LIKE or GLOB pattern too complex/],
  ["zeroblob(2,000,001)", "pass"],
  ["zeroblob(4,194,305)", /string or blob too big/],
  ["zeroblob(8,388,643)", /string or blob too big/],
  ["about 10,000 EXPLAIN rows", "pass"],
  ["about 30,000 EXPLAIN rows", /out of memory/],
];

test("each limit probe gives local workerd's verdict on local D1 and a local Durable Object", async () => {
  const mf = workerMiniflare(resolve(root, "example/worker.ts"), root, { durableObjects: { STORE: "Store" } });
  try {
    const db = await mf.getD1Database("DB");
    for (const file of migrations) await db.batch(splitStatements(file).map((s) => db.prepare(s)));
    const send = async (target: Target, body: unknown) => {
      const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`, { method: "POST", body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    };
    const rows = await deployedLimits(send, { place: 150_000, ordersByIds: [150_000] });
    const json = rows.filter((row) => /^(place|ordersByIds) over /.test(row.probe));
    assert.deepEqual(json.map((row) => [row.probe.split(" ")[0], row.d1, row.do]), [["place", "pass", "pass"], ["ordersByIds", "pass", "pass"]]);
    assert.deepEqual(rows.filter((row) => !json.includes(row)).map((row) => row.probe), expected.map(([probe]) => probe));
    for (const [probe, verdict] of expected) {
      const row = rows.find((r) => r.probe === probe)!;
      for (const [target, result] of [["D1", row.d1], ["the Durable Object", row.do]] as const) {
        if (verdict === "pass") assert.equal(result, "pass", `${probe} on ${target}`);
        else assert.match(result, verdict, `${probe} on ${target}`);
      }
    }
  } finally {
    await mf.dispose();
  }
});
