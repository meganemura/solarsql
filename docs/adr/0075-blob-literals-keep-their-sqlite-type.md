# ADR 0075: BLOB literals keep their SQLite type

Status: accepted (2026-09-13)

## Context

SQLite accepts hexadecimal BLOB literals such as `x'00ff'` without a cast.
The type generator rejected these expressions despite their fixed binary storage class.
This forced callers to change valid SQL or provide metadata manually.

## Decision

Infer `Uint8Array` from a valid BLOB literal in a supported query scope.
Recognize adjacent `x` or `X` and a quoted, even-length hexadecimal sequence.
Keep output names and SQL source as SQLite supplies them.
Let SQLite reject malformed literals before type generation.

Use the same literal inference inside JSON constructors.
A valid JSONB literal can produce any `JsonValue`; invalid JSON content remains an engine error, as described in ADR 0074.

## Evidence

A property test compares arbitrary bytes with SQLite output through SELECT, VALUES, CTEs, and derived tables.
It checks both prefix cases, empty values, exact output names, and unchanged SQL.
Examples cover nullable unions, malformed literals, and a valid JSONB literal.
A generated caller compiles and returns every byte value and an empty BLOB on Node, local D1, and local Durable Objects.
