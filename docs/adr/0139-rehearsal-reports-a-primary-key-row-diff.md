# ADR 0139: rehearsal reports rows inserted, updated, and deleted, by primary key

Status: accepted (2026-09-25). Extends ADR 0057 (rehearse's own authorizer denies ATTACH and DETACH): the row diff below is the one place that authorizer now allows both, narrowly. Adds a field the way ADR 0119 already added `columns` at `version: 1` (CHANGELOG.md).

## Context

`rehearse.md:4` says rehearsal proves a migration applies "without losing rows," but the code never checked that: a plain `delete from customers where id='c3'`, an `insert or ignore` rebuild that loses a row, and an `upper(name)` rewrite all returned `ok: true` with no diagnostic (measured with `rehearseSnapshot`). `rehearse.md:29` and `:72` already say row counts and a successful case do not prove value preservation; the skill's own walkthrough (`sql-workflow.md:94-97`) has an agent hand-write `count(*)` and `sum(amount)` assertions for exactly this reason.

The SQLite session extension (`node:sqlite`'s `createSession`/`changeset`) was measured against solarsql's own generated rebuild shape (`example/migrations/0005_customer_name_not_empty.sql`, Node 26.7.0 and 24.18.0): for a table a foreign key references, with foreign keys on, the changeset is an exact diff; for a leaf table, or with foreign keys off, every re-inserted row reports as an INSERT (500,000 unchanged `orders` rows gave 500,000 inserts, 15.4 MB); for a rebuild that drops a column, `changeset()` throws "not an error" (errcode 0). A report whose correctness depends on foreign-key topology is a silent wrong result, so this was rejected.

What was measured to work instead: a primary-key diff in SQL against a before-copy. Leaf rebuild unchanged 0/0/0; value rewrite updated 2; lost row deleted 1; column-dropping rebuild 0/0/0 over the remaining columns without throwing; backfill of 666,666 rows updated 666666. Cost scales linearly: 100k rows, copy 17ms and diff 64ms; 400k rows, 65ms and 259ms (Node 26.7.0).

## Decision

`rehearseSnapshot()` takes its own before-copy with `db.prepare('vacuum into ?').run(path)`, on the working connection, before `begin` and before any authorizer is installed -- a deny-all authorizer (already in place for the rest of the rehearsal) denies VACUUM INTO too, since it performs its own internal `SQLITE_ATTACH` (measured: "authorization denied", action 24). This one path serves both `rehearse()`'s own on-disk snapshot flow and a direct in-process `rehearseSnapshot()` caller; no second copy is taken from the original source (two VACUUM INTOs of a live WAL source with a commit between them were measured to give different copies).

The diff runs last: after every check and assertion, before commit. The authorizer that has denied ATTACH and DETACH for the whole rehearsal (ADR 0057) is replaced, only for this stage, with one that allows `SQLITE_ATTACH` when its first argument equals the before-copy's own file path exactly, and `SQLITE_DETACH` only for a fixed reserved schema name (`solarsql_rehearse_before`); every other ATTACH or DETACH, and the same PRAGMA denials ADR 0057 already has, stay denied. No proposed SQL runs after this point, so this narrower authorizer never governs a statement the caller wrote.

For each table present, by name (case-insensitive), both before and after, and not a virtual table or one of a virtual table's own shadow tables (`pragma_table_list`'s own `type`) on either side:

- A primary key match is required: the same number of primary-key columns on both sides, each with a same-name (case-insensitive) counterpart on the other side. A table with no primary key, or whose primary-key columns changed, gets `{ compared: false, reason }` instead of counts.
- Every remaining common column (matched by name, case-insensitively) is compared with `a.c IS NOT b.c COLLATE BINARY OR typeof(a.c) IS NOT typeof(b.c)`: measured, plain `IS NOT` alone misses an `upper()` rewrite on a `COLLATE NOCASE` column (0 vs 2) and misses an integer-to-real or TEXT-to-INTEGER retype (0 vs 2); this pair catches both. The primary-key join itself carries no `COLLATE` override, so it runs under each column's own declared collation and can use its own index; a `NOCASE` primary key therefore matches keys case-insensitively here too.
- `inserted`, `deleted`, and `updated` are anti-join and join counts against the attached before-copy.

Cleanup, in `finally`: rollback first (DETACH fails inside an open transaction with "database ... is locked"); then the authorizer is cleared before the DETACH attempt (not kept at the narrow ATTACH-stage allowance), so a run that never reached the diff stage still gets SQLite's own "no such database" for a schema that was never attached, rather than an authorization denial that would mask it -- no proposed SQL runs after this point, so clearing the authorizer early exposes nothing; a DETACH failure other than "no such database" is recorded as a diagnostic without changing `result.ok`; the before-copy's own temporary directory is removed last, unconditionally, so nothing is left behind on Windows either.

The new field, `rows: Record<string, { compared: true; inserted: number; deleted: number; updated: number } | { compared: false; reason: string }>`, is added at the existing `version: 1`, the way ADR 0119 added `columns` there. Whether a deleted or changed row should fail the rehearsal unless `checks.json` names it is an open owner decision; until decided, `rows` only reports, and `rehearse.md:4` is corrected to describe what rehearsal actually checks today.

## Consequences

- `ok: true` is no longer silent about a lost or changed row: `rows` reports it, even though it does not yet fail the rehearsal on its own.
- A virtual table (e.g. FTS5) and its own shadow tables never appear in `rows`; a table with no primary key, or a rebuild that changes the primary key, appears with `compared: false` and a reason instead of counts.
- `rehearseSnapshot()` is no longer free of filesystem access (it now takes its own VACUUM INTO copy); every filesystem call it makes stays synchronous, so a caller driving it from a property test still needs no async scheduling.
- Cost scales with row count (measured linear, tens of ms per 100k rows); a rehearsal against a very large table pays for the copy and the diff even when nothing changed.
