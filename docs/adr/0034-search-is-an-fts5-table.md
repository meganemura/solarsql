# ADR 0034: Full-text search is an FTS5 table declared with search()

Status: accepted (2026-09-06)

## Context

A search over text, such as the notes of orders, is a common need of an application on D1.
`LIKE` reads the table in full, and the build reports it.
SQLite ships FTS5, and D1, a Durable Object, and node:sqlite all carry it: the search test of the example in `test/example.test.ts` runs on Miniflare's D1 and on a Durable Object, and `test/node.test.ts` on node:sqlite. The engine keeps five shadow tables next to the search table.
An external search service is a second system to run.

## Decision

A module declares a search table with `search()`, one `CREATE VIRTUAL TABLE ... USING fts5(...)` statement.
The module owns it like a table, and the boundary check treats it the same.
Its columns are `string | null`, `rank` is `number`, and `where <table> match :q` takes a `string`.
The migration diff creates it after the tables and before the triggers, and a change to its text drops it and creates it again.
Triggers of the module keep it in step with the table it indexes.

## Why

FTS5 is the engine's own search, so the same SQL runs on every target and the types come from the same facts.
A search table has no ALTER, so drop and create is the only migration; the rows come back through the triggers or a rebuild of the index, and the table it indexes keeps them.
`search()` is a name of its own because a search table is not STRICT and has no primary key, which the rules for `table()` require.

## Consequences

- The shadow tables of a search table (`_config`, `_content`, `_data`, `_docsize`, `_idx`) are the engine's own; the build and the migration diff never name them.
- A changed search table starts empty after its migration. The rows of the indexed table survive; the search rows must be inserted again.
- `bm25()`, `highlight()`, and `snippet()` are expressions, and take a CAST like any other (ADR 0017).
