// The example project runs on the local D1 engine and on a SQLite Durable
// Object, through the same module code. The steps are in example-steps.ts;
// each is one request to the Worker in example/worker.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { splitStatements } from "../../src/build/scan.ts";
import { workerMiniflare } from "../worker.ts";
import { exampleSteps, type Reply } from "../example-steps.ts";

const root = resolve(import.meta.dirname, "../..");
const migrationsDir = resolve(root, "example/migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(migrationsDir, f), "utf8"));

for (const target of ["d1", "do"] as const) {
  describe(`example on ${target}`, () => {
    let mf: ReturnType<typeof workerMiniflare> | undefined;
    const send = async (body: Record<string, unknown>): Promise<Reply> => {
      assert.ok(mf, "The selected suite must initialize its runtime");
      const response = await mf.dispatchFetch(`http://localhost/${target === "do" ? "do" : ""}`, { method: "POST", body: JSON.stringify(body) });
      return (await response.json()) as Reply;
    };
    const value = async (body: Record<string, unknown>): Promise<unknown> => {
      const reply = await send(body);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return (reply as { value: unknown }).value;
    };

    before(async () => {
      // Excluded suites do not run disposal hooks, so registration must not own a runtime.
      mf = workerMiniflare(resolve(root, "example/worker.ts"), root, { durableObjects: { STORE: "Store" } });
      if (target === "d1") {
        // wrangler applies each migration file as one batch, in name order.
        const db = await mf.getD1Database("DB");
        for (const file of migrations) await db.batch(splitStatements(file).map((s) => db.prepare(s)));
      }
    });
    after(async () => {
      await mf?.dispose();
    });

    exampleSteps(value, { oneIsolate: true, engineMeta: target === "d1" || target === "do" });
  });
}

test("example selection exits when no test matches", () => {
  const result = spawnSync(process.execPath, [
    "--test", "--test-name-pattern=solarsql-unmatched-selection-probe", import.meta.filename,
  ], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
