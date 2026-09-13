# ADR 0090: Automatic destructive migrations need an exact intent

Status: accepted (2026-09-14)

## Context

The migration generator compares declared DDL with applied migration files.
It can generate `DROP TABLE`, `DROP COLUMN`, or a rebuild that omits a column.
The generator cannot inspect the rows in every deployed database.

An accidental DDL deletion can discard production data. A broad confirmation
flag cannot show which table or column the author reviewed.

## Decision

Automatic generation blocks each removed ordinary table and column by default.
The `migration` command accepts a versioned JSON intent file. Version one has
an exact `drops` list. Each entry names one table, or one column and its table.

The set must match the ordinary removals exactly. The generator rejects a
missing, duplicate, malformed, or unused entry. It parses the file before it
loads project code. It prints names with SQLite identifier quoting, so dots and
other identifier characters remain unambiguous.

A declared rename consumes its source column before the removal comparison.
Virtual search tables keep their existing drop-and-create behavior because they
are derived indexes rather than ordinary row containers.

An exact table intent does not permit a generated drop when a surviving child
table has an incoming foreign key with a delete action other than `NO ACTION`.
`DROP TABLE` can change child rows or fail because of that action. The generator
directs the author to an explicit migration that preserves rows and foreign keys.

`build` reports the blocked object names, a complete JSON example, and a
runnable migration command. `build --check` writes no files.

## Why

The declaration states the target schema. The intent file states the reviewed
data loss. Keeping them separate makes the destructive decision visible in a
small, machine-checkable input.

## Consequences

Removing data needs one additional file and command argument. The generated
migration history still contains only SQL. A future intent version can add
other narrow operations without making an existing file ambiguous.
