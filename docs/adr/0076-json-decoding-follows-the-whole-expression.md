# ADR 0076: JSON decoding follows the whole expression

Status: accepted (2026-09-13)

## Context

A JSON function can occur inside an expression that returns a number or ordinary text.
For example, `length(json_object('value', 1))` returns a number.
Finding the inner function previously assigned an object type and JSON decoding to the complete output.

## Decision

Recognize a JSON constructor only when it spans the complete expression.
Allow parentheses and SQL comments around that expression.
For JSON aggregates, retain complete FILTER and OVER clauses, including named windows.
Retain the documented `coalesce(json_group_array(...), '[]')` form.
Apply these boundaries inside aggregates and nested JSON subqueries as well.

An unsupported enclosing expression receives a build error with CAST guidance.
An explicit numeric or text CAST describes the scalar output and disables JSON decoding.
The SQL itself remains unchanged.

## Evidence

A property test varies scalar wrappers and compares their explicit CAST contracts with SQLite values.
It covers length, comparison, concatenation, substring, and CASE expressions.
Regressions retain JSON aggregate filters, windows, parentheses, and nested subqueries.
Generated callers return scalar CAST results on Node, local D1, and local Durable Objects.
