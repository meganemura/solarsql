# ADR 0061: CHECK types follow stored values

Status: accepted (2026-09-13)

## Context

SQLite compares CHECK operands after affinity conversion and with the column's collation.
A TEXT column constrained by `CHECK(value IN (1))` stores the string `"1"`.
A NOCASE column constrained by `CHECK(value IN ('a'))` also accepts `"A"`.
Extracting a fragment of an OR predicate can exclude valid stored values from the generated type.

## Decision

Refine a column type only from a complete column-level `CHECK(column IN (literal, ...))` predicate.
Parse the predicate with SQL tokens so quoted punctuation remains part of the literal.
Keep literal bytes when normalizing schema definitions, including whitespace and quoted names.
Only narrow string columns with string literals, and number columns with finite, safely represented numeric literals.
STRICT ANY columns can retain either literal class because they preserve the inserted storage class.
Other affinity combinations retain their scalar type.
Non-BINARY collations retain the scalar type because comparison equality can admit additional values.
Complex predicates and unrecognized expressions retain the scalar type.
NOT NULL continues to determine column nullability.
This decision refines the CHECK rule in ADR 0010.

## Evidence

The type tests insert values into SQLite before comparing stored values with inferred types.
Hegel varies storage declarations, literal classes, and string contents.
A generated caller test compiles the inferred contract, including precise text enums and widened affinity or collation cases.

## Consequences

Some generated literal types become string or number types after regeneration.
The broader contract admits values that SQLite already accepts.
Ordinary text enums and integer flags retain their literal unions when the complete predicate proves that restriction.
ADR 0097 narrows one further shape: `column IN (literal, ...) OR column IS NULL`, which SQLite already treats the same as `IN (literal, ...)` alone.
