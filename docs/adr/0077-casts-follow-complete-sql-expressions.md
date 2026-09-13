# ADR 0077: Casts follow complete SQL expressions

Status: accepted (2026-09-13)

## Context

SQLite represents BLOB affinity as an empty type in CREATE TABLE AS metadata.
That probe cannot distinguish a BLOB cast from an expression with no declared type.
Text matching also rejected comments inside CAST and could accept an inner CAST as the enclosing value's type.

## Decision

Read a complete CAST from SQL tokens, including comments, whitespace, and parentheses.
Use its explicit BLOB conversion when the engine's affinity probe returns an empty declaration.
Retain the engine's declared scalar affinity for other output expressions.
Use the same complete CAST boundary for values inside JSON constructors and for nullability checks.

Keep conservative nullability unless the complete inner expression proves a non-null result.
An EXISTS expression with an additional nullable operation does not establish that proof.
A BLOB cast inside JSON follows the `JsonValue` contract from ADR 0074.

## Evidence

A property test checks arbitrary BLOB values through direct casts and CTEs with varying SQL comments and whitespace.
Examples retain scalar conversion, NULL, complete aggregate calls, and unsupported enclosing operations.
A generated caller uses a commented BLOB cast of JSONB inside a CTE on Node, local D1, and local Durable Objects.
