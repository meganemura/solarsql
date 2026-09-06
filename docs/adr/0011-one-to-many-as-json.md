# ADR 0011: One-to-many reads are JSON aggregation in the SQL

Status: accepted (2026-09-06)

## Context

A one-to-many read needs the parent row and its child rows in one result.
An ORM hides this behind lazy loading or a second query.
ADR 0002 forbids code that the calling line does not show.

## Decision

A one-to-many read writes the aggregation in SQL:

```sql
coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty))
  filter (where l.id is not null), '[]') as lines
```

The build step rejects a `json_group_array` over a `LEFT JOIN` that has no `filter` clause.

## Why

The SQL that the agent writes is the SQL that runs.
The type of the column comes from the SQL alone (ADR 0010).
Without the `filter`, a parent with no children gets an array with one null object.

## Evidence (v0)

A scanner finds the `json_object` pairs without an AST.
A probe query selects each value expression as a top-level column, and `columns()` gives its origin.
The engine converts TEXT to a JSON string, INTEGER and REAL to a JSON number, and NULL to JSON null.
The derived type for the example is `Array<{ id: string | null; qty: number; price: number | null; total: number | null }>`.
The `null` on `id` comes from SQLite itself, see ADR 0018.
See v0-measurements.md, section 3.

## Consequences

- A nested value that is an expression needs a CAST (ADR 0017).
- A one-to-many inside the array is `json((select json_group_array(...) from child where child.parent_id = outer.id))`, typed since v4. The `json()` is required: a subquery's text carries no JSON subtype, so without it the inner array nests as a string.
- The library parses the JSON text into the typed array at the driver boundary.
