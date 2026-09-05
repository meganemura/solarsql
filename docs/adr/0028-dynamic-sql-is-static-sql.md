# ADR 0028: Dynamic SQL is static SQL with typed parameters

Status: accepted (2026-09-06)

## Context

ADR 0021 made SQL a plain string literal and removed interpolation.
Other libraries offer fragments and `IN` helpers for four needs: an optional filter, a list of values, a sort column chosen at run time, and paging.
D1 binds at most 100 values per statement, so a list of 101 placeholders fails there.

## Decision

Each need is one static statement with a typed parameter:

| Need | Idiom | Parameter type |
|---|---|---|
| A list of values | `col in (select value from json_each(:ids))` | `readonly T[]`, T the type of `col` |
| Many rows in one statement | `insert into t (a, b) select value ->> 'a', value ->> 'b' from json_each(:rows)` | `readonly { a: A; b: B }[]` |
| An optional filter | `(:status is null or status = :status)` | `T \| null` |
| A sort column | `order by case :sort when 'id' then id when 'name' then name end` | `"id" \| "name"` |
| Paging | `limit :limit offset :offset` | `number` |

The build reads each idiom from the text and types the parameter.
The adapter encodes an array parameter as JSON text.
The build reports a statement whose plan reads a table in full despite a `WHERE`, because the optional-filter idiom disables the index on that column.
Fragments and interpolation stay out.

## Why

One statement per query keeps every type keyed by the text (ADR 0021) and keeps one prepared statement per query.
`json_each` takes one bound value for any list length, and the engine uses the index on `col`.
The full-scan report gives the agent the fact it needs to split a query when the table is large.

## Evidence (v2)

On the local D1 engine, 101 placeholders fail with `too many SQL variables`, and one `json_each` parameter returns 200 rows and accepts 5000 ids.
On node:sqlite with 5000 rows, the `json_each` list runs as fast as 200 placeholders and uses the primary key index.
The optional-filter idiom scans the table and runs five times slower than the static query on the same rows.
See v2-measurements.md, section 1.

## Consequences

- An agent writes `:ids` and passes an array. The 100-value limit of D1 is gone from its concerns.
- A query with an optional filter on a large table is two named queries instead, and the build output says which query scans.
- A sort direction cannot be a parameter. A query with `desc` is a second named query.
