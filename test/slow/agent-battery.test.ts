// Responsibility: run the agent battery (spike/13-agent-battery) with the
// stub agent, over all five scenarios, and pin the stub's own filesRead and
// failedCommands per scenario, since the stub's fix -- and what it reads
// and runs to make it -- is scripted, not model output.
// Boundary: this spawns the stub as a child process and the CLI it calls
// (npx solarsql, npx tsc), so it lives in test/slow/, not test/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureDir } from "../fixture-dir.ts";
import { runBattery } from "../../spike/13-agent-battery/run.ts";

const root = resolve(import.meta.dirname, "../..");
const stubAgent = `node ${JSON.stringify(join(root, "spike/13-agent-battery/stub-agent.ts"))}`;

const expected: Record<string, { filesRead: number; failedCommands: number }> = {
  "invalid-sql": { filesRead: 1, failedCommands: 1 },
  "stale-generated": { filesRead: 1, failedCommands: 1 },
  "ddl-only": { filesRead: 1, failedCommands: 0 },
  "cross-module-write": { filesRead: 2, failedCommands: 1 },
  "rename-needs-intent": { filesRead: 1, failedCommands: 0 },
};

test("the stub repairs all five scenarios, with the pinned reads and failed commands", { timeout: 300_000 }, async () => {
  const out = fixtureDir("agent-battery-");
  const { records, table, ok } = await runBattery(["--agent", stubAgent, "--runs", "1", "--out", out]);

  assert.equal(records.length, 5, table);
  assert.equal(ok, true, JSON.stringify(records, null, 2));
  for (const record of records) {
    assert.equal(record.success, true, `${record.scenario}: ${record.checkFailure}`);
    const want = expected[record.scenario];
    assert.ok(want, `no expected counts for ${record.scenario}`);
    assert.equal(record.filesRead, want.filesRead, `${record.scenario} filesRead`);
    assert.equal(record.failedCommands, want.failedCommands, `${record.scenario} failedCommands`);
  }

  const lines = readFileSync(join(out, "metrics.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  for (const line of lines) {
    const record = JSON.parse(line) as { costUsd: unknown; turns: unknown };
    assert.equal(record.costUsd, 0);
    assert.equal(typeof record.turns, "number");
  }
  assert.match(table, /\| scenario \| runs \| success \| median files read \| median failed commands \| median duration \(ms\) \| median cost \(USD\) \|/);
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
