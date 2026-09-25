// Responsibility: ADR 0137's `at` and ADR 0039's 2026-09-25 `statements`,
// on a real D1 binding and a real Durable Object under Miniflare, not
// only on node and the fakes test/observe-at.test.ts and
// test/observe-statements.test.ts already cover.
// Boundary: local Miniflare evidence; a real Cloudflare deployment is not
// exercised here.
import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { workerMiniflare } from "../worker.ts";

const root = resolve(import.meta.dirname, "../..");

type At = { position: number; of: number; sql: string; included?: string } | { returns: true; sql: string };
type StatementRow = { rows_read: number; rows_written: number; duration?: number };
type EventBody = { kind: string; name: string; outcome: string; at?: At; statements?: StatementRow[] };

test("D1: a successful command with plan (insert, update, insert) and a returns query gives 4 statements entries; a failure gives no at and no statements", async () => {
  const mf = workerMiniflare(resolve(root, "test/observe-plan-item.worker.ts"), root, { durableObjects: { PROBE: "Probe" } });
  onTestFinished(() => mf.dispose());
  const response = await mf.dispatchFetch("http://localhost/");
  const { ok, fail } = (await response.json()) as { ok: EventBody[]; fail: EventBody[] };

  const command = ok.find((e) => e.kind === "command");
  assert.ok(command, JSON.stringify(ok));
  assert.equal(command!.outcome, "ok");
  assert.equal(command!.statements?.length, 4);
  assert.ok(command!.statements!.every((s) => typeof s.rows_read === "number" && typeof s.rows_written === "number" && typeof s.duration === "number"));
  assert.equal("at" in command!, false);

  const failed = fail.find((e) => e.kind === "command");
  assert.ok(failed, JSON.stringify(fail));
  assert.equal(failed!.outcome, "error");
  assert.equal("at" in failed!, false);
  assert.equal("statements" in failed!, false);
});

test("Durable Object: a successful command gives 4 statements entries with no duration, none from a probe; a failure names the failing item, the same at node gives for the same shape", async () => {
  const mf = workerMiniflare(resolve(root, "test/observe-plan-item.worker.ts"), root, { durableObjects: { PROBE: "Probe" } });
  onTestFinished(() => mf.dispose());
  const response = await mf.dispatchFetch("http://localhost/do");
  const { ok, fail } = (await response.json()) as { ok: EventBody[]; fail: EventBody[] };

  const command = ok.find((e) => e.kind === "command");
  assert.ok(command, JSON.stringify(ok));
  assert.equal(command!.outcome, "ok");
  assert.equal(command!.statements?.length, 4);
  assert.ok(command!.statements!.every((s) => !("duration" in s)));

  const failed = fail.find((e) => e.kind === "command");
  assert.ok(failed, JSON.stringify(fail));
  assert.equal(failed!.outcome, "error");
  // failCmd's plan is [insert 'a', insert 'b', failing update 'a']: the
  // third item, position 3 of 3.
  assert.deepEqual(failed!.at, { position: 3, of: 3, sql: "update t set n = json_extract(:doc, '$.n') where id = 'a'" });
  assert.equal("statements" in failed!, false);
});
