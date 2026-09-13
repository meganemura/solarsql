# ADR 0067: Row identifiers follow SQLite name resolution

Status: accepted (2026-09-13)

## Context

Existing SQL can address a row through `rowid`, `_rowid_`, or `oid`.
An INTEGER PRIMARY KEY can change the output column name that SQLite reports for such a reference.
Requiring a CAST for these known integers would force an unnecessary change to the query.

## Decision

Add unshadowed row-identifier names to each table's query scope as hidden numeric columns.
Use SQLite's WITHOUT ROWID attribute to determine their availability.
A declared column takes precedence over the matching spelling, including case differences.
The engine prepares the statement before type inference and supplies its output column names.
Outer joins add nullability, and wildcard expansion excludes the implicit names.
Parameter inference uses the same numeric contract for reads and writes.

Preserve the original SQL text.
Existing non-STRICT columns keep their conservative storage types; an implicit row identifier is an integer regardless of table affinity.
Virtual table statements must also pass engine preparation before this inference applies.

## Evidence

Tests compare inferred names and types with SQLite results for primary-key aliases, shadowing, outer joins, FTS, CTEs, and wildcards.
A generated caller compiles with numeric result and parameter contracts.
Hegel varies stored integers and identifier spellings, then compares actual values with the inferred contract.

## Boundary

Numeric types retain the adapter limits described in ADR 0029.
An implicit row identifier does not establish a persistent application identity.
SQLite can change such identifiers during VACUUM when an INTEGER PRIMARY KEY does not alias them.
See the [SQLite rowid documentation](https://www.sqlite.org/rowidtable.html).
