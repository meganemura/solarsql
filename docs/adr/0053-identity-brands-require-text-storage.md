# ADR 0053: Identity brands require text storage

Status: accepted (2026-09-13)

## Context

`Id<T>` is a branded string and `newId()` generates UUID text.
SQLite also accepts INTEGER and BLOB primary keys in STRICT tables.
A foreign key compares values using the parent affinity, but the child retains its own storage class.

## Decision

A single TEXT primary key receives an identity brand.
Other primary keys retain their scalar types.
A foreign key inherits a text identity brand only when its own column has a text type.
Nullability still follows the child column.
This narrows the brand rules in ADR 0010 and preserves the UUID default in ADR 0016.

## Evidence

The SQL integration test compiles exact caller types and executes integer, BLOB, and mixed-type foreign-key reads through the Node adapter.
The compiler rejects `newId<number>()`.
