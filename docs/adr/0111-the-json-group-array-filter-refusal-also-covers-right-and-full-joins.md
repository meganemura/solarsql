# ADR 0111: The json_group_array filter refusal also covers RIGHT and FULL joins

Status: accepted (2026-09-15)

## Context

ADR 0011's Decision names only a `LEFT JOIN`: "the build step rejects a `json_group_array` over a `LEFT JOIN` that has no `filter` clause." A `RIGHT JOIN` and a `FULL JOIN` put a parent row's json_group_array in exactly the same situation: a parent with no matching child rows still produces one row from the join, with every child column NULL, so an unfiltered array gets one null element instead of staying empty.

`Typer.jsonArrayType` (`src/build/typegen.ts`), the code the refusal lives in, already took its outer-join aliases from `context.nullable`, a set `Typer.sourceContext` builds by walking `LEFT`, `RIGHT`, and `FULL` syntactically from the SQL text. A plain `SELECT` with a `json_group_array` over a RIGHT or FULL join's null-producing side already reached this refusal, correctly, before this record and before the fix this ADR accompanies.

One caller did not go through `sourceContext`. `Typer.nestedJsonType`'s "detached" branch — a one-to-many nested inside another one-to-many, `json((select json_group_array(...) from child where child.parent_id = outer.id))`, reachable only when RETURNING carries the nested value — took its outer-join aliases from `Engine.nullableAliases` (`src/build/facts.ts`) instead. That method reads `EXPLAIN QUERY PLAN`'s output text for the literal string `LEFT-JOIN`; a RIGHT or FULL join produces its own plan node text, which the method's regex never matched, so it always returned an alias as not-nullable for those two join kinds. A RETURNING statement with a nested one-to-many array over a RIGHT or FULL join's null-producing side therefore both skipped the filter refusal and, when a filter was present anyway, mistyped a NOT NULL child column as never-null, when an orphan parent row would in fact produce a null element.

The fix accompanying this ADR makes the detached branch call `sourceContext` too, the same syntactic join walk the already-correct plain-`SELECT` path uses, so both paths now compute outer-join aliases the same way.

## Decision

A `json_group_array` with no `filter` clause over an alias on the null-producing side of a `LEFT JOIN`, a `RIGHT JOIN`, or a `FULL JOIN` is refused, with the same message ADR 0011 already gives for `LEFT JOIN`: add a filter such as `filter (where l.id is not null)`. This applies uniformly to a `json_group_array` at any nesting depth, including one reached only through a statement's RETURNING clause.

## Why

The reason ADR 0011 gives for `LEFT JOIN` — a parent with no matching children gets an array with one null element instead of an empty array — holds identically for `RIGHT JOIN` and `FULL JOIN`: any join kind that can produce a row where the child side is entirely NULL puts `json_group_array` in the same situation, regardless of which side of the join clause the child table's name appears on.

## Consequences

- `RIGHT JOIN` and `FULL JOIN` now give the same "needs a filter" refusal `LEFT JOIN` already gave, for a `json_group_array` reached directly from a SELECT scope or through RETURNING's nested-JSON path alike.
- With a filter present, a NOT NULL child column referenced inside the array's elements types as never-null, matching the type a plain SELECT with the equivalent join already gave.
- `Engine.nullableAliases` (`src/build/facts.ts`) keeps its narrower, LEFT-only reach; nothing in `src/build` calls it any longer, and its doc comment says so. `Typer.sourceContext` is now the one place outer-join nullability is computed, for every caller.
