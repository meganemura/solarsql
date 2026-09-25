// Responsibility: prove, on a real D1 database and a real Durable Object,
// the rows_read differential queries.md's keyset paging recipe and
// docs/adr/0131-keyset-paging-for-fixed-keys.md rest on: a keyset page
// costs a fixed number of rows regardless of depth, an OFFSET page costs
// offset + limit. test/keyset-paging.worker.ts builds the fixture table,
// seeds it, and reports each page's own rows_read through the adapters'
// observe hook.
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here (see skills/solarsql/references/deploy.md's remote suite).
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

type Result = { keyset: number | null; composite: number | null; offset: number | null; limit: number; offsetArg: number };

for (const target of ["d1", "do"] as const) {
  test(`a deep keyset page reads a fixed number of rows and an OFFSET page reads offset + limit, on ${target}`, async () => {
    const mf = workerMiniflare(resolve(root, "test/keyset-paging.worker.ts"), root, { durableObjects: { PROBE: "KeysetProbe" } });
    onTestFinished(() => mf.dispose());

    const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`);
    const result = (await response.json()) as Result;

    // A single-column keyset page reads exactly its own rows.
    assert.equal(result.keyset, result.limit, JSON.stringify(result));
    // A composite (row-value) keyset page reads one extra row: the engine
    // seeks past the last row of the previous page before the first row of
    // this one satisfies the two-column comparison (ADR 0131's measured numbers).
    assert.equal(result.composite, result.limit + 1, JSON.stringify(result));
    // An OFFSET page reads and bills every skipped row, plus the page itself.
    assert.equal(result.offset, result.offsetArg + result.limit, JSON.stringify(result));
  });
}
