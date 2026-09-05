# ADR 0015: An assert is a row in a guard table with one trigger

Status: accepted (2026-09-06)

## Context

ADR 0006 puts multi-row rules into asserts inside a plan.
A D1 batch cannot branch, so an assert must fail as a statement.
The failure must roll back the whole batch and must carry a name.

## Decision

Every database gets one guard table and one trigger:

```sql
create table solarsql_assert (name text not null, ok integer not null);
create trigger solarsql_assert_check before insert on solarsql_assert
  when new.ok = 0
begin
  select raise(abort, new.name);
end;
```

An assert is one statement:

```sql
insert into solarsql_assert (name, ok) select 'not_confirmable', <predicate>;
```

The predicate can read rows written earlier in the same plan.
The predicate can use `changes()` to check the row count of the previous statement.
The trigger uses `ABORT`.

## Why

`raise(abort, new.name)` accepts an expression, so one trigger serves every assert.
The error message is the assert name, so the caller can match it.
`ROLLBACK` ends the transaction from inside, which conflicts with `transactionSync()` on a Durable Object.

## Evidence (v0)

On the local D1 engine a false predicate fails the batch with `D1_ERROR: not_confirmable: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`.
The rows written earlier in the batch are gone afterwards.
A true predicate lets the batch commit.
`changes() = 1` after an `UPDATE ... WHERE status = 'draft'` fails on the second run.
See v0-measurements.md, section 1.

## Consequences

- The migration generator emits the guard table and the trigger in the first migration.
- The library maps `SQLITE_CONSTRAINT_TRIGGER` with a known name to a typed assert failure.
