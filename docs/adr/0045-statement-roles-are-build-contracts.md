# ADR 0045: Statement roles are build contracts

Status: accepted (2026-09-13). Extends ADR 0005 and ADR 0006.

## Context

The query catalog accepted DELETE, and a command's `returns` accepted UPDATE with RETURNING.
Calling `all()` could delete rows, while a write in `returns` escaped the command's change count.
A plan also accepted COMMIT and multiple statements in one string.
The Node adapter prepared the first statement, while the declaration appeared to describe several effects.

## Decision

Each query, plan SQL item, and `returns` contains exactly one statement.
Queries and `returns` contain SELECT, including WITH followed by SELECT.
Plan SQL items contain SELECT, INSERT, UPDATE, DELETE, or REPLACE, including their WITH forms.
The build refuses transaction control, PRAGMA, and schema changes in these locations.
It checks every use of shared SQL against its role and reports the source location.

## Why

A read API must preserve rows.
The adapter must own the transaction that gives a command its rollback guarantee.
One statement per plan item aligns the declared order, parameter metadata, execution, and change count.

## Consequences

Previously accepted statements can fail the build after an upgrade.
Move writes into plan items and use `returns` to read their result.
Split multiple statements into separate plan items.
Declare schema changes in the module and apply them through migrations.
These are build guarantees; applications must run the build check before delivery.
