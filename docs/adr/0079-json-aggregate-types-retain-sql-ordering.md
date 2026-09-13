# ADR 0079: JSON aggregate types retain SQL ordering

Status: accepted (2026-09-13)

## Context

SQLite supports DISTINCT and local ORDER BY terms inside JSON aggregate calls.
The generator previously treated those terms as part of the value expression.
A valid ordered query therefore failed analysis.

## Decision

Separate the aggregate value from a leading DISTINCT and top-level ORDER BY terms.
Infer the array element type from that value.
Leave ordering, duplicate removal, filtering, and execution to SQLite without changing SQL.
SQLite also validates aggregate arity and clause syntax before type generation.
Nested function arguments and their commas remain part of their own expressions.

## Evidence

A property test compares sorted arrays with actual SQLite aggregates across values, NULL, direction, and duplicate removal.
Examples cover JSON objects, multiple order terms, function arguments, collations, and FILTER.
A generated caller checks ordered distinct JSON objects on Node, local D1, and local Durable Objects.
