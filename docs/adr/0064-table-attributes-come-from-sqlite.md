# ADR 0064: Table attributes come from SQLite

Status: accepted (2026-09-13)

## Context

A trailing DDL comment can contain STRICT or WITHOUT ROWID without enabling either attribute.
A text search can therefore classify a non-STRICT table as STRICT and generate a false storage contract.
Comments can also separate CREATE and VIRTUAL without changing the parsed table kind.

## Decision

Read table kind, STRICT, and WITHOUT ROWID from `pragma_table_list` for the main schema.
Use these engine attributes in both type facts and migration shapes.
Keep SQL scanning for definitions and literal contents that SQLite metadata does not expose directly.
The module build continues to require actual STRICT tables.
Schema analysis continues to use SqlValue for non-STRICT columns.

## Evidence

A non-STRICT table with a STRICT comment stores a BLOB in a TEXT column.
The module build rejects this table after the change.
Hegel varies comment contents and table options while checking type facts and migration facts against the requested attributes.
A virtual-table regression confirms that comments preserve its kind and hidden columns while shadow tables stay outside the migration model.
