# ADR 0062: Machine reports use a separate channel

Status: accepted (2026-09-13)

## Context

Configuration and module imports can write startup logs with console or process.stdout.
Those logs can make a successful inspection report invalid JSON.
An automated caller then loses both the contract and the repair diagnostics.

## Decision

Run `inspect` and `build --json` in a child process that sends its report through Node IPC.
Route application stdout and stderr to the CLI's stderr.
The parent emits one JSON document on stdout after the child closes.
Require one report whose success field agrees with the exit code.
A missing report, process failure, or premature exit produces `BUILD_WORKER_FAILED` with a repair action.
Wait for report transmission and stdout completion before exiting, including large reports.
Plain build output keeps its existing format.

## Boundary

Application imports retain their permissions and side effects.
The child process separates report transport; it is not a sandbox.
The CLI still exits after the build and does not wait for unrelated application timers.

## Evidence

CLI tests cover configuration and module logs, direct stdout writes, successful builds, stale output, invalid SQL, import exceptions, and premature exit.
A large error message crosses both the child channel and stdout without truncation.
