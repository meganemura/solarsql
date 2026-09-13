# ADR 0069: Use the literal SQLite reserved prefix

Status: accepted (2026-09-13)

## Context

SQLite reserves names that start with `sqlite_` for internal use.
A LIKE pattern treats the underscore as a wildcard and also excludes legal names such as `sqliteCache`.
That exclusion prevented query analysis and hid application objects from migration comparisons.

## Decision

Use a GLOB pattern against the lowercase name when excluding the `sqlite_` prefix.
GLOB treats the underscore as a literal character.
Apply the same predicate to engine table facts, migration schema objects, and rehearsal table counts.
Continue using SQLite table metadata to exclude virtual shadow tables.

## Evidence

Tests retain legal table names with mixed case, numeric suffixes, and the bare name `sqlite`.
They analyze a view and apply a populated rebuild while preserving named indexes, views, and triggers.
An AUTOINCREMENT table creates the internal sequence table, which stays outside the application table list.
A full-text table creates shadow tables, which also stay outside that list.
Rehearsal reports retain populated legal tables in both before and after counts.
Hegel generates additional legal suffixes and checks both metadata readers.
