# ADR 0126: A stale SQL literal fails with the remedy as its type

Status: accepted (2026-09-19).

## Context

`queries()` constrained its catalog argument to `Record<string, keyof G & string>`, one type shared by every entry.
Measured on 2026-09-19: editing one query string without rebuilding made tsc name the changed literal, but showed, as the "expected" type, the SQL text of an unrelated query — the union of every key of the generated map, because the constraint named no single key.

## Decision

`queries()` checks each catalog entry against its own key with a mapped conditional type: a key found in the generated map keeps its type, and a key not found becomes the string literal `"not in solarsql.generated.ts: run npx solarsql build"`.
The catalog argument is typed by two overloads: the first is the prior signature, so a correct catalog infers exactly as before; the second, checked only when the first fails, reports the per-key remedy. A single generic signature that both infers the catalog's literal types and checks them against the per-key map made every entry fail, not only the stale one, because TypeScript solves the type parameter and its own bound together.

## Consequences

- A stale query literal's tsc error names the literal and reads `run npx solarsql build`, not another query's SQL. `test/stale.test.ts` pins the message text.
- Cascading errors at use sites (a caller of the now-missing property) still appear at the same count as before; this ADR narrows the catalog-site message only.
- `commands()`' plan is a positional array mixing SQL strings and asserts, not a record keyed like the catalog, so the same per-key mapped type does not apply to it without redesigning `PlanShape`. Left for a later ADR if it is worth doing.
