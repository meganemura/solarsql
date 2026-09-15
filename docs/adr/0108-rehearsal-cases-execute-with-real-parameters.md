# ADR 0108: Rehearsal cases execute with real parameters

Status: accepted (2026-09-15). Adds `checks.cases` to rehearse.

## Context

Commits `5d7411c` ("Execute rehearsal cases with real parameters across a migration") and `ec6f184` ("Reject a top-level boolean rehearsal-case parameter") added `checks.cases` to `src/build/rehearse.ts`, before this record existed. `checks.queries` (ADR 0057) compares a query's result columns before and after a migration, without ever executing it with real values; a migration that keeps the same columns can still break stored data, for example a column that turns from JSON into plain text still has the same declared type.

Neither existing ADR admits `checks.cases`. ADR 0057 constrains rehearse's own mechanism, a different scope: a disposable snapshot, integrity checks, `checks.queries` compared by column shape alone, and caller-supplied `checks.assertions` — neither of ADR 0057's two check kinds runs a statement with real, caller-supplied parameter values. ADR 0059 constrains a different thing: rehearsal's validation of its own check fields, rejecting an unknown field name or a malformed SQL map so a typo cannot silently reduce the evidence behind a successful report. That rule validates the shape of whatever fields exist; it does not fix which fields exist, so `checks.cases` entering as a third validated field is a decision ADR 0059 left open, not one it made.

## Decision

A case is one read statement (SELECT, VALUES, or WITH) with named parameters. `rehearseSnapshot` runs it, with real bound values, once before the migration and once after, inside the same rehearsal; both runs must execute without error, and the result columns must match between the two runs, or the rehearsal fails.

Four parameter shapes are refused before any case runs: a top-level boolean (`SqlValue` has none, and no generated query parameter is ever one), a BigInt (bind it as a string instead), a BLOB (`Uint8Array` or `ArrayBuffer`; bind it as a string instead), and an anonymous `?` parameter (every slot must be named).

## Why

A case proves a statement still executes against real rows, not only that its column shape is unchanged — stronger evidence than `checks.queries` alone, for the same reason `checks.assertions` runs against real data instead of only comparing shapes. The four refused parameter shapes each have no real generated-query equivalent (JSON encoding has no BigInt or BLOB literal, and `SqlValue` has no boolean); rehearsing a bind shape no real caller can construct would prove nothing about the actual system.

## Consequences

- A case's own parameters are validated the same way a generated query's would be, before the case ever runs.
- `checks.queries` is unaffected: it still compares column shape only and never executes with bound values.
- This adds `checks.cases` as rehearse's third check kind. Neither ADR 0057 nor ADR 0059 is edited.
