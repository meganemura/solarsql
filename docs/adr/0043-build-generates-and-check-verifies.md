# ADR 0043: Build generates, and check verifies

Status: accepted (2026-09-13). Supersedes the build exit behavior in [ADR 0026](0026-migration-on-demand.md).

## Context

A schema edit can produce valid generated types while its migration remains pending or blocked.
Previously, the build wrote those types and then exited 1 for the migration status.
An agent could treat generation as failed or skip a migration chained with `&&`.

## Decision

`solarsql build` exits 0 after valid generation, including when a migration is pending or blocked.
It reports the migration status and the action required.
Invalid schema, SQL, or module boundaries still fail the build.

`solarsql build --check` writes nothing.
It exits 1 for stale generated files, a stale migration bundle, or pending or blocked migrations.
`solarsql migration <name>` remains the explicit command that writes a migration; a blocked migration makes that command fail.
Recovery commands preserve a custom configuration path.

## Why

The exit code tells an agent whether the requested operation succeeded.
Generation supports edits before the migration is final; the check verifies that the files agree before delivery.

## Consequences

A successful build does not establish that a change is ready to deploy.
After the migration is complete, run `build --check`, the TypeScript check, and the project's tests.
Changed SQL text invalidates its generated type entry.
A DDL edit can leave SQL text unchanged, so TypeScript can accept stale types; the build check detects them.
CI and release gates must use `build --check`.
