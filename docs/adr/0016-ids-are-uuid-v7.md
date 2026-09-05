# ADR 0016: Ids are UUID v7 strings made on the client

Status: accepted (2026-09-06)

## Context

ADR 0006 needs ids before the first statement of a plan runs.
An id from `AUTOINCREMENT` arrives after the insert, which a batch cannot wait for.
Workers and Node both provide `crypto.getRandomValues()`.

## Decision

The library generates ids on the client as UUID version 7, stored as TEXT.
The library ships the generator.
A primary key column is `id text primary key not null` (ADR 0018).

## Why

Version 7 puts a timestamp in the high bits, so new rows land near each other in the primary key index.
A string id reads well in a log and in a test.
The generator is small and needs no dependency.

## Consequences

- Version 1 takes the id from the caller. The generator arrives in a later version.
- Tables that need an integer key for a `rowid` alias are out of the default shape.
- A `WITHOUT ROWID` table is a good fit for a text primary key.
