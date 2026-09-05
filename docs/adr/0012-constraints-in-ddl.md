# ADR 0012: Single-row constraints live in DDL, multi-row rules in asserts

Status: accepted (2026-09-06)

## Context

An agent can forget a validation in application code.
Uniqueness checked in application code loses to a concurrent write.

## Decision

Every single-row constraint and every uniqueness rule lives in DDL: NOT NULL, CHECK, UNIQUE, partial indexes, and foreign keys.
Every rule that spans rows lives in an assert of a command (ADR 0015).

## Why

The database holds the shape guarantee even when the application code forgets it.
A unique index is atomic, and an application check races with concurrent writes.

## Consequences

- The DDL is longer than in a typical ORM schema.
- The migration generator must handle constraint changes, which means a table rebuild in SQLite (ADR 0013, ADR 0019).
