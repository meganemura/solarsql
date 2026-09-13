# ADR 0059: Verify the SQL change workflow

Status: accepted (2026-09-13)

## Context

Individual inference tests do not establish that a caller can adopt existing SQL, repair a query, and assess a populated transition.
The generated artifact, CLI diagnostics, runtime adapter, and migration evidence must work together.

## Decision

A regression test follows a schema-only query from a simple list to a CTE and outer-join report.
It checks an invalid column diagnostic, stale output, regeneration, caller compilation, and runtime results against a direct SQLite driver.
It rehearses a nullable-column addition with stored rows, old queries, and data assertions.
It checks the same report after applying the migration.

Rehearsal rejects unknown check fields and malformed SQL maps.
A typo must not silently reduce the evidence behind a successful report.
The usage reference explains the same sequence and the limits of each check.

## Boundary

This evidence concerns local SQLite and this change sequence.
Miniflare adapter tests and opt-in remote tests establish separate target evidence.
Structural query compatibility does not prove preserved data meaning.
Applications supply assertions for their own invariants.
