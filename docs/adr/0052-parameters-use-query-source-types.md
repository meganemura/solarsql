# ADR 0052: Parameters use query source types

Status: accepted (2026-09-13). Extends ADR 0051 beyond stored-table aliases.

## Context

The result resolver knows the columns of a CTE, view, or derived table.
Parameter inference previously used a separate table lookup, so the same column could become SqlValue in a comparison.
An unqualified inner column also needs local name resolution before a correlated outer lookup.

## Decision

Share query source resolution between results and parameter sites.
Resolve each reference within its SELECT and then its enclosing SELECTs.
Each SELECT retains its own WITH bindings; an inner binding does not change a correlated outer source.
Preserve source brands, scalar unions, and nullability in parameter types.
A decoded JSON result corresponds to SQL text when used as a comparison parameter.

For an IN list through json_each, resolve the compared column at its own source position.
That column belongs to the surrounding expression, while the array parameter occurs inside a subquery.
Parenthesize union element types in generated arrays.

Unrecognized parameter expressions retain the existing SqlValue fallback.
The existing rules still reject a parameter used at incompatible typed sites.

## Evidence

Tests cover renamed CTEs, views, derived tables, nested unqualified columns, correlated references, shadowed WITH bindings, and compound column types.
Property tests compare bound values through CTE and derived-table queries with actual SQLite rows.
The SQL-first test compiles a CTE filter's Params type and executes that filter through the Node adapter.
