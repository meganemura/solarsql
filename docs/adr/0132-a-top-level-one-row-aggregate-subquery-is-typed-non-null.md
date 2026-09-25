# ADR 0132: A top-level one-row aggregate subquery is typed non-null

Status: accepted (2026-09-25). Narrows ADR 0048's rule that "a scalar subquery adds nullability because it can return no row" (0048:22). Reuses `aggregateSelectShape`, defined by ADR 0130 for the nested case.

## Context

Two one-to-many arrays on one parent, for example an order's lines and its events, need one correlated `json_group_array` subquery per child: a single `SELECT` with two `LEFT JOIN`s multiplies rows once a second child joins in. At the top level of a `SELECT`, that form had no clean typed spelling.

Measured on node:sqlite 3.53.4 with `orders`, `order_lines`, and `order_events(id, order_id, kind)`:

- `select o.id, json((select json_group_array(json_object('id', l.id, 'sku', l.sku)) from order_lines l where l.order_id = o.id)) as lines, json((select json_group_array(...) from order_events e where e.order_id = o.id)) as events from orders o where o.id = :id` was refused: `column "lines" is an expression with no type. Wrap it in cast(...)`. That remedy is wrong: a CAST turns off JSON decoding. `outputColumn` had no rule for a `json((select ...))` value at the top level; only `Typer.valueType`, reached from inside `json_object`/`json_group_array`, recognized that shape.
- Without the outer `json()`, the bare subquery built, but ADR 0048's blanket rule typed it `Array<...> | null` unconditionally, even though `json_group_array` over zero rows returns `'[]'`, never SQL `NULL`, so the type never matched the value.
- `(select cast(count(*) as integer) from order_lines l where l.order_id = o.id)` was typed `number | null` and returned `0`, for the same reason: every scalar subquery got the blanket nullability, regardless of whether its own aggregate could be `NULL`.
- The only non-null spelling put both arrays in one `json_object` column, changing the row shape.

Miniflare D1 and a local Durable Object return the same values as node:sqlite for all of the above.

## Decision

Two call sites in `Typer` stop applying ADR 0048's blanket scalar-subquery nullability, and defer to `aggregateSelectShape` (ADR 0130) instead, when it proves the subquery returns exactly its own one aggregate row:

- `branchRows`' bare scalar-subquery item (`(select ...) as x`, with no `json()` wrapper) keeps the inner column's own nullability instead of unconditionally widening it with `| null`, when `aggregateSelectShape` reports `"one-row"`. A `"limited"` shape (LIMIT/OFFSET on an otherwise-one-row aggregate) is refused with the same message ADR 0130 defined, since both positions have the same remedy: an IN-subquery over the child's own primary key.
- `outputColumn`, for a top-level item, now also calls `nestedJsonType` (ADR 0130's own helper) before falling through to the CAST/affinity rule. `json((select json_group_array(...) ...))` and `json((select json_object(...) ...))` type the same way at the top level as they already did nested inside another `json_object`/`json_group_array`; anything else `nestedJsonType` does not recognize falls through unchanged, to the existing "expression with no type" refusal.

`aggregateSelectShape`'s own predicate, `isAggregateCall`, now sees through one outer CAST: a top-level aggregate scalar subquery needs `cast(... as integer)` to satisfy `outputColumn`'s "expression with no type" rule in the first place, so every practical example of this shape is `cast(count(*) as integer)`, not a bare call. CAST is already transparent to nullability elsewhere in this file (`castNeverNull`); this reuses the same idea for shape detection. Unwrapping the CAST can hide `OVER` one paren level deeper than `aggregateSelectShape`'s own top-level scan reaches, so `isAggregateCall` separately rejects a CAST-wrapped call followed by `OVER`.

`count(*)`, unlike `max(...)` and `sum(...)`, is in the existing `neverNullCalls` set that `castNeverNull` already consults, so `cast(count(*) as integer)` types non-null and `cast(max(l.qty) as integer)`/`cast(sum(l.qty) as integer)` stay `| null`: the one-row proof removes the subquery's own "can return no row" nullability, but does not remove the aggregate call's own nullability when the aggregate itself can be `NULL` for an empty group.

## Consequences

- A top-level `json((select json_group_array(...) ...))` column, and its bare (unwrapped) form, type non-null when the subquery is provably one-row, matching the value `json_group_array` actually returns for an empty child set.
- The same forms under GROUP BY, HAVING, or OVER still type `| null`, and under LIMIT/OFFSET are refused, the same rule ADR 0130 already applies to the nested case.
- `(select cast(count(*) as integer) ...)` types `number`; `(select cast(max(...) as integer) ...)` and `(select cast(sum(...) as integer) ...)` stay `number | null`.
- `cast((select count(*) ...) as integer)` (the CAST outside the subquery, ADR 0048's original shape, pinned at `test/shapes.test.ts`) is unchanged: `castNeverNull` does not treat a `select` as a bare column reference or a known never-null call, so it stays `number | null`.
- `queries.md:70` and `:101` and a two-sibling-array recipe are Agent A's file in this round; their text is in this task's report, not committed here.
