# ADR 0097: `CHECK col IN (...) OR col IS NULL` narrows like `IN (...)` alone

Status: accepted (2026-09-14)

## Context

ADR 0061 narrows a column's type only from a complete `CHECK(column IN (literal, ...))` predicate. Any other shape, including `column IN (literal, ...) OR column IS NULL`, retains the scalar type: `oneOfLiterals` in `src/build/facts.ts` requires the whole `CHECK` expression to match `column IN (...)` exactly, nothing else.

`column IN (literal, ...) OR column IS NULL` is a common way to write a `CHECK` that only constrains a nullable column's non-null values. SQLite passes a `CHECK` whenever its predicate evaluates to `NULL`, regardless of what the predicate says. A NULL stored value makes `column IN (literal, ...)` itself evaluate to `NULL` (SQLite's `IN` returns `NULL`, not `FALSE`, when the left operand is `NULL`), so this `CHECK` already passes a `NULL` value with no `OR IS NULL` clause at all.

Confirmed with `node:sqlite`: `create table t (x text check (x in ('a','b') or x is null))` accepts a `NULL` insert and rejects `'c'`. `create table t (x text check (x in ('a','b')))`, without the `OR IS NULL` clause, accepts the same `NULL` insert and rejects the same `'c'`. The two tables accept exactly the same values.

## Decision

`oneOfLiterals` strips one `OR <column> IS NULL` disjunct, in either position (`<in-list> OR <column> IS NULL` or `<column> IS NULL OR <in-list>`), naming the same column the `IN` list constrains, before its exact-match check against `column IN (literal, ...)`. Stripping this one disjunct, and only this one, then narrows the column's type exactly as if the predicate had been `column IN (literal, ...)` alone.

Any other `OR` disjunct, including `OR column IS NOT NULL` or `OR column = 'z'`, is left alone and still retains the scalar type, unchanged from ADR 0061.

## Why

`OR column IS NULL` admits no value `IN (literal, ...)` alone doesn't already admit, because SQLite passes any `CHECK` whose result is `NULL`. Every other `OR` disjunct can admit a value the bare `IN` list does not, so ADR 0061's rule still applies to it: retain the scalar type, because the fragment cannot be extracted without possibly excluding a stored value that fits it.

## Consequences

- A column declared `text check (col in ('a', 'b') or col is null)` (or the disjuncts in the other order) now narrows to `"a" | "b" | null`, instead of `string | null`.
- `schema.md`'s "complex predicates retain the scalar type" gains one named exception: this one disjunct, this one shape.
- No change to a `CHECK` with any other `OR` disjunct, a `NOT NULL` column, or a non-`IN` predicate.
