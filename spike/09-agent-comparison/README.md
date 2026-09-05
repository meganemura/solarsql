# 09: the same task, given to fresh agents, on solarsql and on Drizzle

The experiment behind section 1 of `docs/v3-measurements.md`.

Two starter projects share one schema, one Worker step contract, one
Miniflare harness, and one visible test file. One uses solarsql from the
packed tarball; the other uses `drizzle-orm@0.45.2` with the D1 driver.
A fresh agent gets `task.md` with the path of its own copy, adds a `cancel`
step, and stops. Hidden tests, the transcript, and the diff are read after.

## Files

- `build-starters.sh [work dir] [runs per arm]` builds both starters in a
  work directory, checks them (visible tests green, hidden tests red on
  both), and copies each starter once per run. Drizzle is installed in the
  work directory only.
- `task.md` is the task text; `{{DIR}}` is the run directory.
- `hidden/hidden.test.ts` is copied into a run after the agent is done.
- `collect.sh <work dir>` runs each agent's own checks and the hidden tests,
  and writes the diff of each run against its starter.
- `metrics.py <work dir> <transcripts dir>` counts tool calls, files read,
  build and check runs, and tokens from the agent transcripts.
- `results/<date>/` holds the metrics, the diffs, and the hidden test output
  of one execution.

## Running the agents

Each run is one agent with an empty context, the same model for both arms,
and the text of `runs/task-<arm>-<n>.md` as its whole prompt. The 2026-09-06
execution used Claude Sonnet 5 through the Agent tool of Claude Code, all
six runs at once. The transcripts of those runs are not in this repository;
`results/2026-09-06/metrics.jsonl` is what `metrics.py` read from them.

## Pre-registered metrics

Written before any run:

1. tool calls, total and by tool
2. distinct files read, and how many under node_modules
3. reads outside the run directory and web calls (violations, reported)
4. test runs and typecheck runs until done
5. hidden tests passed, of 6; with no cancel step, both arms pass 1
6. atomicity, from the diff: A = the precondition is inside the write
   (WHERE, or an assert in the same batch); B = a read in JS, then an
   unconditional write; C = a read in JS, then a conditional write.
   A and C are atomic.
7. output tokens and wall seconds, for cost
