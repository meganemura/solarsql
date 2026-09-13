# ADR 0091: Column renames use the migration intent

Status: accepted (2026-09-14). Supersedes the intent-file shape in ADR 0090.

## Context

The schema diff detects a table that loses and gains a column. It cannot know
whether the values should move to the new column. The diff already supports a
precise SQLite `RENAME COLUMN` plan, but the migration command had no way to
receive that plan.

The destructive migration intent already provides one small, pre-import JSON
input. A second flag or a second file would let one migration describe related
changes in two places.

## Decision

Version one of the strict migration intent has all three keys: `version`,
`drops`, and `renames`. `renames` is a list of exact `{table, from, to}`
objects. Either list may be empty.

The command parses the file before it imports configuration code. The diff
accepts a rename only when its source exists in the current table, its target
exists in the declared table, and the source disappears from the target.
It rejects unknown fields, missing objects, duplicates, conflicts, chains,
and unused mappings.

For one removed and one added column, build and build check report the exact
rename object and a shell-safe command. For larger sets, they report source
and target candidates. The generator does not infer their mapping.

## Why

The same input now records both reviewed data removal and reviewed data
movement. A caller can copy one JSON document into the migration command.
SQLite performs the rename, so populated values and row identifiers remain in
place.

## Consequences

A rename needs an intent file even when it does not remove data. A multi-column
rename remains an explicit choice. Safe additions can share the generated
migration with a declared rename.
