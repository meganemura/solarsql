# ADR 0070: Rebuilds retain AUTOINCREMENT history

Status: accepted (2026-09-13)

## Context

An AUTOINCREMENT table retains its largest prior inserted identifier in `sqlite_sequence`.
Deleting a row does not remove that history.
Rebuilding from surviving rows alone can lower the sequence and reuse identifiers that AUTOINCREMENT would have excluded.

## Decision

When both table versions use AUTOINCREMENT, save the old sequence before dropping the table.
After restoring rows, restore a missing sequence row or raise the new sequence to the saved value.
Do not lower a sequence established by the restored rows.
Keep the saved value in SQL throughout, including at the 64-bit integer limit.
Drop the sequence copy in the same migration transaction.

Recognize AUTOINCREMENT as an SQL keyword token.
Comments, string literals, and quoted identifiers do not enable this behavior.
Explicit transitions that add or remove AUTOINCREMENT retain their declared meaning.

## Evidence

Tests preserve deleted maxima, empty tables, rollback after a constraint failure, and an exhausted 64-bit sequence.
The next insert remains above the old maximum on Node and in a local D1 batch.
Hegel varies the deleted maximum and whether a lower row survives.

See the [SQLite AUTOINCREMENT contract](https://www.sqlite.org/autoinc.html).
