# ADR 0006: A command is a verb on a noun, and its body is a plan

Status: accepted (2026-09-06). Since ADR 0033 the commands live in the module's one source file, `module.ts`, next to the queries.

## Context

D1 has no interactive transaction.
A batch is a list of statements that the caller assembles before the first one runs.
The result of statement one cannot become an argument of statement two.
A Durable Object runs SQL synchronously inside one `transactionSync()` call.

## Decision

A command is a verb on a noun, for example `orders.confirm`.
The body of a command is a plan: a list of statements, asserts, and a `returns` clause.
A plan is data.
On D1 the plan becomes one `batch()` call.
On a Durable Object the plan becomes one `transactionSync()` call.
The engine is set in the project configuration.
The `verbs()` type accepts `plan` on D1, and `plan` or `run(tx)` on a Durable Object.

## Why

A plan that fits a D1 batch also fits a Durable Object transaction.
One model covers both targets.
Decisions inside a command live in SQL predicates and in asserts, because a batch cannot branch.
Ids are made on the client (ADR 0016), so an insert never waits for a generated key.

## Evidence (v0)

A false assert makes the whole D1 batch roll back on the local D1 engine.
The error message carries the assert name.
See ADR 0015 and v0-measurements.md, section 1.

## Consequences

- A command cannot read a value in one statement and use it in the next. It writes the condition into SQL.
- The `run(tx)` form exists only on Durable Objects. Code that uses it does not run on D1.
