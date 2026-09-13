# ADR 0089: Machine CLI reports have a time budget

Status: accepted (2026-09-14)

## Context

An agent can request `inspect` or `build --json` while a configuration import waits forever.
The report worker isolates stdout, but it previously gave the caller no completion boundary.
An automated caller then waited without a JSON result or a recovery action.

## Decision

Run each `inspect` and `build --json` report worker with a 30,000 millisecond deadline.
Accept `--timeout-ms` as an integer from 1 to 2147483647 to set another finite deadline.
Parse and remove that option in the parent before it starts the worker.
An invalid budget fails before configuration or module imports execute.

On expiry, the parent kills the worker and emits one JSON failure with code `BUILD_TIMEOUT`.
The diagnostic includes `timeoutMs` and tells the caller to inspect the import and build work before it uses a larger budget.
Application stdout and stderr remain on stderr.

## Boundary

The deadline applies to the report-worker process boundary.
It does not cancel an in-process build API, sandbox configuration code, or establish that the build can safely roll back application side effects.
Plain `build` keeps its existing process and output behavior.

## Evidence

Source and packed CLI tests cover default success, an explicit larger deadline, a bounded hanging configuration import, and invalid budgets.
The timeout tests assert one stdout JSON document, the `BUILD_TIMEOUT` code, the expired budget, and preserved import logs on stderr.
