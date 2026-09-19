#!/usr/bin/env node
// Responsibility: the battery's command. For each scenario and run, build a
// fresh starter, break it, spawn the agent command with the task on stdin,
// parse its event stream, check the repair, and append one metrics line.
// Also writes the run's raw stream and a diff of what the agent changed, so
// a reader can see where the turns went instead of only the four numbers.
// Prints a markdown table at the end and exits 1 when any run failed.
// Boundary: this file owns process orchestration and reporting; scenarios.ts
// owns what breaks and what passes, metrics.ts owns the stream shape.
//
// node spike/13-agent-battery/run.ts --agent "<command>" [--scenario <name>] [--runs <n>] [--out <dir>]
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios, type Scenario } from "./scenarios.ts";
import { buildStarter, finalizeStarter } from "./starter.ts";
import { buildScaleStarter } from "./scale-project.ts";
import { parseStream, countHunksOutsideTask } from "./metrics.ts";

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
  filesEdited: number;
  failedCommands: number;
  toolCalls: number;
  durationMs: number;
  costUsd: number | null;
  turns: number | null;
  hunksOutsideTask: number;
  streamPath: string;
  diffPath: string;
  checkFailure?: string;
};

// A diff of the agent's own dir against a second starter that had the same
// scenario.setup applied (not the repository's own example/ directly),
// since setup already differs from the repository copy and diffing straight
// against it would mix the scenario's own break into what the agent
// changed. git diff --no-index works on two plain directories outside a
// repository and exits 1 (not an error) when they differ.
function diffAgainstPristine(pristineDir: string, dir: string, projectDirName: string): string {
  const result = spawnSync("git", ["diff", "--no-index", "--", join(pristineDir, projectDirName), join(dir, projectDirName)], { encoding: "utf8" });
  return (result.stdout ?? "") + (result.stderr ?? "");
}

// "example" scenarios build their starter as a copy of example/; "scale"
// scenarios build it as spike/12-build-scale.ts's generated project, once
// per module (arm "owned") or once concatenated into one module (arm
// "flat") -- scale-project.ts's buildScaleStarter, which this file does not
// duplicate.
function projectDirName(scenario: Scenario): string {
  return scenario.project === "scale" ? "scale" : "example";
}
async function buildStarterFor(scenario: Scenario, repoRoot: string): Promise<string> {
  return scenario.project === "scale" ? buildScaleStarter(repoRoot, scenario.arm!) : buildStarter(repoRoot);
}

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
      const dir = await buildStarterFor(scenario, repoRoot);
      const pristineDir = await buildStarterFor(scenario, repoRoot);
      try {
        scenario.setup(dir);
        scenario.setup(pristineDir);
        // Only the starter the agent runs in needs its own git repository
        // and smoke test (starter.ts's finalizeStarter); pristineDir is
        // never touched by an agent, only diffed against.
        finalizeStarter(dir);
        const { stdout, wallMs } = await spawnAgent(agent, dir, scenario.task, scenario.name);
        const streamPath = join(out, `${scenario.name}-${run}.stream.jsonl`);
        writeFileSync(streamPath, stdout);
        const metrics = parseStream(stdout, wallMs);
        const result = await scenario.check(dir);
        const diffPath = join(out, `${scenario.name}-${run}.diff`);
        const diffText = diffAgainstPristine(pristineDir, dir, projectDirName(scenario));
        writeFileSync(diffPath, diffText);
        const record: RunRecord = {
          scenario: scenario.name, run, success: result.ok,
          filesRead: metrics.filesRead, filesEdited: metrics.filesEdited, failedCommands: metrics.failedCommands,
          toolCalls: metrics.toolCalls, durationMs: metrics.durationMs,
          costUsd: metrics.costUsd, turns: metrics.turns,
          hunksOutsideTask: countHunksOutsideTask(diffText, scenario.taskTables, scenario.knownTables),
          streamPath, diffPath,
          ...(result.ok ? {} : { checkFailure: result.reason }),
        };
        records.push(record);
        appendFileSync(metricsPath, `${JSON.stringify(record)}\n`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(pristineDir, { recursive: true, force: true });
      }
    }
  }

  const rows = selected.map(scenario => {
    const own = records.filter(r => r.scenario === scenario.name);
    const successes = own.filter(r => r.success).length;
    const cost = medianCost(own.map(r => r.costUsd));
    return `| ${scenario.name} | ${own.length} | ${successes}/${own.length} | ${median(own.map(r => r.filesRead))} | ${median(own.map(r => r.filesEdited))} | ${median(own.map(r => r.failedCommands))} | ${median(own.map(r => r.hunksOutsideTask))} | ${median(own.map(r => r.durationMs))} | ${cost === null ? "n/a" : cost} |`;
  });
  const table = [
    "| scenario | runs | success | median files read | median files edited | median failed commands | median hunks outside task | median duration (ms) | median cost (USD) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");

  return { records, table, ok: records.every(r => r.success) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { table, ok } = await runBattery(process.argv.slice(2));
  console.log(table);
  if (!ok) process.exitCode = 1;
}
