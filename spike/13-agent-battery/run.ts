#!/usr/bin/env node
// Responsibility: the battery's command. For each scenario and run, build a
// fresh starter, break it, spawn the agent command with the task on stdin,
// parse its event stream, check the repair, and append one metrics line.
// Prints a markdown table at the end and exits 1 when any run failed.
// Boundary: this file owns process orchestration and reporting; scenarios.ts
// owns what breaks and what passes, metrics.ts owns the stream shape.
//
// node spike/13-agent-battery/run.ts --agent "<command>" [--scenario <name>] [--runs <n>] [--out <dir>]
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios } from "./scenarios.ts";
import { buildStarter } from "./starter.ts";
import { parseStream } from "./metrics.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

function parseArgs(argv: string[]): { agent: string; scenario: string | undefined; runs: number; out: string } {
  let agent = 'claude -p --model sonnet --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Edit,Write,Bash,Glob,Grep --setting-sources project';
  let scenario: string | undefined;
  let runs = 1;
  let out = join(repoRoot, ".scratch", "battery-out");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") agent = argv[++i]!;
    else if (arg === "--scenario") scenario = argv[++i]!;
    else if (arg === "--runs") runs = Number(argv[++i]);
    else if (arg === "--out") out = resolve(argv[++i]!);
    else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return { agent, scenario, runs, out };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// costUsd is null for an agent CLI (or a stub run) that reports no cost;
// the median only has an opinion once at least one run reports a number.
function medianCost(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : median(known);
}

type RunRecord = {
  scenario: string;
  run: number;
  success: boolean;
  filesRead: number;
  failedCommands: number;
  toolCalls: number;
  durationMs: number;
  costUsd: number | null;
  turns: number | null;
  checkFailure?: string;
};

// A relative path token (such as the stub's own "spike/13-agent-battery/
// stub-agent.ts", written the way a developer running from the repository
// root would type it) is resolved against that root before the shell sees
// it, since the shell's own cwd is about to become the starter.
function resolveAgentCommand(agent: string, invokedFrom: string): string {
  return agent
    .split(" ")
    .map(token => (!token.startsWith("-") && existsSync(resolve(invokedFrom, token)) ? resolve(invokedFrom, token) : token))
    .join(" ");
}

// Spawns the agent command through the shell, cwd at the starter, the task
// on stdin, and a 10-minute deadline -- long enough for a paid model, short
// enough that a hung run does not block the battery forever.
function spawnAgent(agent: string, dir: string, task: string, scenarioName: string): Promise<{ stdout: string; wallMs: number }> {
  return new Promise((resolvePromise, reject) => {
    const start = Date.now();
    const child = spawn(agent, {
      shell: true,
      cwd: dir,
      env: { ...process.env, SOLARSQL_BATTERY_SCENARIO: scenarioName },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent command timed out after 600000ms\n${stderr}`));
    }, 600_000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", () => {
      clearTimeout(timeout);
      resolvePromise({ stdout, wallMs: Date.now() - start });
    });
    child.stdin.write(task);
    child.stdin.end();
  });
}

export async function runBattery(argv: string[]): Promise<{ records: RunRecord[]; table: string; ok: boolean }> {
  const invokedFrom = process.cwd();
  const { agent: agentArg, scenario: scenarioFilter, runs, out } = parseArgs(argv);
  const agent = resolveAgentCommand(agentArg, invokedFrom);
  const selected = scenarioFilter ? scenarios.filter(s => s.name === scenarioFilter) : scenarios;
  if (selected.length === 0) throw new Error(`no scenario named ${scenarioFilter}`);

  mkdirSync(out, { recursive: true });
  const metricsPath = join(out, "metrics.jsonl");
  writeFileSync(metricsPath, "");

  const records: RunRecord[] = [];
  for (const scenario of selected) {
    for (let run = 1; run <= runs; run++) {
      const dir = buildStarter(repoRoot);
      try {
        scenario.setup(dir);
        const { stdout, wallMs } = await spawnAgent(agent, dir, scenario.task, scenario.name);
        const metrics = parseStream(stdout, wallMs);
        const result = await scenario.check(dir);
        const record: RunRecord = {
          scenario: scenario.name, run, success: result.ok,
          filesRead: metrics.filesRead, failedCommands: metrics.failedCommands,
          toolCalls: metrics.toolCalls, durationMs: metrics.durationMs,
          costUsd: metrics.costUsd, turns: metrics.turns,
          ...(result.ok ? {} : { checkFailure: result.reason }),
        };
        records.push(record);
        appendFileSync(metricsPath, `${JSON.stringify(record)}\n`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  const rows = selected.map(scenario => {
    const own = records.filter(r => r.scenario === scenario.name);
    const successes = own.filter(r => r.success).length;
    const cost = medianCost(own.map(r => r.costUsd));
    return `| ${scenario.name} | ${own.length} | ${successes}/${own.length} | ${median(own.map(r => r.filesRead))} | ${median(own.map(r => r.failedCommands))} | ${median(own.map(r => r.durationMs))} | ${cost === null ? "n/a" : cost} |`;
  });
  const table = [
    "| scenario | runs | success | median files read | median failed commands | median duration (ms) | median cost (USD) |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");

  return { records, table, ok: records.every(r => r.success) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { table, ok } = await runBattery(process.argv.slice(2));
  console.log(table);
  if (!ok) process.exitCode = 1;
}
