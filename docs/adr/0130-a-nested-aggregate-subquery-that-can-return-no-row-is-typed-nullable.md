# ADR 0130: A nested aggregate subquery that can return no row is typed nullable

Status: accepted (2026-09-25)

## Context

`json((select json_group_array(...) from child where child.parent_id = outer.id))` types the array as non-null in every case, even one where the subquery has no row. Measured on node:sqlite 3.53.4 with an order `o1` that has lines and an order `o2` that has none, every variant of `json((select json_group_array(json_object('id', l.id)) from order_lines l where l.order_id = o.id <clause>))` typed `lines: Array<{ "id": string }>`: `group by l.order_id`, `having count(*) > 0`, and `json_group_array(...) over ()` each gave `null` for `o2`; `limit 0` gave `null` for every parent; `limit 1 offset 1` gave `null` for every parent, since the aggregate yields one row and OFFSET >= 1 skips it; `limit 2` over three lines returned all three, since LIMIT n >= 1 is a no-op on a one-row result; the plain form (no clause) genuinely returned `[]` for `o2` and matched its non-null type. End to end through `queries()` and `node()`, the GROUP BY case decoded to `{"id":"o2","lines":null}`, `tsc --strict` accepted `o.lines.length`, and the run threw `TypeError: Cannot read properties of null (reading 'length')`. The same SQL gives the same values on Miniflare D1 and a local Durable Object. This breaks ADR 0047's rule: a successful build must not encourage the caller to omit a required null check.

The object form of the same nesting, `json((select json_object(...) from child where ...))`, already types `| null` unconditionally (`Typer.nestedJsonType`, the object branch): a plain SELECT can return no row, so every object subquery gets the null check regardless of clauses. The array form needed the same treatment, but only when it applies: a plain `json_group_array(...)` subquery with no GROUP BY, HAVING, OVER, LIMIT, OFFSET, or compound operator always returns its own one aggregate row (possibly an empty array), so widening it to `| null` would fail `test/typegen.test.ts:399`'s and `test/shapes.test.ts:74`'s existing non-null pin for exactly that shape.

## Decision

`Typer` defines one predicate, `aggregateSelectShape`: a SELECT that calls an aggregate function (`min`/`max` count only in their one-argument form; the two-or-more-argument form is scalar, not aggregate) is `"one-row"` when its own top level carries none of GROUP BY, HAVING, OVER, LIMIT, OFFSET, or a compound operator; `"many-rows"` when GROUP BY, HAVING, OVER, or a compound operator is present, since each of those can make the aggregate return zero or more than one row; `"limited"` when the SELECT would otherwise be `"one-row"` but carries LIMIT or OFFSET, since a LIMIT/OFFSET on a query that already returns exactly one row has no rows left to limit other than that one.

`nestedJsonType`'s array branch (`json_group_array`, both the scoped branch a plain SELECT reaches and the detached branch RETURNING reaches) types the array `Array<T> | null` unless the subquery is `"one-row"`, in which case it stays `Array<T>`, matching the existing pinned non-null cases. A `"limited"` subquery is refused instead of typed: `LIMIT/OFFSET applies to the one aggregate row, not to the child rows.` The message names the fix, measured to build non-null and return at most n children and `[]` for an empty parent: an IN-subquery over the child's own primary key, ordered and capped there, correlated the same way the outer subquery was:

```sql
json((select json_group_array(json_object('id', l.id) order by l.id)
      from order_lines l
      where l.id in (select l2.id from order_lines l2 where l2.order_id = o.id order by l2.id limit :n)))
```

The build already refuses the more obvious derived-table form, `from (select ... where l.order_id = o.id limit :n) x`, with `no such column: o.id` (a correlated reference cannot cross a derived table's own FROM boundary); SQLite itself runs that form, so the message does not offer it.

## Consequences

- A `json_group_array` subquery under GROUP BY, HAVING, or OVER now types `| null`, matching the runtime value for an empty child set; a caller that reads `.length` off it without a null check now fails `tsc --strict` instead of the database.
- A `json_group_array` subquery under LIMIT or OFFSET now fails the build instead of silently returning a non-null type that only holds for a subset of rows.
- The plain form's existing non-null pin (`test/typegen.test.ts:399`, `test/shapes.test.ts:74`, `test/nested-json.test.ts:9`) is unchanged: a plain aggregate subquery still returns its own one row, so the array stays non-null.
- `aggregateSelectShape` is written as a general predicate over any aggregate SELECT, not only the `json_group_array` shape this ADR covers, so a future top-level one-row aggregate subquery (outside `json(...)`) can reuse it instead of a second definition.
- `skills/solarsql/references/build.md`'s table and `queries.md`'s nested-result row carry the refusal message and the null rule, so an agent that hits either reads the fix without opening this ADR.
