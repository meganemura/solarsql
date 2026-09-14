# ADR 0093: Assert rows are deleted at the end of the plan

Status: accepted (2026-09-14)

## Context

ADR 0015 gives every database one guard table, `solarsql_assert`, and one trigger.
A passing assert commits a row; only a false predicate makes the trigger abort the row and the whole batch with it.
Nothing reads a committed row back: the type generator's dependency tracker and the build's static plan analysis both exclude the guard table by name.
A database that runs commands with asserts keeps every passing assert's row, so the table grows by one row per passing assert, with no bound.
Each such row also counts toward D1's `rows_written` billing.

## Decision

A plan with at least one assert item ends with one more statement: `delete from solarsql_assert`.
The adapter appends it after the plan's own statements and after its `returns` statement, inside the same D1 batch or the same Durable Object transaction the plan already runs in.
A plan with no assert gets no extra statement.

`runtime/plan.ts` exports the delete's text as `GUARD_CLEANUP`, next to `GUARD_TABLE` and `GUARD_DDL`.

Placing the delete after `returns` matters. ADR 0015 lets an assert's predicate read `changes()` of the statement right before it, and the build rejects a predicate that breaks this rule. The build runs no matching check on a `returns` clause: nothing today stops one from calling `changes()`.
A `returns` clause that called `changes()` this way would read the cleanup delete's count instead of the statement it meant to count, if the delete ran before `returns` instead of after it.

## Why

An assert's row has no further use once its trigger has run and any later statement in the plan has read what it needs.
Deleting it inside the same transaction returns the table to zero rows after every command.
No cron, TTL column, or separate maintenance path is needed.

A row cap or a time-based prune needs its own upkeep: a scheduled job, or a value compared on every insert.
Accepting unbounded growth was the other closing option, but ADR 0006 makes an assert the ordinary way to state a multi-row rule.
Growth would then follow from ordinary use of the library, not from a rare pattern.

## Consequences

- A command's `rows_written` on D1 includes the cleanup delete, in addition to each passing assert's insert. A table that returns to zero pays this cost on every command that used an assert.
- `changes` in `CommandResult` still counts only the plan's own statements (ADR 0042). The assert inserts and the cleanup delete both stay outside that count, as they already did for the inserts alone.
- `delete from solarsql_assert` removes every row the table holds. A D1 batch and a Durable Object's `transactionSync` each run one command at a time, so this invocation's own rows are the only rows present when the delete runs. A database holding rows from before this decision loses them once, on its next assert-bearing command.
- ADR 0015's guard table and trigger are unchanged. This decision only adds a statement an adapter appends at execution time; the type generator and the build's static plan analysis stay unaware of it, as they already are of `solarsql_assert` itself.
