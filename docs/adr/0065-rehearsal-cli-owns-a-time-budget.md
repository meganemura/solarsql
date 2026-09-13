# ADR 0065: The rehearsal CLI owns a time budget

Status: accepted (2026-09-13)

## Context

A native SQLite backup or statement can outlast an automated verification budget.
The backup promise does not expose cancellation, and a blocked native call cannot run a JavaScript timeout handler in its own process.
ADR 0063 records a reproduced backup wait and a bounded diagnostic experiment.

## Decision

Run the rehearsal CLI in a child process with a 30,000 millisecond default deadline.
Accept `--timeout-ms` as an integer from 1 to 2147483647 to set a different finite budget.
The deadline includes child startup, snapshot creation, and validation.
The parent kills the child when the deadline expires and waits for its closure.
It then removes the temporary root before emitting one JSON report with exit 1 and `REHEARSAL_TIMEOUT`.
The diagnostic tells the caller to inspect the workload and use a larger budget when appropriate.

The parent owns the worker's temporary directory, including every snapshot.
Normal success and failure also remove that directory before reporting.
The source remains a read-only input; committed WAL data participates in the snapshot.
Invalid budgets fail before the worker starts.

## Boundary

The deadline applies to the CLI process boundary.
The in-process `rehearse` API still awaits native backup and does not claim cancellation.
A timeout does not establish that the proposed SQL is invalid or that the native wait has been fixed.

## Evidence

A test starts an infinite recursive SQLite statement and observes entry into native validation before the deadline kills it.
The parent returns one timeout report, removes its snapshots, and retains the source database, WAL bytes, and row identity.
Other cases cover normal success, an explicit larger budget, SQL failure, and invalid budgets.
