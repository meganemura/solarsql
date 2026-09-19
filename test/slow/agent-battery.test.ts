// Responsibility: run the agent battery (spike/13-agent-battery) with the
// stub agent, over all five scenarios, and pin the stub's own filesRead and
// failedCommands per scenario, since the stub's fix -- and what it reads
// and runs to make it -- is scripted, not model output.
// Boundary: this spawns the stub as a child process and the CLI it calls
// (npx solarsql, npx tsc), so it lives in test/slow/, not test/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureDir } from "../fixture-dir.ts";
import { runBattery } from "../../spike/13-agent-battery/run.ts";

const root = resolve(import.meta.dirname, "../..");
const stubAgent = `node ${JSON.stringify(join(root, "spike/13-agent-battery/stub-agent.ts"))}`;
const summarizePath = join(root, "spike/13-agent-battery/summarize.ts");

const expected: Record<string, { filesRead: number; filesEdited: number; failedCommands: number; hunksOutsideTask: number }> = {
  "invalid-sql": { filesRead: 1, filesEdited: 1, failedCommands: 1, hunksOutsideTask: 0 },
  "stale-generated": { filesRead: 1, filesEdited: 0, failedCommands: 1, hunksOutsideTask: 0 },
  "ddl-only": { filesRead: 1, filesEdited: 0, failedCommands: 0, hunksOutsideTask: 0 },
  "cross-module-write": { filesRead: 2, filesEdited: 2, failedCommands: 1, hunksOutsideTask: 0 },
  // The rename touches orders (its declaration and every query, trigger,
  // and command that spells the column) and order_search (the trigger
  // bodies that feed it), a real column rename's own honest blast radius,
  // not a harmful edit outside the task -- hunksOutsideTask counts it
  // anyway, since it only knows "orders" is the task's table; this pin
  // documents that reading, it does not endorse it.
  // 6, not 5, since ADR 0127's deleteByCustomer command: the diff library's
  // context merging (a few unchanged lines keep two changes in one hunk)
  // depends on the example's generated file size, not on the stub's own
  // edits, and orders/solarsql.generated.ts grew, splitting one hunk in two.
  "rename-needs-intent": { filesRead: 1, filesEdited: 2, failedCommands: 0, hunksOutsideTask: 6 },
  "owned-cross-module": { filesRead: 2, filesEdited: 2, failedCommands: 0, hunksOutsideTask: 0 },
  "flat-cross-module": { filesRead: 1, filesEdited: 1, failedCommands: 0, hunksOutsideTask: 0 },
};

test("the stub repairs all seven scenarios, with the pinned reads and failed commands", { timeout: 300_000 }, async () => {
  const out = fixtureDir("agent-battery-");
  const { records, table, ok } = await runBattery(["--agent", stubAgent, "--runs", "1", "--out", out]);

  assert.equal(records.length, 7, table);
  assert.equal(ok, true, JSON.stringify(records, null, 2));
  for (const record of records) {
    assert.equal(record.success, true, `${record.scenario}: ${record.checkFailure}`);
    const want = expected[record.scenario];
    assert.ok(want, `no expected counts for ${record.scenario}`);
    assert.equal(record.filesRead, want.filesRead, `${record.scenario} filesRead`);
    assert.equal(record.filesEdited, want.filesEdited, `${record.scenario} filesEdited`);
    assert.equal(record.failedCommands, want.failedCommands, `${record.scenario} failedCommands`);
    assert.equal(record.hunksOutsideTask, want.hunksOutsideTask, `${record.scenario} hunksOutsideTask`);
    assert.ok(existsSync(record.streamPath), `${record.scenario} missing ${record.streamPath}`);
    assert.ok(existsSync(record.diffPath), `${record.scenario} missing ${record.diffPath}`);
  }

  const invalidSql = records.find(r => r.scenario === "invalid-sql")!;
  const summarized = execFileSync(process.execPath, [summarizePath, invalidSql.streamPath], { encoding: "utf8" });
  const toolLines = summarized.split("\n---\n")[0]!.split("\n").filter(line => line.length > 0);
  assert.equal(toolLines.length, invalidSql.toolCalls);

  const lines = readFileSync(join(out, "metrics.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 7);
  for (const line of lines) {
    const record = JSON.parse(line) as { costUsd: unknown; turns: unknown };
    assert.equal(record.costUsd, 0);
    assert.equal(typeof record.turns, "number");
  }
  assert.match(table, /\| scenario \| runs \| success \| median files read \| median files edited \| median failed commands \| median hunks outside task \| median duration \(ms\) \| median cost \(USD\) \|/);
  for (const scenario of Object.keys(expected)) assert.match(table, new RegExp(`\\| ${scenario} \\| 1 \\| 1/1 \\|`));
});

test("a stub run that skips its fix fails the check, not the agent's own report", { timeout: 60_000 }, async () => {
  const out = fixtureDir("agent-battery-skip-");
  const { records, ok } = await runBattery(["--agent", `env SOLARSQL_BATTERY_SKIP_FIX=1 ${stubAgent}`, "--scenario", "invalid-sql", "--runs", "1", "--out", out]);
  assert.equal(ok, false);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.success, false);
  assert.equal(typeof records[0]!.checkFailure, "string");
  assert.ok(records[0]!.checkFailure!.length > 0);
});
