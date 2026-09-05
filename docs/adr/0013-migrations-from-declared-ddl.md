# ADR 0013: Migrations are generated from the declared DDL

Status: accepted (2026-09-06)

## Context

wrangler applies numbered `.sql` files from `migrations/` and records each name in `d1_migrations`.
SQLite `ALTER TABLE` cannot change a constraint.
A snapshot file is a second source of truth that drifts.

## Decision

The build step generates a numbered `.sql` file from the difference between two schemas.
The current schema is the result of the existing migration files, applied in order to a node:sqlite memory database.
The target schema is the declared DDL, applied to another memory database.
There is no snapshot file.
The generator stops and asks for an explicit rename when a table both loses and gains a column.
The generator stops when a new column is NOT NULL without a default, because existing rows would have no value.
A constraint change becomes a table rebuild (ADR 0019).
On a Durable Object, the library applies the same files inside `blockConcurrencyWhile()` and `transactionSync()`, and records them in a history table per object.

## Why

The migration files are the history, so no second file can drift from them.
A silent drop of a column loses data, and a stop costs one line of declaration.

## Evidence (v0)

A three-round example round-trips: all CREATE, then an ADD COLUMN plus a rebuild plus an index change, then a rename.
A property test over 200 random schema pairs holds: the applied migration has the shape of the declaration, and a second diff is empty.
The property test found two defects before the rule set was complete: an index must be dropped before its column, and a NOT NULL column without a default fails on a table with rows.
wrangler applies one file as one batch, so one file is one transaction on the local engine.
The generated file, including the rebuild, applies on the local D1 engine in one batch.
See v0-measurements.md, section 4.

## Consequences

- The shape comparison uses `pragma_table_xinfo`, `pragma_foreign_key_list`, and normalized column text.
- A candidate ALTER runs on a scratch database first. The engine decides whether the cheap path is enough.
- Views and triggers are not diffed in v0.
