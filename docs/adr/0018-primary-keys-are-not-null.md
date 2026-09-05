# ADR 0018: A primary key column is NOT NULL

Status: accepted (2026-09-06)

## Context

In a rowid table, SQLite allows NULL in a TEXT primary key column.
`pragma table_xinfo` reports `notnull = 0` for `id text primary key`.
ADR 0010 gives the primary key a brand, and a brand on a nullable column is useless.

## Decision

A primary key column must be declared `NOT NULL`, or the table must be `WITHOUT ROWID`.
The build step reports any other primary key as an error.

## Why

The type of the id must be `OrderId` without `null`.
`WITHOUT ROWID` makes the primary key NOT NULL by itself and clusters rows by the key.

## Evidence (v0)

`id text primary key` in a rowid table has `notnull = 0`.
The same column in a `WITHOUT ROWID` table has `notnull = 1`, and an insert of NULL fails.
See v0-measurements.md, section 3.

## Consequences

- The recommended shape is `id text primary key not null`.
- Existing tables without the constraint need a rebuild migration (ADR 0019).
