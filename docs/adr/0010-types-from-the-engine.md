# ADR 0010: Types come from the real engine, keyed by the SQL text

Status: accepted (2026-09-06)

## Context

A type written by hand drifts from the SQL.
An agent forgets to run the build.
A stale type that still compiles is a silent error.

## Decision

Row types come from node:sqlite at build time.
`StatementSync.columns()` gives the origin table, the origin column, and the declared type of each result column.
`pragma_table_xinfo` gives NOT NULL, the primary key, and the default.
`pragma_foreign_key_list` gives the references.
The primary key column of a table gets a brand from the table name.
A column with `references` inherits the brand of the referenced column.
A `check (x in (...))` becomes a union of literals.
Nullability comes from NOT NULL and from the join kind.
A JSON aggregation gets a nested type from the literal keys of `json_object` and the origin of each value (ADR 0011).
The generated types are keyed by the SQL text as a literal type.
A `${...}` in a template is a `Param` for a value or a `Ref` for an identifier, and the two are different types.

## Why

When the SQL text changes, the old key no longer exists and `tsc` fails at the call site.
The failure names the new SQL, so the agent knows to regenerate.

## Evidence (v0)

`columns()` returns the origin through aliases, CTEs, derived tables, views, and `RETURNING`.
It returns null for every expression column.
The nullable side of a `LEFT JOIN` comes from `EXPLAIN QUERY PLAN`, which marks that loop with `LEFT-JOIN`.
A file that uses a changed SQL string fails with `TS2345 ... is not assignable to parameter of type 'keyof Generated'`.
See v0-measurements.md, section 3.

## Consequences

- Expression columns need a CAST to get a type (ADR 0017).
- A primary key must be NOT NULL to carry a non-null brand (ADR 0018).
- The union type from CHECK comes from a scan of the CREATE TABLE text (ADR 0020).
