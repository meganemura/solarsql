# ADR 0098: `unionMembers` drops a literal member `string` or `number` already covers

Status: accepted (2026-09-14)

## Context

`unionType`/`unionMembers` (`src/build/scope.ts`) back every union the type generator builds: JSON aggregates, CASE expressions, and compound `SELECT` column merges among them. `unionMembers` splits a type string on its top-level `|` and dedupes only exact-text duplicates.

A `UNION ALL` whose branches produce a CHECK-narrowed literal type in one branch and the unconstrained scalar type in another generates a type such as `string | null | "formula" | "cask"` instead of `string | null`. Confirmed against the real type generator: `select cast('tool' as text) as kind from a union all select kind from b`, where `a.tool` is an unconstrained `text` column and `b.kind` is `text check (kind in ('formula', 'cask'))`, reports the column's type as `string | null | "formula" | "cask"`.

TypeScript treats the two forms as the same type: a string-literal type is already assignable to `string`, so nothing is unsound. The redundant members only make the generated file harder to read.

## Decision

`unionMembers` drops a double-quoted string-literal member once `string` is also a member of the union, and drops a numeric-literal member once `number` is also a member. `null`, and every other member, is left alone. Member order is otherwise unchanged; nothing is reordered.

## Why

The two literal classes this project's CHECK narrowing ever produces (ADR 0061) are double-quoted string literals and plain numeric literals; both are always assignable to their respective bare type. Dropping them only when the bare type is already present in the same union keeps a union of literals alone (no bare type present) untouched, since only a complete `IN (...)` predicate without an unconstrained branch produces that shape, and it remains the useful, narrow type ADR 0061 exists to produce.

## Consequences

- A `UNION ALL`, JSON aggregate, or CASE expression whose branches mix a CHECK-narrowed literal type with the unconstrained scalar type now generates the simpler type; regenerating a project with this shape changes only this simplification in the file.
- A union of literal members alone, with no bare `string` or `number` member present, is unaffected.
- Nothing downstream of `unionMembers` needed a change: every caller that builds a type string from its result (`ofRef` in `typegen.ts`, in particular) already derives that string from `unionMembers`'s own output, so a later, repeated call to `unionMembers` on an already-simplified string is a no-op, not a second simplification pass.
