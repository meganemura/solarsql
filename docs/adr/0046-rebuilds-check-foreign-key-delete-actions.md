# ADR 0046: Rebuilds check foreign-key delete actions

Status: accepted (2026-09-13). Narrows the automatic rebuild of ADR 0019.

## Context

A parent-table rebuild drops the parent before restoring its rows.
With ON DELETE CASCADE, that drop deletes child rows even when foreign-key checks are deferred.
An audit reproduced this loss by adding a CHECK to a parent with one child.
The transaction committed and the parent returned, while the child remained deleted.

## Decision

Automatic rebuilds require incoming foreign keys to use ON DELETE NO ACTION.
The migration generator checks incoming references in both the current and target schemas, including self-references.
CASCADE, SET NULL, SET DEFAULT, and RESTRICT block the rebuild.
The diagnostic identifies the parent, referencing column, and action.
Cheap ALTER operations remain available because they preserve the table.

## Why

Deferring a constraint check does not defer a foreign-key delete action.
The generator has schema facts but cannot inspect the deployed rows that these actions would affect.
Checking both schemas covers references introduced during the migration.

## Consequences

Affected changes require an explicit migration that preserves the related rows.
The build can generate query types while it reports this blocked migration; the migration command and build check fail.
Data-preservation tests compare row values and foreign-key validity after accepted changes.
This decision blocks unsafe automatic rebuilds; it does not provide a general rewrite of cascading relationships.
