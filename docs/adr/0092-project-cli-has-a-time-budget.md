# ADR 0092: Project-loading CLI commands have a time budget

Status: accepted (2026-09-14)

Supersedes: ADR 0089 for `build`, `build --check`, and `migration`.

## Context

Project configuration imports can wait forever.
ADR 0089 bounded the JSON report worker only.
The normal build, check, and migration commands imported project code in their parent process.

## Decision

Run `build`, `build --check`, and `migration` in a direct worker.
Give the worker a 30,000 millisecond deadline by default.
Accept `--timeout-ms` as an integer from 1 to 2147483647.
The parent parses every command option and the deadline before project code loads.

The worker retains the normal stdout, stderr, exit codes, and successful writes.
When a deadline expires, the parent stops its direct worker and writes one error with the expired budget and a recovery action.
The error does not describe application-owned child processes.

Write each generated file and each `migrations/index.ts` replacement through a sibling temporary file and an atomic rename.
Before a migration worker creates its lock, it announces the candidate lock path to the parent and waits for an acknowledgement.
The worker captures this private control channel before project imports execute.
The parent records only the first accepted announcement for that worker.
After a timed-out migration, inspect the migration directory before reuse.
If `.solarsql-generation.lock` remains, inspect it and remove it only after the worker has stopped.

## Boundary

The deadline does not roll back application side effects.
It does not prove the current state of a migration output after an interrupted write.
The generated-file replacement prevents a partly written generated file or migration index.
The lock protocol protects the parent report from application code that replaces `process.send`.

## Evidence

Source and packed CLI tests cover successful default and explicit deadlines.
They cover invalid deadlines before imports and a hanging import.
They also stop a worker after a generated-file or migration-index replacement starts.
Those checks prove that each destination retains complete old contents while its sibling temporary file has complete new contents.
The migration check retains a lock and verifies its exact path and recovery text.
It also replaces `process.send` during project import.
It observes the acknowledgement and sends a later forged announcement.
