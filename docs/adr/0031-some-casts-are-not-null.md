# ADR 0031: A CAST over a shape that is never null is not null

Status: accepted (2026-09-06). Narrows the last consequence of ADR 0017.

## Context

ADR 0017 makes an expression column carry a CAST, and gives every such column the type `T | null`.
Some expressions never yield null: `count(*)` over an empty set is 0, `exists (...)` is 0 or 1, `row_number()` starts at 1, and `coalesce(x, 0)` ends in a value.
A reader of `orders: number | null` writes a null check that no row needs.

## Decision

The build drops `| null` from a CAST when the whole expression inside it is one of these shapes:

- `count(...)`, `total(...)`, `row_number()`, `rank()`, `dense_rank()`, `ntile(...)`, with an optional `filter (...)` and `over (...)` after the call;
- `exists (...)` and `not exists (...)`;
- `coalesce(...)` or `ifnull(...)` whose last argument is a literal, or a column that is NOT NULL and not on the outer side of a join.

Every other expression keeps `| null`: `sum(...)`, `max(...)`, a division, a CASE, a subquery.
The same rule applies to a value inside `json_object`.

## Why

The list holds the shapes whose result the engine defines for every input, so the type is sound without a table of function return types.
A shape outside the list is nullable in some case that the text does not show, and `| null` stays the honest type.

## Consequences

- `cast(count(*) as integer) as n` is `number`. A report that wants an optional count writes `sum`, or reads the null it gets.
- The call must be the whole expression. `cast(count(*) / nullif(x, 0) as integer)` stays `number | null`.
- The list is closed. A new shape enters through a new ADR.
