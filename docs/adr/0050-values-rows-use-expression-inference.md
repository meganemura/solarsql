# ADR 0050: VALUES rows use expression inference

Status: accepted (2026-09-13). Extends ADRs 0045, 0048, and 0049.

## Context

VALUES is a SQLite query form and a conventional seed for recursive CTEs.
Requiring SELECT instead changes the caller's SQL for a type-generation limitation.

## Decision

Accept VALUES in query catalogs, command reads, and query scopes.
Analyze each row's expressions with the existing SELECT expression rules on scratch probes.
Merge all row types by column position, including nullability and JSON decoding policy.
Keep the original SQL as the generated key and runtime statement.
Support VALUES as the non-recursive seed of a recursive CTE.
SQL literals also retain their scalar types inside JSON expressions.

## Evidence

The VALUES tests check heterogeneous rows, commas inside strings, renamed CTE columns, and JSON decoding.
Property tests compare recursive sequences with actual SQLite rows over generated bounds.
The SQL-first test compiles generated VALUES result types and runs the unchanged query through the Node adapter.
