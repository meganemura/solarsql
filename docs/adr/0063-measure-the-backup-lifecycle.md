# ADR 0063: Measure the backup lifecycle before changing it

Status: accepted (2026-09-13)

## Context

Some complete test runs showed long rehearsal times, while isolated runs completed quickly.
A yield after backup completion did not establish a cause or a reliable correction.

## Decision

Keep SQLite backup and remove the speculative yield after its promise resolves.
Node's backup implementation finishes the backup and closes its target before resolving that promise.
See the [Node 26.7.0 implementation](https://github.com/nodejs/node/blob/v26.7.0/src/node_sqlite.cc#L550-L574).

Use `node spike/11-backup-lifecycle.ts` to measure source opening, backup, source closure, copy opening, validation, and copy closure.
The experiment calls the production rehearsal function through an asynchronous Node test.
It repeats successful changes, incompatible queries, failed assertions, constraint errors, denied attachments, and transaction-control errors.
It checks both rollback-journal and WAL snapshots, source bytes, committed rows, and implicit row identities.
The `solarsql.rehearse` diagnostics channel emits a start event before each operation and an end event with elapsed milliseconds after completion.
The experiment subscribes to that channel and writes phase records.
An operation that throws can have a start event without an end event.
A parent process limits the experiment to 20 seconds.
The child uses the parent-owned temporary directory for its source fixtures and production snapshots, so the parent can remove both after timeout or completion.
The optional arguments set the iteration count and slow-phase threshold in milliseconds.
A slow phase, validation failure, or timeout produces exit 1.

## Evidence and limits

On Node 26.7.0, the initial isolated run completed 20 snapshots.
The maximum measured backup time was 31.58 milliseconds; the maximum validation time was 23.99 milliseconds.
The original rehearsal test file completed in about 1.2 seconds before the yield was removed.
A later production-path test took about 71 seconds.
Instrumentation reproduced waits of about 30.09 and 8.10 seconds inside `await backup`; validation and closure completed quickly afterward.
The bounded production-sequence experiment later timed out after 20 seconds, with its last event at the fourth rollback-journal backup.
The native backup wait is observed, but its cause remains unattributed. Removing the yield is not a claim that the delay is fixed.
A probe with a periodic timer completed sooner, so timer-free traces remain necessary to investigate scheduling without changing it.

If the delay returns, run the experiment alongside the affected workload and retain its JSON lines, runtime version, and process timeout result.
The last phase start and completed timings distinguish a backup wait from validation or connection closure.
The [Node backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options) defines batch size and reports page progress; it does not provide a cancellation option.
The experiment's process timeout supplies that diagnostic boundary without changing production snapshot semantics.
