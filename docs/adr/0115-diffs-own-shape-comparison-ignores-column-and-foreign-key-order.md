# ADR 0115: diff()'s own shape comparison ignores column and foreign-key order

Status: accepted (2026-09-16)

## Context

`diff()` (`src/build/migration.ts`) decides whether a migration is needed by comparing the currently-deployed schema (the migration files, replayed in order) against the currently-declared schema (the modules' own DDL), table by table, through `tableShape()` and a `JSON.stringify` equality (`same()`). `tableShape()` already sorted `constraints` before this decision, but left `columns` and `foreignKeys` in whatever order `introspect()`'s `pragma_table_xinfo`/`pragma_foreign_key_list` returned them: declaration order.

Declaration order is not part of a table's shape. `ALTER TABLE ... ADD COLUMN` always appends a column at the end of the live table, while a rebuild's `CREATE TABLE` (and a hand-merged module file) orders columns by whatever order the source declares. Two histories can both be legitimate and still arrive at the same columns in a different order: two branches each add a column independently, and whichever order their migration files replay in need not match the order the merged module declares them in. A column that carries its own inline `references` clause moves its entry in `foreignKeys` the same way, since `pragma_foreign_key_list` also follows declaration order.

Before this decision, such a reorder — with no other change — made `diff()` treat the two schemas as different. On an ordinary table this proposed a full rebuild: a fresh `CREATE TABLE`, a data copy, a drop, and a rename, every view on the table dropped and recreated around it, for no reason the schemas actually disagree on. When the reordered table was referenced by another table's foreign key with an `ON DELETE` action other than `NO ACTION`, `diff()` refused outright (`{ kind: "blocked", ... }`) with a reason that named a hazard the declared schema never introduced, and never mentioned column order.

ADR 0101 established the same fact for a different, sibling comparison: whether a migration file's recorded rebuild snapshot still matches the live table at replay time. It rejected a whole-body string comparison for exactly this reason (quoted from that decision): "`ALTER TABLE ... ADD COLUMN` appends a column at the end of the table, but a rebuild's `CREATE TABLE` orders columns by each module's declaration order instead, so two histories can both be legitimate and still arrive at the same set of column declarations in a different order... Keying the comparison by column name... keeps this decision insensitive to a column's position." That decision never reached `diff()`'s own comparison, which predates it and compares a different pair of schemas at a different time.

## Decision

`tableShape()` sorts `columns` by name and `foreignKeys` by a key of every field (`from`, `table`, `to`, `onUpdate`, `onDelete`) before either field takes part in the comparison, the same way it already sorted `constraints`. This is the single function both `diff()`'s two `same(tableShape(a), tableShape(b))` call sites and the exported `shape()` use, so the fix lives there instead of at each call site: `shape()` and `diff()` must keep agreeing on what a table's shape is, since a property test runs the plan `diff()` returns and then compares `shape()` on both sides.

Foreign keys sort on every field, not only the column they come from, because SQLite allows more than one foreign key declared from the same column with a different target or action; keying on `from` alone would leave those in declaration order and reintroduce the same sensitivity for that narrower case.

The cheap-ALTER candidate check (the scratch-database re-verification before `diff()` accepts a candidate `ALTER` sequence instead of a rebuild) uses the same `tableShape()` and inherits the fix without a separate change: a candidate whose resulting column or foreign-key *set* is wrong, not merely reordered, still fails the comparison and falls through to a rebuild, because the fields that actually differ still differ after sorting.

## Why

The two comparisons — `diff()`'s own and ADR 0101's replay-time RebuildRecord check — study different schema snapshots at different times, but they rest on the same fact: declaration order is not a semantic property of a table, only an artifact of how SQLite reports and how modules happen to list columns. A fix in one place does not imply the other already has it; this decision closes the same gap `diff()`'s own comparison still had.

## Consequences

- A table's declared column order and its live column order can now differ (as they always could through `ADD COLUMN`) without `diff()` proposing a rebuild for that reason alone. A genuine addition alongside an unrelated reorder is now a single `ALTER TABLE ... ADD COLUMN`, not a rebuild that also happens to add the column.
- The table's own `sql` text (`Table.sql`, the literal `CREATE TABLE` SQLite stored) is still not part of `tableShape()` and still isn't compared; only the structured fields are, as before this decision.
- ADR 0101's RebuildRecord check, in `applied()` and `durable.ts`'s `migrate()`, is unchanged: it was already order-insensitive, and this decision does not touch it.
