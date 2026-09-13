# ADR 0048: Result types follow query scopes

Status: accepted (2026-09-13). Supersedes the temporary SQL restrictions and origin fallback of ADR 0047.
Extends the scanner responsibilities of ADR 0020 and the expression exceptions of ADR 0017.

## Context

A non-null table column can become null after an outer join or an empty scalar subquery.
A CTE or view can preserve that column without adding nullability.
SQLite origin metadata identifies the stored column, while the query determines which values reach the result.
Compound queries and RIGHT or FULL joins need query-derived nullability and branch types.

## Decision

The scanner identifies query scopes, CTE bindings, sources, joins, projections, and compound branches.
SQLite still validates SQL syntax and supplies output names and schema facts.
The resolver follows each source into its defining scope, including renamed CTE and view columns.
It resolves inner names before correlated outer names.

LEFT, RIGHT, and FULL joins add nullability to the sources that can be absent.
USING and NATURAL joins resolve their combined output columns according to the join direction.
A scalar subquery adds nullability because it can return no row.
A view, CTE, or derived table preserves the types of its defining query.
UNION merges possible types by column position; INTERSECT and EXCEPT retain the left input's types.
Literal outputs have inferred types without a CAST.
Other expressions retain the documented CAST and JSON rules.

Decoded JSON retains its shape through scopes.
A compound output that mixes decoded JSON with ordinary SQL values is rejected when one decoding policy cannot serve both branches.
A caller can CAST the JSON branch AS TEXT to request SQL text instead.
The alias-specific JSON FILTER rule from ADR 0047 remains in force.

The generated catalog key and executed SQL retain the caller's SQL text.
Structural analysis and scratch probes serve type generation; they do not rewrite the runtime query.
Recursive CTEs and unresolved structural forms produce build errors until their types have explicit support.

## Evidence

`test/scope.test.ts` compares inferred guarantees with populated SQLite results, including empty and unmatched inputs.
An independent value-membership check tests generated rows against inferred scalar types.
Exact type assertions also check precision for non-null wrappers, compound branches, and nested JSON.

`test/sql-first.test.ts` builds a temporary module, compiles caller types, applies its migration, and runs the Node adapter.
The test checks unchanged SQL text and direct SQLite results.
`node spike/10-sql-scopes.ts` prints those SQL statements, inferred columns, and actual rows.

## Consequences

An agent can use SQL scopes to structure a query while keeping query-derived caller types.
The structural resolver needs regression tests for each supported form.
These checks establish behavior for the tested forms; they do not establish complete SQLite coverage.
Parameter inference retains its separate pattern-based rules.
