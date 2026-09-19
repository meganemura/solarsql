# Agent battery

Nothing measures agent outcomes today. This battery gives a fresh agent a broken project and one task, then measures: repair success, files read, failed commands, and wall time to a passing `build --check`.

Five scenarios, each in `scenarios.ts`: an invalid column in a query, a query edited without a rebuild, a column added to the schema only, a write into another module's table from the wrong module, and a column rename declared without its migration intent. Each `setup` breaks a fresh copy of `example/`, states one task, and `check` verifies the repair against the library's own rules (`build --check`, `npx tsc --noEmit`, and the scenario's own shape).

`starter.ts` builds the fresh copy: `test/copy-example.ts`'s `copyExample`, with the skill at `.claude/skills/solarsql/` (where a Claude Code agent looks for it) and the same three-sentence project note in both `AGENTS.md` and `CLAUDE.md` (Claude Code reads `CLAUDE.md`, not `AGENTS.md`). Two `node_modules/.bin` shims (`solarsql`, `tsc`) forward to this repository's own source, so `npx solarsql build` and `npx tsc --noEmit` -- the commands the skill and the build's own "next:" line name -- resolve inside the starter with no network install.

Metrics come from the agent CLI's own event stream (`--output-format stream-json`), not from file-system watching: the same source for every agent, needing no OS support. `metrics.ts` is the only file that knows that shape; a different agent CLI needs only a new parser with the same `Metrics` return type. Reads count a distinct `Read` `file_path`, plus one for each `Glob` or `Grep` call; failed commands count every `tool_result` with `is_error: true`; cost and turns come from the stream's final `result` line (`total_cost_usd`, `num_turns`), `null` when the agent does not report them.

## Running with the stub

`stub-agent.ts` is a scripted fixer, not a model. Its purpose is to prove the harness: setup breaks the project, and the check catches a wrong fix (`SOLARSQL_BATTERY_SKIP_FIX=1` makes it apply no fix; the run then reports `success: false` with a `checkFailure` string).

```
node spike/13-agent-battery/run.ts --agent "node spike/13-agent-battery/stub-agent.ts" --out .scratch/battery-out
```

`test/slow/agent-battery.test.ts` runs this over all five scenarios and pins the stub's `filesRead` and `failedCommands` per scenario, since the stub's fix is scripted and so is what it reads and runs.

## Running with Claude Code

```
node spike/13-agent-battery/run.ts --agent "claude -p --model sonnet --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Edit,Write,Bash,Glob,Grep --setting-sources project" --out .scratch/battery-out
```

This runs a paid model, once per scenario per `--runs`; vary `--model` to compare models. The owner starts it, not an agent working in this repository. `--setting-sources project` matters: without it, a headless run also loads the operator's own `~/.claude` hooks and instructions into the agent under test, not just the starter's own `CLAUDE.md`.

## Options

```
node spike/13-agent-battery/run.ts --agent "<command>" [--scenario <name>] [--runs <n>] [--out <dir>]
```

`--out` gets `metrics.jsonl` (one JSON line per run, with `costUsd` and `turns` alongside the other fields) and, on stdout, a markdown table of scenario, runs, success, median files read, median failed commands, median duration, and median cost (USD). The command exits 1 when any run failed.

Each run also gets two files, named on its `metrics.jsonl` line as `streamPath` and `diffPath`: `<scenario>-<run>.stream.jsonl` is the agent's raw stdout, saved before it is parsed, and `<scenario>-<run>.diff` is a `git diff --no-index` of the agent's finished `example/` directory against a second starter built with the same `scenario.setup` (not the repository's own `example/`, since `setup` already differs from it -- diffing straight against the repository would mix the scenario's own break into what the agent changed). Together they answer why one scenario cost more tool calls than another, which the four counted numbers alone cannot.

```
node spike/13-agent-battery/summarize.ts <out>/<scenario>-<run>.stream.jsonl
```

Prints one line per tool call, in the order the agent made it: the tool name, its main argument (`file_path`, `command`, or `pattern`, truncated to 120 characters), and `FAILED` when the matching `tool_result` reported an error -- then the agent's own final result text.

## Results

`docs/v5-measurements.md` gets the first real run's table, appended to the numbers `spike/12-build-scale.ts` already put there. This spike does not write that file.
