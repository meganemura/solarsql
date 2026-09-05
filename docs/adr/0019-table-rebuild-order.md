# ADR 0019: A table rebuild copies rows through a side table

Status: accepted (2026-09-06)

## Context

SQLite cannot alter a constraint, so a constraint change rebuilds the table.
A migration file runs as one transaction on D1 (ADR 0013).
`PRAGMA foreign_keys` cannot change inside a transaction.
Only `PRAGMA defer_foreign_keys` is available there.

## Decision

The generator emits this order for a rebuild of table `t`:

```sql
pragma defer_foreign_keys = on;
create table "_solarsql_new_t" (...declared definition...);
create table "_solarsql_copy_t" as select <common columns> from "t";
drop table "t";
alter table "_solarsql_new_t" rename to "t";
insert into "t" (<common columns>) select <common columns> from "_solarsql_copy_t";
drop table "_solarsql_copy_t";
-- create the indexes of t
```

## Why

`DROP TABLE` on a foreign-key parent runs an implicit `DELETE`, which raises the deferred violation counter once per child row.
The counter goes down only when a parent row enters a table with the referenced name.
Rows that enter the new table before the rename do not count, so the commit fails.
Rows that enter after the rename bring the counter back to zero.

## Evidence (v0)

Five orders were measured with child rows present.
Only this order commits.
The order with the copy before the drop fails at commit, with and without `defer_foreign_keys`.
A rename of the old table away first rewrites the child foreign keys to the old name.
The generated file applies on the local D1 engine in one batch.
See v0-measurements.md, section 4.

## Consequences

- A rebuild copies the rows twice.
- The side table is a normal table, because D1 support for `TEMP` tables is not verified.
