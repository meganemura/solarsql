# ADR 0057: Rehearse transitions on a database snapshot

Status: accepted (2026-09-13)

## Context

An empty-schema comparison cannot validate existing rows or old queries.
A file copy can omit committed data held in a WAL file.

## Decision

Use SQLite backup from a read-only connection to create a disposable snapshot.
Apply proposed SQL in one transaction, then check integrity, foreign keys, old query structure, and caller-supplied data assertions.
Report row counts and completed checks as JSON. Deny database attachments and transaction control inside the proposed SQL.
Remove the snapshot after success or failure.

## Limits

Compilation checks column names and declared types, not all query semantics.
Assertions express the caller's data requirements.
A successful local rehearsal does not establish a remote deployment's compatibility or migration history.
