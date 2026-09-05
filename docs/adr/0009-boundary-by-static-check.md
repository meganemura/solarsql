# ADR 0009: Module boundaries are enforced by static checks

Status: accepted (2026-09-06)

## Context

SQLite has no roles and no grants.
The database cannot enforce which module reads which table.

## Decision

Enforcement is static and happens in the build step.
A table declaration carries the brand of its module.
The query API of module B accepts only tables with the brand of B.
The build step prepares every statement in node:sqlite with `setAuthorizer()` and collects the table accesses.
An access is allowed when the table is owned by the module or is on the public surface it imports.
A module can declare read access to all tables, for reports.

## Why

`setAuthorizer()` fires at prepare time and reports every column read and every table written.
The build step never runs the statement, so the check is fast and needs no data.

## Evidence (v0)

The authorizer reports `SQLITE_READ(table, column)` for each column, including columns in `ON` and `WHERE`.
It reports `SQLITE_INSERT`, `SQLITE_UPDATE`, and `SQLITE_DELETE` with the table name.
A view or a trigger passes its name as the fifth argument, so the base-table access is attributed.
A denied access fails prepare with `access to customers.name is prohibited`.
A foreign key check reads the primary key of the parent table, so an insert into `orders` reports `SQLITE_READ("customers", "id")`.
See v0-measurements.md, section 2.

## Consequences

- The allowed set for a module includes the primary key columns that its foreign keys reference.
- Postgres gets a second layer with roles when the adapter arrives (ADR 0003).
