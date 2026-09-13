# ADR 0047: Reject unproven result types

Status: partially superseded by ADR 0048 (2026-09-13). The JSON FILTER rule remains accepted. Originally narrows the supported SQL shapes of ADR 0020 and the JSON inference of ADR 0011.

## Context

SQLite column metadata describes origins, but does not prove all possible result values.
The query `select n from a union all select null` inferred number while returning null.
A RIGHT JOIN could also return null for a column inferred as number.
A JSON aggregate filtered on the preserved table incorrectly removed nullability from the joined table.

## Decision

The build rejects UNION, INTERSECT, EXCEPT, RIGHT JOIN, and FULL JOIN until their result types can be established.
The restriction applies to nested queries and to queries through views.
Comments and quoted strings do not trigger the restriction.

A JSON aggregate removes an outer alias's nullability only when its FILTER predicate is exactly `alias.column IS NOT NULL`.
Other filter expressions retain conservative nullability for that alias.
Filtering one alias does not remove another alias's nullability.

Output inference uses the outer query's aliases.
An origin column reached through a view, CTE, derived table, or scalar subquery retains nullability when a direct non-null source cannot be established.
Direct table wildcards expand before expressions are paired with output columns.
Duplicate output names are rejected because a row object cannot preserve both values.
Wildcards over multiple sources, CTEs, or derived tables require explicit columns.

## Why

A successful build must not encourage the caller to omit a required null check.
An explicit unsupported-shape error gives the agent a repair target; an incorrect type can silently reach production.

## Consequences

Previously accepted compound queries and RIGHT or FULL joins now fail the build.
Use separate queries, or express an applicable join with LEFT JOIN.
Some JSON filters produce wider types even when their predicates exclude null rows.
View and CTE columns can also acquire conservative nullability, so an upgrade can require caller changes.
Further support requires tests against actual SQLite results, including empty and unmatched inputs.
