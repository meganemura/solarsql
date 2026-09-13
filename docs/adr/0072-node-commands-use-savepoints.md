# ADR 0072: Node commands use savepoints

Status: accepted (2026-09-13)

## Context

The Node adapter receives a connection owned by its caller.
A caller may already have a transaction that combines direct SQL and typed commands.
Starting another BEGIN prevented that composition.

## Decision

Use a SQLite savepoint for each synchronous Node transaction callback.
Release it after success; roll back to it and release it after failure.
An outermost release commits, while a nested release leaves the caller's transaction open.
Repeated savepoint names resolve to the innermost savepoint and therefore support nested callbacks.

Preserve the original exception when rollback succeeds.
If savepoint cleanup also fails, retain both errors in an AggregateError with the original failure as its cause.
Public command handling propagates that aggregate instead of converting its cause to an ordinary constraint failure.
The callback must stay synchronous and must not end its enclosing transaction.

## Evidence

Public commands compose with direct SQL under caller-controlled COMMIT and ROLLBACK.
A command constraint failure leaves prior outer work intact.
Tests cover nested callback failures, successful nested writes followed by outer rollback, matching savepoint names, and deferred foreign-key failures.
Hegel varies inner failures, outer failures, and stored values, then compares the retained rows with the expected successful writes.

## Boundary

The outer caller owns its final commit and any deferred constraints checked there.
A command can succeed within that transaction before the outer commit is attempted.
SQLite transaction-ending conflicts, such as INSERT OR ROLLBACK, can also roll back earlier caller writes and remove the savepoint.
That failure throws the aggregate cleanup error; callers must not treat it as an isolated command rejection.
This change concerns the Node shim; D1 continues to use its batch API.
