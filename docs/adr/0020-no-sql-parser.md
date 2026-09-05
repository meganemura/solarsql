# ADR 0020: No SQL parser, a scanner and engine probes

Status: accepted (2026-09-06)

## Context

The dependency policy prefers language-official packages, then vendor packages, and avoids single-maintainer packages.
The available SQL parsers for SQLite are single-maintainer packages.
ADR 0010 and ADR 0013 need facts about the SQL text.

## Decision

The library has no SQL parser dependency.
A scanner that tracks string literals and parenthesis depth gives the text facts:

- the pairs inside `json_object(...)`
- the items of a select list, by position
- the column definitions inside `CREATE TABLE (...)`
- the `check (x in (...))` literals
- the alias of each table in `FROM` and `JOIN`
- the statements in a migration file, with trigger bodies kept whole

Every other fact comes from the engine: `columns()`, `pragma_table_xinfo`, `pragma_foreign_key_list`, `setAuthorizer()`, `EXPLAIN QUERY PLAN`, and `CREATE TEMP TABLE ... AS ... LIMIT 0`.
A candidate statement runs on a scratch database, and the engine's answer decides.

## Why

The engine already parses the SQL, and its answers are correct by definition.
A small scanner is easier to read than a parser dependency.

## Evidence (v0)

Every fact in the type derivation of ADR 0010 and in the migration diff of ADR 0013 came from the scanner or from the engine.
See v0-measurements.md, sections 3 and 4.

## Consequences

- The scanner matches a fixed set of patterns. A construct outside them fails the build with a message.
- A self-join with `SELECT *` cannot map columns to aliases. The build step requires explicit column aliases there.
