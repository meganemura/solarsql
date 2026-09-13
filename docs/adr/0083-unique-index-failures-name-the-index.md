# ADR 0083: Unique index failures name the index

Status: accepted (2026-09-13)

## Context

An expression index can reject a row with an index-specific UNIQUE error.
The classifier previously interpreted the index message as a table and column list.
Those fields did not identify the actual constraint.

## Decision

Add the `unique_index` command failure with an `index` field.
Decode the index name from SQLite's quoted error text, including doubled apostrophes.
Keep the ordinary `unique` result for table-column errors.
Observation reports `unique_index` for the new result.
Callers with exhaustive switches over constraint kinds must handle this variant.

## Evidence

A property test creates real expression indexes with varied names and compares the reported name with the original.
A generated customer command conflicts with an index whose name contains an apostrophe.
Node, local D1, and local Durable Objects return the same structured result.
The Node check also verifies one persisted row and the observation outcome.
