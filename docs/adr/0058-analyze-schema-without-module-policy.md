# ADR 0058: Analyze a schema without module policy

Status: accepted (2026-09-13)

## Context

An existing SQLite application can benefit from generated query types before it adopts table ownership or command plans.
Its schema can include tables without primary keys and columns with flexible storage classes.

## Decision

`analyze` accepts schema DDL and a JSON catalog of read queries.
It creates an in-memory database and imports no application modules.
It emits versioned operation metadata and a TypeScript file with the original SQL catalog and its generated metadata.
Callers use the existing `queries()` function and adapters.

This entry point assigns no identity brands and requires no primary key.
Non-STRICT columns use `SqlValue`, because affinity does not restrict stored classes.
STRICT columns use their scalar types, without CHECK-literal narrowing.
The shared inference engine handles expressions, parameters, and nullable joins.
Unsupported inference produces a diagnostic with its query location.

## Boundary

The input contains CREATE statements, not data or database configuration.
Analysis does not validate the supplied DDL against a populated database.
It does not generate migrations or enforce module ownership.
The local engine and adapter limits still apply.
`--check` verifies generated content against the supplied inputs; it does not inspect deployed databases.
