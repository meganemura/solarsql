# ADR 0095: An assert predicate normalizes to 0 or 1 at run time

Status: accepted (2026-09-14)

## Context

ADR 0015 gives every database one guard table, `solarsql_assert (name text not null, ok integer not null) strict`, and one trigger that fires `when new.ok = 0`.
An assert is one statement: `insert into solarsql_assert (name, ok) select 'name', (predicate)`.
The predicate's value goes into the table exactly as it is.

A predicate that evaluates to NULL fails the table's own `not null` constraint, not the trigger.
A predicate that evaluates to text or a blob the STRICT table cannot store as an integer fails the table's datatype check, not the trigger.
Both failures return `{ kind: "not_null", table: "solarsql_assert", ... }` or `{ kind: "datatype", table: "solarsql_assert", ... }`, naming the internal guard table, not `{ kind: "assert", assert: <name> }`.

A predicate that evaluates to an integer other than 0 or 1, such as 2, stores that value directly.
The trigger's `when new.ok = 0` only checks for zero, so this value counts as a pass today.
Nothing enforces the 0-or-1 contract the trigger's own condition assumes.

`build.ts`'s `checkCommands` already refuses an assert whose predicate calls `changes()` in the wrong place: `changes()` reports the row count of the statement right before it, so an assert must sit right after the statement it counts.
A command's `returns` clause runs after the whole plan, including any assert; ADR 0093 named a related gap without closing it: nothing stops `returns` from calling `changes()` too, and since `returns` runs after the plan's last item, a `changes()` there reads that last item's count, not necessarily the statement the author meant. When the plan's last item is an assert, `returns` would read the assert's own insert (always 1 row), not the write the author meant to count.

## Decision

`assertStatement()` in `runtime/plan.ts` wraps the predicate before it reaches the guard table's insert:

```sql
insert into solarsql_assert (name, ok) select 'name', (case when (predicate) then 1 else 0 end)
```

SQLite's own truthiness rules decide the wrapped value, the same rules a `WHERE` clause already uses: NULL is false; 0 is false; any other number is true; text or a blob SQLite can read as a nonzero number is true; text or a blob it cannot is false.
The stored `ok` value is then always exactly 0 or 1, so the trigger's `when new.ok = 0` keeps working unchanged, and the guard table's `not null`/STRICT constraint can no longer fire from a predicate's shape.

`checkCommands` also refuses a command whose `returns` clause calls `changes()`, extending the check that already refuses a misplaced `changes()` inside an assert.

## Why

Three other ways to close the gap were considered.

Wrapping the predicate in `coalesce(predicate, 0)` fixes only the NULL case.
A non-numeric predicate, such as text SQLite cannot read as a number, still fails the table's own datatype check; `coalesce` does not touch that path.

Statically rejecting a predicate whose inferred type can be NULL or non-integer needs a type the type generator does not expose today: an `insert ... select` without `returning` reports no output columns, so nothing carries the predicate's result type out of `typer.analyze()` for a static check to read. Building that would be new machinery, and a static check on the SQL's shape still could not catch a predicate that reads a nullable column whose value happens to be non-null at build time but NULL at run time, or the reverse.

Changing the trigger's `WHEN` clause, for example to `when new.ok is not 1`, states the contract most directly, but `GUARD_DDL` ships in the first migration file of every project (ADR 0015). Changing it needs a migration path across every database that has already applied that file. The wrap reaches the same outcome without any DDL or migration change, the same kind of run-time-only fix ADR 0093 already used for the guard table's cleanup.

## Consequences

- A predicate that is NULL or non-numeric text, today misreported as `kind: "not_null"` or `kind: "datatype"` naming `solarsql_assert`, now reports `{ kind: "assert", assert: <name> }`, the outcome ADR 0015 already documents for a false predicate.
- No predicate that passes today starts failing. A predicate that is exactly 1 still passes. A predicate that is any other nonzero number, or text or a blob SQLite reads as nonzero, already passed the trigger's `when new.ok = 0` and continues to.
- `commands.md`'s description of an assert predicate changes from "any SQL expression that yields 0 or 1" to an expression whose truthiness SQLite decides, the same as inside a `WHERE` clause.
- The build refuses a `returns` clause that calls `changes()`, alongside the assert it already refused this in, closing the gap ADR 0093 named.
