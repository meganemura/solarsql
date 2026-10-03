// Responsibility: run the analyze output for a table-valued function that
// reads an enclosing query's column on local D1 and on a local Durable
// Object, and compare each adapter's rows with that target's own driver.
// The correlated EXISTS form must also return the same rows as the join
// form on the fixture data.
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";
import { labels } from "../fixtures/correlated-json-each.ts";

const root = resolve(import.meta.dirname, "../..");

for (const target of ["d1", "do"] as const) {
  test(`on ${target}, a correlated json_each query returns the driver's rows and the join form's rows`, async () => {
    const mf = workerMiniflare(resolve(root, "test/correlated-json-each.worker.ts"), root, { durableObjects: { PROBE: "CorrelatedProbe" } });
    onTestFinished(() => mf.dispose());
    const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`);
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as Record<string, { adapter: unknown[]; driver: unknown[] }>;
    for (const [name, { adapter, driver }] of Object.entries(result)) assert.deepEqual(adapter, driver, name);
    const ids = (label: string, query: string) => result[`${query}:${label}`]!.adapter.map((row) => (row as { id: string }).id);
    assert.deepEqual(ids("red", "byLabel"), ["a", "d"]);
    assert.deepEqual(ids("blue", "byLabel"), ["a", "b"]);
    assert.deepEqual(ids("1", "byLabel"), []);
    for (const label of labels) assert.deepEqual(ids(label, "byLabel"), ids(label, "byLabelJoin"), label);
    assert.deepEqual(result.labelCounts!.adapter, [{ id: "a", labelCount: 2 }, { id: "b", labelCount: 1 }, { id: "c", labelCount: 0 }, { id: "d", labelCount: 2 }, { id: "e", labelCount: 1 }]);
  });
}
