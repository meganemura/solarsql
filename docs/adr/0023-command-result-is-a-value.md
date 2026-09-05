# ADR 0023: A command result is a value

Status: accepted (2026-09-06)

## Context

An assert that yields 0 is a normal outcome of a command: the order had no lines, the row was not a draft.
An exception is control flow that the calling line does not show (ADR 0002).

## Decision

`db.run(command, params)` returns `{ ok: true, rows } | { ok: false, assert: "<name>" }`.
The assert names of a command form the union type of `assert`.
Any other engine error, a unique violation for example, is thrown as it is.

## Why

The caller sees every outcome in the type of the result.
A `switch` on `assert` is exhaustive, and a new assert in the plan makes `tsc` report the branch that is missing.

## Evidence (v1)

On D1 and on a Durable Object, a second `confirm` of the same order returns `{ ok: false, assert: "was_draft" }` and leaves the row as it was (`test/example.test.ts`).

## Consequences

- The adapter recognizes the guard trigger by `SQLITE_CONSTRAINT_TRIGGER` and the assert name at the start of the message.
- A constraint the DDL enforces (ADR 0012) stays an exception. A command that wants it as a value adds an assert before the statement.
