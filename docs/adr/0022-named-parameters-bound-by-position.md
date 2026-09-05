# ADR 0022: Named parameters, bound by position

Status: accepted (2026-09-06)

## Context

D1 `bind()` and the Durable Object `exec()` take positional values.
D1 rejects an object as a value with `D1_TYPE_ERROR`.
SQLite numbers a named parameter by its first appearance, and a repeated name keeps its number.

## Decision

SQL uses `:name`.
The build records the names in order of first appearance in the generated file.
The adapter binds the values in that order.
A `?` or `?NNN` parameter fails the build.

## Why

D1 accepts `:name` in the SQL text when the values arrive by position, so no rewrite of the text is needed.
An agent reads `:customer_id` and knows what to pass.
The build infers the type of `:name` from where it sits: a comparison with a column, a `SET`, or an `INSERT` column list.

## Evidence (v1)

On the local D1 engine, `select * from t where id = :id` with `bind("a")` returns the row, and `bind({ id: "a" })` fails.
See v1-measurements.md, section 2.

## Consequences

- A parameter the build cannot place has the type `SqlValue`. A typed use elsewhere in the same plan refines it.
- A missing value at run time is an error before the statement runs.
