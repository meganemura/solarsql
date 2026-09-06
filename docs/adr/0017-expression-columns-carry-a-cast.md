# ADR 0017: An expression column carries a CAST

Status: accepted (2026-09-06). ADR 0031 narrows the last consequence: a CAST over count, exists, a ranking function, or coalesce with a literal is not null.

## Context

`columns()` returns no type for an expression: a function call, an operator, a literal, or an aggregate.
`CREATE TABLE ... AS SELECT` gives such a column an empty declared type.
Only `CAST(expr AS type)` gives an expression a declared type through that path.

## Decision

A result column that is an expression must be wrapped in `CAST(... AS integer | real | text)`.
The build step reports a column with no type as an error.
The same rule applies to a value inside `json_object` (ADR 0011).

## Why

A CAST is real SQL, so the engine enforces the meaning at run time.
One rule covers every function, so the library needs no table of function return types.

## Evidence (v0)

`cast(count(l.id) as integer)` gets the declared type `INT` through `CREATE TEMP TABLE ... AS ... LIMIT 0`.
`count(l.id)` without a cast gets an empty type.
See v0-measurements.md, section 3.

## Consequences

- Queries are a little longer.
- In v0 the type of an expression column includes `null`. A later ADR can narrow it.
