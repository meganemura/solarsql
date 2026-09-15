# ADR 0105: A CAST around a bare NOT NULL column reference is not null

Status: accepted (2026-09-15). Adds one shape to ADR 0031's list.

## Context

Commit `d0782dc` ("Type a CAST around a bare NOT NULL column as non-null") widened `castNeverNull` (`src/build/typegen.ts`) to drop `| null` from `cast(<bare column> as T)` when the referenced column is declared NOT NULL. That commit landed before this record existed. ADR 0031's Consequences state its shape list is closed: "A new shape enters through a new ADR." ADR 0100's Consequences named this exact widening in advance, as "a separate decision affecting every caller, not part of this one." This ADR is that decision, written after the code shipped, not before it.

Measured directly: `select cast(l.qty as text) as t from orders o left join order_lines l on l.order_id = o.id`, where `order_lines.qty` is declared NOT NULL, types `t` as `string | null`. The outer-join case keeps the nullable type, the same exception ADR 0031 already applies to `coalesce`'s and `ifnull`'s last argument.

## Decision

`castNeverNull` drops `| null` from `cast(expr as T)` when the whole of `expr` is one column reference (bare, or `<alias>.<column>`) and that column is declared NOT NULL and not on the outer side of a join — the same qualifier ADR 0031 already applies to `coalesce`'s and `ifnull`'s last argument.

## Why

The same reasoning as ADR 0031: the table's own NOT NULL declaration proves the value for every row the column reference reaches, so the type is sound without a new inference rule, and it does not need a table of function return types the way a call expression would.

## Consequences

- `cast(qty as text)`, where `qty` is declared NOT NULL, types `string`, not `string | null`.
- The outer side of a join keeps `| null`: `select cast(l.qty as text) as t from orders o left join order_lines l on l.order_id = o.id` types `string | null` even though `order_lines.qty` is declared NOT NULL, because a row with no match nulls the whole joined side.
- This adds one shape to ADR 0031's list. ADR 0031's own closed-list consequence continues to apply to the list as a whole: a further shape needs its own ADR.
