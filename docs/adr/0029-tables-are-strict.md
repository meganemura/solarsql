# ADR 0029: Tables are STRICT, so stored values match the generated types

Status: accepted (2026-09-06)

## Context

ADR 0010 takes the type of a column from its declared type.
A plain SQLite table stores a text in an INTEGER column without complaint, so a generated `number` can arrive as a string at run time.
Other libraries decode each row against a schema at run time to catch this.
SQLite has STRICT tables, which reject a value whose storage class differs from the declared type at write time.

## Decision

Every table is STRICT.
The build fails on a table without `strict`, with the fix in the message.
The declared types are the STRICT set: INT, INTEGER, REAL, TEXT, BLOB, ANY.
ANY maps to `SqlValue`.
The adapters do not validate rows.

## Why

A rejection at write time is stronger than a check at read time: the wrong value never enters the table.
The generated types then hold for every stored value, and the check costs nothing per row.
A NOT NULL, a CHECK (ADR 0012), and STRICT together make the engine the validator.

## Evidence (v2)

A plain table accepts `'twelve'` in an INTEGER column and returns it as a string.
A STRICT table rejects it with `cannot store TEXT value in INTEGER column`, on node:sqlite and on the local D1 engine (`SQLITE_CONSTRAINT_DATATYPE`).
A STRICT table still converts the numeric text `'12'` to 12 and the integer 42 to `'42'` in a TEXT column.
A per-row check in JavaScript would cost about half a nanosecond per row, so cost was never the reason.
See v2-measurements.md, section 2.

## Consequences

- Adding `strict` to an existing table is a table rebuild (ADR 0019). A stored value that does not match fails the rebuild, and the file rolls back, so the data is fixed before the constraint lands.
- A declared type outside the STRICT set (`varchar(10)`) fails at CREATE, which the build reports with the engine's message.
- D1 returns an INTEGER as a JavaScript number, so a value above 2^53 loses precision on D1. STRICT does not change that.
- A schema library validates input that arrives from outside the database, before it reaches a parameter.
