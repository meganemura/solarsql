# ADR 0087: Ambiguous constraint targets remain errors

Status: accepted (2026-09-14)

## Context

SQLite permits dots in quoted table and column names.
Its UNIQUE, NOT NULL, and datatype error messages join the table and column with another dot and omit identifier quoting.
The adapter split at the first dot and reported fields that did not name the real schema objects.

## Decision

Classify a table-column constraint only when every target contains one dot and the table name agrees across all targets.
Require one dot for NOT NULL and datatype targets too.
Preserve the original engine error when its text cannot identify the boundary.
Keep CHECK, foreign-key, and quoted expression-index classification unchanged because those results do not split a table-column pair.

## Evidence

Property tests retain structured results for ordinary identifiers and decline messages with additional separators.
A real table and columns with quoted dotted names produce UNIQUE, NOT NULL, and datatype failures.
Node, local D1, and a Durable Object rethrow all three errors and retain only the fixture's seed row.
Existing tests preserve ordinary constraint results on each adapter.
