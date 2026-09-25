# ADR 0122: Inspect carries the query plan

Status: accepted (2026-09-19)

## Context

`BuildResult.scans` already names a table a statement reads in full, from `Engine.fullScans()`. That tells an agent a table is scanned, not which index (if any) serves the rest of the plan, whether a SEARCH walks a covering index or one that still visits the table, or whether a sort or a group needed a temporary B-tree. `EXPLAIN QUERY PLAN` on the same in-memory schema the build already prepares against answers all three, and node:sqlite already exposes it: `Engine.fullScans()` calls it today for its own narrower purpose.

`sqlite.org/eqp.html` (fetched 2026-09-19) documents the four output columns (`id`, `parent`, `notused`, `detail`) and `detail`'s own grammar: a `SCAN <table>` or `SEARCH <table> USING [COVERING] INDEX <name>` line, a `SEARCH <table> USING [INTEGER] PRIMARY KEY` line when no `sqlite_schema` index names the access path, and a `USE TEMP B-TREE FOR ORDER BY` (or `GROUP BY`, or `DISTINCT`) line when no index served a sort or a group. A trailing qualifier word (`EXISTS`, `LEFT-JOIN`) can follow either of the first two forms without changing what they mean.

## Decision

`Engine.plan(sql)` in `src/build/facts.ts`, next to `fullScans()`, runs `EXPLAIN QUERY PLAN <sql>` and returns its rows with `notused` dropped. It is exempt from the denied-function allowlist the same way `fullScans()`, `accesses()`, `columns()`, and the build's diagnostic `select sqlite_version()` already are: the allowlist gates text a user wrote, and each of these is the build reading facts about a statement already checked at its own `prepare()`.

`summarizePlan()`, a pure function in `src/build/build.ts`, turns those rows into `scans` (each table named by a `SCAN` line), `searches` (each table named by a `SEARCH ... USING INDEX` or `SEARCH ... USING [INTEGER] PRIMARY KEY` line, with the index name or `null`), and `tempBtree` (true when any `detail` contains `USE TEMP B-TREE`). `OperationInspection.plan` carries `{ rows, scans, searches, tempBtree }` for a SELECT, VALUES, or WITH-prefixed read statement, and `null` for a write: a write has no read plan of its own to report. A CTE or a subquery keeps its own rows in this list, unfolded, rather than folded into its enclosing statement's summary.

The field needs no new flag: it sits inside `OperationInspection`, which already appears only under `result.inspection.operations`, gated by the existing `--inspect`/`inspect` behavior. `build --json` without `inspect` never populates `inspection` at all, so nothing else changes.

## Evidence

`test/inspect-plan.test.ts` pins the example's `byCustomer` (a search on `orders_customer_id`), `byNote` (a full scan of `orders`, since no index serves `LIKE`), and `customers`' `all` query (`order by name`, no index on `name`, so `tempBtree` is true), plus a write statement carrying `plan: null`. A Hegel property builds a table with a random column name and an index on it, and checks that an equality filter on that column always summarizes to a search on that index and never a scan of that table.

## Consequences

- `skills/solarsql/references/build.md`'s "Inspect an operation contract" section documents the four `plan` fields and says explicitly that the plan comes from an empty schema with no `ANALYZE` statistics, so a deployed database may choose differently.
- The CLI's human-readable `scan` line is unchanged; `plan` is a `--json`/`inspect`-only field, read by an agent or a script, not printed as its own line.

## 2026-09-25: a write has a read cost, and the build now reports it

The Decision above says `OperationInspection.plan` is `null` for a write because "a write has no read plan of its own to report." Measured on node v26.7.0 against `create table o (id text primary key, c text, s text)`: `EXPLAIN QUERY PLAN update o set s = 1 where c = ?` and `... delete from o where c = ?` both return `['SCAN o']`. An UPDATE or a DELETE with a WHERE clause has exactly the read plan a SELECT with the same WHERE clause would have, and D1 and a Durable Object bill the rows that plan reads (ADR 0039). The reason given for `plan: null` was wrong; `--inspect`'s field stays `null` for a write here (that part of the Decision is unchanged), but `BuildResult.scans` -- the human-readable line, not `inspect` -- no longer skips a write.

Before this section, `Engine.fullScans()` was called from exactly one place, `typegen.ts`'s `analyze()`, gated by `select && /\bwhere\b/i.test(sql)`. `isSelect()` matches only `select` and `values`, so no UPDATE, DELETE, or INSERT...SELECT plan item was ever checked. That includes an assert statement, itself an INSERT...SELECT: one of the example's own asserts, `has_lines` (`exists (select 1 from order_lines where order_id = :id)`), does carry a WHERE inside its predicate, so `writeScans()` now checks it too; it reports nothing today only because `order_lines.order_id` is indexed (`order_lines_order_id`). `build.ts` now has its own `writeScans(engine, sql)`, called beside where it reads `analysis.scans`, for any statement where `!isSelect(sql) && /\bwhere\b/i.test(sql)`. The WHERE gate is unchanged: a WHERE-less write (the example's `clear` commands) is meant to scan its table and still prints nothing.

Measured on node v26.7.0: a DELETE or an UPDATE on a parent table can report a *child* table, not its own target, when the child's foreign-key column has no index. `delete from customers where id = :id`, against `orders(customer_id text references customers(id))` with no index on `customer_id`, plans a `SCAN orders` line for SQLite's own foreign-key check, beside the parent's own indexed `SEARCH customers`. `Engine.fullScans()` alone does not surface this: its alias-candidate gate (`if (!aliases.has(alias)) return`, `src/build/facts.ts`) only recognizes an alias the statement's own text mentions, and a foreign-key check names a table the DELETE's text never does. That gate exists for a different reason (a synthetic `SCAN 2 CONSTANT ROWS` line from a VALUES/CTE construct must not be reported as a table named after itself), so `writeScans()` does not widen it. Instead it unions `Engine.fullScans(sql)`'s result with every `SCAN` row of `Engine.plan(sql)` whose name is not one of the statement's own declared aliases (`aliasCandidates(sql)`) and is a real, non-virtual table's name: a foreign-key check's implicit table passes that test, and a synthetic construct's alias-shaped name does not (it is not a declared table).

`skills/solarsql/references/build.md`'s scan-line text (its "## build" section) already reads generically ("`scan` lines for full scans"), which already covers a write; the fragment naming a scanned FK-child table separately is reported to the docs owner rather than written here, since build.md is a shared file this session. The example build's own output is unchanged: no example statement scans an unindexed FK-child table today.
